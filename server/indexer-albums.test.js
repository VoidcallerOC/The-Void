import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbiCoder, Interface, id } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { BlockchainIndexer, decodeAlbumLog } from "./indexer.js";
import { releaseIndexerConfig } from "./config.js";
import { IndexerStore } from "./indexer-store.js";

const RELEASE = `0x${"a1".repeat(20)}`;
const FACTORY = `0x${"fa".repeat(20)}`;
const KEY = `0x${"aa".repeat(32)}`;
const TX = `0x${"c1".repeat(32)}`;
const TOKEN_ID = 69621777096996404494569967715110965261109496187347335164928263396549073080909n;
const MINT_END = 1_900_000_000n;

// Build the ABI from the contract source so the indexer topics track the real declarations.
const source = readFileSync(join(import.meta.dirname, "..", "contracts", "VoidRelease1155V4.sol"), "utf8");
const declarations = ["AlbumCreated", "AlbumTrackCreated", "AlbumClosed", "ExpandedReleaseApproved"].map((name) => {
  const match = source.match(new RegExp(`event ${name}\\(([^)]*)\\);`));
  if (!match) throw new Error(`VoidRelease1155V4 no longer declares ${name}.`);
  return `event ${name}(${match[1]})`;
});
const iface = new Interface(declarations);
const config = releaseIndexerConfig({ chainId: 43113, address: RELEASE, startBlock: 1, factoryAddress: FACTORY });
const block = (number) => ({ number, hash: `0xblock${number}`, parentHash: `0xblock${number - 1}`, timestamp: 1_700_000_000 + number });

function albumLog(name, args, { logIndex = 0, blockNumber = 7 } = {}) {
  const encoded = iface.encodeEventLog(name, args);
  return { address: RELEASE, topics: encoded.topics, data: encoded.data, transactionHash: TX, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex };
}

function storeDouble() {
  const events = new Map();
  const calls = { album: [], errors: [], transfers: [], events: [] };
  return {
    calls,
    async recordEvent(value) { calls.events.push(value); const key = `${value.contractAddress}:${value.transactionHash}:${value.logIndex}`; if (events.has(key)) return null; events.set(key, value); return value; },
    async recordIndexerError(value) { calls.errors.push(value); },
    async applyAlbumEvent(value) { calls.album.push(value); return { ok: true }; },
    async applyTransfer(value) { calls.transfers.push(value); return {}; },
  };
}

describe("VoidRelease1155V4 album event decoding", () => {
  it("configures ERC1155 topics that match the contract's album event declarations", () => {
    for (const name of ["AlbumCreated", "AlbumTrackCreated", "AlbumClosed", "ExpandedReleaseApproved"]) {
      expect(config.eventTopics[name]).toBe(iface.getEvent(name).topicHash);
    }
    expect(config.eventTopics.AlbumTrackCreated).toBe(id("AlbumTrackCreated(uint256,bool,uint64)"));
  });

  it("decodes AlbumTrackCreated including the indexed bool single topic and uint64 mintEnd", () => {
    const single = decodeAlbumLog(albumLog("AlbumTrackCreated", [TOKEN_ID, true, MINT_END]), { chainId: 43113, eventTopics: config.eventTopics });
    expect(single).toMatchObject({ eventType: "AlbumTrackCreated", contractAddress: RELEASE, tokenId: TOKEN_ID.toString(), single: true, mintEnd: MINT_END.toString(), blockNumber: 7, logIndex: 0 });
    const track = decodeAlbumLog(albumLog("AlbumTrackCreated", [5n, false, 0n]), { chainId: 43113, eventTopics: config.eventTopics });
    expect(track).toMatchObject({ tokenId: "5", single: false, mintEnd: "0" });
    const maxUint64 = (1n << 64n) - 1n;
    expect(decodeAlbumLog(albumLog("AlbumTrackCreated", [5n, true, maxUint64]), { chainId: 43113, eventTopics: config.eventTopics }).mintEnd).toBe(maxUint64.toString());
  });

  it("rejects a non-boolean single topic and an incomplete track log", () => {
    const log = albumLog("AlbumTrackCreated", [5n, true, 0n]);
    expect(() => decodeAlbumLog({ ...log, topics: [log.topics[0], log.topics[1], `0x${"0".repeat(63)}2`] }, { chainId: 43113, eventTopics: config.eventTopics })).toThrow(/bool/);
    expect(() => decodeAlbumLog({ ...log, topics: log.topics.slice(0, 2) }, { chainId: 43113, eventTopics: config.eventTopics })).toThrow(/single/);
  });

  it("decodes album created, closed and expanded approval events", () => {
    expect(decodeAlbumLog(albumLog("AlbumCreated", [KEY]), { chainId: 43113, eventTopics: config.eventTopics })).toMatchObject({ eventType: "AlbumCreated", releaseKey: KEY });
    expect(decodeAlbumLog(albumLog("AlbumClosed", [KEY]), { chainId: 43113, eventTopics: config.eventTopics })).toMatchObject({ eventType: "AlbumClosed", releaseKey: KEY });
    expect(decodeAlbumLog(albumLog("ExpandedReleaseApproved", [20n, 6n]), { chainId: 43113, eventTopics: config.eventTopics })).toMatchObject({ eventType: "ExpandedReleaseApproved", maxTracks: "20", maxSingles: "6" });
  });

  it("ignores logs whose topic is not an album event", () => {
    const transfer = { ...albumLog("AlbumCreated", [KEY]), topics: [config.eventTopics.TransferSingle] };
    expect(decodeAlbumLog(transfer, { chainId: 43113, eventTopics: config.eventTopics })).toBeNull();
    expect(decodeAlbumLog(albumLog("AlbumCreated", [KEY]), { chainId: 43113, eventTopics: { TransferSingle: config.eventTopics.TransferSingle } })).toBeNull();
  });
});

