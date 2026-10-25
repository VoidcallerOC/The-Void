import { randomUUID } from "node:crypto";
import process from "node:process";
import { DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE, loadIndexerConfig, loadServerConfig } from "./config.js";
import { closeDatabasePool, createDatabasePool } from "./db.js";
import { BlockchainIndexer } from "./indexer.js";
import { reconcileOwnership } from "./indexer-reconcile.js";
import { createIndexerStore } from "./indexer-store.js";
import { createJsonRpcClient } from "./indexer-rpc.js";
import { SubmittedTransactionReconciler } from "./marketplace-settlement-reconcile.js";

export class IndexerLeaseError extends Error {
  constructor() {
    super("Another active indexer worker holds the database lease.");
    this.name = "IndexerLeaseError";
    this.code = "INDEXER_LEASE_HELD";
  }
}

function isRateLimitFailure(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  return /RPC HTTP 429/i.test(String(error.message || ""));
}

export function rateLimitCooldownMs(error, config) {
  const maxDelay = Math.max(1, Number(config?.retryMaxDelayMs) || 60_000);
  const configuredFloor = Math.max(
    Number(config?.rpcRateLimitCooldownMs) || 45_000,
    Number(config?.pollIntervalMs) || 15_000,
    Number(config?.retryBaseDelayMs) || 250,
  );
  // Only honor Retry-After when the transport actually attached a finite value.
  // Number(null) === 0 would incorrectly collapse the cooldown to zero.
  const rawRetryAfter = error?.retryAfterMs;
  const retryAfterMs = rawRetryAfter == null || rawRetryAfter === "" ? NaN : Number(rawRetryAfter);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(maxDelay, Math.max(configuredFloor, retryAfterMs));
  }
  return Math.min(maxDelay, configuredFloor);
}

export class ProductionIndexerWorker {
  constructor({ indexer, store, rpc, config, settlement = null, ownerId = randomUUID(), logger = console, now = () => Date.now() } = {}) {
    if (!indexer || !store || !rpc || !config) throw new TypeError("ProductionIndexerWorker requires an indexer, store, RPC client, and configuration.");
    this.indexer = indexer;
    // Optional transaction-targeted settlement reconciler; runs on its own short tick beside the block cycle.
    this.settlement = settlement;
    this.lastSettlement = null;
    this._wakeSettlement = null;
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
    this._cycleInFlight = false;
    this._nextCycleNotBefore = 0;
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
    if (this._cycleInFlight) {
      this.logger.warn?.("indexer.worker.cycle.skipped", { chainId: this.config.chainId, reason: "in_flight" });
      return { skipped: true, reason: "in_flight" };
    }
    this._cycleInFlight = true;
    try {
      await this.heartbeat();
      const rebuiltBefore = await this.runRebuilds();
      const sync = await this.indexer.syncAll();
      const rebuiltAfter = await this.runRebuilds();
      const catchingUp = sync.filter((result) => result?.partial === true);
      const finalizedBlocks = sync.map((result) => Number(result.finalizedBlock)).filter(Number.isSafeInteger);
      // Ownership is compared against one finalized block, so it runs only once every contract has reached the
      // same target this cycle. While any contract is still catching up (per-cycle chunk budget), or the
      // contracts report different finalized heights, the comparison is deferred to a later cycle.
      const deferOwnership = catchingUp.length > 0 || new Set(finalizedBlocks).size > 1;
      const ownership = deferOwnership ? [] : await this.runOwnershipReconciliation({ finalizedBlock: finalizedBlocks.length ? Math.min(...finalizedBlocks) : null });
      if (deferOwnership) {
        this.logger.info?.("indexer.worker.ownership.deferred", {
          chainId: this.config.chainId,
          finalizedBlocks: [...new Set(finalizedBlocks)],
          catchingUp: catchingUp.map((result) => ({ address: result.address, nextBlock: result.nextBlock, targetBlock: result.targetBlock, remainingBlocks: result.remainingBlocks })),
        });
      }
      this.lastCycle = { completedAt: new Date(this.now()).toISOString(), sync, rebuilt: [...rebuiltBefore, ...rebuiltAfter], ownershipChecks: ownership.length, catchingUp: catchingUp.length, ownershipDeferred: deferOwnership };
      this._nextCycleNotBefore = 0;
      this.logger.info?.("indexer.worker.cycle.completed", { chainId: this.config.chainId, contracts: sync.length, catchingUp: catchingUp.length, rebuilt: this.lastCycle.rebuilt.length, ownershipChecks: ownership.length, ownershipDeferred: deferOwnership });
      return this.lastCycle;
    } catch (error) {
      if (isRateLimitFailure(error)) {
        const cooldownMs = rateLimitCooldownMs(error, this.config);
        this._nextCycleNotBefore = this.now() + cooldownMs;
        this.logger.warn?.("indexer.worker.cycle.rate_limited", { chainId: this.config.chainId, cooldownMs, retryAfterMs: error.retryAfterMs ?? null, error: error.message });
      }
      throw error;
    } finally {
      this._cycleInFlight = false;
    }
  }

