# Forgive & Forget (SINGLE) — release acceptance checklist

Evidence date: 2026-10-19 (UTC, ~17:10–17:30). Deployed commit: `06f9f92eb9edb24ff2161710a880599812408df2`.
Every status below is backed by a read-only observation made at that time, or by a cited existing record.
Nothing in this run wrote to production, the chain, the catalog database, or Render/Vercel configuration.

Status vocabulary: **PASS** (observed), **FAIL** (observed wrong), **BLOCKED** (needs a decision, credential or authorization), **NOT TESTED** (no evidence either way).

## Canonical identity (as observed)

| Item | Value | Source |
| --- | --- | --- |
| Release | `release-83611741-c9ee-4487-a438-b6fa844762e6`, slug `forgive-forget`, status `DRAFT`, `published_at` null | Supabase project "The Void Mainnet", table `releases` |
| Edition | `edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7`, status `DRAFT`, `supply` 25, `priceWei` 10000000000000000 (0.01 AVAX), `contract_id` `4c38219d-…` | table `editions` |
| Release clone (ERC-1155) | `0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103`, chain 43114, deployment block 97932485, tx `0x0744371252c78954b80f06a14426e5ee9ff1dac67f8e1356d12773b28f79cb2b` | tables `contracts`, `release_contracts` (status `DEPLOYED`, `release_key` `0x1d7747cc…0731`, implementation `0x8064238e…9006` v2) |
| Primary sale | `0x6ae84a51f100f10f0535a514555043ae9edf9aa3` | `release_contracts.primary_sale_contract_id`; `/api/health/ready` contracts.primarySale |
| Provenance anchor | `0x26d1bc084bcc313668530af7c10b390cb9a2cbed` | `release_contracts.provenance_anchor_contract_id` |
| Artist wallet | `0x284C09a7CC187E096cbbdc88d99DEFE6df32180a` | `release_contracts.artist_wallet`; on-chain `owner()` of the clone |
| Expected token id | `25679935302133066722236771263728427871936411831072189551573738559199048803312` | `experiences.requirements[0].tokenIds`; `tokens` has one pre-registered row for the edition |

**Address correction.** The directive baseline lists the clone as `0x9aa6165b493ac50f0d8cdee2fd48a3c5155fd103`. That address has **no code** on C-Chain (`eth_getCode` returns `0x`). The catalog database, the production API readiness payload and the indexer all use `…493ac50d0f8cde…`, and that address holds an EIP-1167 minimal proxy pointing at implementation `0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006`. The baseline string is a transposition; production is bound correctly. Use `0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103` in every future record.

## Checklist

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Canonical release identity and correct release binding | **PASS** | `editions.contract_id` = `release_contracts.release_contract_id` = `contracts.id` for `0x9aa6…d103`; `release_key` in the DB equals the indexed topic in the clone's initialization logs (tx `0x0744…cb2b`, block 97932485); on-chain `hasRole(ARTIST_ROLE, artist)` = true, `hasRole(DEFAULT_ADMIN_ROLE, artist)` = true, `owner()` = artist; both experiences gate on this contract and token id. |
| 2 | Release not leaked before publication | **PASS** | `GET /api/releases`, `/api/editions`, `/api/experiences` on `the-void-api-mainnet.onrender.com` return only the legacy `voidcaller-legacy-genesis` records. Forgive & Forget is absent (DRAFT). |
| 3 | Final artist-approved edition supply and price | **BLOCKED** (artist decision) | DB holds supply 25 and 0.01 AVAX as draft values. No record of artist sign-off exists in the repo or the DB. Nothing on chain yet: the primary-sale contract has emitted only `OwnershipTransferred` (to the factory) since deployment; `platformFeeBps` = 250, `platformRecipient` = `0xb65C…1ce4`. |
| 4 | Edition creation and publication readiness (off-chain preconditions) | **PASS** | Publish path (`server/studio-service.js` lines 754–842) requires: bound factory release (present, `DEPLOYED`), edition on the bound contract (true), a mined `EditionCreated` receipt signed by an artist wallet (not yet performed, by design), royalty policy 250 bps (enforced on chain by `VoidRelease1155V4Royalty`). No `albumCreated`, `albumSingleCount` = 0, `albumTrackCount` = 0 on the clone. |
| 5 | Edition created on chain / sale configured | **NOT TESTED** (deliberately not performed) | Clone logs since deployment: only initialization events (role grants, ownership transfer, base URI `ipfs://QmXYB2fB9M4LSGaK7M4QR7ojeWuwPYq6KHPCnaGyDUqqvz`, release initialized). No `EditionCreated`, no `TransferSingle`. This is the artist's launch action and needs explicit authorization. |
| 6 | Collector acquisition and entitlement verification (real holder) | **NOT TESTED** | No holder exists because no token exists. Cannot be exercised on mainnet before item 5. Fuji rehearsal is possible (Fuji API lists three PUBLISHED editions with primary sales) but needs a disposable Fuji wallet key, which this session does not hold. |
| 7 | Protected full-track access for an entitled holder | **NOT TESTED** | Experience `…-full-track` is `primary: true`, `protected: true`, asset `asset-1463db33-…` (audio/wav); demo experience `…-experience-audio` asset `asset-2deb8f1e-…`. Metadata-level registration is per the existing baseline; delivery to a holder cannot be observed before item 5/6. |
| 8 | Correct denial for an ineligible or anonymous wallet | **PASS** (anonymous), **NOT TESTED** (authenticated non-holder) | Production: `POST /api/media/grants` without a session → HTTP 401; `GET /api/media/<bogus>` → HTTP 404 `MEDIA_NOT_FOUND`. Authenticated non-holder denial is covered by `server/release-entitlement.test.js` and `server/ownership.test.js` on the deployed commit, not by a live probe. |
| 9 | Stale indexer state and reorg snapshots fail closed | **PASS** (code, deployed) / **BLOCKED** (effective thresholds) | `checkpointFresh` (`server/ownership.js` 53–64) rejects missing/old `last_successful_run_at`, non-IDLE/RUNNING status, and lag > `OWNERSHIP_MAX_INDEXER_LAG_BLOCKS`; `REORG_PENDING` snapshots are rejected. `deploy/mainnet/render.mainnet.yaml` sets neither `OWNERSHIP_MAX_INDEXER_STALENESS_MS` nor `OWNERSHIP_MAX_INDEXER_LAG_BLOCKS`, so the defaults (120000 ms, 24 blocks) apply **unless overridden in the Render dashboard**, which this session cannot read. See F-10 below. |
| 10 | Production API and indexer health | **PASS** | `/api/health/ready`: `ok: true`, DB latency 4–23 ms, chain 43114 checkpoints for MARKETPLACE, RELEASE_FACTORY, PRIMARY_SALE and the ERC-1155 clone all present; `last_completed_run_at` 17:11:37Z; `last_error` null. Render: `the-void-api-mainnet` (`srv-db8ib9ajnfac73fs5r20`) and `the-void-indexer-mainnet` (`srv-db8j8o8u01pc738cubsg`) not suspended, last updated 2026-10-19 09:48Z (auto-deploy of `main`). |
| 11 | Artist Studio behaviour needed for the release | **PASS** (preconditions) / **NOT TESTED** (live publish) | Studio requires an artist-owner session for the `voidcaller` artist; the only remaining Studio actions are the artist-signed `createEdition` (publication) and primary-sale configuration (`src/lib/primary-sale.js` `configureSale`). Both are launch actions, not readiness gaps. |
| 12 | Duplicate release untouched | **PASS** | `release-273f5476-0cdb-45d3-83d3-5908eb42bc6c` (slug `forgive-forget-2`, DRAFT, no editions) was read only. |
| 13 | Genesis functionality | **NOT TESTED** (deferred by directive) | Not inspected. |

