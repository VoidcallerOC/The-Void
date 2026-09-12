# The-Void Fuji Staging Certification

**Date:** 2026-09-12
**Repository:** `VoidcallerOC/The-Void`
**Branch:** `main`
**Decision:** **FUJI NOT CERTIFIED**

This report separates repository/runtime evidence from deployment evidence. No contract addresses, transaction hashes, credentials, database records, Render status, or checkpoints were invented.

## Certification matrix

| Area | Status | Evidence and limits |
|---|---|---|
| API | **YELLOW** | Local `createApiServer` probe returned valid JSON and HTTP 200 for `GET /api/health`. The dependency-aware readiness endpoint correctly returned HTTP 503 because no database was configured. A deployed Fuji API endpoint was not available for live verification. |
| Database | **RED** | The code, migrations, and database wiring are present, but no dedicated Fuji PostgreSQL/Supabase `DATABASE_URL` was available. Migrations, table existence, persistence writes, and API/worker database access could not be executed. |
| Indexer | **YELLOW** | `createIndexerWorker` validates Fuji RPC configuration and chain ID `43113`; local worker construction succeeded with a test pool. Retry, checkpoint, duplicate-event, reorg, and reconciliation behavior are covered by the repository test suite. No live worker process or Render worker logs were available. |
| RPC | **GREEN** | Live `https://api.avax-test.network/ext/bc/C/rpc` responded successfully. `eth_chainId` returned `0xa869` (`43113`), and `eth_blockNumber` returned `0x37a1905`; both values are recorded exactly as returned. |
| Checkpointing | **YELLOW** | Checkpoint persistence, restart/resume, duplicate handling, failure marking, and reorg foundations are verified in code and tests. No live database checkpoint or restart cycle could be observed without the Fuji database. |
| Vercel API routing | **YELLOW** | `vercel.json` contains routes for `/api/health`, `/api/health/ready`, `/api/indexer/tick`, and nested `/api/*` paths. Local handler tests passed. A deployed Vercel routing request was not executed in this run. |
| Render runtime | **RED** | `render.yaml` defines separate `the-void-api-fuji` web and `the-void-indexer-fuji` worker services, both configured for Fuji RPC and chain ID `43113`. No authenticated Render deployment, service health, worker logs, or restart evidence was available. |

> The RPC block result is retained as the exact JSON-RPC response value `0x37a1905`; it is not treated as a fabricated transaction or deployment record.

## Verified in code

The repository contains the following verified implementation foundations:

- `render.yaml` defines separate API and indexer worker services, dedicated Fuji RPC configuration, chain ID `43113`, and secret-managed database/configuration values.
- `server/config.js` enforces Fuji chain separation and validates production configuration requirements.
- `server/index.js` creates the API runtime, persistence pool, readiness checker, and authentication service.
- `server/indexer-worker.js` requires Fuji RPC configuration, chain ID `43113`, and non-empty indexer contract configuration before startup.
- `server/indexer.js` persists per-block checkpoints, retries RPC work, records malformed/duplicate events, marks failed checkpoints, and detects canonical block changes.
- `server/indexer-reconcile.js` compares indexed ownership against finalized blockchain state and records mismatches.
- `vercel.json` routes health, readiness, nested API paths, and the scheduled indexer tick.
- The local probe returned HTTP 200 for `/api/health`, HTTP 503 for `/api/health/ready` with an explicit missing-database diagnosis, and successfully validated Fuji worker configuration.

## Verified in deployment

- Public Fuji RPC connectivity and chain identity were verified directly.

No other deployment evidence was available from the repository tooling in this run. In particular, there was no live Render API URL, Render worker log, Supabase connection, migration result, database checkpoint, Vercel deployment request, or end-to-end Fuji transaction.

## Not verifiable from GitHub/repository tooling

The following require deployment credentials or live infrastructure and therefore remain unverified:

- Applying migrations to the dedicated Fuji database.
- Confirming required tables and migration checksums in Fuji PostgreSQL/Supabase.
- API persistence reads/writes against Fuji PostgreSQL.
- Indexer startup, polling, checkpoint persistence, restart recovery, and duplicate suppression against the live database.
- Render web service and worker health, logs, restarts, and continuous operation.
- Deployed Vercel health/readiness/indexer-tick requests.
- Contract deployment, event indexing, ownership reconciliation, marketplace settlement, or wallet-based end-to-end flows.

## Software validation

| Command | Result |
|---|---|
| `npm test` | **PASS** — 11 test files, 77 tests passed |
| `npm run lint` | **PASS** |
| `npm run build` | **PASS** |
| `node scripts/fuji-runtime-probe.mjs` | **PASS** for local health/worker configuration probe; readiness correctly reports `503 not_ready` without a database |
| Live Fuji `eth_chainId` | **PASS** — `0xa869` (`43113`) |
| Live Fuji `eth_blockNumber` | **PASS** — `0x37a1905` |
| Database migration/validation | **NOT RUN** — no Fuji `DATABASE_URL` was available |

## Remaining blockers

1. Provide the dedicated Fuji PostgreSQL/Supabase connection string to both Render services and apply the repository migrations.
2. Configure a real `INDEXER_CONTRACTS_JSON` value containing deployed Fuji contract addresses and start blocks; no addresses are present in this report because none were supplied or verified.
3. Deploy or connect the Render API and worker, then capture `/api/health`, `/api/health/ready`, worker startup, RPC polling, checkpoint, restart, and failure-recovery evidence.
4. Execute deployed Vercel routing checks for `/api/health`, `/api/health/ready`, and `/api/indexer/tick`.
5. Do not mark Fuji certified until database persistence and continuous worker operation have been observed against the intended Fuji infrastructure.

## Final decision

# FUJI NOT CERTIFIED

The Fuji RPC and repository-level runtime foundations are healthy, and all local tests/lint/build checks pass. Certification remains blocked by the unavailable dedicated database and unavailable live Render/Vercel deployment evidence.
