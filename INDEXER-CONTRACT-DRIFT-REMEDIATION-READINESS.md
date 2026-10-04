# The Void — Indexer Contract Drift Remediation Readiness

**Audit date:** 2026-10-04 00:42 EDT  
**Repository:** `VoidcallerOC/The-Void` at `1cd67c5` (`main`)  
**Mode:** Read-only readiness analysis; no changes executed

## STATUS

**PARTIAL**

The exact replacement for the release and primary-sale entries, checkpoint semantics, start blocks, database coexistence behavior, API dependency, and user-flow impact are established from source and live read-only evidence.

The complete current production `INDEXER_CONTRACTS_JSON` cannot be recovered because Render stores it as `sync: false` and no Render dashboard/runtime credential is available. The existing marketplace object—including its exact `startBlock`, `platformFeeBps`, and any optional fields—must therefore be preserved from the live secret rather than guessed.

## CURRENT CONFIG

### Proven schema

`server/config.js:77-100` parses `INDEXER_CONTRACTS_JSON` as an array. Every entry requires:

- `chainId` — must equal `INDEXER_CHAIN_ID`;
- `address` — normalized lowercase 20-byte address;
- `contractType` — `ERC1155`, `MARKETPLACE`, `PRIMARY_SALE`, `PRIMARY_SALE_V2`, or `COLLECTION_FACTORY`;
- `startBlock` — required non-negative integer.

A `PRIMARY_SALE` entry additionally requires:

- `tokenAddress` — the paired ERC-1155 release address, and it must differ from the sale address.

Optional fields include:

- `platformFeeBps`;
- `reconcileListings`.

Event filters are **derived automatically** from `contractType`; they are not JSON fields. Contract names and deployment transaction IDs are also not part of this environment-variable schema. The parser adds the configured sale addresses as `skipMintOperators` on each ERC-1155 entry.

### Live old configuration fields that are proven

The exact secret is not exposed, but the API/indexer runtime and historical deployment records prove this active pair:

```json
[
  {
    "chainId": 43113,
    "address": "0x82b26da27136935454bdf1e40801190b521b82e5",
    "contractType": "ERC1155",
    "startBlock": 58761820
  },
  {
    "chainId": 43113,
    "address": "0xcc26cd6d6dc25654652d1fbb64db5f61e20f60f1",
    "contractType": "PRIMARY_SALE",
    "tokenAddress": "0x82b26da27136935454bdf1e40801190b521b82e5",
    "startBlock": 58761822
  },
  {
    "chainId": 43113,
    "address": "0x982b28352fd612fe934c5e1ad8fea399689190d2",
    "contractType": "MARKETPLACE",
    "startBlock": "<existing live value — not available in sandbox>"
  }
]
```

The marketplace address is visible in live checkpoint health, but the complete marketplace object and its exact start block are not exposed by the health endpoint.

## PROPOSED CONFIG

The safe replacement is to change only the release/sale pair and preserve the marketplace object byte-for-byte from the existing Render secret:

```json
[
  {
    "chainId": 43113,
    "address": "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6",
    "contractType": "ERC1155",
    "startBlock": 59015108
  },
  {
    "chainId": 43113,
    "address": "0x51ccd2d5cd71368917f1efe3fa43fab8068e1aba",
    "contractType": "PRIMARY_SALE",
    "tokenAddress": "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6",
    "startBlock": 59015114
  },
  {
    "address": "0x982b28352fd612fe934c5e1ad8fea399689190d2",
    "contractType": "MARKETPLACE",
    "chainId": 43113,
    "startBlock": "<copy existing live value unchanged>",
    "<copy any existing optional marketplace fields unchanged>": "..."
  }
]
```

The lowercase form above matches `server/config.js` normalization. The user-facing replacement should retain the existing marketplace object exactly; inventing its start block or optional fields would be unsafe.

### Fields that change

| Entry | Field | Old | Proposed |
|---|---|---|---|
| ERC-1155 | `address` | `0x82b26…` | `0x7Bba…` |
| ERC-1155 | `startBlock` | `58761820` | `59015108` |
| Primary sale | `address` | `0xcc26…` | `0x51cC…` |
| Primary sale | `tokenAddress` | old release | current release |
| Primary sale | `startBlock` | `58761822` | `59015114` |
| All entries | `chainId` | `43113` | unchanged |
| All entries | `contractType` | unchanged | unchanged |
| Marketplace | all fields | unchanged | unchanged |

The event filters change implicitly because the new entries retain the same `contractType` values. No contract name or deployment transaction field is accepted by this environment-variable parser.

## API CONFIG SOURCE

The API reads the indexer configuration from the same process environment:

```text
server/index.js:40
→ loadIndexerConfig(process.env, { requireConfiguration: false })
→ ApiService.indexerConfig
→ getIndexerHealth()
→ reportIndexedContracts()
→ /api/health/ready
```

