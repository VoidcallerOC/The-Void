# The Void — End-to-End Production Launch Gate

**Decision: do not represent the platform as production-ready.** The repository contains a tested implementation of the platform services described below, but no production PostgreSQL database, Avalanche C-Chain contracts, RPC credentials, object-storage signer, persistent indexer worker, monitoring integration, or deployed backend has been configured or verified in this workspace.

> **Status definitions.** **🟢 VERIFIED** means a repository-level validation completed successfully. **🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED** means the code path and automated tests are present, but it cannot operate in production until the stated external dependency is configured and tested. **🔴 NOT COMPLETE** means a required real-world staging or production verification has not occurred.

## Verified repository validation

The final local validation completed on 2026-09-09. It ran `npm test`, `npm run lint`, `npm run build`, `npm run db:validate`, `npm audit --omit=dev`, `npm audit`, and `git diff --check`. The result was **136 tests passed in 20 files**, a successful Vite production build, zero lint findings, zero production and full dependency-audit findings, contiguous migration numbering, and no patch whitespace errors. The expected error logs emitted by resilience tests for simulated RPC failures, malformed requests, and blocked legacy media paths are test fixtures rather than validation failures.

| Validation | Result | Scope and limit |
|---|---|---|
| Automated tests | **136 passing** | Unit and boundary tests; no live PostgreSQL, wallet, RPC, object-storage, or deployed-contract test occurred. |
| Static production build | **Passed** | Vite 8.2.2 output builds successfully. |
| Static media leakage scan | **Passed** | No master-audio directory remains under `public/assets/audio`, and the build contains only preview media. |
| Migration structure | **Passed** | Seven sequential migrations have one normalized outer transaction each. This is not evidence that they were applied to a real PostgreSQL service. |
| Dependency audit | **Passed** | `npm audit` and `npm audit --omit=dev` both report zero known vulnerabilities at validation time. |

## Launch matrix

