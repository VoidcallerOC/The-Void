import { describe, expect, it, vi } from "vitest";
import { loadIndexerConfig } from "./config.js";
import { reportIndexedContracts } from "./indexer-contracts.js";
import { IndexerLeaseError, ProductionIndexerWorker } from "./indexer-worker.js";

const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";

function config(overrides = {}) {
  return {
    chainId: 43113,
    contracts: [{ chainId: 43113, address: contract, contractType: "ERC1155", startBlock: 100 }],
    pollIntervalMs: 1,
    ownershipReconciliationIntervalMs: 1,
    leaseTtlMs: 60_000,
    ...overrides,
  };
}

function store(overrides = {}) {
  return {
    acquireWorkerLease: vi.fn().mockResolvedValue({ lease_key: "voidcaller-indexer" }),
    heartbeatWorkerLease: vi.fn().mockResolvedValue({ lease_key: "voidcaller-indexer" }),
    releaseWorkerLease: vi.fn().mockResolvedValue(),
    getPendingRebuildJob: vi.fn().mockResolvedValue(null),
    rebuildDerivedState: vi.fn().mockResolvedValue({ replayedMarketplaceEvents: 0 }),
    listOwnershipReconciliationTargets: vi.fn().mockResolvedValue([]),
    getOwnership: vi.fn().mockResolvedValue({ amount: "1" }),
    recordIndexerError: vi.fn().mockResolvedValue(),
    reconcileOwnership: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("production indexer worker", () => {
  it("starts cleanly, obtains an exclusive lease, syncs, and releases safely", async () => {
    const indexer = { syncAll: vi.fn().mockResolvedValue([{ state: "CONFIRMED" }]), retryOptions: { retries: 0 } };
    const durableStore = store();
    const worker = new ProductionIndexerWorker({ indexer, store: durableStore, rpc: {}, config: config(), ownerId: "worker-a", logger, now: () => 1 });
    await expect(worker.runOnce()).resolves.toMatchObject({ sync: [{ state: "CONFIRMED" }], ownershipChecks: 0 });
    expect(durableStore.acquireWorkerLease).toHaveBeenCalledWith({ ownerId: "worker-a", ttlMs: 60_000 });
    expect(durableStore.heartbeatWorkerLease).toHaveBeenCalledWith({ ownerId: "worker-a" });
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledWith({ ownerId: "worker-a" });
  });

  it("can restart after a completed or killed worker releases the lease", async () => {
    const durableStore = store();
    const first = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn().mockResolvedValue([]), retryOptions: {} }, store: durableStore, rpc: {}, config: config(), ownerId: "worker-a", logger });
    const second = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn().mockResolvedValue([]), retryOptions: {} }, store: durableStore, rpc: {}, config: config(), ownerId: "worker-b", logger });
    await first.runOnce();
    await second.runOnce();
    expect(durableStore.acquireWorkerLease).toHaveBeenCalledTimes(2);
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledTimes(2);
  });

  it("refuses concurrent workers when the database lease is held", async () => {
    const durableStore = store({ acquireWorkerLease: vi.fn().mockResolvedValue(null) });
    const worker = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn(), retryOptions: {} }, store: durableStore, rpc: {}, config: config(), logger });
    await expect(worker.runOnce()).rejects.toBeInstanceOf(IndexerLeaseError);
    expect(durableStore.releaseWorkerLease).not.toHaveBeenCalled();
  });

  it("executes pending reorg rebuilds before and after synchronization", async () => {
    const pending = { chain_id: 43113, from_block: 100 };
    const durableStore = store({ getPendingRebuildJob: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(null), rebuildDerivedState: vi.fn().mockResolvedValue({ chainId: 43113, replayedMarketplaceEvents: 3 }) });
    const worker = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn().mockResolvedValue([]), retryOptions: {} }, store: durableStore, rpc: {}, config: config(), logger });
    await expect(worker.runOnce()).resolves.toMatchObject({ rebuilt: [{ replayedMarketplaceEvents: 3 }] });
    expect(durableStore.rebuildDerivedState).toHaveBeenCalledWith({ chainId: 43113 });
  });

  it("records ownership reconciliation on its configured schedule and repairs a mismatch", async () => {
    const durableStore = store({ listOwnershipReconciliationTargets: vi.fn().mockResolvedValue([{ token_id: "7", wallet_address: wallet }]), getOwnership: vi.fn().mockResolvedValue({ amount: "1" }) });
    const rpc = { getBalanceOf: vi.fn().mockResolvedValue(2n) };
    let clock = 10;
    const worker = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn().mockResolvedValue([]), retryOptions: { retries: 0 } }, store: durableStore, rpc, config: config({ ownershipReconciliationIntervalMs: 100 }), logger, now: () => clock });
    await worker.runOnce();
    expect(durableStore.reconcileOwnership).toHaveBeenCalledWith(expect.objectContaining({ chainId: 43113, contractAddress: contract, wallet, tokenId: "7", amount: "2" }));
    clock += 10;
    await worker.runOnce();
    expect(rpc.getBalanceOf).toHaveBeenCalledTimes(1);
  });

  it("releases its lease after a synchronization/database failure", async () => {
    const failure = new Error("database write failed");
    const durableStore = store();
    const worker = new ProductionIndexerWorker({ indexer: { syncAll: vi.fn().mockRejectedValue(failure), retryOptions: {} }, store: durableStore, rpc: {}, config: config(), logger });
    await expect(worker.runOnce()).rejects.toBe(failure);
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledOnce();
  });

  it("stops a continuous worker safely after the active cycle", async () => {
    const durableStore = store();
    let worker;
    const indexer = { retryOptions: {}, syncAll: vi.fn(async () => { worker.stop(); return []; }) };
    worker = new ProductionIndexerWorker({ indexer, store: durableStore, rpc: {}, config: config(), logger });
    await expect(worker.start()).resolves.toBeUndefined();
    expect(indexer.syncAll).toHaveBeenCalledOnce();
    expect(durableStore.releaseWorkerLease).toHaveBeenCalledOnce();
  });
});

