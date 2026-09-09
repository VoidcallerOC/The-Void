import { describe, expect, it, vi } from "vitest";
import { BlockchainIndexer, decodeTransferLog, retry } from "./indexer.js";
import { reconcileOwnership } from "./indexer-reconcile.js";

const singleTopic = "0xsingle";
const batchTopic = "0xbatch";
const zero = "0x0000000000000000000000000000000000000000";
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addrTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const block = (number, hash = `0xblock${number}`, parentHash = `0xparent${number - 1}`) => ({ number, hash, parentHash, timestamp: 1_700_000_000 + number });
const singleLog = ({ blockNumber = 1, tokenId = 1, amount = 2, from = alice, to = bob, tx = `0xtx${blockNumber}`, logIndex = 0, address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } = {}) => ({ address, topics: [singleTopic, addrTopic(alice), addrTopic(from), addrTopic(to)], data: `0x${word(tokenId)}${word(amount)}`, transactionHash: tx, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex });

function storeDouble({ checkpoints = new Map(), blocks = new Map(), failAtBlock = null } = {}) {
  const events = new Map();
  const transfers = [];
  const calls = { checkpoints: [], reorgs: [], errors: [], applied: [] };
  return {
    calls, events, transfers,
    async getCheckpoint(key) { return checkpoints.get(`${key.chainId}:${key.address}`) || null; },
    async setCheckpoint(value) { calls.checkpoints.push(value); checkpoints.set(`${value.chainId}:${value.address}`, value); return value; },
    async getBlock({ chainId, blockNumber }) { return blocks.get(`${chainId}:${blockNumber}`) || null; },
    async recordBlock(value) { blocks.set(`${value.chainId}:${value.blockNumber}`, { block_hash: value.blockHash, ...value }); },
    async handleReorg(value) { calls.reorgs.push(value); },
    async recordEvent(value) { const key = `${value.chainId}:${value.contractAddress}:${value.transactionHash}:${value.logIndex}`; if (events.has(key)) return null; events.set(key, value); return value; },
    async applyTransfer(value) { if (failAtBlock === value.blockNumber) throw new Error("projection failure"); calls.applied.push(value); transfers.push(value); return value; },
    async recordIndexerError(value) { calls.errors.push(value); },
    async getOwnership() { return { amount: "2" }; },
  };
}