The API does **not** read `config/fuji-release.json` for its runtime indexer health addresses. Its catalog SQL does separately import canonical contract scope through `server/fuji-contract-scope.js`:

```text
server/api-service.js:208-216
→ certifiedContractParams()
→ current release address from config/fuji-release.json
→ database joins only tokens on the current canonical release contract
```

This combination explains the split: API health reports the old configured/indexed pair, while API catalog queries filter for the current pair and can return no current edition if the database has not been indexed/populated for it.

## WORKER CONFIG SOURCE

The worker uses the same schema and environment variable independently:

```text
server/indexer-worker.js:147
→ loadServerConfig()
→ loadIndexerConfig()
→ createProductionIndexerWorker()
→ BlockchainIndexer({ configs: indexerConfig.contracts })
```

Render declares `INDEXER_CONTRACTS_JSON` separately on both the API and worker services, each with `sync: false`. The exact worker secret value is not inspectable from this sandbox. However, the live checkpoint rows actively advancing for the old release and old sale prove that the operational indexer projection is currently old-pair based.

## CHECKPOINT KEY

**Primary key:** `(chain_id, contract_address)`

Evidence:

- `server/migrations/003_indexer_state.sql:3-15`:

```sql
PRIMARY KEY (chain_id, contract_address)
```

- `server/indexer-store.js:29` reads by `chain_id` and `contract_address`.
- `server/indexer-store.js:36` writes with `ON CONFLICT (chain_id, contract_address)`.

Checkpoints are **not** keyed by deployment transaction, deployment ID, event stream name, or arbitrary configuration ID.

## CHECKPOINT BEHAVIOR

When the contract address changes from old to current:

1. `BlockchainIndexer.syncContract()` calls `getCheckpoint({ chainId, address })`.
2. No row exists for the new address.
3. `storedNextBlock()` falls back to the new entry’s `startBlock`.
4. `setCheckpoint()` inserts a new `(chain_id, current_address)` row.
5. The indexer scans from the new start block to the finalized target.
6. The old `(chain_id, old_address)` checkpoint remains in the database unless separately archived/deleted.

Therefore behavior is:

- **A — automatically creates a new checkpoint** for the new address;
- old checkpoint is retained;
- no explicit checkpoint reset is needed for the new address;
- the new checkpoint must still be validated operationally after configuration change.

The indexer will not incorrectly reuse the old checkpoint because the address is part of the lookup key.

Changing only `startBlock` while keeping the same address is different: the persisted `next_block` wins over the configured start block. A deliberate rewind would require explicit reorg/rewind handling and is not part of this proposed address replacement.

## CURRENT CONTRACT DEPLOYMENT BLOCKS

| Contract | Address | Deployment transaction | Deployment block |
|---|---|---|---:|
| Current ERC-1155 release | `0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6` | `0x14dd51d90520a901200997b2233c7fb02fa42a6368188a4d879a72354b168c91` | `59015108` |
| Current primary sale | `0x51cCD2d5Cd71368917f1EFe3fa43Fab8068E1aBA` | `0xc7525c83dbfa694578b199ccf41c27d88d967eb9bbfe585916e7197c12dfdbec` | `59015114` |

Both deployment receipts were independently verified on Fuji with successful status.

## REQUIRED START BLOCK

### Release entry

**Required start block: `59015108`**, the current ERC-1155 deployment block.

The earliest relevant current release event found by direct Fuji RPC was:

- `EditionCreated` at block `59022633`;
- transaction `0x6a9d4564e4af6f810ee5416a39c294134d9de74311f55aab8d84676d3c0ad772`.

Starting at deployment block safely includes constructor/deployment-adjacent and all subsequent release events without replaying the entire Fuji chain.

### Primary-sale entry

**Required start block: `59015114`**, the current primary-sale deployment block.

The current sale configuration event was independently observed at block `59022663` in the prior live chain audit. Starting at deployment block safely includes it and any earlier initialization/configuration events.

### Current old checkpoints

Live `/api/health/ready` showed old-pair checkpoint state near the current chain head:

- old release checkpoint around `59024097`;
- old sale checkpoint around `59024097`;
- chain ID `43113`.

These are old-address checkpoint rows and will not be reused for the new addresses.

## DATABASE PROJECTION BEHAVIOR

### Contract and token identity

The database is designed to let old and current deployments coexist:

- `contracts` has `UNIQUE (chain_id, address)` (`001_initial_persistence.sql:40-55`).
- `tokens` has `UNIQUE (contract_id, token_id)` (`001_initial_persistence.sql:73-85`).
- `editions` reference a `contract_id`; edition IDs are globally primary-keyed, so the same logical edition ID must not be inserted twice.
- `ownership_snapshots` is keyed by `(chain_id, contract_address, token_id, wallet_address)`.
- `blockchain_events` is keyed by `(chain_id, contract_address, transaction_hash, log_index)`.
- `primary_sale_projections` is keyed by `(chain_id, sale_address, transaction_hash, log_index)`.