| Area | Status | Evidence | Infrastructure or verification still required |
|---|---|---|---|
| FRONTEND | 🟢 VERIFIED | Production build passes. The public catalog, collector experience, wallet authentication client, protected-player path, marketplace panels, and `/studio` route compile. | Configure `VITE_API_ORIGIN` if the API is hosted on a separate origin. |
| BACKEND | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Node HTTP API includes request IDs, structured logs, classified errors, liveness at `GET /api/health`, readiness at `GET /api/health/ready`, allowlisted CORS, wallet auth, media grants, and Studio routes. | Deploy the Node API with server-only secrets, TLS, startup supervision, and a health-check target. |
| DATABASE | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | PostgreSQL migration runner uses an advisory lock, checks immutable migration checksums, and applies each migration plus bookkeeping atomically. Pooling, SSL, connection and idle timeouts are configured. | Provision PostgreSQL, restrict network access, set `DATABASE_URL` and verified TLS, run `npm run db:migrate`, and retain a migration/application record. |
| WALLET AUTH | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | EIP-191 challenges are domain and URI bound, nonce hashes and session hashes are stored instead of raw secrets, and replay/mismatch/expiry tests pass. | Set the real HTTPS `PUBLIC_APP_URL`, `AUTH_DOMAIN`, `AUTH_URI`, and C-Chain chain policy; exercise with a real wallet against the deployed API. |
| MARKETPLACE | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Listing, cancellation, purchase-intent, submission, settlement validation, idempotency, and reconciliation code paths are tested. | Deploy and independently review the marketplace and ERC-1155 contracts, register genuine addresses and deployment blocks, then verify transactions on-chain. |
| INDEXER | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Durable checkpoints, exclusive worker lease, retry handling, restart safety, duplicate-event handling, canonical block checks, and worker shutdown are tested. | Supply a reliable Avalanche RPC endpoint, confirmed contract start blocks, and a continuously supervised worker process. |
| OWNERSHIP | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Authorization now uses canonical `ownership_snapshots`, rejects `REORG_PENDING` values, and fails closed for stale or lagging index checkpoints. It never trusts browser-reported ownership. | Populate and keep ownership snapshots current through a deployed indexer; tune lag/staleness thresholds with real monitoring. |
| RECONCILIATION | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Marketplace and ownership reconciliation code plus mismatch/duplicate tests are present. | Run scheduled reconciliation against the deployed contracts and preserve alerts/audit evidence for failed repairs. |
| REORG RECOVERY | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Tests cover changed canonical block hashes, safe rewind, derived-state rebuild, replay, and worker restart behavior. | Verify recovery against a real RPC endpoint and persisted PostgreSQL data before enabling production access decisions. |
| SECURE MEDIA | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | All ten public master files were removed from static serving. Previews remain public. Wallet-bound, revocable, five-minute grants gate private media and are audited. The production signer is provider-neutral and accepts only allowlisted HTTPS output hosts. | Upload masters to private object storage with no public ACL, deploy the signing service, configure the `MEDIA_*` values, and test anonymous, owner, expired, revoked, and range requests in the real environment. |
| ARTIST STUDIO | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | `/studio` implements Artist → Release → Edition → Experience, artist-wallet authorization, `DRAFT → REVIEW → PUBLISHED`, ERC-1155 association, token validation, and audit events. | Apply migration `007_artist_studio.sql`; seed or create actual artist owner records through authenticated Studio use; test the deployed API with separate owner and non-owner wallets. |
| OPERATIONS | 🟡 CODE COMPLETE / INFRASTRUCTURE REQUIRED | Structured JSON logs, request IDs, pooled DB configuration, timeouts, graceful API and worker shutdown, liveness/readiness, and failure classification are implemented. | Connect logs, metrics, uptime checks, alerting, secret rotation, backup monitoring, and incident ownership to real infrastructure. |
| FUJI STAGING | 🔴 NOT COMPLETE | The code permits Fuji chain ID `43113` outside production, but no verified Fuji contracts, RPC endpoint, deployed database, media store, worker, or test transactions were supplied. | Complete the ordered staging procedure below and retain the test evidence. |
| AVALANCHE C-CHAIN PRODUCTION | 🔴 NOT COMPLETE | Production configuration enforces chain ID `43114` and HTTPS, but no C-Chain deployment data or credentials were supplied. | Complete contract deployment/review, endpoint configuration, operational readiness checks, and the staging promotion checklist. |
| END-TO-END FLOW | 🔴 NOT COMPLETE | Individual repository-level tests exist across the component steps. | Execute the real Artist, Collector, secondary-market, and transfer journeys against Fuji, then repeat the approved release candidate against C-Chain. |

## Implemented flow boundaries

### Artist Studio

An authenticated wallet can create its own artist profile and becomes that artist’s `OWNER` in `artist_owners`. Only an owner or future manager record may update that artist’s releases, editions, or experiences. The Studio keeps the intended music-native hierarchy visible in its form order: **Artist → Release → Edition → Experience**. The edition form stores contract and token information as configuration rather than making those low-level fields the principal catalog identity. Its supported lifecycle is **DRAFT → REVIEW → PUBLISHED**; lifecycle regression from `PUBLISHED` is rejected.

The server routes are `POST /api/studio/artists`, `PATCH /api/studio/artists/:artistId`, `POST /api/studio/artists/:artistId/releases`, `PATCH /api/studio/releases/:releaseId`, `POST /api/studio/releases/:releaseId/editions`, `PATCH /api/studio/editions/:editionId`, `POST /api/studio/editions/:editionId/experiences`, and `PATCH /api/studio/experiences/:experienceId`. Every write requires the same verified bearer session used by the marketplace and media services. The database migration adds `artist_owners`, indexes ownership and lifecycle lookups, and permits `REVIEW` in existing catalog lifecycle constraints.

### Collector, marketplace, transfer, and entitlement path

The wallet client requests a one-time challenge and exchanges a valid EIP-191 signature for an opaque bearer session. Listing and purchase APIs bind the request wallet to that session and preserve pending state until the authoritative chain/indexer paths report a valid settlement. The worker persists canonical blocks, transfers, checkpoint state, marketplace event projections, ownership snapshots, reconciliation jobs, and reorganization recovery state.