describe("album events in the ERC1155 indexer path", () => {
  it("records each album event and projects it through the store", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [config] });
    const logs = [
      albumLog("AlbumCreated", [KEY], { logIndex: 0 }),
      albumLog("ExpandedReleaseApproved", [20n, 6n], { logIndex: 1 }),
      albumLog("AlbumTrackCreated", [TOKEN_ID, true, MINT_END], { logIndex: 2 }),
      albumLog("AlbumClosed", [KEY], { logIndex: 3 }),
    ];
    const results = [];
    for (const log of logs) results.push(await indexer.processLog(config, log, block(7)));
    expect(results.map((result) => result.eventType)).toEqual(["AlbumCreated", "ExpandedReleaseApproved", "AlbumTrackCreated", "AlbumClosed"]);
    expect(store.calls.events.map((event) => event.eventType)).toEqual(["AlbumCreated", "ExpandedReleaseApproved", "AlbumTrackCreated", "AlbumClosed"]);
    expect(store.calls.events[2].eventData).toMatchObject({ tokenId: TOKEN_ID.toString(), single: true, mintEnd: MINT_END.toString() });
    expect(store.calls.album[2]).toMatchObject({ chainId: 43113, contractAddress: RELEASE, transactionHash: TX, blockNumber: 7, blockHash: "0xblock7", logIndex: 2, single: true });
    expect(store.calls.transfers).toHaveLength(0);

    // A replayed log is a duplicate event; the projection upsert is re-applied idempotently.
    await expect(indexer.processLog(config, logs[2], block(7))).resolves.toMatchObject({ duplicate: true, eventType: "AlbumTrackCreated" });
  });

  it("keeps TransferSingle handling and unknown logs unchanged", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [config] });
    const coder = AbiCoder.defaultAbiCoder();
    const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
    const mint = { address: RELEASE, topics: [config.eventTopics.TransferSingle, topic(`0x${"11".repeat(20)}`), topic(`0x${"0".repeat(40)}`), topic(`0x${"22".repeat(20)}`)], data: coder.encode(["uint256", "uint256"], [5n, 1n]), transactionHash: TX, blockNumber: 7, blockHash: "0xblock7", logIndex: 9 };
    await expect(indexer.processLog(config, mint, block(7))).resolves.toMatchObject({ eventType: "MINT", transferCount: 1 });
    const other = { ...mint, topics: [id("ReleaseInitialized(bytes32,address,address)"), KEY, topic(`0x${"11".repeat(20)}`), topic(`0x${"22".repeat(20)}`)], data: "0x", logIndex: 10 };
    await expect(indexer.processLog(config, other, block(7))).resolves.toMatchObject({ eventType: "UNKNOWN", transferCount: 0 });
    expect(store.calls.album).toHaveLength(0);
  });

  it("stores a malformed album log as MALFORMED without projecting it", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [config] });
    const log = albumLog("AlbumTrackCreated", [5n, true, 0n]);
    await expect(indexer.processLog(config, { ...log, topics: [log.topics[0], log.topics[1], `0x${"f".repeat(64)}`] }, block(7))).resolves.toEqual({ duplicate: false, malformed: true });
    expect(store.calls.events[0]).toMatchObject({ eventType: "MALFORMED", isMalformed: true });
    expect(store.calls.album).toHaveLength(0);
  });
});