The new current release/sale addresses therefore create distinct contract/checkpoint/event/token/ownership identities and do not overwrite old-address rows merely because the chain ID is the same.

### Primary purchases and transactions

`primary_purchases` has a unique key `(chain_id, transaction_hash, log_index)`, while sale and token contract addresses are stored as columns. Since the current deployment’s transactions are distinct from the old deployment’s transactions, normal indexing should coexist without duplicate-key conflicts. The marker table includes `sale_address`, providing an additional sale-specific identity for projection idempotency.

### Safety conclusion

Based on schema and write paths, indexing the current pair will:

- create new contract rows/checkpoint rows where absent;
- coexist with old contract/event/ownership rows;
- not overwrite old projections by address;
- not require a schema migration;
- not require deleting old rows merely to begin current indexing.

However, old rows can still affect public behavior if query paths do not filter to the current canonical contract. The API catalog does filter token joins to the current canonical release, while generic collector/activity and marketplace queries are more address/data dependent.

A later archival/cleanup decision is separate and should not be combined with the initial configuration correction.

## API DEPENDENCY

| API behavior | Configuration source |
|---|---|
| Indexer health contract addresses | `INDEXER_CONTRACTS_JSON` parsed by `loadIndexerConfig()` |
| Public edition token join | `config/fuji-release.json` through `server/fuji-contract-scope.js` |
| Public release rows | Database release/artist status; no direct contract filter at release-only lookup |
| Listings | Database `contracts` rows and requested chain/address filters |
| Collector/ownership activity | Database indexed transfers/ownership/purchase rows |
| Studio catalog | Authenticated API/database response plus Studio’s current direct-chain reads |

API and worker do not derive their indexer contract list from the deployment manifest. Studio does.

## AFFECTED USER FLOWS

| Flow | Classification | Reason |
|---|---|---|
| Public catalog | **POTENTIALLY INCORRECT** | API catalog joins tokens only on the current canonical address; old-only indexer state can make current Fuji editions absent. |
| Release pages | **POTENTIALLY INCORRECT** | `/api/releases/forgive-forget-23` currently returns `404`; direct chain confirms the current release exists. Release lookup is database-backed. |
| Sale status | **SPLIT** | Studio direct RPC sale status is **CORRECT**; API health reports old sale contract and is potentially incorrect for current Fuji. |
| Ownership / collector | **POTENTIALLY INCORRECT** | Fuji ownership snapshots are keyed by contract address; old-address indexing cannot represent current-contract ownership. |
| Marketplace | **POTENTIALLY INCORRECT** | Old token-contract rows/listings may be indexed; current-contract listings/events are not guaranteed to be present. |
| Purchase / claim | **POTENTIALLY INCORRECT** | Current sale events are not guaranteed in old indexer projections; direct receipt verification may still succeed for individual operations. |
| Gated content | **POTENTIALLY INCORRECT** | Fuji indexed ownership is part of the ownership verifier path; current-contract holders may appear unauthorized until indexed. |
| Artist / Studio persisted data | **POTENTIALLY INCORRECT** | Studio catalog/release resume depends on API/database rows, while sale status itself is direct-chain and correct. |
| Legacy C-Chain Voidcaller flows | **CORRECT / NOT DEPENDENT** | They use the separate legacy C-Chain contract and are not the Fuji pair under remediation. |

## FORGIVE & FORGET DISCREPANCIES

### Direct Fuji RPC

Current live chain confirms:

- release `forgive-forget-23` exists on `0x7Bba…`;
- edition `forgive-forget` exists on the current release;
- token `5539478311145551066997171016458124004742133628133122798593311459807321372836` exists;
- current primary sale is on `0x51cC…` and is configured;
- current sale configuration event was observed at block `59022663`.

### Public API

Read-only public API queries showed:

- `GET /api/releases/forgive-forget-23` → `404`;
- `GET /api/editions?releaseId=release-b96d6a64-3379-4da0-b834-ae2e00bf9571` → `{"data":[]}` for the older archived identity;
- unfiltered public release/edition lists currently expose only the legacy C-Chain Voidcaller catalog;
- `/api/health/ready` reports old Fuji release/sale addresses and old-address checkpoints.

The exact authenticated `/studio/catalog` payload remains unavailable, but the public API behavior is consistent with the canonical current-contract filter finding no current indexed current-contract row.

### Exact discrepancy

```text
Direct chain: current Forgive & Forget V2/open-edition release and sale exist and are configured.
API/indexer: current API health and checkpoint projections use the prior release/sale pair;
             public API does not expose forgive-forget-23 in the observed catalog routes.
```

