import { randomUUID } from "node:crypto";
import process from "node:process";
import { loadIndexerConfig, loadServerConfig } from "./config.js";
import { closeDatabasePool, createDatabasePool } from "./db.js";
import { BlockchainIndexer } from "./indexer.js";
import { reconcileOwnership } from "./indexer-reconcile.js";
import { createIndexerStore } from "./indexer-store.js";
import { createJsonRpcClient } from "./indexer-rpc.js";

export class IndexerLeaseError extends Error {
  constructor() {
    super("Another active indexer worker holds the database lease.");
    this.name = "IndexerLeaseError";
    this.code = "INDEXER_LEASE_HELD";
  }
}

export class ProductionIndexerWorker {
  constructor({ indexer, store, rpc, config, ownerId = randomUUID(), logger = console, now = () => Date.now() } = {}) {
    if (!indexer || !store || !rpc || !config) throw new TypeError("ProductionIndexerWorker requires an indexer, store, RPC client, and configuration.");
    this.indexer = indexer;
    this.store = store;
    this.rpc = rpc;
    this.config = config;
    this.ownerId = ownerId;
    this.logger = logger;
    this.now = now;
    this.stopping = false;
    this.started = false;
    this.nextOwnershipReconciliationAt = 0;
    this.lastCycle = null;
    this._wake = null;
  }

  async acquire() {
    const lease = await this.store.acquireWorkerLease?.({ ownerId: this.ownerId, ttlMs: this.config.leaseTtlMs });
    if (this.store.acquireWorkerLease && !lease) throw new IndexerLeaseError();
    this.started = true;
    this.logger.info?.("indexer.worker.acquired", { ownerId: this.ownerId, chainId: this.config.chainId, contracts: this.config.contracts.length });
  }

  async release() {
    if (!this.started) return;
    try { await this.store.releaseWorkerLease?.({ ownerId: this.ownerId }); } catch (error) { this.logger.error?.("indexer.worker.release.failed", { error: error.message }); }
    this.started = false;
  }

  async heartbeat() {
    const heartbeat = await this.store.heartbeatWorkerLease?.({ ownerId: this.ownerId });
    if (this.store.heartbeatWorkerLease && !heartbeat) throw new IndexerLeaseError();
  }

  async runRebuilds() {
    if (!this.store.getPendingRebuildJob || !this.store.rebuildDerivedState) return [];
    const rebuilt = [];
    const job = await this.store.getPendingRebuildJob({ chainId: this.config.chainId });
    if (!job) return rebuilt;
    this.logger.warn?.("indexer.worker.rebuild.started", { chainId: this.config.chainId, fromBlock: job.from_block });
    rebuilt.push(await this.store.rebuildDerivedState({ chainId: this.config.chainId }));
    this.logger.info?.("indexer.worker.rebuild.completed", rebuilt.at(-1));
    return rebuilt;
  }

  async runOwnershipReconciliation({ finalizedBlock = null } = {}) {
    if (this.now() < this.nextOwnershipReconciliationAt) return [];
    if (!this.store.listOwnershipReconciliationTargets) return [];
    const results = [];
    for (const contract of this.config.contracts.filter((item) => item.contractType === "ERC1155")) {
      const targets = await this.store.listOwnershipReconciliationTargets({ chainId: contract.chainId, contractAddress: contract.address });
      for (const target of targets) {
        const blockTag = finalizedBlock === null ? "finalized" : `0x${BigInt(finalizedBlock).toString(16)}`;
        const reconciliation = await reconcileOwnership({ rpc: this.rpc, store: this.store, chainId: contract.chainId, contractAddress: contract.address, assets: [target.token_id], wallets: [target.wallet_address], blockTag, retryOptions: this.indexer.retryOptions });
        results.push(...reconciliation);
      }
    }
    this.nextOwnershipReconciliationAt = this.now() + this.config.ownershipReconciliationIntervalMs;
    return results;
  }

  async cycle() {
    if (this.stopping) return { stopped: true };
    await this.heartbeat();
    const rebuiltBefore = await this.runRebuilds();
    const sync = await this.indexer.syncAll();
    const rebuiltAfter = await this.runRebuilds();
    const finalizedBlocks = sync.map((result) => Number(result.finalizedBlock)).filter(Number.isSafeInteger);
    const ownership = await this.runOwnershipReconciliation({ finalizedBlock: finalizedBlocks.length ? Math.min(...finalizedBlocks) : null });
    this.lastCycle = { completedAt: new Date(this.now()).toISOString(), sync, rebuilt: [...rebuiltBefore, ...rebuiltAfter], ownershipChecks: ownership.length };
    this.logger.info?.("indexer.worker.cycle.completed", { chainId: this.config.chainId, contracts: sync.length, rebuilt: this.lastCycle.rebuilt.length, ownershipChecks: ownership.length });
    return this.lastCycle;
  }

  async runOnce() {
    await this.acquire();
    try { return await this.cycle(); } finally { await this.release(); }
  }

  async waitForNextCycle() {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this._wake = null; resolve(); }, this.config.pollIntervalMs);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  async start() {
    await this.acquire();
    try {
      while (!this.stopping) {
        try { await this.cycle(); } catch (error) {
          if (error instanceof IndexerLeaseError) throw error;
          this.logger.error?.("indexer.worker.cycle.failed", { chainId: this.config.chainId, error: error.message });
        }
        if (!this.stopping) await this.waitForNextCycle();
      }
    } finally { await this.release(); }
  }

  stop() {
    this.stopping = true;
    this._wake?.();
  }
}

export function createProductionIndexerWorker({ serverConfig = loadServerConfig(), indexerConfig = loadIndexerConfig(), pool = null, rpc = null, store = null, logger = console } = {}) {
  const resolvedPool = pool || createDatabasePool(serverConfig);
  const resolvedStore = store || createIndexerStore(resolvedPool);
  const resolvedRpc = rpc || createJsonRpcClient({ url: indexerConfig.rpcUrl, timeoutMs: indexerConfig.rpcTimeoutMs });
  const indexer = new BlockchainIndexer({ rpc: resolvedRpc, store: resolvedStore, configs: indexerConfig.contracts, confirmations: indexerConfig.confirmations, chunkSize: indexerConfig.chunkSize, retryOptions: { retries: indexerConfig.rpcRetries, baseDelayMs: indexerConfig.retryBaseDelayMs }, logger });
  const worker = new ProductionIndexerWorker({ indexer, store: resolvedStore, rpc: resolvedRpc, config: indexerConfig, logger });
  indexer.onProgress = () => worker.heartbeat();
  return { worker, pool: resolvedPool };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { worker, pool } = createProductionIndexerWorker();
  const shutdown = () => worker.stop();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  worker.start().catch((error) => {
    console.error(JSON.stringify({ event: "indexer.worker.fatal", code: error.code || "INDEXER_WORKER_FATAL", error: error.message }));
    process.exitCode = 1;
  }).finally(async () => { await closeDatabasePool(pool); });
}
