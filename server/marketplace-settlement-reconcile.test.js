import { describe, expect, it, vi } from "vitest";
import { BlockchainIndexer } from "./indexer.js";
import { marketplaceInterface } from "./marketplace-events.js";
import { SubmittedTransactionReconciler, normalizeReceiptLog } from "./marketplace-settlement-reconcile.js";
import { ProductionIndexerWorker } from "./indexer-worker.js";

const chainId = 43114;
const marketplace = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const retainedMarketplace = "0xcccccccccccccccccccccccccccccccccccccccc";
const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const tx = `0x${"1".repeat(64)}`;
const otherTx = `0x${"5".repeat(64)}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const hash32 = (seed) => `0x${String(seed).repeat(64).slice(0, 64)}`;
const blockFor = (number) => ({ number, hash: hash32(number % 10), parentHash: hash32((number - 1) % 10), timestamp: 1_700_000_000 + number });

function receiptLog(name, args, { address = marketplace, blockNumber = 100, logIndex = 4, transactionHash = tx } = {}) {
  const encoded = marketplaceInterface.encodeEventLog(name, args);
  return { address, transactionHash, blockNumber: hex(blockNumber), blockHash: blockFor(blockNumber).hash, logIndex: hex(logIndex), topics: encoded.topics, data: encoded.data };
}
const soldLog = (overrides = {}) => receiptLog("ListingSold", [7, buyer, seller, token, 12, 2, 50, 5, 3], overrides);
const createdLog = (overrides = {}) => receiptLog("ListingCreated", [9, seller, token, 12, 4, 25, 0], overrides);

function receipt({ status = "0x1", blockNumber = 100, logs = [soldLog()], to = marketplace, transactionHash = tx } = {}) {
  return { transactionHash, status, blockNumber: hex(blockNumber), blockHash: blockFor(blockNumber).hash, to, logs };
}

function storeDouble({ submitted = [] } = {}) {
  const events = new Map();
  const projections = new Map();
  const blocks = new Map();
  const transactions = new Map(submitted.map((row) => [row.transaction_hash, { status: "SUBMITTED", transaction_type: "PURCHASE", chain_id: chainId, to_address: marketplace, ...row }]));
  return {
    events, projections, blocks, transactions,
    listSubmittedMarketplaceTransactions: vi.fn(async ({ marketplaceAddresses, limit }) => [...transactions.values()].filter((row) => row.status === "SUBMITTED" && marketplaceAddresses.includes(row.to_address)).slice(0, limit)),
    getBlock: vi.fn(async ({ blockNumber }) => blocks.get(blockNumber) || null),
    recordBlock: vi.fn(async (value) => { blocks.set(value.blockNumber, { block_hash: value.blockHash, ...value }); }),
    recordEvent: vi.fn(async (event) => {
      const key = `${event.contractAddress}:${event.transactionHash}:${event.logIndex}`;
      if (events.has(key)) return null;
      events.set(key, event);
      return event;
    }),
    applyMarketplaceEvent: vi.fn(async (event) => {
      const key = `${event.marketplaceAddress}:${event.transactionHash}:${event.logIndex}`;
      if (projections.has(key)) return { duplicate: true };
      projections.set(key, event);
      if (event.eventType === "ListingSold" || event.eventType === "ListingCreated") transactions.set(event.transactionHash, { ...(transactions.get(event.transactionHash) || {}), status: "CONFIRMED", block_number: event.blockNumber });
      return { duplicate: false, event };
    }),
    reconcileMarketplaceTransaction: vi.fn(async ({ transactionHash, state, receipt: observed }) => {
      transactions.set(transactionHash, { ...(transactions.get(transactionHash) || {}), status: state, block_number: observed?.blockNumber ?? null });
      return { state };
    }),
    recordIndexerError: vi.fn(async () => {}),
    getCheckpoint: vi.fn(async () => null),
    setCheckpoint: vi.fn(async (value) => value),
    handleReorg: vi.fn(async () => {}),
  };
}

function rpcDouble({ receipts = {}, latest = 200, blocks = blockFor } = {}) {
  return {
    getTransactionReceipt: vi.fn(async ({ transactionHash }) => receipts[transactionHash] ?? null),
    getBlockNumber: vi.fn(async () => latest),
    getBlock: vi.fn(async (_chainId, number) => blocks(number)),
    getLogs: vi.fn(async () => []),
  };
}

const marketplaceConfig = (address = marketplace) => ({ chainId, address, contractType: "MARKETPLACE", startBlock: 0, platformFeeBps: null, reconcileListings: false });
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function reconciler({ store, rpc, configs = [marketplaceConfig()], confirmations = 12, ...rest } = {}) {
  const indexer = new BlockchainIndexer({ rpc, store, configs, confirmations, logger });
  return { indexer, reconciler: new SubmittedTransactionReconciler({ indexer, store, rpc, chainId, confirmations, logger, retryOptions: { retries: 0 }, ...rest }) };
}

describe("transaction-targeted settlement reconciliation", () => {
  it("normalizes raw receipt logs into the numeric shape the indexer expects", () => {
    expect(normalizeReceiptLog({ address: marketplace.toUpperCase(), blockNumber: "0x64", logIndex: "0x4", transactionHash: tx.toUpperCase(), blockHash: hash32(0).toUpperCase(), topics: [], data: "0x" })).toMatchObject({ address: marketplace, blockNumber: 100, logIndex: 4, transactionHash: tx, blockHash: hash32(0) });
    expect(() => normalizeReceiptLog({ blockNumber: "0x-1" })).toThrow();
  });

  it("settles a confirmed purchase from its receipt without waiting for the block cycle, and the later sequential pass is a no-op", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt() }, latest: 112 });
    const { indexer, reconciler: target } = reconciler({ store, rpc });
    // The sequential checkpoint for the marketplace has not moved at all.
    expect(store.setCheckpoint).not.toHaveBeenCalled();
    await expect(target.run()).resolves.toMatchObject({ checked: 1, settled: 1, errors: 0 });
    expect(store.transactions.get(tx)).toMatchObject({ status: "CONFIRMED", block_number: 100 });
    expect(store.applyMarketplaceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "ListingSold", listingId: "7", buyerWallet: buyer, transactionHash: tx, blockNumber: 100, logIndex: 4 }));
    expect(store.recordBlock).toHaveBeenCalledWith(expect.objectContaining({ chainId, blockNumber: 100, blockHash: blockFor(100).hash }));
    expect(store.setCheckpoint).not.toHaveBeenCalled();
    expect(rpc.getLogs).not.toHaveBeenCalled();
    // Exactly the receipt, the head and the block were read; no scan.
    expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(rpc.getBlock).toHaveBeenCalledTimes(1);

    // The sequential indexer later reaches block 100 with the same log: recorded once, projected once.
    const sequentialLog = { ...normalizeReceiptLog(soldLog()) };
    await expect(indexer.processLog(marketplaceConfig(), sequentialLog, blockFor(100))).resolves.toMatchObject({ duplicate: true, eventType: "ListingSold", projectionApplied: false });
    expect(store.events.size).toBe(1);
    expect(store.projections.size).toBe(1);
  });

  it("is idempotent across repeated passes: duplicate delivery never double-applies", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt() }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    await target.run();
    // Simulate the row still being SUBMITTED on the next listing (e.g. a lost write race) and re-run.
    store.transactions.set(tx, { ...store.transactions.get(tx), status: "SUBMITTED" });
    await expect(target.run()).resolves.toMatchObject({ checked: 1, settled: 1 });
    expect(store.applyMarketplaceEvent).toHaveBeenCalledTimes(2);
    expect(store.projections.size).toBe(1);
    expect(store.events.size).toBe(1);
  });

  it("waits for the indexer's confirmation depth before settling and keeps a receipt-less transaction pending", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }, { transaction_hash: otherTx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt({ blockNumber: 100 }) }, latest: 105 });
    const { reconciler: target } = reconciler({ store, rpc, confirmations: 12 });
    await expect(target.run()).resolves.toMatchObject({ checked: 2, awaitingConfirmations: 1, pending: 1, settled: 0 });
    expect(store.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(store.transactions.get(tx).status).toBe("SUBMITTED");
    expect(store.transactions.get(otherTx).status).toBe("SUBMITTED");
    rpc.getBlockNumber.mockResolvedValue(112);
    await expect(target.run()).resolves.toMatchObject({ settled: 1, pending: 1 });
    expect(store.transactions.get(tx).status).toBe("CONFIRMED");
  });

  it("marks a reverted transaction FAILED only once it is confirmed and never projects its logs", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt({ status: "0x0", logs: [] }) }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    await expect(target.run()).resolves.toMatchObject({ failed: 1 });
    expect(store.reconcileMarketplaceTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId, transactionHash: tx, state: "FAILED", receipt: expect.objectContaining({ blockNumber: 100 }) }));
    expect(store.transactions.get(tx).status).toBe("FAILED");
    expect(store.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(store.recordBlock).not.toHaveBeenCalled();
  });

  it("leaves a replaced or dropped submission alone: no receipt means no state change", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: {}, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    for (let pass = 0; pass < 3; pass += 1) await expect(target.run()).resolves.toMatchObject({ pending: 1 });
    expect(store.transactions.get(tx).status).toBe("SUBMITTED");
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
  });

  it("survives a missing or failing RPC response and settles on the next pass", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt() }, latest: 150 });
    rpc.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error("RPC HTTP 503"), { status: 503 }));
    const { reconciler: target } = reconciler({ store, rpc });
    await expect(target.run()).resolves.toMatchObject({ errors: 1, settled: 0 });
    expect(store.transactions.get(tx).status).toBe("SUBMITTED");
    expect(logger.warn).toHaveBeenCalledWith("indexer.settlement.reconcile.failed", expect.objectContaining({ transactionHash: tx, attempts: 1 }));
    await expect(target.run()).resolves.toMatchObject({ settled: 1, errors: 0 });
    expect(store.transactions.get(tx).status).toBe("CONFIRMED");
  });

  it("refuses a receipt whose block is not canonical or contradicts a recorded block, and leaves reorg handling to the sequential pass", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const forked = { ...receipt(), blockHash: hash32(9) };
    const rpc = rpcDouble({ receipts: { [tx]: forked }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    await expect(target.run()).resolves.toMatchObject({ skipped: 1, settled: 0 });
    expect(store.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(store.handleReorg).not.toHaveBeenCalled();
    expect(store.setCheckpoint).not.toHaveBeenCalled();

    // A block already recorded under another hash is a reorg the sequential pass owns.
    const recorded = storeDouble({ submitted: [{ transaction_hash: tx }] });
    recorded.blocks.set(100, { block_hash: hash32(8) });
    const { reconciler: second } = reconciler({ store: recorded, rpc: rpcDouble({ receipts: { [tx]: receipt() }, latest: 150 }) });
    await expect(second.run()).resolves.toMatchObject({ skipped: 1 });
    expect(recorded.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(recorded.handleReorg).not.toHaveBeenCalled();
  });

  it("verifies chain, destination and event address: a receipt for another contract is never projected", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt({ to: token, logs: [soldLog({ address: token })] }) }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    await expect(target.run()).resolves.toMatchObject({ skipped: 1 });
    expect(store.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(store.transactions.get(tx).status).toBe("SUBMITTED");
    // A submission for a marketplace this indexer does not configure is ignored outright.
    const foreign = storeDouble({ submitted: [{ transaction_hash: tx, to_address: retainedMarketplace }] });
    const { reconciler: unconfigured } = reconciler({ store: foreign, rpc: rpcDouble({ receipts: { [tx]: receipt() }, latest: 150 }) });
    await expect(unconfigured.run()).resolves.toMatchObject({ checked: 0 });
    expect(foreign.listSubmittedMarketplaceTransactions).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddresses: [marketplace] }));
    expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("projects only the marketplace's own logs from a mixed receipt, in log order, and ignores token transfers", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    const transfer = { address: token, transactionHash: tx, blockNumber: hex(100), blockHash: blockFor(100).hash, logIndex: hex(2), topics: [`0x${"ab".repeat(32)}`], data: "0x" };
    const settled = { ...receiptLog("SaleSettled", [7, 1, seller, 42], { logIndex: 5 }) };
    const rpc = rpcDouble({ receipts: { [tx]: receipt({ logs: [settled, transfer, soldLog({ logIndex: 4 })] }) }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc });
    await expect(target.run()).resolves.toMatchObject({ settled: 1 });
    expect(store.recordEvent.mock.calls.map(([event]) => [event.eventType, event.logIndex])).toEqual([["ListingSold", 4], ["SaleSettled", 5]]);
    expect(store.applyMarketplaceEvent).toHaveBeenCalledTimes(1);
  });

  it("serves several marketplaces and bounds the RPC work per pass", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }, { transaction_hash: otherTx, to_address: retainedMarketplace, transaction_type: "LISTING_CREATE" }] });
    const rpc = rpcDouble({ receipts: { [tx]: receipt(), [otherTx]: receipt({ transactionHash: otherTx, to: retainedMarketplace, blockNumber: 101, logs: [createdLog({ address: retainedMarketplace, transactionHash: otherTx, blockNumber: 101, logIndex: 1 })] }) }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc, configs: [marketplaceConfig(), marketplaceConfig(retainedMarketplace)], batchSize: 1 });
    await expect(target.run()).resolves.toMatchObject({ checked: 1, settled: 1 });
    expect(store.listSubmittedMarketplaceTransactions).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddresses: [marketplace, retainedMarketplace], limit: 1 }));
    await expect(target.run()).resolves.toMatchObject({ checked: 1, settled: 1 });
    expect(store.transactions.get(tx).status).toBe("CONFIRMED");
    expect(store.transactions.get(otherTx).status).toBe("CONFIRMED");
    expect(store.applyMarketplaceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "ListingCreated", marketplaceAddress: retainedMarketplace, listingId: "9" }));
    // One head read per pass, shared by every transaction in it.
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it("gives up on a transaction whose projection keeps failing instead of retrying it forever", async () => {
    const store = storeDouble({ submitted: [{ transaction_hash: tx }] });
    store.applyMarketplaceEvent.mockRejectedValue(new Error("Marketplace lifecycle event references an unknown listing."));
    const rpc = rpcDouble({ receipts: { [tx]: receipt() }, latest: 150 });
    const { reconciler: target } = reconciler({ store, rpc, maxAttempts: 2 });
    await expect(target.run()).resolves.toMatchObject({ errors: 1 });
    await expect(target.run()).resolves.toMatchObject({ errors: 1 });
    await expect(target.run()).resolves.toMatchObject({ checked: 0, skipped: 1, errors: 0 });
    expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it("is disabled cleanly when the store or indexer cannot support it", async () => {
    const store = storeDouble();
    delete store.listSubmittedMarketplaceTransactions;
    const { reconciler: target } = reconciler({ store, rpc: rpcDouble() });
    await expect(target.run()).resolves.toMatchObject({ disabled: true, checked: 0 });
    const { reconciler: noMarketplace } = reconciler({ store: storeDouble(), rpc: rpcDouble(), configs: [{ chainId, address: token, contractType: "ERC1155", startBlock: 0, eventTopics: {} }] });
    await expect(noMarketplace.run()).resolves.toMatchObject({ disabled: true });
  });
});

describe("worker settlement loop", () => {
  const workerConfig = (overrides = {}) => ({ chainId, contracts: [marketplaceConfig()], pollIntervalMs: 5, settlementReconcileIntervalMs: 1, ownershipReconciliationIntervalMs: 1, leaseTtlMs: 60_000, ...overrides });
  const leaseStore = () => ({
    acquireWorkerLease: vi.fn().mockResolvedValue({ lease_key: "voidcaller-indexer" }),
    heartbeatWorkerLease: vi.fn().mockResolvedValue({ lease_key: "voidcaller-indexer" }),
    releaseWorkerLease: vi.fn().mockResolvedValue(),
    getPendingRebuildJob: vi.fn().mockResolvedValue(null),
    listOwnershipReconciliationTargets: vi.fn().mockResolvedValue([]),
  });

  it("settles a submitted purchase between block cycles, on its own tick, while a long cycle is still running", async () => {
    const durableStore = leaseStore();
    let worker;
    let releaseCycle;
    const cycleGate = new Promise((resolve) => { releaseCycle = resolve; });
    const indexer = { retryOptions: {}, syncAll: vi.fn(async () => { await cycleGate; worker.stop(); return []; }) };
    const settlement = { run: vi.fn().mockResolvedValueOnce({ checked: 1, settled: 1, errors: 0 }).mockResolvedValue({ checked: 0, settled: 0, errors: 0 }) };
    worker = new ProductionIndexerWorker({ indexer, store: durableStore, rpc: {}, config: workerConfig(), settlement, logger });
    const run = worker.start();
    // The settlement pass completes while syncAll is still blocked.
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("indexer.worker.settlement.completed", expect.objectContaining({ chainId, settled: 1 })));
    expect(indexer.syncAll).toHaveBeenCalledOnce();
    expect(worker.lastSettlement).toMatchObject({ errors: 0 });
    releaseCycle();
    await run;
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledOnce();
    expect(indexer.syncAll).toHaveBeenCalledOnce();
  });

  it("keeps the block cycle alive when a settlement pass throws, and stops with the worker", async () => {
    const durableStore = leaseStore();
    let worker;
    const indexer = { retryOptions: {}, syncAll: vi.fn(async () => { worker.stop(); return []; }) };
    const settlement = { run: vi.fn().mockRejectedValue(new Error("settlement exploded")) };
    worker = new ProductionIndexerWorker({ indexer, store: durableStore, rpc: {}, config: workerConfig(), settlement, logger });
    await worker.start();
    expect(logger.error).toHaveBeenCalledWith("indexer.worker.settlement.failed", expect.objectContaining({ error: "settlement exploded" }));
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledOnce();
    expect(worker.stopping).toBe(true);
  });

  it("runs without a settlement reconciler exactly as before", async () => {
    const durableStore = leaseStore();
    let worker;
    const indexer = { retryOptions: {}, syncAll: vi.fn(async () => { worker.stop(); return []; }) };
    worker = new ProductionIndexerWorker({ indexer, store: durableStore, rpc: {}, config: workerConfig(), logger });
    await expect(worker.start()).resolves.toBeUndefined();
    await expect(worker.reconcileSubmittedTransactions()).resolves.toBeNull();
  });
});