Protected-media authorization is a separate server-side decision. The gateway validates the session wallet, published experience configuration, a current ERC-1155 ownership requirement, canonical ownership state, indexer freshness, grant expiry, and revocation before returning an opaque API media path. It records grant issuance, authorization, denial, and revocation. A browser’s local token check can improve UI feedback but cannot reveal or authorize a master file.

## Secure-media asset disposition

All **20 tracked full-duration audio files** were removed from static serving, including the self-titled EP masters and unreferenced Tunnel Vision masters. Ten legacy full-duration files were found under `public/assets/audio-preview/` and were removed as well; the remaining ten public clips measure only 27–30 seconds. `public/assets/audio-preview/` is now the sole public audio directory. The original masters were relocated only to the current workspace’s ignored `private-media/` holding area so they do not return to the static site or source history. That local holding area is **not** a deployed media store and is intentionally not committed. Before deployment, upload the masters through a controlled private-storage process and use the storage keys configured in each published experience.

## Required configuration

| Variable | Purpose | Production requirement |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Required; use a managed secret and a TLS-capable database endpoint. |
| `DATABASE_SSL` | PostgreSQL TLS control | Keep enabled in production. |
| `DATABASE_POOL_MAX` | Maximum DB connections per API/worker process | Size within database capacity. |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | Idle connection timeout | Configure for the selected hosting platform. |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | Connection acquisition timeout | Configure and alert on exhaustion. |
| `APP_SHUTDOWN_TIMEOUT_MS` | Graceful API shutdown bound | Required operational policy value. |
| `PUBLIC_APP_URL` | Canonical public HTTPS application origin | Required and must be HTTPS in production. |
| `AUTH_DOMAIN` and `AUTH_URI` | Exact signed-message domain and URI | Must match the deployed public app origin. |
| `AUTH_ALLOWED_CHAIN_IDS` | Wallet authentication chain allowlist | Must be `43114` only in production. |
| `AUTH_CHALLENGE_TTL_SECONDS` | One-time challenge lifetime | Required security policy value. |
| `AUTH_SESSION_TTL_SECONDS` | Bearer-session lifetime | Required security policy value. |
| `API_ALLOWED_ORIGINS` | Additional browser origins permitted to call the API | Set only when API and app are different origins. |
| `VITE_API_ORIGIN` | Non-secret frontend API origin | Build-time setting only when API and app are different origins. |
| `OWNERSHIP_MAX_INDEXER_LAG_BLOCKS` | Maximum authorization lag before failing closed | Tune from observed finality/indexing performance. |
| `OWNERSHIP_MAX_INDEXER_STALENESS_MS` | Maximum time since successful indexer cycle | Tune from observed worker health. |
| `INDEXER_CHAIN_ID` | Indexer chain | `43114` in production; `43113` only in staging. |
| `INDEXER_RPC_URL` | Avalanche JSON-RPC endpoint | Required for the worker; use a vetted, monitored endpoint. |
| `INDEXER_CONTRACTS_JSON` | Registered ERC-1155/marketplace addresses and start blocks | Required; enter only reviewed, deployed values. |
| `INDEXER_CONFIRMATIONS`, `INDEXER_CHUNK_SIZE`, `INDEXER_POLL_INTERVAL_MS` | Indexing/finality behavior | Tune and validate against the selected RPC provider. |
| `INDEXER_RPC_TIMEOUT_MS`, `INDEXER_RPC_RETRIES`, `INDEXER_RETRY_BASE_DELAY_MS` | RPC resilience behavior | Tune while retaining lease safety. |
| `INDEXER_OWNERSHIP_RECONCILIATION_INTERVAL_MS`, `INDEXER_LEASE_TTL_MS` | Reconciliation and worker exclusivity | Required for durable operation. |
| `MEDIA_STORAGE_DRIVER` | Protected media driver | Must be `object` in production. |
| `MEDIA_GRANT_TTL_SECONDS`, `MEDIA_SIGNED_URL_TTL_SECONDS`, `MEDIA_MAX_BYTES` | Media access bounds | Signed URL TTL must not exceed grant TTL. |
| `MEDIA_AUDIT_HASH_SECRET` | Salt for IP/user-agent audit fingerprints | Required secret in production. |
| `MEDIA_OBJECT_SIGNER_ENDPOINT` | Provider-neutral private-object signer | Required HTTPS endpoint in production. |
| `MEDIA_OBJECT_SIGNER_TOKEN` | Server-to-signer credential | Required secret; never client-exposed. |
| `MEDIA_OBJECT_URL_HOSTS` | Approved returned object-storage hosts | Required allowlist of exact hostnames. |

