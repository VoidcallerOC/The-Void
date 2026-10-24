# Mainnet indexer latency: measurement and targeted settlement fix

Date: 2026-10-24 (UTC). Network: Avalanche C-Chain, chain id 43114. Branch: `claude/friendly-pascal-m57r46`.
Status of this document's claims: measured values are labelled **measured**; everything else is an estimate.

## 1. Root cause

The pending message ("Purchase submitted. Waiting for the authoritative index to confirm marketplace settlement.")
clears only when the sequential block scan for the marketplace contract reaches the purchase's block. On mainnet that
scan trails the chain by **2.3 to 3.3 hours (measured)** and the gap is not shrinking:

* Ten contracts (3 release factories, 3 marketplaces, 2 release clones, 2 primary sales) share one RPC pacer that
  spaces every call by 5 s (`INDEXER_RPC_MIN_INTERVAL_MS` default; Render logs show every wait at 4,951–5,000 ms).
* Each contract may index 20 chunks × 100 blocks per cycle (`INDEXER_MAX_CHUNKS_PER_CYCLE`), and every empty chunk
  cost two paced calls: `eth_getLogs` plus `eth_getBlockByNumber` for the chunk's end block (a reorg anchor only).
* 10 contracts × ~41 calls × 5 s ≈ 34 min per cycle (**measured**: cycles completed 12:04:53, 12:55:42, 13:30:25,
  14:05:08). The chain produced ~2,200 blocks in those 34 min (**measured** 1.07 blocks/s), against a 2,000-block
  budget per contract, so the lag drifts up by roughly 200–250 blocks per cycle.
* Rate limiting is not the bottleneck: zero `cycle.rate_limited`, `indexer.rpc.retry` or `cycle.failed` events in
  the 24 h to 14:45 UTC. The pacing itself is.

Everything after the indexer is fast: the API reads the `transactions` row straight from Postgres (readiness reports
3–4 ms database latency) and the UI polls that endpoint every 1.5 s backing off to 15 s.

## 2. Measured latency breakdown

Sampled from `GET /api/indexer/health?chainId=43114` and `GET /api/health/ready` on the-void-api-mainnet at
14:37:19 and 14:37:40 UTC, Render logs for `the-void-indexer-mainnet` (srv-db8j8o8u01pc738cubsg), and block
timestamps from the public RPC.

| Stage | Value | Kind |
| --- | --- | --- |
| Wallet submission to inclusion | not instrumented; Avalanche inclusion is typically one or two blocks | estimate |
| Block production rate | 1.07 blocks/s (blocks 98,421,681 → 98,434,158 over 11,682 s) | measured |
| Confirmation policy | 12 blocks ≈ 11–13 s | measured policy, estimated time |
| Indexer head known to worker | 98,433,397 at 14:34:50 | measured |
| Active marketplace checkpoint (0x0f59…5eb2) | 98,423,681, written 14:22:38, block mined 12:02:17 | measured |
| Marketplace lag | 9,716 blocks ≈ 2 h 35 min at sample time; checkpoint written 2 h 20 min after the block | measured |
| Lowest contract checkpoint (release clones, sales) | 98,421,681, block mined 11:29:26 → 11,716 blocks ≈ 3 h 15 min | measured |
| RPC pacing | one call per 5.0 s, serialized across all contracts | measured (logs) |
| Chunk cadence | 2 chunks (200 blocks) in 20 s on factory 0xea0c… (checkpoints 14:37:11 → 14:37:31) | measured |
| Calls per empty chunk | 2 (`eth_getLogs` + end-block `eth_getBlockByNumber`) | code |
| Max blocks per contract per cycle | 2,000 (20 chunks × 100) | config default |
| Cycle duration | ~35 min (12:04 → 12:55 → 13:30 → 14:05); ~110 min overnight on the previous instance | measured |
| Rate-limit events, 24 h | 0 | measured (logs) |
| Persistence → API response | same Postgres row; readiness reports 3–4 ms DB latency | measured |
| API visibility → UI reconciliation | ≤ 15 s (poll 1.5 s doubling to a 15 s cap) | code |
| Lag trend | growing: 7,634 blocks (cycle ending 14:05) → 7,887 (cycle ending 14:22) for the marketplace | measured |

