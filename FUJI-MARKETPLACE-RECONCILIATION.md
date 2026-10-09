# Fuji Marketplace Reconciliation and Canonical V3 Authority Audit — 2026-10-09

**Mode:** read-only. No transaction was broadcast or signed. No production configuration, environment variable, database row or cron state was changed. The cron `crn-dat953e0tbcc73acrepg` stayed suspended throughout.
**Evidence rules:** [`CHAIN-AUTHORITY.md`](./CHAIN-AUTHORITY.md). Tier 1 is receipts and logs, tier 2 is contract state and code, tier 4 is manifests, and tiers 5–7 are indexer, reports and recollection.
**Chain access:** this audit sandbox cannot reach the Fuji RPC (network policy denies it). All chain evidence comes from read-only GitHub Actions runs of the scripts below on PR #142, against the public RPC `https://api.avax-test.network/ext/bc/C/rpc`.

| Run | Scripts | Fuji tip block |
|---|---|---|
| [37907784942](https://github.com/VoidcallerOC/The-Void/actions/runs/37907784942) | `fuji-release-capability-probe.mjs`, `fuji-marketplace-reconciliation-probe.mjs`, bundle scan | 59224940–59225 k |
| __DEPLOYER_RUN__ | `fuji-deployer-audit.mjs` | __DEPLOYER_TIP__ |

---

## 1. Executive summary

**Observed facts:**

1. **The canonical marketplace is `0x42B740aA92A6F48380F6D97AD91e332a7921a744`, ReleaseMarketplaceV3 on Fuji 43113.**
   - Its runtime code matches the repository's ReleaseMarketplaceV3 source (`44cc90de`, partial match).
   - Its `registry()` is FactoryV2 `0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505`, the factory the Studio and API use.
   - Fee is 250 bps to `0xb65C575CaE01574296Fab6E620B9A15cC0121ce4`; `deploymentChainId` is 43113.
   - It was created by tx `0x3d08466ab91b4f31fdb69aa42b3107d821c7cef5d53effad3e56f2affd8c3861` at block 59082610 (2026-10-05T22:41:29Z), with constructor args `(0xb65C…1ce4, 250, 0xa5Cb…3505)`.
   - It matches the manifest `deployments/release-per-contract-fuji.json`, the config `config/fuji-release-per-contract-v2.json`, Vercel production `VITE_MARKETPLACE_ADDRESS` and the indexer `MARKETPLACE` checkpoint.
   - It has 0 listings and holds 0 AVAX.
2. **The three reported deployments are real.** All are confirmed on-chain (status 1) and created by `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`. They are not three isolated events: the same Render cron, same key and same script **also created `0x982b28352fd612fe934c5e1ad8fea399689190d2` (2026-09-29) and `0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b` (2026-10-01)**, in runs that Render recorded as **unsuccessful**. Those two were then adopted as the app's marketplace.
3. **All five MusicMarketplace deployments are reproduced exactly from repository source, but not with repository build settings.** The Render image does not copy `foundry.toml` (`Dockerfile:25-32`), so `forge create` used forge defaults: **solc 0.8.30, optimizer off, EVM prague**. Rebuilt that way:
   - `MusicMarketplace.sol` @ `0dfb240e` (blob `ba389bcf`, identical to current `main`) reproduces the cron-logged creation SHA-256 `0x6e707e33…85c785`, and matches `0xd13f…` with **zero non-immutable byte differences**, including the metadata hash;
   - @ `9e5411f0` matches `0x982b…` the same way (§3).
4. **Legacy state still exists:**
   - `0x982b…` and `0xa03b…` each hold **one ACTIVE on-chain listing** (listing 2) from seller `0x6a86…d2fb`. Both are **expired**, so neither can be filled now. Neither is in the production database.
   - The database's sold listing #1 on each is the only legacy activity it knows about.
   - The three cron-only deployments have **zero** listings.
5. **Consumers.**
   - Frontend transaction targets point only at V3 `0x42B7…`.
   - The production bundle *contains* `0xa03b…` (inert `VITE_FUJI_LISTING_*` variable, inlined because `src/lib/marketplace.js:8` reads `import.meta.env` whole), plus V1 `0x8291…` and `0x2287…` (bundled config JSON; only `chainId` and `networkName` are read). None of these is a transaction target.
   - The API never reads `MARKETPLACE_ADDRESS`. Its marketplace authority is the append-only DB `contracts` table, which still registers `0x982b…` and `0xa03b…`.

**Verdict.** Canonical V3 for the *current* FactoryV2: **COMPLETE.** Marketplace reconciliation: **PARTIAL** (the open items are in §10). **Mainnet readiness: BLOCKED** (§9).

---

## 2. Contract-authority model

```
                       ┌───────────────────────────────────────────┐
  intended authority   │ VoidReleaseFactoryV2 0xa5Cb…3505 (Fuji)   │  registry: isRelease(clone)
  (repo design,        │   └─ clones VoidRelease1155V4 (pre-album) │
   audit-reports/01)   └───────────────▲───────────────────────────┘
                                       │ immutable registry()
                       ┌───────────────┴───────────────────────────┐
                       │ ReleaseMarketplaceV3 0x42B7…a744          │  accepts only factory-registered clones
                       └───────────────▲───────────────────────────┘
          source of truth for address: │ deployments/release-per-contract-fuji.json  (tier 4)
                                       │ config/fuji-release-per-contract-v2.json    (tier 4)
         ┌─────────────────────────────┼──────────────────────────────┐
  Frontend (Vercel)            API (Render)                    Indexer (Render worker)
  VITE_MARKETPLACE_ADDRESS     DB `contracts` rows             INDEXER_CONTRACTS_JSON (secret)
  = 0x42B7 (buy/list/cancel)   type MARKETPLACE (append-only)  MARKETPLACE checkpoint = 0x42B7
  verifies registry()==factory  ⚠ still registers 0x982b, 0xa03b  (health 2026-10-09)
```

| Question | Answer from the repository | Evidence |
|---|---|---|
| What makes a marketplace canonical? | A ReleaseMarketplaceV3 whose immutable `registry()` is the configured release factory, recorded in the deployment manifest and `config/fuji-release-per-contract-v2.json`. There is **no on-chain marketplace registry and no version field**; canonical status is a configuration fact. | `contracts/ReleaseMarketplaceV3.sol:42-56`; `src/lib/secondary-listing.js:51-97` checks `registry`, chain and 250 bps on-chain |
| How deployments are created and recorded | **V3:** `scripts/deploy-release-per-contract-fuji.mjs` via a manual `workflow_dispatch` with typed confirmation, recorded in `deployments/`. **MusicMarketplace:** `scripts/deploy-marketplace.mjs`, run by the Render cron, which writes only to the ephemeral container. Nothing is committed. | Workflow file; `deploy-marketplace.mjs:260-270` |
| Can a deployment escape registration? | **Yes.** `deploy-marketplace.mjs` broadcasts with no registry, manifest or parity step. Five deployments happened this way, and none appears in git history at all. | §3 and §8 |
| One marketplace or several? | **Frontend:** exactly one (`MARKETPLACE_CONFIG`; buys are pinned to it since #141). **API:** any marketplace with a DB `contracts` row of type `MARKETPLACE` (`server/api-service.js:336-337`). **Indexer:** whatever `INDEXER_CONTRACTS_JSON` lists. | Code |
| Authoritative source per environment | **Fuji:** `deployments/release-per-contract-fuji.json` plus on-chain `registry()`. **Mainnet:** none. `config/mainnet-release.json` has no marketplace and `deployed: false`. | Files |

**Design vs deployed behaviour.** `audit-reports/01-release-per-contract-implementation.md` defines V3 as the only resale path, with "no shared canonical-token exception". The deployed tooling still contains the legacy MusicMarketplace path (single canonical token `0x82b26…`), and a scheduled service could run it. That is the disagreement.

---

## 3. Every marketplace-like Fuji contract

Source: reconciliation probe, run 37907784942. All deployers are `0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174`.

| Address (full) | Created (tx, block, UTC) | Code | Identity | Immutable config | Listings on chain | Referenced by |
|---|---|---|---|---|---|---|
| `0x42B740aA92A6F48380F6D97AD91e332a7921a744` | `0x3d08466ab91b4f31fdb69aa42b3107d821c7cef5d53effad3e56f2affd8c3861`, 59082610, 2026-10-05 22:41:29 | 5,891 B, `0xedce…199a` | **ReleaseMarketplaceV3 @44cc90de** (partial match, optimizer 200) | registry FactoryV2 `0xa5Cb…3505`; fee 250 to `0xb65C…1ce4`; chain 43113 | 0 | manifest, config, Vercel, indexer |
| `0x228734C7a6325f7B6F570EBCAc80239495fdedf0` | `0xf8d2834916406024326f771db35c3db14f9c846435310a41df6f7751978cce32`, 59050637, 2026-10-05 00:34:54 | 5,891 B, `0x1476…49a2` | ReleaseMarketplaceV3 @44cc90de | registry **V1 factory `0x8291…c265`** (releaseCount 0); fee 250 to `0xb65C…` | 0 | `config/fuji-release-per-contract.json` (bundled; not a target) |
| `0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b` | `0xc5c56d7b3f7ca4e2cdb8d73427f929ac29639b4724a4479a343161376ee2493f`, 58933908, 2026-10-01 13:49:45 | 9,834 B, `0x4530…5431` | MusicMarketplace (unmatched; optimizer-off size) | token `0x82b26…`; fee 250 to `0x284C…180a`; chain 43113 | 1 SOLD, 1 ACTIVE (expired) | git `7b1bee8` (removed `4bbce80`); Vercel `VITE_FUJI_LISTING_MARKETPLACE_ADDRESS` (inert); DB `contracts` |
| `0x982b28352fd612fe934c5e1ad8fea399689190d2` | `0xe6cbb916c86e04061886dbd82c63a2a2532248375661efb65913015666cd57d0`, 58850317, 2026-09-29 10:19:37 | 8,827 B, `0x87d0…7b6c` | MusicMarketplace, older (2-arg constructor; no `deploymentChainId` or `canonicalToken`; size matches `9e5411f0` optimizer-off) | fee 250 to `0x284C…180a` | 1 SOLD, 1 ACTIVE (expired) | git `606b3aa`; DB `contracts`; 2026-10-04 indexer |
| `0xd13f6184f4e3166901c7ed322e8c2c6be5915f92` | `0x06efd5a56057da3b846c21c21cf5eba89258721df113b636161addb26837488a`, 59023173, 2026-10-04 03:58:01 | 9,834 B, `0x4530…5431` (**identical to `0xa03b`**) | MusicMarketplace (unmatched) | token `0x82b26…`; fee 250 to `0x284C…180a`; chain 43113 | 0 | **nothing** (absent from git, config, bundle and DB listings) |
| `0xced494f8c5e51053fe631d68c5165856633e7a29` | `0xee1eda13d2ce8e51f095d0b43a37c6f736729d48289c1024ff0eca3428752548`, 59036649, 2026-10-04 13:50:58 | 9,834 B, `0x4530…5431` (identical) | MusicMarketplace (unmatched) | same as `0xd13f` | 0 | nothing |
| `0x1bc4cc82e658856d9bd53793612d97b0b23a6e04` | `0x8317e65b923d690576706fbf0a725a4e7e3d6b0a4d97e919e3e376542644a6b1`, 59089446, 2026-10-06 03:13:59 | 9,834 B, `0x8993…6476` | MusicMarketplace (unmatched) | token `0x82b26…`; fee 250 to **`0xb65C…1ce4`**; chain 43113 | 0 | nothing |

**Notes:**
- All seven contracts have 0 native balance.
- None has an owner, admin, pause or withdraw function, by source of every version (`grep owner|admin|pause|withdraw`). No party can disable, upgrade or reconfigure them.
- Constructor args for the MusicMarketplace rows were not decoded (`constructorArgs: null`), because decoding is only attempted after a fingerprint match. The immutable getters above report the same values directly from contract state (tier 2).

**Bytecode identity (COMPLETE).**
- **Inputs.** All three reported runs built from byte-identical inputs: `contracts/MusicMarketplace.sol` blob `ba389bcf`, `scripts/deploy-marketplace.mjs` blob `58670388`, `foundry.toml` blob `33a4cfa6`. The image does not contain `foundry.toml`. Each run logged SHA-256(creation bytecode) `0x6e707e33…85c785`.
- **On-chain metadata.** The CBOR tail of the deployed code names **solc 0.8.30**.
- **Rebuild.** forge 1.3.1 + solc 0.8.30 (official `v0.8.30` static binary, sha256 `f3e987dc…428f7`), optimizer off, EVM prague:

  | Source | vs on-chain | Non-immutable byte diffs | Creation SHA-256 |
  |---|---|---|---|
  | `MusicMarketplace.sol` @ `0dfb240e` | `0xd13f…` (9,834 B) | **0** (100 differing bytes, all inside immutable slots) | `0x6e707e33…85c785` = **cron-logged** |
  | `MusicMarketplace.sol` @ `9e5411f0` | `0x982b…` (8,827 B) | **0** (42 differing bytes, all immutable) | `0xed1542d5…db87` (no log retained) |

- **Same code elsewhere.** `0xa03b…` and `0xced4…` have runtime byte-identical to `0xd13f…`, including immutables (same full code hash `0x4530…5431`). `0x1bc4…` differs only in the `feeRecipient` immutable.
- **Probe identity.** The fingerprint table now carries these exact builds, so the probe identifies every one on-chain (§11 run).

---

## 4. Canonical V3 verification record

| State | Value | Evidence | Status |
|---|---|---|---|
| A. Intended in source | `0x42B740aA92A6F48380F6D97AD91e332a7921a744` | `config/fuji-release-per-contract-v2.json:7`; `deployments/release-per-contract-fuji.json:15-24` (commit `38d54a1`, 2026-10-05) | COMPLETE |
| B. Configured per component | **Vercel:** `VITE_MARKETPLACE_ADDRESS = 0x42b740…a744`, chain 43113. **Indexer:** `MARKETPLACE` checkpoint `0x42b7…`. **API:** DB rows (not enumerable; includes `0x982b` and `0xa03b`). | Vercel env API; `/api/indexer/health`; `/api/listings?status=SOLD` | PARTIAL (the DB row set is not fully enumerable) |
| C. Deployed on Fuji | Code present; V3 partial match; constructor args decoded from tx input | Probe (tier 1–2) | COMPLETE |
| D. Registry linkage | `registry() == 0xa5Cb…3505`. FactoryV2 has `implementation 0xAe32…B8b4` and `releaseCount 2`. | Probe (tier 2) | COMPLETE |
| E. Frontend transaction target | buy, list and cancel all use `MARKETPLACE_CONFIG.address` = `0x42b7…` | `src/components/PurchasePanel.jsx` (after #141), `ListingPanel.jsx:81-86`, bundle scan | COMPLETE |
| F. API and indexer usage | Indexer checkpoint `0x42b7` (`IDLE`). API accepts any DB-registered marketplace. | Health endpoint; `server/api-service.js:336` | PARTIAL |

---

## 5. Address-parity matrix

| Component | Expected | Actual | Chain | Version evidence | Status | Discrepancy |
|---|---|---|---|---|---|---|
| Manifest `deployments/release-per-contract-fuji.json` | `0x42B7…a744` | `0x42B7…a744` | 43113 | Deploy receipt | COMPLETE | — |
| `config/fuji-release-per-contract-v2.json` | `0x42B7…a744` | `0x42B7…a744` | 43113 | — | COMPLETE | — |
| `config/fuji-release-per-contract.json` (V1) | (superseded) | `0x2287…edf0` | 43113 | V3 bound to the unused factory | COMPLETE | **Intentional legacy reference.** Shipped in the bundle; only `chainId` and `networkName` are read (`src/lib/fuji-release.js:7,411,578`, `ClaimPage.jsx:171,319`). |
| Frontend buy target | `0x42B7…` | `MARKETPLACE_CONFIG.address` = `0x42b7…` | 43113 | Listing path verifies `registry` and 250 bps on-chain | COMPLETE | — |
| Frontend list/cancel target | `0x42B7…` | Same | 43113 | Same | COMPLETE | — |
| Vercel `VITE_MARKETPLACE_ADDRESS` (production) | `0x42B7…` | `0x42b740aa92a6f48380f6d97ad91e332a7921a744` | 43113 | — | COMPLETE | Preview builds have no `VITE_MARKETPLACE_*` set, so the marketplace is disabled in previews. |
| Vercel `VITE_FUJI_LISTING_MARKETPLACE_ADDRESS` (production) | none | `0xa03b…0c0b` | 43113 | Legacy MusicMarketplace | COMPLETE | **Stale but unused.** It is in the bundle (whole-object `import.meta.env` inlining at `src/lib/marketplace.js:8`), but no code reads it. |
| Render API `MARKETPLACE_ADDRESS` | — | Secret; not read by any server code | — | `grep` of `server/` | COMPLETE | **Stale/inert setting.** Its value is UNVERIFIED (secret). |
| API marketplace authority (DB `contracts`) | `0x42B7…` only | Includes `0x982b…` and `0xa03b…` (proven by SOLD listings joined to them), plus `0x42b7` (indexed) | 43113 | — | PARTIAL | **Genuine defect (low severity).** `assertRegisteredMarketplace` accepts legacy marketplaces for listing and cancel submissions. |
| Indexer `INDEXER_CONTRACTS_JSON` | `0x42B7…` | Checkpoint shows `MARKETPLACE 0x42b7…` only | 43113 | Health | COMPLETE (by observed behaviour) | The secret itself is UNVERIFIED. Legacy marketplaces are no longer indexed, which is why their listing 2 is missing from the DB. |
| `scripts/deploy-marketplace.mjs` | Must not deploy app marketplaces | Deploys MusicMarketplace for token `0x82b26…` | 43113/43114 | — | — | **Production configuration problem.** It is the unregistered deployment path (§8). |
| Chain `registry()` | FactoryV2 | FactoryV2 | 43113 | Probe | COMPLETE | — |
| Mainnet (43114) | — | No marketplace configured or deployed | 43114 | `config/mainnet-release.json` | NOT STARTED | — |

---

## 6. Discrepancy explanations

1. **`0x982b…` and `0xa03b…` came from "failed" cron runs.**
   - **Facts:** Render reports the runs `crn-…-1790677171` (started 2026-09-29T10:19:31Z) and `crn-…-1790862580` (started 2026-10-01T13:49:40Z) as `unsuccessful`, `nonZeroExit: 1`. Their creation transactions were mined 6 s and 5 s after those starts.
   - **Hypothesis:** the broadcast succeeded but the script failed afterwards (output parsing or record writing), so the deploy was invisible to whoever triggered it. The code paths at commits `8fd88ba…0bfebf7` would explain this; the run logs have expired, so it is not proven.
2. **The 2026-10-06 run was "canceled" after it had deployed.** Run `crn-…-1791256432` started 03:13:52Z. Its creation tx was mined at 03:13:59Z and the record was logged at 03:14:01Z. `voidcalleroc@gmail.com` cancelled it at 03:14:02Z.
3. **On-chain listings missing from the DB.** On both legacy marketplaces, listing 2 was created on 2026-10-03 (`0x982b`: 20:00:56Z; `0xa03b`: 20:39:29Z). The DB only has listing 1 on each. The likely cause is that the indexer stopped indexing those marketplaces when `INDEXER_CONTRACTS_JSON` changed; that is hypothesis-level, because the secret's history is not visible. Both listings expired on 2026-10-03, at `expiresAt` 1791058500 and 1791061200 (UTC 20:15:00 and 21:00:00), and cannot be filled.
4. **`bytecodeHash` differs from the repository build.** Root cause, proven by exact reproduction: the Docker image omits `foundry.toml`. Deployed code was compiled with solc 0.8.30, optimizer off and EVM prague; the repository build uses 0.8.24, optimizer 200 and cancun. **Implication:** "same source" does not mean "same bytecode" for anything deployed from the Render image.

---

## 7. Legacy impact and release dependencies

| Contract | Callable | Targeted by an app component | Assets/state | Admin | Release dependency | Keep for history |
|---|---|---|---|---|---|---|
| `0x982b…` | Yes (immutable) | No (DB-registered only) | 1 SOLD (in DB), 1 expired ACTIVE (not in DB); 0 AVAX | None | Old release token `0x82b26…` sales; DB volume and activity history | **Yes** |
| `0xa03b…` | Yes | No (inert in bundle; DB-registered) | 1 SOLD (in DB), 1 expired ACTIVE (not in DB); 0 AVAX | None | Same | **Yes** |
| `0xd13f…`, `0xced4…`, `0x1bc4…` | Yes | No | 0 listings, 0 AVAX | None | None | Only as audit evidence |
| `0x2287…` (V3/V1 factory) | Yes | No (bundled config only) | 0 listings | None | V1 factory has 0 releases | No dependency |

**Residual risk.** A holder of token `0x82b26…` who approves one of these marketplaces can still create listings on them. The app would not show or index those listings, and it never targets these contracts. On the old release, the expired listings' seller `0x6a86…d2fb` still has `isApprovedForAll = true` for both legacy marketplaces. Revoking that is a wallet action by the seller (owner decision; not authorized here).

**Albums and singles.**
- Every release is its own FactoryV2 clone. Release type is off-chain (`release_metadata.releaseType`: EP or ALBUM); album and single semantics exist only in source (deployed implementation `albumCapable: false`, probe run 37905878502).
- No published edition depends on a legacy marketplace:
  - **Published Fuji editions** sit on the shared V2 `0x7Bba…95B6` (production `/api/editions`).
  - **Legacy marketplaces** only ever traded the older release `0x82b26…`.
  - **Pre-album clones** `0x1AaF…` and `0x12Ff…` have no editions.
- **Ownership verification** reads ERC-1155 balances, so it is unaffected by any marketplace.
- **Mainnet risk.** On mainnet, the album redeploy creates a new factory and a new V3. Unless `deploy-marketplace.mjs` is retired or guarded, the same tooling could also create an unregistered MusicMarketplace there (it accepts `DEPLOY_NETWORK=mainnet` with `CONFIRM_MAINNET_DEPLOY=yes`).

---

## 8. Deployment-cron root cause

| Item | Finding | Evidence |
|---|---|---|
| Service | Render cron `crn-dat953e0tbcc73acrepg` ("The-Void"), docker command `npm run deploy:marketplace`, schedule `0 0 1 1 *`, auto-deploy off | Render API |
| Trigger | **All 14 runs since 2026-09-28 were manual**; the schedule never fired. 11 runs between 09-28 and 10-01 are marked `unsuccessful`, 2 are `successful` (10-04), and 1 is `canceled` (10-06, by `voidcalleroc@gmail.com`). | Render events |
| Broadcasts | **At least 5:** `0x982b`, `0xa03b`, `0xd13f`, `0xced4` and `0x1bc4`. The deployer enumeration (§11) lists every contract the key created. | Receipts |
| Source commit per reported run | `81756115` (10-04 03:58), `3a960ba2` (10-04 13:51), `0705495f` (10-06 03:14). These are pre-rewrite SHAs, still fetchable. Contract, script and `foundry.toml` blobs are identical to current `main`. | Render deploy windows, `git rev-parse <sha>:path` |
| Network and implementation selection | `DEPLOY_NETWORK` (default `fuji`). The contract is hard-coded to `contracts/MusicMarketplace.sol:MusicMarketplace`. The token is pinned to `0x82b26…` on Fuji. | `scripts/deploy-marketplace.mjs:10-60,78-90` |
| Can it deploy an outdated implementation? | **Yes, by design.** It always deploys the legacy MusicMarketplace, never V3, and compiles without repository settings. | Same |
| Owner authorization | None beyond whoever can trigger the cron. The key lives in the Render env. Mainnet only needs one extra env flag. | Same |
| Registration and parity checks | None. The output record is written inside the ephemeral container. | `deploy-marketplace.mjs:260-270` |
| Key | The deployer `0xaBd3…c174` is also the repo's `FUJI_E2E_WALLET` and a former artist `owner_wallet` (migration 032). It deployed FactoryV2 and V3 as well. | Probe; `server/production-gate-readiness.test.js:24` |

**Proposed safeguards** (none implemented; each needs owner approval):
1. Retire the legacy path: delete the cron service and remove `deploy:marketplace` from `package.json`, or make the script refuse to run without a manifest-registration step.
2. Use a single deploy path, the reviewed `workflow_dispatch` with typed confirmation (already the V3 path). Post-deploy, assert `registry()`, the fee and the chain, then commit the manifest (#142 adds the artifact and immutable record).
3. Add a canonical-version assertion: refuse to deploy unless the artifact fingerprint matches an allow-list (like `scripts/data/marketplace-fingerprints.json`).
4. Copy `foundry.toml` into the image, or build with an explicit `--optimizer-runs 200 --use 0.8.24`, so deployed bytecode is reproducible.
5. Rotate `0xaBd3…`. Use a dedicated deployer key held only in the GitHub environment secret with required reviewers, never in Render.
6. API: restrict `assertRegisteredMarketplace` to the configured canonical marketplace(s) per chain, or mark legacy rows `metadata.status = 'LEGACY'` and reject them for new submissions. This is a code PR, not a DB edit.

---

## 9. Mainnet implications

| Item | Status |
|---|---|
| Mainnet marketplace, factory or manifest | NOT STARTED (`config/mainnet-release.json`: `deployed: false`, no marketplace) |
| Album/single implementation | BLOCKED on the redeploy decisions (D1–D5 in `ALBUM-SINGLE-REDEPLOY-AND-ACCEPTANCE.md`) |
| Legacy deploy path can create an unregistered mainnet marketplace | OPEN (safeguards 1–3) |
| Deployer key hygiene | OPEN (safeguard 5) |
| Reproducible bytecode | OPEN (safeguard 4) |
| Fuji state preservation | Mainnet does not need any Fuji migration. Legacy Fuji contracts stay immutable and historical; the new manifest is per-chain. |

**Mainnet readiness: BLOCKED.**

---

## 10. Open questions and owner decisions

| # | Decision | Recommendation |
|---|---|---|
| M1 | Retire `scripts/deploy-marketplace.mjs` and delete the suspended cron? | Yes. V3 is the only designed resale path. |
| M2 | Rotate deployer `0xaBd3…c174`, which is shared by the cron, the GitHub workflow and E2E tests? | Yes, before any broadcast (supersedes D5). |
| M3 | Mark `0x982b…` and `0xa03b…` as LEGACY in the API (code change) while keeping their history? | Yes |
| M4 | Ask seller `0x6a86…d2fb` to revoke approvals for the legacy marketplaces? | Optional; the listings are expired and Fuji-only. |
| M5 | Delete the unused Vercel `VITE_FUJI_LISTING_*` variables? | Yes. It also removes `0xa03b` from the bundle. |
| U1 | ~~Byte identity of the MusicMarketplace deployments~~ | **Resolved:** exact rebuild (§3) |
| U2 | Full DB `contracts` and `listings` contents | Needs read-only DB access |
| U3 | Render `INDEXER_CONTRACTS_JSON` and `MARKETPLACE_ADDRESS` values | Needs a secure dashboard export |

---

## 11. Deployer enumeration

__DEPLOYER_SECTION__

---

## 12. Reproduction (read-only)

```bash
# Any machine with Fuji RPC access, or run the "Fuji read-only release probe" workflow
node scripts/fuji-release-capability-probe.mjs
node scripts/fuji-marketplace-reconciliation-probe.mjs
DEPLOYER=0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174 node scripts/fuji-deployer-audit.mjs
# Render: cron run history (events API) and run logs for crn-dat953e0tbcc73acrepg
# Production API: GET /api/listings?chainId=43113&status=SOLD ; GET /api/indexer/health?chainId=43113
```

Fingerprint table: `scripts/data/marketplace-fingerprints.json`. It was self-tested: all 5 repository-setting builds identify uniquely after randomizing immutables and metadata.
