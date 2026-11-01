# The Void — Production Contract Address Drift Audit

**Audit date:** 2026-10-04 00:40 EDT  
**Repository:** `VoidcallerOC/The-Void` at `1cd67c5` (`main`)  
**Scope:** Fuji release and primary-sale contract configuration across API, indexer/worker, Studio, deployment history, and live chain

## STATUS

**PARTIAL**

The drift is proven active for the public API/indexer projection, but the exact secret `INDEXER_CONTRACTS_JSON` values configured in the separate Render API and worker dashboards, and the full production database contents, are not directly inspectable from this sandbox. No code, deployment, environment, database, checkpoint, or service changes were made.

## CANONICAL RELEASE CONTRACT

`0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6`

## CANONICAL PRIMARY-SALE CONTRACT

`0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA`

## CHAIN

Avalanche Fuji — chain ID `43113`

## OLD RELEASE CONTRACT

`0x82b26Da27136935454Bdf1e40801190B521b82e5`

## OLD PRIMARY-SALE CONTRACT

`0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1`

## EXECUTIVE FINDING

This is an **active split-brain configuration**:

| Runtime path | Release contract | Primary-sale contract | Chain | Evidence |
|---|---|---|---:|---|
| **API** | Old `0x82b26…` | Old `0xcc26…` | `43113` | Live `/api/health/ready`; API reports its loaded `indexerConfig.contracts` and indexed contracts |
| **Indexer/worker projection** | Old `0x82b26…` | Old `0xcc26…` | `43113` | Live checkpoints and contract rows returned by `/api/health/ready`; current successful runs are advancing those old-contract checkpoints |
| **Studio** | Current `0x7Bba…` | Current `0x51cC…` | `43113` | `config/fuji-release.json` imported by `src/lib/fuji-release.js`; direct Studio RPC reads use this config |
| **Deployment manifest in repository** | Current `0x7Bba…` | Current `0x51cC…` | `43113` | `config/fuji-release.json`, updated by commit `5c50b20` |

The old pair is therefore **not dead or unused**. It is actively used by the public API/indexer data path.

## PHASE 1 — WHERE THE ADDRESSES EXIST

### Runtime/canonical configuration sources

| Source | Address | Purpose | Runtime used? | Canonical? |
|---|---|---|---|---|
| `config/fuji-release.json:8` | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | Current Fuji V2 ERC-1155 release | Yes, imported by Studio and server contract-scope modules | Yes |
| `config/fuji-release.json:12` | `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA` | Current Fuji primary sale | Yes, imported by Studio sale reads | Yes |
| `render.yaml` API `INDEXER_CONTRACTS_JSON` | Secret/sync-false; value not committed | API-side indexer contract list | Yes; live API reports old pair | No — stale runtime value |
| `render.yaml` worker `INDEXER_CONTRACTS_JSON` | Secret/sync-false; value not committed | Worker/indexer contract list | Operationally evidenced as old pair through live checkpoints; exact worker secret value unverified | No — stale runtime value |
| `server/config.js:145-176` | Reads `INDEXER_CHAIN_ID`, `INDEXER_RPC_URL`, `INDEXER_CONTRACTS_JSON` | Runtime indexer configuration parser | Yes | Not an address source by itself |
| `server/api-service.js:151-173` | Uses `this.indexerConfig.contracts` and checkpoint rows | API health contract reporting | Yes | Reports whatever runtime config/checkpoints contain |
| `src/lib/fuji-release.js:2-5` | Imports `config/fuji-release.json` | Studio/runtime client contract config | Yes | Yes |

### Old address occurrences

The old pair appears in several categories:

| Location/category | Old address usage | Classification |
|---|---|---|
| Git history: commit `755d8c8` | Old pair was written into `config/fuji-release.json` as the deployed V2 release/sale | Previous deployment, now superseded |
| Git history: commits before `5c50b20` | Old pair was the then-current canonical Fuji V2 pair | Previous deployment |
| `server/voidcaller-alias-archive.test.js` | Old release and sale used in archival/alias test fixture | Historical/archival fixture |
| `scripts/ops/voidcaller-alias-archive/01-precheck.sql` and `03-postcheck.sql` | Old release address in guarded archive checks | Historical/archival operational script; not runtime startup config |
| `src/data.js` | Old release as the CATALOG/volume identity for the legacy Voidcaller fixture | Historical or legacy catalog data; not Studio’s current Fuji V2 config |
| `scripts/deploy-marketplace.mjs` and `scripts/deploy-marketplace-signer.test.mjs` | `FUJI_CANONICAL_TOKEN` defaults/guards still use old release | Deployment/tooling drift; potentially dangerous if those scripts are run, but not executed in this audit |
| Several unit/integration tests | Old address as fixture input or legacy path | Test fixture, not production runtime |
| Public Render runtime | Old release and sale in active API/indexer configuration | **Active production/staging runtime drift** |