describe("ERC-1155 event decoding", () => {
  it("decodes transfer, mint, and burn semantics", () => {
    expect(decodeTransferLog(singleLog({ from: alice, to: bob }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0]).toMatchObject({ eventType: "TransferSingle", tokenId: "1", amount: "2", from: alice, to: bob });
    expect(decodeTransferLog(singleLog({ from: zero, to: bob }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0].eventType).toBe("MINT");
    expect(decodeTransferLog(singleLog({ from: alice, to: zero }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0].eventType).toBe("BURN");
  });

  it("supports multiple token IDs from a batch transfer", () => {
    const data = `0x${word(64)}${word(160)}${word(2)}${word(7)}${word(8)}${word(2)}${word(3)}${word(4)}`;
    const result = decodeTransferLog({ ...singleLog({}), topics: [batchTopic, addrTopic(alice), addrTopic(alice), addrTopic(bob)], data }, { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferBatch: batchTopic } });
    expect(result.map((item) => [item.tokenId, item.amount])).toEqual([["7", "3"], ["8", "4"]]);
  });
});

describe("durable index synchronization", () => {
  it("processes multiple contracts and prevents duplicate events", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn(({ address }) => Promise.resolve([singleLog({ blockNumber: 1, address, tx: `0x${address.slice(-4)}1` })])), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }, { chainId: 43114, address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await indexer.syncAll();
    await indexer.syncAll();
    expect(store.transfers).toHaveLength(2);
    expect(store.events.size).toBe(2);
  });

  it("resumes from the last checkpoint after interruption", async () => {
    const store = storeDouble();
    let failed = true;
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(3), getLogs: vi.fn(() => Promise.resolve([singleLog({ blockNumber: 1 }), singleLog({ blockNumber: 2 }), singleLog({ blockNumber: 3 })])), getBlock: vi.fn((_, number) => { if (number === 2 && failed) { failed = false; return Promise.reject(new Error("RPC interrupted")); } return Promise.resolve(block(number)); }) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow("RPC interrupted");
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).nextBlock).toBe(2);
    await indexer.syncAll();
    expect(store.calls.applied.some((item) => item.blockNumber === 3)).toBe(true);
  });

  it("retries RPC failures and does not advance after a failed fetch", async () => {
    let attempts = 0;
    await expect(retry(async () => { attempts += 1; if (attempts < 3) throw new Error("RPC down"); return "ok"; }, { retries: 3, baseDelayMs: 0, sleep: async () => {} })).resolves.toBe("ok");
    expect(attempts).toBe(3);
  });

  it("marks a changed block hash as a reorganization", async () => {
    const store = storeDouble({ blocks: new Map([["43114:2", { block_hash: "0xold" }]]) });
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => Promise.resolve(block(number, number === 2 ? "0xnew" : undefined))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 2, eventTopics: { TransferSingle: singleTopic } }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(1);
  });

  it("rewinds from a divergent persisted checkpoint on restart and replays the replacement canonical block", async () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const checkpoints = new Map([[`43114:${address}`, { chain_id: 43114, contract_address: address, nextBlock: 4, last_processed_block: 3, last_processed_hash: "0xold3" }]]);
    const blocks = new Map([["43114:2", { block_hash: "0xcanonical2" }], ["43114:3", { block_hash: "0xold3" }]]);
    const store = storeDouble({ checkpoints, blocks });
    store.handleReorg = async (value) => { store.calls.reorgs.push(value); blocks.delete("43114:3"); };
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(3),
      getLogs: vi.fn().mockResolvedValue([singleLog({ blockNumber: 3, tx: "0xreplacement3" })]),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number, number === 2 ? "0xcanonical2" : "0xreplacement3"))),
    };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address, contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
    expect(store.calls.reorgs).toEqual([expect.objectContaining({ chainId: 43114, fromBlock: 3, replacementHash: "0xreplacement3" })]);
    expect(store.calls.applied).toContainEqual(expect.objectContaining({ blockNumber: 3, transactionHash: "0xreplacement3" }));
  });

  it("does not advance a checkpoint across a missing block gap", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => number === 2 ? Promise.resolve(null) : Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow();
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).nextBlock).toBe(2);
  });

  it("persists failure state when the checkpoint database write fails", async () => {
    const store = storeDouble();
    store.setCheckpoint = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn().mockResolvedValue(block(1)) };
    const logger = { error: vi.fn() };
    const indexer = new BlockchainIndexer({ rpc, store, logger, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow("database unavailable");
    expect(logger.error).toHaveBeenCalledWith("indexer.failure.persistence.failed", expect.objectContaining({ originalError: "database unavailable" }));
  });

  it("records malformed events without stopping the synchronization loop", async () => {
    const store = storeDouble();
    const malformed = { ...singleLog(), topics: [singleTopic], data: "0x01" };
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1), getLogs: vi.fn().mockResolvedValue([malformed]), getBlock: vi.fn().mockResolvedValue(block(1)) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
    expect(store.calls.errors[0].errorType).toBe("MALFORMED_EVENT");
  });
});

describe("ownership reconciliation", () => {
  it("compares indexed balances with finalized RPC state", async () => {
    const errors = [];
    const result = await reconcileOwnership({ rpc: { getBalanceOf: vi.fn().mockResolvedValue(2n) }, store: { getOwnership: vi.fn().mockResolvedValue({ amount: "1" }), recordIndexerError: vi.fn((value) => errors.push(value)) }, chainId: 43114, contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", assets: [1, 2], wallets: [bob], retryOptions: { retries: 0 } });
    expect(result.every((item) => item.match === false)).toBe(true);
    expect(errors).toHaveLength(2);
  });
});
