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

// CONCERN-01: Factory V2 (V4 clones, separate VoidProvenanceAnchor) and Factory V3 (V5 clones that
// are their own anchor) coexist on one indexer. Each event must stay attributed to its real emitter.
describe("concurrent Factory V2 and Factory V3 releases", () => {
  const V2_RELEASE = `0x${"c2".repeat(20)}`;
  const V2_ANCHOR = `0x${"d2".repeat(20)}`;
  const V2_FACTORY = `0x${"f2".repeat(20)}`;
  const v2Config = releaseIndexerConfig({ chainId: 43113, address: V2_RELEASE, startBlock: 1, factoryAddress: V2_FACTORY });
  const transferIface = new Interface(["event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"]);

  function concurrentStore() {
    const events = [];
    const transfers = [];
    const seen = new Set();
    return {
      events,
      transfers,
      // Same idempotency contract as the real store: a repeated (tx, logIndex) is not inserted again.
      async recordEvent(value) { const id = `${value.transactionHash}:${value.logIndex}`; if (seen.has(id)) return null; seen.add(id); events.push(value); return value; },
      async recordIndexerError() {},
      async applyTransfer(value) { transfers.push(value); return value; },
      async applyAlbumEvent() { throw new Error("not an album event"); },
    };
  }

  it("records a V3 clone's ProvenanceAnchored under that clone while a V2 clone's transfers index normally", async () => {
    const store = concurrentStore();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [v2Config, config] });
    await expect(indexer.processLog(config, anchoredLog(), block)).resolves.toMatchObject({ duplicate: false, eventType: "ProvenanceAnchored", provenanceRoot: ROOT });
    const transfer = transferIface.encodeEventLog("TransferSingle", [ARTIST, "0x0000000000000000000000000000000000000000", ARTIST, 9n, 1n]);
    await indexer.processLog(v2Config, { address: V2_RELEASE, topics: transfer.topics, data: transfer.data, transactionHash: `0x${"e2".repeat(32)}`, blockNumber: 7, blockHash: "0xblock7", logIndex: 0 }, block);
    expect(store.events.filter((event) => event.eventType === "ProvenanceAnchored")).toEqual([expect.objectContaining({ contractAddress: RELEASE, eventData: expect.objectContaining({ releaseContract: RELEASE }) })]);
    expect(store.transfers.at(-1)).toMatchObject({ contractAddress: V2_RELEASE, tokenId: "9" });
  });

  it("never credits a V2 separate-anchor ProvenanceAnchored log to the V2 clone", async () => {
    // V2 anchors are not indexer targets (their events are verified at confirmation, server-side).
    // Even if such a log reached the clone's config, its real emitter is kept and it is refused.
    const store = concurrentStore();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [v2Config, config] });
    const result = await indexer.processLog(v2Config, anchoredLog({ emitter: V2_ANCHOR, loggedRelease: V2_RELEASE }), block);
    expect(result).toEqual({ duplicate: false, malformed: true });
    expect(store.events.filter((event) => event.eventType === "ProvenanceAnchored" && !event.isMalformed)).toEqual([]);
  });

  it("treats a replayed V3 ProvenanceAnchored log as a duplicate, not a second record", async () => {
    const store = concurrentStore();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [v2Config, config] });
    await indexer.processLog(config, anchoredLog(), block);
    await expect(indexer.processLog(config, anchoredLog(), block)).resolves.toMatchObject({ duplicate: true, eventType: "ProvenanceAnchored" });
    expect(store.events.filter((event) => event.eventType === "ProvenanceAnchored")).toHaveLength(1);
  });
});
