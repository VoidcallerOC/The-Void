# Album / Single Redeploy Package and Acceptance Matrix — 2026-10-09

Builds on [`RELEASE-ARCHITECTURE-RECOVERY.md`](./RELEASE-ARCHITECTURE-RECOVERY.md). Evidence rules: [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md).
**Update 2026-10-10:** the redeploy in §3 **has been broadcast** (owner-authorized run [38054831224](https://github.com/VoidcallerOC/The-Void/actions/runs/38054831224); record `deployments/release-per-contract-fuji-0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8.json`). See §6 for the independent re-verification. The album paths (B, C) are still unproven on-chain. Every further on-chain step needs the owner's explicit authorization.

## 1. Why a redeploy is needed

The live FactoryV2 `0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505` was deployed on 2026-10-05. The album and open-edition V4 source was merged on 2026-10-06 (`f67a643`). EIP-1167 clones are bound to their implementation and cannot be upgraded. Albums and singles therefore need a new factory, and a new ReleaseMarketplaceV3 whose `registry` is that factory.

**Tier-2 evidence.** The `fuji-readonly-probe` run [37905878502](https://github.com/VoidcallerOC/The-Void/actions/runs/37905878502) at Fuji block `59224329` (2026-10-09T08:35:35Z) found:
- implementation `0xAe3257a441C5119Ee496330Dd93Deb06ab0eB8b4`: 12,075 bytes of code, and **none** of the 5 album selectors (`albumCapable: false`);
- `albumCreated()` **reverts** on both clones, `0x1AaF…9BfC` and `0x12Ff…0Fe6`.

The detector was validated against compiled current-source V4 (all selectors present) and V2 (none present).

## 2. Decisions required before broadcast

A redeploy creates a new **immutable** implementation, so these choices become permanent.

| # | Decision | Current source behaviour | Recommendation |
|---|---|---|---|
| D1 | What a **single** is | A single is an album track flagged `single = true` (`isAlbumSingle`). There is no standalone SINGLE release type. The README lists Single/EP/Album. | Confirm one of two options: (a) keep "single = album track", or (b) add a standalone single release. If you pick (b), the clone needs a type-specific rule, such as exactly one edition. |
| D2 | Who may lift the 13-track / 4-single caps | `approveExpandedRelease` is gated by `DEFAULT_ADMIN_ROLE`, which the **artist** holds. The caps are therefore advisory. | If the caps are a platform rule, move approval to a platform-held role. |
| D3 | Standalone editions created before `createAlbum` | Allowed. They do not count toward the caps, so the caps can be bypassed. | Make `createAlbum` revert when standalone editions already exist. |
| D4 | When a clone becomes an album | Only through a separate `createAlbum` transaction after `createRelease`. | Optional: pass the release type into `createRelease` so album mode is set atomically. |
| D5 | The deployer key | The workflow signs with the GitHub secret `DEPLOYER_PRIVATE_KEY`. The suspended cron's 3 Fuji deploys were all sent `from` **`0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`** (probe, tier 1). | If the dry-run `deployer_address` equals `0xaBd3…c174`, the same key also sits in the Render cron env. Rotate it, or delete it from the cron env, before broadcast. |

D2–D4 change Solidity. If you choose to change it, I will put it in a separate PR with forge tests before any broadcast.

## 3. Manual authorization flow

The signer is the GitHub Actions secret key. Your authorization is the workflow dispatch. No browser-wallet signature is involved.

1. **Merge PR #142.** It contains the album guard and the record fix. Without the fix, a broadcast would mine both contracts and then lose their addresses on `EEXIST`.
2. **Dry run** (no transactions). Go to Actions → *Deploy release-per-contract infrastructure to Fuji* → `broadcast_deployment = false`. Review in the log:
   - `deployer_address=`, `fuji_chain_id=43113` and `fuji_balance_wei=`;
   - the album guard passes. If it doesn't, the run fails with "lacks album functions".
   - the plan contains:
     - FactoryV2 with constructor `platformRecipient = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`;
     - ReleaseMarketplaceV3 with constructor `(feeRecipient = 0xb65C…1ce4, platformFeeBps = 250, releaseFactory = <new factory>)`.
3. **Broadcast** (owner only). Run the same workflow with `broadcast_deployment = true` and `confirm_fuji_deploy = I_CONFIRM_FUJI_RELEASE_PER_CONTRACT_DEPLOY`.
   - **Effect:** two contract-creation transactions on Fuji 43113. Gas is paid in test AVAX by the deployer. No existing contract changes.
   - **Output:** `FACTORY_MINED`, `MARKETPLACE_MINED` and `RECORD` log lines, plus the `release-per-contract-fuji-<run_id>` artifact.
4. **Wiring** (after broadcast; addresses come only from the mined record):

   | Where | Change | Who |
   |---|---|---|
   | `config/fuji-release-per-contract-v2.json` and `deployments/` | New factory, implementation and marketplace addresses, plus deployment blocks | PR (Claude) |
   | Vercel `VITE_MARKETPLACE_ADDRESS` | New ReleaseMarketplaceV3 | Owner |
   | Render `INDEXER_CONTRACTS_JSON` (API and indexer) | Add `RELEASE_FACTORY` and `MARKETPLACE` entries with their real `startBlock`. Keep the old entries for history. | Owner (secret env) |
   | Render API | Manual deploy of the wiring PR | Owner-approved |
   | Probe | Rerun. Expect `albumCapable = true`, `v3ParityOnChain = true`, and the new factory `releaseCount = 0`. | Claude |

**Effect on existing state.** Old clones `0x1AaF…9BfC` and `0x12Ff…0Fe6` have no published editions (production `/api/editions`). After the config switch, Studio binding accepts only the new factory. The old ReleaseMarketplaceV3 `0x42B7…a744` had `nextListingId == 1`, meaning no listings, at the 2026-10-08 probe.

## 4. End-to-end acceptance matrix

Status for every row is **NOT STARTED** unless noted. A row passes only with the stated evidence. Tier numbers are from [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md). Mocked or simulated runs do not count.

### Shared infrastructure

| ID | Check | Required evidence | Status |
|---|---|---|---|
| S1 | The new implementation can create albums | Probe: `albumCapable = true` (tier 2) | **VERIFIED** (§6): implementation `0x45c3…E452` has all 6 album selectors. |
| S2 | V3 `registry` equals the new factory, fee is 250 bps to `0xb65C…1ce4`, chain is 43113 | Probe: `v3ParityOnChain = true` (tier 2) | **VERIFIED for the new pair** `0x3e4E…3aC8` / `0xa464…C898` (§6). Also verified for the historical pair `0xa5Cb…3505` / `0x42B7…a744` (probe run 37905878502). |
| S3 | Frontend, API, indexer and chain all agree on factory and marketplace | Vercel env value, JSON config, `/api/indexer/health` contract list, probe | **VERIFIED for the new pair** (§6): the config lists it as active, indexer health lists the new factory and marketplace, on-chain `registry()` agrees, and Vercel production runs `fc83364`, which includes the per-factory marketplace routing from `078ffd6`. The Vercel env value itself was not re-read in this pass. |
| S4 | The indexer picks up new factory releases and their sales | `factory_releases` row and health entry within 2 minutes of `ReleaseCreated` | **PARTIAL.** Health lists both new-factory clones (`0xBf75…4CB9`, `0x4b27…9bB0`) and their sales. The `factory_releases` rows and the 2-minute latency were not measured. |
| S5 | API and indexer run the merged code | Render deploy record SHA and `/api/health/ready` returns 200 | **COMPLETE.** API `dep-db4aape0tbcc73dnak2g` and indexer `dep-db4a8vqvcj2c73d0kgkg` are both on `ffe9c52`; health returned 200 at 2026-10-09T08:28:18Z. |

### Path A — standalone release (EP)

| ID | Step | Required evidence |
|---|---|---|
| A1 | Studio: create an EP release; the artist wallet calls `createRelease` | `ReleaseCreated` receipt; `releaseContractOf(key)`; owner equals the artist |
| A2 | Bind the release | `POST /studio/releases/:id/contract` returns 200; `release_contracts` row is DEPLOYED |
| A3 | Create an edition with `createEdition` or `createEditionWithMintEnd` | `EditionCreated` receipt on the clone; metadata URI matches Pinata |
| A4 | Configure the sale and buy (collector wallet ≠ artist) | `Purchased` and mint `TransferSingle` on the release's own sale; `balanceOf(buyer) = 1` |
| A5 | Ownership appears in the API | Collector activity / ownership endpoint includes the token within the lag bound |
| A6 | Protected media unlocks for the collector only | Authenticated grant succeeds for the owner and returns 403 for a non-owner |
| A7 | Resale on V3 | `ListingCreated`, then `ListingSold` on the new V3; royalty and fee split match the receipt |

### Path B — album

| ID | Step | Required evidence |
|---|---|---|
| B1 | Create an ALBUM release | Same as A1–A2 |
| B2 | `createAlbum` | `AlbumCreated` receipt; Studio shows "Album Contract active" after reload (read from chain) |
| B3 | Add 3 tracks (one with `single = true`, one with `mintEnd`) | 3 `AlbumTrackCreated` receipts; `albumTrackCount = 3`, `albumSingleCount = 1` |
| B4 | Cap enforcement | Tracks 14+ revert `AlbumTrackLimitReached` and singles 5+ revert `AlbumSingleLimitReached`. Proven on a disposable clone, or by forge tests plus simulation of a live `eth_call`. |
| B5 | Standalone path is blocked | `createEdition` on the album reverts `AlbumTrackPathRequired` (`eth_call` simulation) |
| B6 | Mint deadline | Purchase after `mintEnd` reverts; purchase before it succeeds |
| B7 | `closeAlbum` | `AlbumClosed` receipt; a further `createAlbumTrack` reverts `AlbumAlreadyClosed` |
| B8 | Buy, own, unlock and resell a track | A4–A7 on an album track |

### Path C — single (as defined by D1)

| ID | Step | Required evidence |
|---|---|---|
| C1 | The single is discoverable as a single | API or catalog shows `isAlbumSingle` from chain. **Not implemented:** the indexer does not decode `AlbumTrackCreated` yet. |
| C2 | Single-specific mint window | B6 on the single track |
| C3 | Buy, own, unlock and resell | A4–A7 on the single |

### Negative and security checks

| ID | Check | Required evidence |
|---|---|---|
| N1 | A foreign marketplace is never paid | Listing with a non-canonical `marketplace` is blocked before any wallet prompt. Unit test merged in #141; live check NOT STARTED. |
| N2 | Wrong chain | Wallet on 43114 cannot send any release, sale or marketplace transaction |
| N3 | Album UI on a pre-album clone | Studio shows the unsupported message and sends no transaction (#141) |
| N4 | Non-owner media request | 403; no grant created |
| N5 | Rejecting a duplicate release key | Second `createRelease` with the same key reverts |

## 5. Production security verification (this session)

| Gap | Evidence | Status |
|---|---|---|
| Render cron `crn-dat953e0tbcc73acrepg` | Run logs show it broadcast 3 Fuji MusicMarketplace deployments: `0xd13f…5f92`, `0xced4…7a29`, `0x1bc4…6e04`. On-chain, all 3 have `status 1`, are `from 0xaBd3…c174`, have code present, are not canonical V3, and are not `isRelease`. Suspended by the owner; the Render API reports `suspended`, suspenders `["user"]`, at 2026-10-09T08:22:14Z. | CONTAINED. These 3 deployments still exist and **were not undone**. |
| Secrets in git history | Pattern scan of all 1,132 reachable commits and the 455 pre-rewrite commits found 0 credentials. The only hits are the CI container DSN `postgres:postgres@127.0.0.1`. No `.env`, `.pem`, key or mnemonic file was ever added. | VERIFIED CLEAN (pattern scan; not exhaustive entropy analysis) |
| **Audio masters in public history** | The repo is **public**. `refs/pull/{1,2,3,5,6,7}/head` still point at pre-rewrite commits containing 10 full-length `public/assets/audio/*.mp3` files (36.1 MB). The rewrite removed them from `main` only. | **OPEN, P0 for protected media.** The owner must ask GitHub Support to remove those PR refs and cached views, or make the repo private. |
| Marketplace address in the frontend | Vercel production `VITE_MARKETPLACE_ADDRESS = 0x42b740…a744`, chain 43113 (canonical V3) | VERIFIED |
| Stale Vercel variable | `VITE_FUJI_LISTING_MARKETPLACE_ADDRESS = 0xa03b…0c0b` is read by no code. **Correction:** it *is* in the production bundle. `src/lib/marketplace.js:8` reads `import.meta.env` as a whole object, so Vite inlines every `VITE_*` variable (bundle scan, run 37907512682). It is inert, not a transaction target. See `FUJI-MARKETPLACE-RECONCILIATION.md` §5. | Hygiene: delete it |
| Database credentials on Vercel | The Vercel project holds Supabase integration secrets (`SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_*`) although the frontend is static. None are `VITE_*`. | Least privilege: remove them if unused |
| DB TLS | `DATABASE_SSL_CA` support is in #142. Production still runs `sslmode=require` without certificate verification until the owner sets the CA. | PARTIAL |
| RLS and grants (live) | Migrations 001–036 are recorded in production (API startup log 2026-10-09T08:27:42Z). Live `check-rls.sql` has not been run: no database access from this session. | UNVERIFIED |
| Pinata credential | Not tested | UNVERIFIED |
| Reviewer DMs | API startup logs `X_DM_CONFIG_MISSING`, so reviewer alerts are not delivered | OPEN (owner sets the X_* secrets, or accepts it) |

## 6. Post-broadcast re-verification — 2026-10-10T22:50Z

Read-only. `node scripts/fuji-release-capability-probe.mjs` (tier 2, public Fuji RPC, tip block `59283203`), plus production API and Vercel reads. No transaction was sent.

| Check | Result |
|---|---|
| Factory `0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8` `implementation()` | `0x45c3FFBb3C0Db3a8C87453d4612c9B3b6392E452`. Matches config. |
| Implementation album selectors | 6 of 6 present (14,652 bytes). `albumCapable = true` |
| ReleaseMarketplaceV3 `0xa464edb22C4959943334DB07001e3ba63989C898` | `registry` = new factory, `platformFeeBps` = 250, `feeRecipient` = `0xb65C…1ce4`, `deploymentChainId` = 43113. `v3ParityOnChain = true` |
| New factory `releaseCount` | 2: `0xBf753E65…4CB9` and `0x4b279079…9bB0`. `isRelease = true` and `albumCreated() = false` on both. Neither clone has emitted `AlbumCreated` or `AlbumTrackCreated` (`eth_getLogs` from block 59269207). |
| Production API `/api/health/ready` | `ok: true`; the indexer covers both factories, both marketplaces, both new clones and their sales. Lag is 15 blocks. |
| Vercel production | `dpl_994HePxZcJ3ZQiYvT4RBWfEeyRGu` is READY on `fc83364` (main HEAD). |

**What this certifies:** contract capability and wiring (S1–S3).
**What it does not certify:** any album workflow. Paths B and C are **NOT STARTED** on-chain. No album has been created on any clone. Path A has not been re-run end to end on the new pair.

**Deployed source is behind main.** `1e95f5b` added `VoidRelease1155V5` and `VoidReleaseFactoryV3` (provenance root at edition creation). These are **not deployed**. The album-capable factory on Fuji is V2/V4 and has no atomic provenance anchoring. Decide whether to certify albums on V2/V4 now, or to deploy V3/V5 first and certify there. Certifying both means doing the work twice.