The repository search also found other old-address tests for API/public-catalog, marketplace, purchase, reliquary, and edition rendering. Those are fixtures or legacy behavior tests unless explicitly invoked by a deployment/runtime process.

## PHASE 2 — RUNTIME CONFIGURATION TRACE

### API

```text
Render API service secret INDEXER_CONTRACTS_JSON
→ server/config.js:145-176 loadIndexerConfig()
→ server/api-service.js receives indexerConfig
→ getIndexerHealth() selects indexerConfig.contracts
→ reportIndexedContracts({ indexed, configured })
→ /api/health/ready
```

Live evidence from `https://the-void-api-fuji.onrender.com/api/health/ready`:

```json
{
  "chain_id": "43113",
  "contracts": [
    { "type": "ERC1155", "address": "0x82b26da27136935454bdf1e40801190b521b82e5" },
    { "type": "PRIMARY_SALE", "address": "0xcc26cd6d6dc25654652d1fbb64db5f61e20f60f1" }
  ]
}
```

The endpoint also reports those same addresses under `contracts.release.address` and `contracts.primarySale.address`. This proves the API’s live runtime/indexer health projection is old-pair based.

### Indexer/worker

```text
Render worker secret INDEXER_CONTRACTS_JSON
→ server/config.js:145-176 loadIndexerConfig()
→ createProductionIndexerWorker()
→ BlockchainIndexer({ configs: indexerConfig.contracts })
→ indexer checkpoints / contracts tables
→ API reads checkpoint health
```

The live API readiness response reports current, advancing checkpoints for:

- old ERC-1155 contract `0x82b26…`;
- old primary-sale contract `0xcc26…`;
- the API’s own marketplace contract.

The checkpoint record had a successful run timestamp at audit time and a current indexed block near the chain head for those contract entries. This is active indexing evidence, not merely a stale database row.

**Exact worker dashboard secret value:** **UNVERIFIED**. `render.yaml` marks `INDEXER_CONTRACTS_JSON` as `sync: false`, and no Render-management credential or environment inspection was available. The operational checkpoint evidence nevertheless establishes that the indexed projection currently tracks the old pair.

### Studio

```text
config/fuji-release.json
→ src/lib/fuji-release.js imports deployment JSON
→ ArtistStudioPage.jsx / primary-sale.js
→ direct Fuji RPC calls
```

Studio uses the current pair:

- Release: `0x7Bba…95B6`
- Sale: `0x51cC…1aBA`
- Chain: `43113`

The previous audit already established that the Studio primary-sale UI is correct for the current published token. This audit does not revisit or modify that behavior.

### Deployment scripts/configuration

The committed canonical manifest was changed by commit `5c50b20`:

```text
old release 0x82b26… → current release 0x7Bba…
old sale    0xcc26… → current sale    0x51cC…
```

The Render blueprint was not changed to include literal addresses. It intentionally leaves `INDEXER_CONTRACTS_JSON` as a dashboard-managed secret (`sync: false`). That created the possibility for the Render runtime to remain on the prior pair after the repository manifest moved forward.

## PHASE 3 — INDEPENDENT CANONICAL DEPLOYMENT EVIDENCE

The current pair is independently established on Avalanche Fuji, not only by repository comments:

| Contract | Address | Deployment transaction | Block | Live bytecode |
|---|---|---|---:|---:|
| Current release | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `0x14dd51d90520a901200997b2233c7fb02fa42a6368188a4d879a72354b168c91` | `59015108` | 10,310 bytes; keccak `0x67770fc82259050f0db0d6e7545298aeb79e7454a37529bf6ab5b5a9cf010770` |
| Current primary sale | `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA` | `0xc7525c83dbfa694578b199ccf41c27d88d967eb9bbfe585916e7197c12dfdbec` | `59015114` | 4,331 bytes; keccak `0x9c172bda04f5d12cbb020070d13aa297d7c93e6ef646179afc82137bbfabe8db` |

Read-only RPC validation showed:

- Chain ID is `43113`.
- Both deployment receipts exist and have `status: 1`.
- The current sale’s `releases()` immutable/configured pointer returns the current release address exactly: `0x7Bba…95B6`.
- The current sale’s `platformRecipient()` and `platformFeeBps()` return the expected configured values.
- The live current release contains the Forgive & Forget V2 edition/token used by Studio.

The old pair is also independently proven to be a real prior deployment, not a typo:

| Contract | Address | Deployment transaction | Block | Live bytecode |
|---|---|---|---:|---:|
| Old release | `0x82b26Da27136935454Bdf1e40801190B521b82e5` | `0x7a5ac3594d52615dca9368090e4180090b18dfadb9ee9b4f0b780cee31bfd627` | `58761820` | 10,331 bytes; keccak `0x4260f41d196db1978e3c2d9e290c2d372f9f7c5539fb553917371f3ebd765cca` |
| Old primary sale | `0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1` | `0xac50233cfc711e1635d9c4d51b2091fa89640d9e0c41470ea689abbb6018928c` | `58761822` | 4,196 bytes; keccak `0xa6c24b1b74fe848a34c12b4450478e3e772ed8d2f4fb97e6cfbff177199c98de` |

The old sale’s `releases()` pointer returns the old release address exactly. This confirms a coherent **previous release/sale deployment pair**, not a random stale address.

## PHASE 4 — IS THE DRIFT HARMFUL?

### API path

**Answer: Yes, potentially.**

The API’s operational health and indexer contract reporting describe the old pair as the active Fuji contracts. Public API catalog projections can therefore:

- omit current-release editions/tokens created on `0x7Bba…`;
- report stale/old contract identity;
- expose old sale/indexer health as if it were current;
- fail to project current `SaleConfigured`/purchase/transfer events from `0x51cC…`.

The public API listing observed during this audit contained only the legacy C-Chain Voidcaller release, not the current Fuji Forgive & Forget release. This is consistent with the API/indexer being split from Studio, but does not by itself prove that every current database table is empty.

### Indexer/worker path

**Answer: Yes, for data integrity of indexed Fuji projections.**

The indexer is actively advancing old-contract checkpoints. It cannot discover current-contract events if current contracts are not registered in `INDEXER_CONTRACTS_JSON`. Current events and ownership/sale projections can therefore be absent or incomplete in the indexer-backed database.

### Studio path

**Answer: No for the audited primary-sale status.**

Studio reads the current contract directly from Fuji RPC, so it correctly sees the current token’s configured sale even while the API/indexer is old.

### Severity

This is a **specific staging/production-data consistency issue**, not evidence of corrupted on-chain state or a false Studio sale claim. The split affects API/indexer-backed catalog, ownership, listing, and sale projections; it does not alter the deployed contracts or current on-chain sale state.

## PHASE 5 — DATABASE / INDEXER STATE

### Verified

The live API readiness endpoint shows indexed checkpoint/contract projections for:

- old ERC-1155 release `0x82b26…`;
- old primary sale `0xcc26…`;
- marketplace `0x982b…`;
- chain `43113`.

It reports current successful indexer runs against those old contract entries.

### Not directly verified

The full production database contents were not queried because no direct database credential was available in the sandbox and the task prohibited guessing credentials. In particular, this audit cannot directly enumerate every row in:

- `contracts`;
- `releases`;
- `editions`;
- `tokens`;
- sale/event projection tables;
- ownership snapshots.

Therefore the exact answer to “old/current/both in every table” is **UNVERIFIED**. The checkpoint layer is definitively old-pair based; the public API catalog currently exposes no current Fuji Forgive & Forget row in the unauthenticated listing observed.

## PHASE 6 — API / WORKER / STUDIO MATRIX

| | API | WORKER / INDEXER | STUDIO |
|---|---|---|---|
| Release contract | `0x82b26…` — live `/api/health/ready` reports API-configured/indexed address | `0x82b26…` — active checkpoint contract; exact worker secret unverified | `0x7Bba…` — imported from `config/fuji-release.json` |
| Sale contract | `0xcc26…` — live `/api/health/ready` reports API-configured/indexed address | `0xcc26…` — active checkpoint contract; exact worker secret unverified | `0x51cC…` — imported from `config/fuji-release.json` |
| Chain ID | `43113` | `43113` | `43113` |
| Data authority | Database/indexer projection | Fuji event/indexer projection | Direct Fuji RPC for sale state; API catalog for persisted resume data |

**Conclusion:** the system is currently split-brain across API/indexer and Studio.

## PHASE 7 — WHY THE OLD CONTRACTS EXIST

The evidence supports the following explanation:

1. Commit `755d8c8` adopted the old pair as the deployed Fuji V2 release/sale:
   - old release deployed at block `58761820`;
   - old sale deployed at block `58761822`;
   - old sale points to old release.
2. Commit `5c50b20` later adopted a new open-edition release/sale pair:
   - current release deployed at block `59015108`;
   - current sale deployed at block `59015114`;
   - current sale points to current release.
3. The committed frontend/canonical manifest was updated to the current pair.
4. Render’s `INDEXER_CONTRACTS_JSON` remained dashboard-managed (`sync: false`) and was not updated through the repository blueprint.
5. The live API/indexer continues to report and checkpoint the old pair.

