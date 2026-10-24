import { retry } from "./indexer-utils.js";

/**
 * Transaction-targeted settlement reconciliation.
 *
 * The sequential indexer is the authority for marketplace state, but on mainnet it trails the chain by hours
 * (ten contracts share one RPC pacer, so a 2,000-block catch-up budget per contract per cycle barely keeps pace
 * with ~1 block/s). A purchase, listing or cancellation the UI submitted sits in `transactions` as SUBMITTED until
 * the marketplace checkpoint reaches its block.
 *
 * This reconciler looks only at those submitted rows. For each one it reads the receipt from the same RPC, waits
 * for the indexer's own confirmation depth, verifies the receipt (success, destination = a configured marketplace,
 * block hash = the canonical block at that height, no conflicting block already recorded) and then feeds the
 * marketplace logs of that receipt through the indexer's ordinary `processLog` path. Every write it makes is one
 * the sequential pass would make later: `recordBlock` / `recordEvent` / `applyMarketplaceEvent` are keyed on the
 * block, log and projection markers, so the later sequential pass is a no-op for these logs. Checkpoints are never
 * touched, so no block is skipped and reorg detection stays exactly where it was.
 */

const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const lower = (value) => String(value || "").toLowerCase();

function quantity(value, label) {
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is not a safe block quantity.`);
  return parsed;
}

/** Receipt logs arrive as raw JSON-RPC hex; the indexer expects the numeric shape `rpc.getLogs` produces. */
export function normalizeReceiptLog(log) {
  return {
    ...log,
    address: lower(log.address),
    blockNumber: quantity(log.blockNumber, "log.blockNumber"),
    logIndex: quantity(log.logIndex, "log.logIndex"),
    transactionHash: lower(log.transactionHash),
    blockHash: lower(log.blockHash),
  };
}

export class SubmittedTransactionReconciler {
  constructor({ indexer, store, rpc, chainId, confirmations = 12, maxAgeMs = 86_400_000, batchSize = 10, maxAttempts = 5, retryOptions = {}, logger = console, now = () => Date.now() } = {}) {
    if (!indexer || !store || !rpc || !Number.isSafeInteger(Number(chainId))) throw new TypeError("SubmittedTransactionReconciler requires an indexer, store, RPC client and chain id.");
    this.indexer = indexer;
    this.store = store;
    this.rpc = rpc;
    this.chainId = Number(chainId);
    this.confirmations = Math.max(0, Number(confirmations) || 0);
    this.maxAgeMs = Math.max(1, Number(maxAgeMs) || 86_400_000);
    this.batchSize = Math.max(1, Number(batchSize) || 10);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    // An object, or a function returning the current options (the worker installs heartbeat-aware options later).
    this.retryOptions = retryOptions;
    this.logger = logger;
    this.now = now;
    // Processing failures per hash (unknown listing, projection conflict, ...). Bounded so a row the sequential
    // pass must own is not re-fetched forever; the sequential pass is unaffected either way.
    this.attempts = new Map();
  }

  retryOpts() { return typeof this.retryOptions === "function" ? this.retryOptions() || {} : this.retryOptions || {}; }

  marketplaces() {
    return new Map(
      (this.indexer.configs || [])
        .filter((config) => config.contractType === "MARKETPLACE" && Number(config.chainId) === this.chainId)
        .map((config) => [lower(config.address), config]),
    );
  }

  noteAttempt(hash) {
    const count = (this.attempts.get(hash) || 0) + 1;
    this.attempts.set(hash, count);
    return count;
  }

  async run() {
    const summary = { chainId: this.chainId, checked: 0, settled: 0, pending: 0, awaitingConfirmations: 0, failed: 0, skipped: 0, errors: 0 };
    if (typeof this.store.listSubmittedMarketplaceTransactions !== "function" || typeof this.indexer.processLog !== "function") return { ...summary, disabled: true };
    const marketplaces = this.marketplaces();
    if (!marketplaces.size) return { ...summary, disabled: true };
    const rows = await this.store.listSubmittedMarketplaceTransactions({ chainId: this.chainId, marketplaceAddresses: [...marketplaces.keys()], maxAgeMs: this.maxAgeMs, limit: this.batchSize });
    if (!rows.length) return summary;
    let latest = null;
    const head = async () => {
      if (latest === null) latest = Number(await retry(() => this.rpc.getBlockNumber(this.chainId), this.retryOpts()));
      return latest;
    };
    for (const row of rows) {
      const hash = lower(row.transaction_hash);
      if (!TRANSACTION_HASH.test(hash)) { summary.skipped += 1; continue; }
      if ((this.attempts.get(hash) || 0) >= this.maxAttempts) { summary.skipped += 1; continue; }
      const config = marketplaces.get(lower(row.to_address));
      if (!config) { summary.skipped += 1; continue; }
      summary.checked += 1;
      try {
        const outcome = await this.reconcileOne({ hash, config, head });
        summary[outcome.state] = (summary[outcome.state] || 0) + 1;
        if (outcome.state === "settled" || outcome.state === "failed") {
          this.attempts.delete(hash);
          this.logger.info?.("indexer.settlement.reconciled", { chainId: this.chainId, transactionHash: hash, state: outcome.state, blockNumber: outcome.blockNumber, events: outcome.events ?? 0, transactionType: row.transaction_type });
        }
      } catch (error) {
        summary.errors += 1;
        const attempts = this.noteAttempt(hash);
        this.logger.warn?.("indexer.settlement.reconcile.failed", { chainId: this.chainId, transactionHash: hash, attempts, error: error.message });
      }
    }
    return summary;
  }

  /**
   * One submitted transaction. Returns { state } where state is one of pending (no receipt yet),
   * awaitingConfirmations, failed (reverted on-chain), settled (marketplace logs projected) or skipped.
   */
  async reconcileOne({ hash, config, head }) {
    const receipt = await retry(() => this.rpc.getTransactionReceipt({ chainId: this.chainId, transactionHash: hash }), this.retryOpts());
    if (!receipt) return { state: "pending" };
    if (lower(receipt.transactionHash || hash) !== hash) throw new Error("RPC returned a receipt for a different transaction.");
    const blockNumber = quantity(receipt.blockNumber, "receipt.blockNumber");
    const blockHash = lower(receipt.blockHash);
    if (!/^0x[0-9a-f]{64}$/.test(blockHash)) throw new Error("Receipt block hash is malformed.");
    // Same confirmation policy as the sequential indexer: nothing below `latest - confirmations` is authoritative.
    const latest = await head();
    if (latest - blockNumber < this.confirmations) return { state: "awaitingConfirmations", blockNumber };
    // The destination must be the marketplace the submission named; a receipt for anything else is left to the
    // sequential pass (which only ever projects marketplace logs anyway).
    if (lower(receipt.to) !== lower(config.address)) {
      this.attempts.set(hash, this.maxAttempts);
      this.logger.warn?.("indexer.settlement.destination_mismatch", { chainId: this.chainId, transactionHash: hash, to: lower(receipt.to), expected: lower(config.address) });
      return { state: "skipped", blockNumber };
    }
    const status = lower(receipt.status);
    if (status === "0x0" || status === "0") {
      if (typeof this.store.reconcileMarketplaceTransaction !== "function") return { state: "skipped", blockNumber };
      await this.store.reconcileMarketplaceTransaction({ chainId: this.chainId, transactionHash: hash, state: "FAILED", receipt: { ...receipt, blockNumber, blockHash } });
      return { state: "failed", blockNumber };
    }
    if (status !== "0x1" && status !== "1") throw new Error(`Receipt status ${receipt.status} is not recognised.`);
    // The receipt must sit in the canonical block at its height, and must not contradict a block already recorded
    // (by this path earlier or by the sequential pass). A mismatch is a reorg in progress: the sequential pass owns
    // reorg handling (rewind + rebuild); this path simply waits for the next pass.
    const block = await retry(() => this.rpc.getBlock(this.chainId, blockNumber), this.retryOpts());
    if (!block?.hash || !block.parentHash || lower(block.hash) !== blockHash) {
      this.logger.warn?.("indexer.settlement.block_mismatch", { chainId: this.chainId, transactionHash: hash, blockNumber, receiptBlockHash: blockHash, canonicalBlockHash: lower(block?.hash) || null });
      return { state: "skipped", blockNumber };
    }
    const previous = typeof this.store.getBlock === "function" ? await this.store.getBlock({ chainId: this.chainId, blockNumber }) : null;
    if (previous && lower(previous.block_hash) !== blockHash) {
      this.logger.warn?.("indexer.settlement.recorded_block_mismatch", { chainId: this.chainId, transactionHash: hash, blockNumber, recorded: lower(previous.block_hash), canonical: blockHash });
      return { state: "skipped", blockNumber };
    }
    const logs = (Array.isArray(receipt.logs) ? receipt.logs : [])
      .filter((log) => lower(log?.address) === lower(config.address))
      .map(normalizeReceiptLog)
      .sort((left, right) => left.logIndex - right.logIndex);
    for (const log of logs) {
      if (log.transactionHash !== hash || log.blockHash !== blockHash || log.blockNumber !== blockNumber) throw new Error("Receipt log does not belong to the receipt's transaction and block.");
    }
    if (!logs.length) {
      // A successful call into the marketplace that emitted nothing for it has nothing to settle; leave the row to
      // the sequential pass and stop re-reading it.
      this.attempts.set(hash, this.maxAttempts);
      return { state: "skipped", blockNumber, events: 0 };
    }
    if (typeof this.store.recordBlock === "function") await this.store.recordBlock({ chainId: this.chainId, blockNumber, blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp });
    const results = [];
    for (const log of logs) results.push(await this.indexer.processLog(config, log, block));
    return { state: "settled", blockNumber, events: logs.length, results };
  }
}
