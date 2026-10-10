import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { BlockchainIndexer, decodeProvenanceAnchoredLog } from "./indexer.js";
import { releaseIndexerConfig } from "./config.js";

const RELEASE = `0x${"a1".repeat(20)}`;
const OTHER = `0x${"b2".repeat(20)}`;
const FACTORY = `0x${"fa".repeat(20)}`;
const ARTIST = `0x${"a7".repeat(20)}`;
const KEY = `0x${"aa".repeat(32)}`;
const EDITION = `0x${"ed".repeat(32)}`;
const ROOT = "0x72e39f2f98fefaa1266fdeb3e9a7ed1359ce97db5d2d1130e759c15d80042e20";
const TX = `0x${"c1".repeat(32)}`;

// Build the ABI from the contract source so the indexer topic tracks the real declaration.
const source = readFileSync(join(import.meta.dirname, "..", "contracts", "VoidRelease1155V5.sol"), "utf8");
const match = source.match(/event ProvenanceAnchored\(([^)]*)\);/);
if (!match) throw new Error("VoidRelease1155V5 no longer declares ProvenanceAnchored.");
const iface = new Interface([`event ProvenanceAnchored(${match[1].replace(/\s+/g, " ").trim()})`]);
const config = releaseIndexerConfig({ chainId: 43113, address: RELEASE, startBlock: 1, factoryAddress: FACTORY });
const block = { number: 7, hash: "0xblock7", parentHash: "0xblock6", timestamp: 1_700_000_007 };

function anchoredLog({ root = ROOT, emitter = RELEASE, loggedRelease = RELEASE } = {}) {
  const encoded = iface.encodeEventLog("ProvenanceAnchored", [root, KEY, EDITION, 5n, ARTIST, loggedRelease]);
  return { address: emitter, topics: encoded.topics, data: encoded.data, transactionHash: TX, blockNumber: 7, blockHash: "0xblock7", logIndex: 1 };
}

function storeDouble() {
  const events = [];
  return { events, async recordEvent(value) { events.push(value); return value; }, async recordIndexerError() {}, async applyTransfer() { throw new Error("not a transfer"); }, async applyAlbumEvent() { throw new Error("not an album event"); } };
}

describe("VoidRelease1155V5 ProvenanceAnchored indexing", () => {
  it("configures the ERC1155 topic from the contract declaration", () => {
    expect(config.eventTopics.ProvenanceAnchored).toBe(iface.getEvent("ProvenanceAnchored").topicHash);
  });

  it("decodes the root, identities, attesting artist and release contract", () => {
    expect(decodeProvenanceAnchoredLog(anchoredLog(), { chainId: 43113, eventTopics: config.eventTopics })).toMatchObject({
      eventType: "ProvenanceAnchored", contractAddress: RELEASE, provenanceRoot: ROOT, releaseId: KEY, editionId: EDITION, tokenId: "5", artist: ARTIST, releaseContract: RELEASE, blockNumber: 7, logIndex: 1,
    });
  });

  it("rejects a log whose recorded release contract is not the emitter, or a zero root", () => {
    expect(() => decodeProvenanceAnchoredLog(anchoredLog({ loggedRelease: OTHER }), { chainId: 43113, eventTopics: config.eventTopics })).toThrow(/does not match/);
    expect(() => decodeProvenanceAnchoredLog(anchoredLog({ root: `0x${"00".repeat(32)}` }), { chainId: 43113, eventTopics: config.eventTopics })).toThrow(/zero/);
  });

  it("records the event for a tracked release clone and marks a mismatched one malformed", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [config] });
    await expect(indexer.processLog(config, anchoredLog(), block)).resolves.toMatchObject({ duplicate: false, eventType: "ProvenanceAnchored", provenanceRoot: ROOT });
    expect(store.events.at(-1)).toMatchObject({ eventType: "ProvenanceAnchored", isMalformed: false, eventData: expect.objectContaining({ provenanceRoot: ROOT, artist: ARTIST }) });
    await expect(indexer.processLog(config, anchoredLog({ loggedRelease: OTHER }), block)).resolves.toEqual({ duplicate: false, malformed: true });
  });
});