## External infrastructure dependencies

The deployed application needs an internet-reachable static frontend, a separately hosted long-running Node API, a private PostgreSQL database, a persistent indexer-worker runtime, an Avalanche Fuji/C-Chain RPC provider, reviewed and deployed ERC-1155 and marketplace contracts, a private object-storage bucket or equivalent, a signer service that can produce tightly scoped HTTPS object URLs, secret management, centralized logs, metrics and alerting, encrypted database backups, and a rehearsed restore process. The static Vercel configuration in this repository does not by itself run `server/index.js` or `server/indexer-worker.js`; those processes require their own runtime and release configuration.

## Exact remaining actions for a real launch

1. **Create a non-production Fuji environment.** Provision isolated PostgreSQL, private object storage, a signer service, API runtime, and persistent worker runtime. Set all required non-secret and secret configuration through the host’s secret manager.
2. **Apply and record migrations.** Run `npm run db:validate`, then `npm run db:migrate` against Fuji PostgreSQL. Verify `schema_migrations` contains all seven checksums and verify `/api/health/ready` reports database and indexer state once the worker runs.
3. **Deploy and review contracts.** Independently review ERC-1155 and marketplace source/parameters. Deploy them on Fuji, verify them with the appropriate explorer, retain the real contract addresses, deployment transaction hashes, and exact deployment start blocks, and register those facts in `contracts` and `INDEXER_CONTRACTS_JSON`.
4. **Load only private master objects.** Upload master tracks with all public ACLs disabled. Create published experience records whose `protectedMedia.storageKey` values exactly match those objects. Confirm the signer accepts only valid internal requests and returns only short-lived URLs on `MEDIA_OBJECT_URL_HOSTS`.
5. **Run the real Fuji launch-flow test.** With distinct wallets, test artist creation/publishing, collector authentication, collection, indexer detection, access grant, media authorization, listing, purchase, cancellation, failed purchase, token transfer, access loss/gain, duplicate events, worker restart, simulated RPC failure, simulated DB failure, and controlled reorganization recovery. Preserve transaction hashes, logs, and before/after ownership evidence.
6. **Operationalize recovery.** Configure metrics and alerts for readiness, DB connections, RPC errors, indexer lag, lease loss, reorg rebuild failure, media authorization failures, signer errors, and backup failures. Write and perform a database restore drill; record the recovery objective and observed restore time.
7. **Promote configuration to C-Chain.** Set production to HTTPS, `AUTH_ALLOWED_CHAIN_IDS=43114`, `INDEXER_CHAIN_ID=43114`, `MEDIA_STORAGE_DRIVER=object`, and the reviewed C-Chain contract/start-block configuration. Do not reuse Fuji database, storage, or secrets.
8. **Repeat the release-candidate flow on C-Chain.** Re-run the same controlled journey with production monitoring and rollback procedures active. Only after this evidence is reviewed should the platform be described as production-ready.

## Known implementation gaps intentionally not claimed as complete

The implementation does not deploy infrastructure, create an Avalanche contract, fabricate a contract address, create a blockchain transaction, create a database, upload media to object storage, or enroll an external monitoring system. It also does not provide a Studio UI for assigning additional `MANAGER` wallets; the underlying role is modeled in the database, but a controlled owner-management workflow should be designed before delegating artist administration. The current ownership verifier supports explicit ERC-1155 balance requirements and deliberately rejects unsupported requirement types rather than silently authorizing them.

## Repository commands

```bash
npm install
npm run db:validate    # structural migration validation only
npm run db:migrate     # requires a real configured PostgreSQL DATABASE_URL
npm test
npm run lint
npm run build
npm audit
npm run start:api      # requires server configuration and PostgreSQL
npm run start:indexer  # requires PostgreSQL, RPC URL, and contract configuration
```

## References

This gate is based on the repository implementation and local validation results described above. No external infrastructure state was queried or inferred.