  async runOnce() {
    await this.acquire();
    try { return await this.cycle(); } finally { await this.release(); }
  }

  async waitForNextCycle() {
    const rateLimitWait = Math.max(0, this._nextCycleNotBefore - this.now());
    const delay = Math.max(this.config.pollIntervalMs, rateLimitWait);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this._wake = null; resolve(); }, delay);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  async waitForSettlementTick() {
    const delay = Math.max(1, Number(this.config.settlementReconcileIntervalMs) || 5_000);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this._wakeSettlement = null; resolve(); }, delay);
      this._wakeSettlement = () => { clearTimeout(timer); this._wakeSettlement = null; resolve(); };
    });
  }

  /** One settlement pass. Safe to call while a block cycle is in flight: both go through the same serialized RPC pacer. */
  async reconcileSubmittedTransactions() {
    if (!this.settlement) return null;
    const result = await this.settlement.run();
    this.lastSettlement = { completedAt: new Date(this.now()).toISOString(), ...result };
    if (result && (result.checked || result.errors)) this.logger.info?.("indexer.worker.settlement.completed", { chainId: this.config.chainId, ...result });
    return result;
  }

  async runSettlementLoop() {
    if (!this.settlement) return;
    while (!this.stopping) {
      try { await this.reconcileSubmittedTransactions(); } catch (error) {
        if (error instanceof IndexerLeaseError) throw error;
        this.logger.error?.("indexer.worker.settlement.failed", { chainId: this.config.chainId, error: error.message });
      }
      if (!this.stopping) await this.waitForSettlementTick();
    }
  }

  async waitForLease() {
    await new Promise((resolve) => {
      const delay = Math.max(1, Math.min(this.config.pollIntervalMs, this.config.leaseTtlMs));
      const timer = setTimeout(() => { this._wake = null; resolve(); }, delay);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  async start() {
    while (!this.stopping) {
      try {
        await this.acquire();
      } catch (error) {
        if (!(error instanceof IndexerLeaseError)) throw error;
        const retryInMs = Math.max(1, Math.min(this.config.pollIntervalMs, this.config.leaseTtlMs));
        this.logger.warn?.("indexer.worker.lease.waiting", { ownerId: this.ownerId, chainId: this.config.chainId, retryInMs });
        await this.waitForLease();
        continue;
      }
      break;
    }
    if (this.stopping) {
      await this.release();
      return { stopped: true };
    }
    // The settlement loop runs beside the block cycle (the RPC pacer serializes their calls) and ends with it.
    const settlementLoop = this.runSettlementLoop().catch((error) => { this.logger.error?.("indexer.worker.settlement.stopped", { chainId: this.config.chainId, error: error.message }); });
    try {
      while (!this.stopping) {
        try { await this.cycle(); } catch (error) {
          if (error instanceof IndexerLeaseError) throw error;
          this.logger.error?.("indexer.worker.cycle.failed", { chainId: this.config.chainId, error: error.message });
        }
        if (!this.stopping) await this.waitForNextCycle();
      }
    } finally {
      this.stopping = true;
      this._wakeSettlement?.();
      await settlementLoop;
      await this.release();
    }
  }

  stop() {
    this.stopping = true;
    this._wake?.();
    this._wakeSettlement?.();
  }
}

export function createProductionIndexerWorker({ serverConfig = loadServerConfig(process.env, { requireWalletAuth: false }), indexerConfig = loadIndexerConfig(), pool = null, rpc = null, store = null, logger = console } = {}) {
  const resolvedPool = pool || createDatabasePool(serverConfig);
  const resolvedStore = store || createIndexerStore(resolvedPool);
  // Populated after the worker exists so long pacer waits can heartbeat the lease.
  const pacerHooks = { onWait: null };
  const resolvedRpc = rpc || createJsonRpcClient({
    url: indexerConfig.rpcUrl,
    timeoutMs: indexerConfig.rpcTimeoutMs,
    minIntervalMs: indexerConfig.rpcMinIntervalMs ?? 5_000,
    rateLimitCooldownMs: indexerConfig.rpcRateLimitCooldownMs ?? 45_000,
    maxDelayMs: indexerConfig.retryMaxDelayMs ?? 60_000,
    postRateLimitIntervalMs: indexerConfig.rpcPostRateLimitIntervalMs ?? 10_000,
    onWait: (...args) => pacerHooks.onWait?.(...args),
  });
  const retryOptions = {
    retries: indexerConfig.rpcRetries,
    baseDelayMs: indexerConfig.retryBaseDelayMs,
    maxDelayMs: indexerConfig.retryMaxDelayMs ?? 60_000,
    // RPC pacer owns 429 cooldowns; avoid stacking another full Retry-After sleep here.
    deferRateLimitDelay: true,
  };
  const indexer = new BlockchainIndexer({ rpc: resolvedRpc, store: resolvedStore, configs: [...indexerConfig.contracts], confirmations: indexerConfig.confirmations, chunkSize: indexerConfig.chunkSize, maxChunksPerCycle: indexerConfig.maxChunksPerCycle ?? DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE, batchContracts: indexerConfig.batchContracts !== false, retryOptions, logger });
  const settlement = indexerConfig.settlementReconcileEnabled === false ? null : new SubmittedTransactionReconciler({
    indexer,
    store: resolvedStore,
    rpc: resolvedRpc,
    chainId: indexerConfig.chainId,
    confirmations: indexerConfig.confirmations,
    maxAgeMs: indexerConfig.settlementReconcileMaxAgeMs,
    batchSize: indexerConfig.settlementReconcileBatchSize,
    // Resolved per call, so the heartbeat-aware retry options installed below apply to this path too.
    retryOptions: () => indexer.retryOptions,
    logger,
  });
  const worker = new ProductionIndexerWorker({ indexer, store: resolvedStore, rpc: resolvedRpc, config: indexerConfig, settlement, logger });
  indexer.onProgress = () => worker.heartbeat();
  pacerHooks.onWait = ({ waitMs, nextAllowedAt, method = null, priority = false, reason = null }) => {
    // delay in indexer.rpc.retry is only the tiny deferred sleep; this is the real gate. `reason` says which gate
    // (retry_after, post_rate_limit, spacing) and `method` names the waiting call; no payload is logged.
    if (waitMs >= 1_000) {
      logger.info?.(JSON.stringify({
        event: "indexer.rpc.pacer.wait",
        chainId: indexerConfig.chainId,
        waitMs,
        nextAllowedAt,
        method,
        priority,
        reason,
      }));
    }
    return worker.heartbeat();
  };
  // Keep the DB lease alive across long 429 / 5xx backoffs so the worker is not stolen mid-retry.
  indexer.retryOptions = {
    ...indexer.retryOptions,
    onRetry: ({ attempt, delay, error }) => {
      logger.warn?.(JSON.stringify({
        event: "indexer.rpc.retry",
        chainId: indexerConfig.chainId,
        attempt,
        delay,
        delayKind: "deferred_inner_retry",
        method: error?.rpcMethod ?? null,
        status: error?.status ?? null,
        retryAfterMs: error?.retryAfterMs ?? null,
        error: error?.message,
      }));
      return worker.heartbeat();
    },
  };
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


// Compatibility factory used by the deterministic worker tests and legacy startup path.
export function createIndexerWorker({ config, pool = null, logger = console } = {}) {
  const indexerConfig = config?.indexer || config;
  const marketplace = config?.marketplace || { enabled: false, address: null, chainId: null };
  logger.info?.("indexer.marketplace", marketplace.enabled ? { status: "configured", address: marketplace.address, chainId: marketplace.chainId } : { status: "not_configured", address: marketplace.address ?? null, chainId: marketplace.chainId ?? null });
  return {
    async syncOnce() {
      const { worker } = createProductionIndexerWorker({ serverConfig: config, indexerConfig, pool, logger });
      return worker.runOnce();
    }
  };
}