## F-08 and F-10 position

- **F-08 (ownership freshness judged by last completed run)** is in the deployed commit (`2366b58`, merged in `06f9f92`, HEAD of `main`). Production exercise with a real holder remains NOT TESTED (item 6).
- **F-10 (availability: fail-closed `OWNERSHIP_INDEX_STALE`)** is an *availability* risk, not a security risk. With `INDEXER_CONFIRMATIONS` 12 and `INDEXER_POLL_INTERVAL_MS` 15000, steady-state lag is 12 blocks and runs complete every ~15 s, so the defaults hold while the worker is healthy. The worker will fail closed for the duration of any RPC outage longer than the staleness window or any deploy restart. Indexer logs for the last 24 h show only transient `Block N was not found` retries from the public RPC (recovered on retry) and SIGTERM restarts at deploy time. The cumulative `rpc_failures` counter is 147. **Resolution that needs no code and no config change:** the owner reads the two `OWNERSHIP_MAX_INDEXER_*` values on `the-void-api-mainnet` in the Render dashboard and records them here. Do not raise `OWNERSHIP_MAX_INDEXER_STALENESS_MS` without separate authorization.

## Post-launch improvements (not blockers)

- Contract source verification on Snowtrace: the implementation `0x8064…9006` and the sale `0x6ae8…9aa3` report "source code not verified" to the Etherscan API, although the deployment record marks the deploy `VERIFIED` (workflow-level). Public verification helps collectors, not correctness.
- Alerting on `OWNERSHIP_INDEX_STALE` (503) rate and on indexer `rpc_failures` growth; consider a paid RPC endpoint for the indexer.
- Correct the clone address string in any external record that carries the transposed `…50f0d8…` form.

## Remaining launch blockers (ranked)

1. **Artist sign-off on edition economics** (supply 25, 0.01 AVAX). Blocks items 3, 5. Needs: artist decision. Success: a written approval (or new values) recorded in the War Room log and mirrored into the draft edition before publication.
2. **Artist-signed on-chain publication** (`createEdition` via Studio, then `configureSale`). Blocks items 5, 6, 7. Needs: explicit authorization and the artist's wallet on the artist's own device. Success: `EditionCreated` for the expected token id on `0x9aa6…d103`, edition `PUBLISHED`, release visible in `/api/releases`.
3. **Entitled-holder end-to-end** (collect, grant, full-track playback, demo playback). Blocks items 6, 7. Cheapest path: one Fuji rehearsal with a disposable wallet on the existing Fuji editions, then the first mainnet purchase after blocker 2. Needs: a Fuji test key and a small AVAX test balance. Success: HTTP 200 grant + audio bytes for the holder; 403 for a second, non-holding wallet.
4. **F-10 effective thresholds** (item 9). Needs: the owner reading two env values in the Render dashboard. Success: the values are recorded here and are the defaults or an already-authorized override.

Blockers 1 and 2 are the launch itself; 3 and 4 are acceptance evidence that can be gathered in minutes once 1 and 2 are done.
