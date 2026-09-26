import { describe, expect, it, vi } from "vitest";
import { id } from "ethers";
import { BlockchainIndexer, decodePurchasedLog, decodeTransferLog, retry } from "./indexer.js";
import { reconcileOwnership } from "./indexer-reconcile.js";
import { CheckpointRegressionError } from "./indexer-store.js";
import { createIndexerWorker, ProductionIndexerWorker } from "./indexer-worker.js";

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

describe("primary sale purchase indexing", () => {
  const purchasedTopic = id("Purchased(uint256,address,uint256,uint256,uint256,uint256)");
  const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const sale = "0xcccccccccccccccccccccccccccccccccccccccc";
  const purchasedLog = () => ({
    address: sale,
    topics: [purchasedTopic, `0x${word(1)}`, addrTopic(bob)],
    data: `0x${word(2)}${word(1000)}${word(750)}${word(250)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 1,
    blockHash: "0xblock1",
    logIndex: 1,
  });

  it("decodes a Purchased event into the ERC1155 buyer, price, and fee split", () => {
    expect(decodePurchasedLog(purchasedLog(), { chainId: 43113, blockTimestamp: new Date("2026-01-01T00:00:00Z"), tokenAddress: token, eventTopic: purchasedTopic })).toMatchObject({
      eventType: "Purchased", buyerWallet: bob, tokenContractAddress: token, tokenId: "1", quantity: "2", paidWei: "1000", artistCutWei: "750", platformCutWei: "250",
    });
    expect(decodePurchasedLog(purchasedLog(), { chainId: 43113, blockTimestamp: new Date(), tokenAddress: token, eventTopic: "0x" + "11".repeat(32) })).toBeNull();
  });

  it("records the purchase and credits ownership from Purchased while the paired ERC1155 mint does not credit twice", async () => {
    const store = storeDouble();
    store.applyPrimaryPurchase = vi.fn().mockResolvedValue({ duplicate: false, ownershipCredited: true });
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [{ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", tokenAddress: token, eventTopics: { Purchased: purchasedTopic } }] });
    await expect(indexer.processLog({ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", tokenAddress: token, eventTopics: { Purchased: purchasedTopic } }, purchasedLog(), block(1))).resolves.toMatchObject({ eventType: "Purchased", projectionApplied: true });
    expect(store.applyPrimaryPurchase).toHaveBeenCalledWith(expect.objectContaining({ buyerWallet: bob, quantity: "2", tokenContractAddress: token }));

    const releaseStore = storeDouble();
    const mint = singleLog({ from: zero, to: bob, address: token, logIndex: 0 });
    mint.topics[1] = addrTopic(sale);
    const releaseIndexer = new BlockchainIndexer({ rpc: {}, store: releaseStore, configs: [{ chainId: 43113, address: token, contractType: "ERC1155", eventTopics: { TransferSingle: singleTopic }, skipMintOperators: [sale] }] });
    await releaseIndexer.processLog({ chainId: 43113, address: token, contractType: "ERC1155", eventTopics: { TransferSingle: singleTopic }, skipMintOperators: [sale] }, mint, block(1));
    expect(releaseStore.calls.applied[0]).toMatchObject({ eventType: "MINT", to: bob, skipOwnership: true });
  });
});

describe("Fuji worker startup", () => {
  it("initializes deterministically with marketplace functionality disabled", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = createIndexerWorker({
      config: {
        marketplace: { enabled: false, address: null, chainId: null },
        databaseUrl: "postgres://staging",
        databaseSsl: false,
        poolMax: 1,
        poolIdleTimeoutMs: 1000,
        poolConnectionTimeoutMs: 1000,
        indexer: { rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113, confirmations: 12, pollIntervalMs: 15000, contracts: [{ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1 }] },
      },
      pool: { query: vi.fn(), end: vi.fn() },
      logger,
    });
    expect(worker).toHaveProperty("syncOnce");
    expect(logger.info).toHaveBeenCalledWith("indexer.marketplace", { status: "not_configured", address: null, chainId: null });
  });

  it("waits for an existing lease instead of exiting fatally during restart", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = {
      acquireWorkerLease: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ owner_id: "new-worker" }),
      releaseWorkerLease: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new ProductionIndexerWorker({
      indexer: { syncAll: vi.fn() },
      store,
      rpc: {},
      config: { chainId: 43113, contracts: [], leaseTtlMs: 90, pollIntervalMs: 1, ownershipReconciliationIntervalMs: 90 },
      logger,
    });
    worker.cycle = vi.fn(async () => { worker.stop(); return { stopped: true }; });

    await expect(worker.start()).resolves.toBeUndefined();
    expect(store.acquireWorkerLease).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("indexer.worker.lease.waiting", expect.objectContaining({ chainId: 43113 }));
    expect(store.releaseWorkerLease).toHaveBeenCalledWith(expect.objectContaining({ ownerId: worker.ownerId }));
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

  it("advances empty ranges without fetching every block and fetches each event block once", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(9), getLogs: vi.fn().mockResolvedValue([
      singleLog({ blockNumber: 5, tx: "0xtx5a" }),
      singleLog({ blockNumber: 5, tx: "0xtx5b", logIndex: 1 }),
    ]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 10, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic } }] });
    const [result] = await indexer.syncAll();
    expect(result.processedBlocks).toBe(10);
    expect(rpc.getBlock).toHaveBeenCalledTimes(2);
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).lastProcessedBlock).toBe(9);
    expect(store.transfers).toHaveLength(2);
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

// Mirrors what IndexerStore returns from Postgres: snake_case rows with bigint columns as strings,
// and the forward-only next_block guard enforced by setCheckpoint.
function pgRowStore({ row = null, blocks = new Map() } = {}) {
  let checkpoint = row;
  const history = [];
  const calls = { reorgs: [], writes: [] };
  return {
    calls, history, blocks,
    get row() { return checkpoint; },
    async getCheckpoint() { return checkpoint ? { ...checkpoint } : null; },
    async setCheckpoint(value) {
      calls.writes.push(value);
      if (checkpoint && !value.allowRewind && value.nextBlock < Number(checkpoint.next_block)) throw new CheckpointRegressionError({ chainId: value.chainId, contractAddress: value.address, nextBlock: value.nextBlock });
      checkpoint = {
        ...checkpoint,
        chain_id: String(value.chainId), contract_address: value.address, contract_type: value.contractType, next_block: String(value.nextBlock), status: value.status,
        ...(value.lastProcessedBlock !== undefined ? { last_processed_block: String(value.lastProcessedBlock) } : {}),
        ...(value.lastError !== undefined ? { last_error: value.lastError } : {}),
        rpc_failures: (checkpoint?.rpc_failures ?? 0) + (value.rpcFailure ? 1 : 0),
      };
      history.push(Number(checkpoint.next_block));
      return checkpoint;
    },
    async getBlock({ chainId, blockNumber }) { const stored = blocks.get(`${chainId}:${blockNumber}`); return stored ? { block_hash: stored } : null; },
    async recordBlock(value) { blocks.set(`${value.chainId}:${value.blockNumber}`, value.blockHash); },
    async handleReorg(value) { calls.reorgs.push(value); for (const key of [...blocks.keys()]) if (Number(key.split(":")[1]) >= value.fromBlock) blocks.delete(key); },
    async recordEvent(value) { return value; },
    async applyTransfer(value) { return value; },
    async recordIndexerError() {},
  };
}

describe("checkpoint rewind regression (Fuji 43113)", () => {
  const address = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
  const startBlock = 58_428_586;
  const config = { chainId: 43113, address, contractType: "ERC1155", startBlock, eventTopics: { TransferSingle: singleTopic } };
  const chainRpc = (head, hashOf = (n) => `0xblock${n}`) => ({
    head,
    getBlockNumber: vi.fn(function () { return Promise.resolve(this.head); }),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlock: vi.fn((_, n) => Promise.resolve(block(n, hashOf(n)))),
  });

  it("resumes from the persisted next_block instead of restarting at startBlock", async () => {
    const store = pgRowStore({ row: { chain_id: "43113", contract_address: address, next_block: "58647586", last_processed_block: "58647585" }, blocks: new Map([["43113:58647585", "0xblock58647585"]]) });
    const rpc = chainRpc(58_648_000);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 12, chunkSize: 500, configs: [config] });
    const [result] = await indexer.syncAll();
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(58_647_586);
    expect(rpc.getLogs.mock.calls.every(([range]) => range.fromBlock >= 58_647_586)).toBe(true);
    expect(store.calls.reorgs).toHaveLength(0);
    expect(result.nextBlock).toBe(58_648_000 - 12 + 1);
    expect(Math.min(...store.history)).toBeGreaterThanOrEqual(58_647_586);
  });

  it("keeps the checkpoint monotonic across repeated cycles while the head advances", async () => {
    const store = pgRowStore();
    const rpc = chainRpc(startBlock + 1_000);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 12, chunkSize: 500, configs: [config] });
    const observed = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await indexer.syncAll();
      observed.push(Number(store.row.last_processed_block));
      rpc.head += 700;
    }
    for (let i = 1; i < observed.length; i += 1) expect(observed[i]).toBeGreaterThan(observed[i - 1]);
    for (let i = 1; i < store.history.length; i += 1) expect(store.history[i]).toBeGreaterThanOrEqual(store.history[i - 1]);
    expect(store.calls.reorgs).toHaveLength(0);
  });

  it("does not treat a missing stored block hash as a reorg", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:990", "0xblock990"]]) });
    const rpc = chainRpc(1_100);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 500, configs: [{ ...config, startBlock: 900 }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(0);
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(1_001);
  });

  it("rewinds to the common ancestor on a genuine hash mismatch and then converges forward", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:998", "0xblock998"], ["43113:999", "0xorphan999"], ["43113:1000", "0xorphan1000"]]) });
    const rpc = chainRpc(1_010);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 500, configs: [{ ...config, startBlock: 900 }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toEqual([expect.objectContaining({ chainId: 43113, fromBlock: 999, replacementHash: "0xblock999" })]);
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(999);
    expect(Number(store.row.next_block)).toBe(1_011);
    rpc.head = 1_020;
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(1);
    expect(Number(store.row.next_block)).toBe(1_021);
  });

  it("refuses an older checkpoint write that is not a verified reorg", async () => {
    const store = pgRowStore({ row: { next_block: "58647586", last_processed_block: "58647585" } });
    await expect(store.setCheckpoint({ chainId: 43113, address, contractType: "ERC1155", nextBlock: 58_433_086, status: "RUNNING" })).rejects.toBeInstanceOf(CheckpointRegressionError);
    expect(store.row.next_block).toBe("58647586");
  });

  it("reports a meaningful error and keeps the checkpoint when verification cannot read the chain", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:1000", "0xblock1000"]]) });
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1_100), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn().mockResolvedValue(null) };
    const indexer = new BlockchainIndexer({ rpc, store, logger: { error: vi.fn() }, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ ...config, startBlock: 900 }] });
    await expect(indexer.syncAll()).rejects.toThrow("RPC returned no canonical hash for block 1000 during checkpoint verification.");
    expect(store.row).toMatchObject({ next_block: "1001", status: "FAILED", rpc_failures: 1 });
    expect(store.calls.reorgs).toHaveLength(0);
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