## REMEDIATION PLAN

**Not executed.** Minimal safe sequence:

1. Read the existing Render API and worker `INDEXER_CONTRACTS_JSON` secrets without exposing them; preserve the marketplace object exactly.
2. Replace only the release and primary-sale entries with the proposed current pair and verified start blocks `59015108` and `59015114`.
3. Apply the same replacement to both Render services; do not change `INDEXER_RPC_URL`, `INDEXER_CHAIN_ID`, marketplace fields, database, or code.
4. Restart/deploy the worker and API through the normal controlled deployment process.
5. Confirm new checkpoint rows appear for `(43113, 0x7bba…)` and `(43113, 0x51cc…)`; confirm old checkpoint rows remain unchanged.
6. Confirm the new checkpoints begin at the configured start blocks and advance to finalized blocks.
7. Confirm current `EditionCreated` and `SaleConfigured` events are indexed, including the Forgive & Forget token.
8. Confirm `/api/health/ready` reports the current release and sale addresses.
9. Confirm `/api/releases/forgive-forget-23` and current-edition API queries return the expected current records.
10. Validate ownership, marketplace, purchase, gated-content, and Studio/API agreement using read-only acceptance checks.
11. Only after validation, decide separately whether old deployment rows should remain archived or be explicitly marked historical.

## RISKS

- If the marketplace entry is accidentally omitted, marketplace indexing will stop or lose coverage.
- If the current release/sale start blocks are wrong, events may be missed or unnecessary history may be replayed.
- If a service is updated but the other is not, the split-brain state persists.
- If current database rows already exist, reindexing must rely on idempotent keys and should be observed for projection errors.
- If the current release was intentionally not meant to replace the old indexed staging deployment, updating Render would change staging semantics; deployment ownership/intention should be confirmed before execution.
- Old checkpoint rows are retained; leaving them active in the database is safe by key, but any generic query must continue to filter correctly.

## ROLLBACK PLAN

If the remediation produces unexpected results:

1. Stop the worker/API rollout through the deployment provider’s normal rollback path.
2. Restore the previously captured `INDEXER_CONTRACTS_JSON` value exactly for both services.
3. Do not delete or rewind checkpoints.
4. Restart the affected service(s) and verify old checkpoint continuity.
5. Preserve any newly created current-address checkpoint rows for forensic review; do not merge them into old-address rows.
6. Investigate projection errors before attempting another change.

No rollback action was performed in this audit.

## VERIFIED

- Environment schema and required fields traced through `server/config.js`.
- API config path traced through `server/index.js` and `server/api-service.js`.
- Worker config path traced through `server/indexer-worker.js`.
- Checkpoint primary key proven to be `(chain_id, contract_address)`.
- New-address behavior proven from `getCheckpoint`, `storedNextBlock`, and `ON CONFLICT` write paths.
- Current deployment blocks and deployment receipts verified on Fuji.
- Earliest current release `EditionCreated` event observed at block `59022633`.
- Current sale configuration event observed at block `59022663`.
- Database contract/token/event/ownership/projection uniqueness constraints inspected.
- Live old checkpoint addresses and active run timestamps observed through `/api/health/ready`.
- Live API `forgive-forget-23` query returned `404`.
- Previous audit’s Studio direct-chain sale correctness remains settled.

## UNVERIFIED

- Complete current production API and worker `INDEXER_CONTRACTS_JSON` secret values.
- Existing marketplace `startBlock`, `platformFeeBps`, and optional fields in the Render secret.
- Complete production database row inventory for old/current/both contract identities.
- Whether the current pair’s database rows exist but are hidden by public API status/withdrawal filters.
- Whether the operator intentionally wants to retain the old pair as a parallel staging index.
- Exact authenticated Studio catalog payload.

## BLOCKERS

1. Render dashboard access is required to capture and update the complete secret safely.
2. Read-only production database access is required to inventory current/old projections before execution.
3. Operator confirmation is required before changing the live Render-managed runtime configuration, because this readiness task explicitly forbids executing remediation.

## DO NOT REDO

- Do not modify Studio’s direct primary-sale read or configured boolean.
- Do not deploy, restart, update Render, write database state, create/reset checkpoints, run migrations, or clean old rows in this task.
- Do not guess the marketplace start block or optional fields.
- Do not reuse old checkpoint rows for the new addresses; the indexer will create distinct rows automatically.
- Do not delete old checkpoints as part of the initial correction.
- Do not treat the current on-chain Forgive & Forget sale as invalid because the API/indexer is stale.

## NEXT ACTION

**Capture the complete existing `INDEXER_CONTRACTS_JSON` from both Render services and prepare an operator-reviewed replacement that changes only the release/sale addresses, paired token address, and verified start blocks while preserving the marketplace object exactly.**

This action is recommended but **not executed**.
