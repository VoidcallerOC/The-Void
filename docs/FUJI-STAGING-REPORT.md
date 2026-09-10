# Fuji staging report

**Date:** 2026-09-10  
**Environment:** Intended isolated Avalanche Fuji staging (`chainId=43113`)  
**Repository:** `VoidcallerOC/The-Void`

## Status summary

| Requirement | Actual status | Evidence or blocker |
|---|---|---|
| Fuji RPC reachability | **Verified** | Public RPC returned `eth_chainId=0xa869` (43113) and `eth_blockNumber=0x37997b6`. |
| Dedicated PostgreSQL reachable | **Not verified** | No `DATABASE_URL` is available in the session. `npm run db:migrate` and `npm run db:validate` fail closed with `DATABASE_URL is required`. |
| PostgreSQL TLS | **Configured in code** | `DATABASE_SSL=true` is the default and the pool requires certificate validation; no real connection was available to verify. |
| Migrations applied | **Not performed** | The available Supabase project `ForgeCT` has zero application migrations and was not modified because it is not identified as this app's staging database. |
| Migration checksums | **Implemented, not exercised** | `npm run db:validate` verifies `schema_migrations` names and SHA-256 checksums once a staging database is supplied. |
| API deployed | **Not deployed** | No hosting deployment target or permission was available. |
| HTTPS/API health | **Implemented, not externally verified** | `/api/health` exists; provider TLS and public URL remain unconfigured. |
| Readiness | **Implemented, not externally verified** | `/api/health/ready` checks database migrations, Fuji RPC, finalized checkpoint, lag, and stale status. |
| Persistent indexer | **Implemented, not running** | `npm run start:indexer` uses durable checkpoints, but no deployed worker host or contract addresses were supplied. |
| Contract start blocks | **Blocked** | Actual Fuji marketplace/ERC-1155 deployments and addresses are not available. |
| Secrets | **No secrets committed** | `.env.example` contains names only; no database, signer, auth, media, or RPC credentials were added. |
| Tests/lint/build | **Passed** | 10 test files / 65 tests passed; lint passed; production build passed. |

## Repository changes

The staging implementation adds explicit environment validation, Fuji-only indexer configuration, database migration validation, a readiness endpoint, an independently runnable persistent indexer worker, origin-restricted CORS, a production container, and a no-secret runbook. The API and worker remain separate processes so the worker can be restarted independently while retaining checkpoints in PostgreSQL.

## Remaining blockers

Completion requires the operator to provide or authorize all of the following: a dedicated staging PostgreSQL connection URL with TLS, a hosting provider/project capable of running one HTTPS Node API and one persistent Node worker, the staging public URL and auth configuration, the deployed Fuji marketplace and token contract addresses plus deployment start blocks, and the provider secret-manager entries for database/auth/media/RPC secrets. After those inputs exist, run migrations, validate checksums, deploy both processes, verify health/readiness over HTTPS, observe checkpoint advancement, restart the worker, and verify it resumes from the persisted checkpoint.

The unrelated `ForgeCT` Supabase project was deliberately not modified. Its current state is healthy but not a valid substitute for an isolated The-Void staging database.