Side effect worth knowing: protected-media ownership checks require the token contract's checkpoint to be within
24 blocks or refreshed within 120 s (`OWNERSHIP_MAX_INDEXER_LAG_BLOCKS`, `OWNERSHIP_MAX_INDEXER_STALENESS_MS`). While
the release clones sit 3 h behind, those checks fail closed with `OWNERSHIP_INDEX_STALE`. Not changed here.

## 3. Fix implemented (smallest safe change)

### 3a. Transaction-targeted settlement (option 1 from the brief)

`server/marketplace-settlement-reconcile.js`, wired into the worker as a second loop beside the block cycle:

1. Every `INDEXER_SETTLEMENT_RECONCILE_INTERVAL_MS` (default 10 s) the worker lists `transactions` rows that are
   `SUBMITTED` for a configured marketplace with a real hash (purchase intents use `intent:` keys and are never read),
   newest last, at most `INDEXER_SETTLEMENT_RECONCILE_BATCH_SIZE` (10) per pass and no older than
   `INDEXER_SETTLEMENT_RECONCILE_MAX_AGE_MS` (24 h). A pass with nothing submitted makes no RPC call.
2. For each row it reads `eth_getTransactionReceipt` through the same pacer. No receipt → still pending, nothing
   written. It then applies the indexer's own confirmation depth (`INDEXER_CONFIRMATIONS`, 12) against one
   `eth_blockNumber` read per pass.
3. Receipt verification before any write: `to` must equal the marketplace the submission named; `status` must be
   `0x1` (a `0x0` receipt is recorded `FAILED` through the existing `reconcileMarketplaceTransaction`, which is what
   the UI renders as a reverted purchase); the canonical block at that height must carry the receipt's block hash;
   and a block already recorded under a different hash (reorg in progress) makes the pass skip the row.
4. Only logs emitted by that marketplace are taken from the receipt, normalised to the shape `rpc.getLogs` produces
   and fed, in log order, to the unchanged `BlockchainIndexer.processLog` path: same ABI decoding, same address,
   fee and identity checks, same `recordEvent`, `applyMarketplaceEvent` and `reconcileMarketplaceListing` writes.
5. No checkpoint is read or written. When the block scan later reaches the block, `recordEvent` and the
   `marketplace_event_projections` marker make it a no-op; reorg handling (rewind + rebuild) stays with the scan.
   A row whose projection keeps failing (for example a listing the scan has not indexed yet) is retried a bounded
   number of times, then left to the scan.

The frontend needs no change: it already polls the authoritative transaction endpoint and flips to CONFIRMED only
when the row is CONFIRMED and carries a matching purchase record.

### 3b. Fewer RPC calls per empty chunk (part of option 3/4)

`server/indexer.js`: the chunk end block is fetched and recorded only for the last chunk of a `syncContract` call.
Every block that carries a log is still fetched and recorded, so timestamps and reorg anchors for indexed state are
unchanged, and the persisted checkpoint's `last_processed_block` is always anchored. An empty intermediate chunk now
costs one paced call instead of two.

## 4. Files changed

* `server/marketplace-settlement-reconcile.js` (new): the targeted reconciler.
* `server/indexer-worker.js`: settlement loop (`runSettlementLoop`, `reconcileSubmittedTransactions`), wiring in
  `createProductionIndexerWorker`, stop/finally handling.
* `server/indexer-store.js`: `listSubmittedMarketplaceTransactions`.
* `server/config.js`: `INDEXER_SETTLEMENT_RECONCILE`, `…_INTERVAL_MS`, `…_MAX_AGE_MS`, `…_BATCH_SIZE`.
* `server/indexer.js`: end-block anchor only on the call's last chunk.
* `deploy/mainnet/README.md`: the four optional keys.
* Tests: `server/marketplace-settlement-reconcile.test.js` (new), `server/indexer.test.js`,
  `server/indexer-worker.test.js`, `server/indexer-store.test.js`.

## 5. Tests and build

Vitest, this branch, 14:5x UTC:

* New and touched suites: `indexer`, `indexer-worker`, `indexer-store`, `config`, `marketplace-reconciliation`,
  `marketplace-settlement-reconcile`: all passing (123 tests across the six files).
* New coverage: confirmed purchase settled from the receipt without a block cycle and the later scan a no-op;
  repeated passes and duplicate delivery; confirmation depth and receipt-less (replaced or dropped) submissions;
  reverted receipt → FAILED without projection; RPC failure then recovery; non-canonical receipt block and a
  conflicting recorded block are skipped without touching reorg handling or checkpoints; wrong destination or
  unconfigured marketplace never projected; mixed receipts project only the marketplace's logs in order; two
  marketplaces with a bounded batch and one head read per pass; bounded retries; worker loop runs beside a blocked
  cycle, survives a throwing pass, stops with the worker; indexer anchor-only-on-last-chunk with log blocks still
  recorded; config defaults, overrides and bounds; store query shape.