describe("indexer worker configuration", () => {
  it("requires explicit RPC and contract configuration and restricts production to Fuji", () => {
    expect(() => loadIndexerConfig({}, { requireConfiguration: true })).toThrow(/INDEXER_RPC_URL/);
    expect(() => loadIndexerConfig({ NODE_ENV: "production", INDEXER_CHAIN_ID: "43114", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ chainId: 43114, address: contract, contractType: "ERC1155", startBlock: 1 }]) })).toThrow(/Fuji/);
  });

  it("validates explicit Fuji contract configuration without inventing deployment data", () => {
    const result = loadIndexerConfig({ INDEXER_CHAIN_ID: "43113", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ chainId: 43113, address: contract, contractType: "ERC1155", startBlock: 123 }]) });
    expect(result).toMatchObject({ chainId: 43113, contracts: [{ address: contract, contractType: "ERC1155", startBlock: 123 }] });
    expect(result.contracts[0].eventTopics.TransferSingle).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.contracts[0].skipMintOperators).toEqual([]);
  });

  it("indexes the ERC1155 release and the primary sale together", () => {
    const sale = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const result = loadIndexerConfig({ INDEXER_CHAIN_ID: "43113", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ chainId: 43113, address: contract, contractType: "ERC1155", startBlock: 10 }, { chainId: 43113, address: sale, contractType: "PRIMARY_SALE", tokenAddress: contract, startBlock: 11 }]) });
    expect(result.contracts[0]).toMatchObject({ contractType: "ERC1155", skipMintOperators: [sale] });
    expect(result.contracts[1]).toMatchObject({ contractType: "PRIMARY_SALE", tokenAddress: contract, address: sale });
    expect(result.contracts[1].eventTopics.Purchased).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => loadIndexerConfig({ INDEXER_CHAIN_ID: "43113", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", startBlock: 11 }]) })).toThrow(/tokenAddress/);
  });

  it("reports both the ERC1155 release and the primary sale on readiness", () => {
    const sale = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ready = reportIndexedContracts({
      configured: [{ address: contract, contractType: "ERC1155" }, { address: sale, contractType: "PRIMARY_SALE" }],
      indexed: [{ address: contract, type: "ERC1155", status: "IDLE" }, { address: sale, type: "PRIMARY_SALE", status: "RUNNING" }],
    });
    expect(ready.ok).toBe(true);
    expect(ready.release).toMatchObject({ contractType: "ERC1155", healthy: true, address: contract });
    expect(ready.primarySale).toMatchObject({ contractType: "PRIMARY_SALE", healthy: true, address: sale });
    expect(reportIndexedContracts({ configured: [{ address: contract, contractType: "ERC1155" }], indexed: [{ address: contract, type: "ERC1155", status: "IDLE" }] }).ok).toBe(false);
  });
  it("rejects the known placeholder contract address in production configuration", () => {
    expect(() => loadIndexerConfig({ NODE_ENV: "production", INDEXER_CHAIN_ID: "43113", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ chainId: 43113, address: "0x0000000000000000000000000000000000000001", contractType: "MARKETPLACE", startBlock: 0 }]) })).toThrow(/placeholder contract address/);
  });
});