describe("album projection storage", () => {
  const event = { chainId: 43113, contractAddress: RELEASE.toUpperCase().replace("0X", "0x"), transactionHash: TX, blockNumber: 7, blockHash: "0xblock7", logIndex: 2 };

  it("upserts album tracks keyed by chain, contract and token", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ token_id: "5" }] }) };
    const store = new IndexerStore(db);
    await store.applyAlbumEvent({ ...event, eventType: "AlbumTrackCreated", tokenId: "5", single: true, mintEnd: MINT_END.toString() });
    await store.applyAlbumEvent({ ...event, eventType: "AlbumTrackCreated", tokenId: "5", single: true, mintEnd: MINT_END.toString() });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO release_album_tracks");
    expect(sql).toContain("ON CONFLICT (chain_id, contract_address, token_id) DO UPDATE");
    expect(params).toEqual([43113, RELEASE, "5", true, MINT_END.toString(), TX, 7, "0xblock7", 2]);
    expect(db.query.mock.calls[1]).toEqual(db.query.mock.calls[0]);
  });

  it("upserts album lifecycle state keyed by chain and contract", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{}] }) };
    const store = new IndexerStore(db);
    await store.applyAlbumEvent({ ...event, eventType: "AlbumCreated", releaseKey: KEY });
    await store.applyAlbumEvent({ ...event, eventType: "AlbumClosed", releaseKey: KEY });
    await store.applyAlbumEvent({ ...event, eventType: "ExpandedReleaseApproved", maxTracks: "20", maxSingles: "6" });
    expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO release_albums .*created_block_number.*ON CONFLICT \(chain_id, contract_address\) DO UPDATE/);
    expect(db.query.mock.calls[1][0]).toMatch(/closed_block_number=EXCLUDED\.closed_block_number/);
    expect(db.query.mock.calls[2][0]).toMatch(/expanded_max_tracks=EXCLUDED\.expanded_max_tracks/);
    expect(db.query.mock.calls[2][1]).toEqual([43113, RELEASE, "20", "6", TX, 7, "0xblock7", 2]);
  });

  it("rejects malformed projections before writing", async () => {
    const db = { query: vi.fn() };
    const store = new IndexerStore(db);
    await expect(store.applyAlbumEvent({ ...event, eventType: "AlbumTrackCreated", tokenId: "5", single: "yes", mintEnd: "0" })).rejects.toThrow(/single/);
    await expect(store.applyAlbumEvent({ ...event, eventType: "AlbumTrackCreated", tokenId: "5", single: true, mintEnd: (1n << 64n).toString() })).rejects.toThrow(/mintEnd/);
    await expect(store.applyAlbumEvent({ ...event, eventType: "AlbumCreated", releaseKey: "0x1" })).rejects.toThrow(/releaseKey/);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("removes album projections at or above the reorg block", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const store = new IndexerStore({ query: vi.fn(), connect: vi.fn().mockResolvedValue(client) });
    await store.handleReorg({ chainId: 43113, fromBlock: 7, replacementHash: "0xnew" });
    const statements = client.query.mock.calls.filter(([sql]) => String(sql).includes("release_album"));
    expect(statements.map(([sql]) => String(sql))).toEqual([
      expect.stringContaining("DELETE FROM release_album_tracks WHERE chain_id=$1 AND block_number >= $2"),
      expect.stringContaining("DELETE FROM release_albums WHERE chain_id=$1 AND created_block_number >= $2"),
      expect.stringContaining("closed_block_number >= $2"),
      expect.stringContaining("expanded_block_number >= $2"),
    ]);
    for (const [, params] of statements) expect(params).toEqual([43113, 7]);
  });
});