* Full suite: 212 files passed, 4 failed, 22 skipped. The 4 failing files (`scripts/mainnet-owner-signing.test.mjs`,
  `scripts/deploy-release-per-contract-mainnet.test.mjs`, `scripts/verify-settled-sale-activation.test.mjs`,
  `src/owner-deploy/flow.test.js`) are deployment-signing suites that read Foundry artifacts under `out/`, which
  this environment cannot build (no `forge`); none of them import the files changed here. The 22 skipped files are
  the `*.db.test.js` suites that need `TEST_DATABASE_URL`; the new store query was not executed against Postgres
  here (UNVERIFIED until CI's Postgres job runs).
* `npm run lint`: clean.

## 6. Expected versus measured improvement

| Path | Today (measured) | After this change | Status |
| --- | --- | --- | --- |
| Purchase / listing / cancel submitted through the UI | 2 h 20 min to 3 h 15 min after inclusion | ≈ 12 s confirmations + ≤ 10 s tick + 3–4 paced calls (≈ 15–20 s, interleaved with the scan) + ≤ 15 s UI poll → roughly 40–60 s | estimate; UNVERIFIED in production |
| Catch-up throughput of the block scan | ~2,000 blocks per contract per ~34 min cycle (≈ chain rate) | ~2,000 blocks per ~18 min cycle; net gain ≈ 850 blocks per cycle; the current ~10k-block backlog clears in ≈ 4 h | estimate |
| Steady-state scan lag once caught up | not reachable today | 12 confirmations + one cycle (~31 calls × 5 s ≈ 2.6 min) + 15 s poll ≈ 3 min | estimate |

What must be measured after deploy to call this COMPLETE: for one real purchase, the receipt block timestamp, the
`transactions.updated_at` when the row turned CONFIRMED (logged as `indexer.settlement.reconciled`), and the moment the
UI cleared the pending message. And `indexer_lag` from `/api/indexer/health` over several cycles to confirm the
backlog shrinks.

## 7. Trade-offs and remaining limitations

* RPC budget: while a submission is pending the targeted pass spends 1–2 paced calls per tick on it (receipt, and
  the head once per pass), so the block scan slows slightly for ~30 s per purchase. Bounded by batch size.
* Scope: only logs from configured marketplaces are projected early. The ERC-1155 transfer in the same receipt
  (collector balance in `ownership_snapshots`) still waits for the token contract's scan; the UI refreshes wallet
  balances from the chain directly, and protected-media ownership stays fail-closed on the scan's freshness.
* Replaced or dropped transactions: with no receipt the row stays `SUBMITTED` (as today) and the UI keeps polling
  at the 15 s cap; nothing is marked STALE because a mempool miss on a public RPC is not proof of replacement.
* The structural fix for the scan is still open: one `eth_getLogs` with an address array for every contract at the
  same checkpoint (10× fewer calls), or a dedicated RPC endpoint with lower pacing. Either is a larger change or a
  credential/config decision and was not made here.
* Nothing was deployed, merged, or changed in production configuration.

## 8. Handoff

* STATUS: PARTIAL (code and tests complete on the branch; production effect UNVERIFIED until deployed and observed).
* TASK: mainnet indexer latency measurement and targeted settlement fix.
* VERIFIED: 2.3–3.3 h index lag with a growing trend; 5 s per RPC call, no rate limiting; 35 min cycles; unit tests
  for the new path and the anchor change pass; lint clean.
* CHANGED: files in §4; no production action.
* EVIDENCE: §2 (API health samples 14:37 UTC, Render logs 14:35–14:44 UTC and 24 h event search, RPC block
  timestamps), vitest and eslint output in §5.
* UNVERIFIED: production latency after deploy; the store SQL against Postgres (DB suites skipped here).
* BLOCKERS: none for review; deploy needs explicit approval.
* DO NOT REDO: the ERC-7572 malformed-event investigation; the measurement in §2.
* NEXT ACTION: review and merge the PR, deploy `the-void-indexer-mainnet`, then time one real purchase end to end
  and watch `indexer_lag` shrink over three cycles.