This makes **previous deployment plus stale Render-managed indexer configuration** the evidence-based root cause. The exact dashboard change history is unavailable, so whether the secret was never updated, intentionally retained, or updated only for one service remains unverified.

## ROOT CAUSE

**The current canonical Fuji deployment was changed in repository configuration from the old V2 pair to a newer open-edition pair, but the Render-managed `INDEXER_CONTRACTS_JSON` runtime configuration remained on the previous pair.**

The repository cannot itself prove the exact secret value because the Render blueprint intentionally excludes it with `sync: false`; live API health and indexed checkpoints prove the effective old runtime behavior.

## DRIFT TYPE

**Active / split-brain / previous-deployment drift**

It is not stale-only, because the old pair is actively reported and indexed. It is not merely historical, because current API health and checkpoints use it. It is not an on-chain redeployment ambiguity: both pairs exist on Fuji, and each sale points coherently to its corresponding release.

## USER-FACING IMPACT

**Specific impact:** API/indexer-backed users can receive stale or incomplete Fuji catalog, sale, ownership, listing, and health data for the current V2/open-edition release. Studio’s direct sale-status display remains correct for the current published token.

## DATA-INTEGRITY IMPACT

**Specific but bounded impact:** current contract events are not guaranteed to be represented in the old-contract indexer projections. This can cause missing current-release rows/events or stale health/readiness reporting. No evidence shows on-chain data corruption or modification of the current contracts.

## CURRENT FORGIVE & FORGET

The current live Forgive & Forget release is associated with:

- release contract `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6`;
- primary sale contract `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA`;
- chain `43113`;
- release `forgive-forget-23`;
- edition `forgive-forget`;
- token `5539478311145551066997171016458124004742133628133122798593311459807321372836`.

The old pair is associated with the previous Fuji V2 deployment and prior indexed/projection history, not the current on-chain Forgive & Forget token.

The exact production database row association for current Forgive & Forget is **UNVERIFIED** because direct database access was not available.

## CHANGES

**NONE — this was audit only.**

No environment variables, Render settings, services, workers, checkpoints, databases, migrations, contracts, APIs, Studio code, or deployments were modified.

## VERIFIED

- Exact old and current addresses found in repository history and current config.
- Runtime loader path traced through `server/config.js`.
- API health path traced through `server/api-service.js`.
- Studio path traced through `src/lib/fuji-release.js` and `config/fuji-release.json`.
- Live public API health reports old release and sale addresses.
- Live indexer checkpoints actively advance old release and sale addresses.
- Both old and current pairs independently verified on Fuji chain `43113`.
- Both deployment receipts exist with successful status.
- Current sale `releases()` points to current release.
- Old sale `releases()` points to old release.
- Git history proves the old pair preceded the current open-edition pair.
- Repository blueprint leaves indexer contract configuration Render-managed and unsynchronized (`sync: false`).
- Previous audit’s Studio primary-sale correctness finding remains settled and unchanged.

## UNVERIFIED

- Exact Render dashboard secret values for the separate API and worker services.
- Whether API and worker dashboard values are byte-for-byte identical, although the shared active checkpoint projection is old-pair based.
- Complete production database contents across contracts, releases, editions, tokens, sale events, and ownership snapshots.
- Whether any current-pair indexer rows exist outside the publicly exposed catalog/checkpoint views.
- Render variable-change history or the operator’s intended reason for retaining the old pair.

## BLOCKERS

1. Direct Render environment inspection is unavailable; `INDEXER_CONTRACTS_JSON` is secret/sync-false.
2. Direct production database credentials are unavailable; full row-level old/current/both classification cannot be completed.
3. The worker’s exact loaded environment cannot be independently queried from the API endpoint; active old-pair checkpoint behavior is the available runtime evidence.

## DO NOT REDO

- Do not revisit or modify the Studio primary-sale UI.
- Do not force `configured` false or replace the direct chain read with stale API/database state.
- Do not treat `0x82b26…` / `0xcc26…` as random invalid addresses; they are a real previous Fuji deployment pair.
- Do not treat the old pair as merely historical; it is actively used by the current API/indexer projection.
- Do not change environment variables, restart services, alter checkpoints, modify the database, redeploy, or modify contracts as part of this audit.

## NEXT ACTION

**Update the Render-managed `INDEXER_CONTRACTS_JSON` for both the API and worker services to the current Fuji release/sale pair—using the verified current deployment blocks and preserving the marketplace entry—then run a read-only health/checkpoint/catalog validation before any data rebuild or backfill.**

This remediation is recommended but was **not executed**.
