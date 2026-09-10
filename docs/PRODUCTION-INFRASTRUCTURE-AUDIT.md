# Voidcaller — Production Infrastructure Audit

**Repository:** `VoidcallerOC/The-Void` on `main`  
**Audit date:** 2026-09-09  
**Scope:** Full tracked repository review. No source code was modified.

## Executive conclusion

The repository is a **well-structured client foundation**, not yet a production platform. The existing React/Vite application, domain model, wallet discovery, ownership UX, marketplace ABI client, experience contracts, tests, and marketplace Solidity source should be preserved. The production gap is concentrated in the missing trust boundary: there is no backend, database, indexer, authenticated API, private media gateway, durable transaction ledger, deployment pipeline for the contract, or operational monitoring.

The most important conclusion is that **Phase 7 describes the intended server contracts but does not implement a hosted server**. The repository correctly documents this handoff in `README.md` and `docs/PHASE-7-FINAL-PLATFORM.md`; production work should connect those adapters rather than replace the domain architecture.

## Readiness score

### A. Current production-readiness percentage: **31%**

This is a weighted engineering estimate, not a vendor certification. The score gives credit for the functioning frontend and domain foundation, but treats absent production control planes as blockers rather than as partially complete UI features.

| Capability area | Assessment | Weight | Score rationale |
|---|---:|---:|---|
| Frontend build and application shell | Strong | 15% | React/Vite app builds, routes, lazy loading, error boundary, and static deployment configuration exist. |
| Domain model and experience contracts | Strong foundation | 10% | Artist, release, edition, experience, ownership, redemption, and authorization contracts exist as client-side modules. |
| Wallet and on-chain reads | Partial | 10% | EIP-6963/legacy wallet support and ERC-1155 balance reads exist, but reads are direct browser RPC calls without indexed consistency. |
| Marketplace client and contract source | Partial | 15% | Contract and raw ABI client exist, but the contract is not deployed/configured and listing/purchase records are not persisted. |
| Secure authentication and media delivery | Not production-ready | 15% | Signature/grant interfaces are present, but no server verifier, nonce store, private origin, or streaming endpoint exists. |
| Database, API, indexing, and jobs | Absent | 20% | No backend, schema, migrations, event indexer, ownership indexer, queue, cron, or webhook layer is tracked. |
| Operations, observability, CI/CD, and production chain controls | Partial | 15% | Basic CI runs lint/tests/build; no release gates, monitoring, alerting, deployment manifests, or chain operations are present. |
| **Total** |  | **100%** | **31%** |

## Classification legend

- **🟢 Production-ready:** Appropriate as a foundation for production after normal release controls.
- **🟡 Implemented but needs production hardening:** Real implementation exists, but production safety, durability, or operational controls are incomplete.
- **🟠 Prototype/static/client-only:** Useful UX or domain contract, but browser state or static assets are being treated as if they were authoritative.
- **🔴 Missing:** No implementation exists in the repository.
- **⚠️ Security risk:** The implementation creates a material confidentiality, integrity, replay, authorization, or financial risk.

## 1. Repository architecture

**🟡 Implemented but needs production hardening.** The repository is a Vite SPA with a clear separation among `src/components`, `src/domain`, and `src/lib`. The core files are `src/App.jsx`, `src/components/Layout.jsx`, `src/domain/models.js`, `src/data.js`, `src/lib/web3.js`, `src/lib/marketplace.js`, `src/lib/experience-service.js`, and `src/lib/media-auth.js`. This is a good client foundation and should be preserved.

The architecture is not yet a complete production system because every trust-sensitive service is represented by browser modules or adapters. There is no `server/`, `api/`, database schema, migration directory, worker, or indexer. The exact required change is to add a separately deployable service boundary, preferably under a new `server/` or `apps/api/` subtree, while keeping the existing domain contracts reusable. The service must own authentication, persistence, indexing, media authorization, and transaction reconciliation. Dependencies are the database schema, API contract, queue/worker runtime, and deployment environment. **Priority: P0. Implement in this repository: yes**, with a clear server boundary.

**🟢 Production-ready:** The repository is cleanly tracked on `main`, has no uncommitted changes at audit time, and has no evidence that the existing React shell needs to be rewritten.

## 2. Frontend/backend separation

**🔴 Missing.** `package.json` contains only Vite, React, router, lint, test, and build scripts. `vercel.json` rewrites all paths to `index.html`, and there are no server routes or API handlers. `README.md` lines 30–38 describes only the client architecture.

The frontend currently performs wallet discovery, RPC reads, transaction submission, receipt polling, local catalog access, and client-side media gating. That is insufficient because the browser is untrusted and cannot establish authoritative ownership, persist business state, protect media, or reconcile chain events reliably.

Required change: add a versioned API with separate modules for auth, catalog, ownership, marketplace, media, redemptions, and health. The frontend should call the API for authoritative reads and protected media grants while retaining wallet-provider code for user-approved transactions. Dependencies are database, signer verification, indexer, private storage, rate limiting, and observability. **P0; yes.**

## 3. Database requirements

**🔴 Missing.** `src/lib/experience-service.js` uses browser `localStorage` through `CATALOG_STORAGE_KEY` and an in-memory/adaptor pattern. `createAuditLog` also writes through a browser storage adapter. `src/lib/collection.js` creates ephemeral ownership records. No schema, migrations, ORM, or database connection is present.

This cannot support concurrent users, durable listings, purchase records, audit retention, redemption integrity, idempotency, operator actions, or reorg correction. Browser storage is user-controlled and can be deleted or forged.

Required change: introduce PostgreSQL with migrations and transactional tables for artists, releases, editions, experiences, contracts, chain blocks, token transfers, ownership balances, listings, purchases, transactions, media grants, nonces, audit events, redemptions, and job runs. Add unique constraints on chain/event identity, grant IDs, nonce scope, listing IDs, and transaction hashes. Dependencies are the API and indexer design. **P0; yes.**

## 4. API requirements

**🔴 Missing.** There are no API routes. The Phase 7 contract in `src/lib/experience-service.js` contains callback hooks such as `verifySignature` and `ownsExperience`, but no network endpoint invokes them.

Required change: implement an authenticated, versioned API. Minimum endpoints are `GET /health`, `GET /catalog`, `POST /auth/challenge`, `POST /auth/verify`, `POST /media/grants`, `GET /media/:grantId`, `GET /ownership/:wallet`, `GET /listings`, `GET /listings/:id`, `POST /indexer/reconcile` for protected operations, and operator-only redemption/catalog endpoints. Validate schemas at the boundary, return stable error codes, apply rate limits, and include request IDs. Dependencies are database, auth, media storage, and indexer. **P0; yes.**

## 5. Authentication and signature verification

**🟡 Implemented but needs production hardening / ⚠️ Security risk.** `src/lib/media-auth.js` creates a wallet-bound challenge, and `src/lib/experience-service.js` calls injected `verifySignature` and `ownsExperience` callbacks. `PlatformPages.jsx` presents the intended server-side flow. However, the challenge statement is a simple string, there is no EIP-191/EIP-712 server verifier, no domain binding, no server-issued challenge endpoint, and no session or grant persistence.

The current `challenge.wallet` comparison is not sufficient authentication because client code can construct a challenge and call the adapter. A production verifier must recover the signer, normalize the address, verify domain/origin, bind the challenge to the exact wallet, experience, chain, issued time, and nonce, and reject stale or already-used challenges. Dependencies are nonce storage, clock policy, API, and rate limiting. **P0; yes.**

## 6. Marketplace contract deployment and configuration

**🟡 Implemented but needs production hardening.** `contracts/MusicMarketplace.sol` contains listing, cancellation, expiration, purchase, fee, royalty, and ERC-1155 receiver logic. `src/lib/marketplace.js` contains raw selectors and receipt parsing. But `MARKETPLACE_CONFIG` is explicitly disabled with an empty address in `src/lib/marketplace.js` line 5, and the UI tells users that deployment is pending.

Required change: deploy the reviewed contract to Avalanche Fuji first and Avalanche C-Chain mainnet only after an independent review. Record deployment transaction, bytecode hash, verified source, chain ID, marketplace address, fee recipient, fee basis points, supported token contracts, and deployment block in a versioned configuration table and environment configuration. Add contract tests against a fork and testnet. Add pause/emergency controls, governance of fee recipient, and documented upgrade/non-upgrade policy if these are required by the project. Dependencies are contract review, ERC-1155 contract addresses, treasury, RPC providers, and indexer start blocks. **P0; yes.**

**⚠️ Security risk:** The contract pays the seller, platform fee recipient, and royalty receiver using external calls. `nonReentrant` protects `buy`, but production review must still test malicious recipients, fee/royalty bounds, seller balance changes, stale approvals, and settlement event correctness. `contracts/MusicMarketplace.sol` must receive an adversarial test suite before funds are accepted. **P0; yes.**

## 7. Listing persistence

**🟠 Prototype/static/client-only.** `src/lib/marketplace.js` creates a client-side listing record and transitions listing state in memory. `src/components/ListingPanel.jsx` submits approval and listing transactions, extracts a listing ID from a receipt, and displays local state. It does not write a listing to a database or reload an authoritative listing collection.

The chain contract is authoritative for settlement, but the application still needs a durable read model for discovery, seller history, status, pagination, expiration, cancellation, and reconciliation. Required change: index `ListingCreated`, `ListingCancelled`, `ListingExpired`, and `ListingSold`; upsert by chain ID, contract address, and listing ID; store raw transaction/block/log identity; expose API reads; and reconcile each active listing against contract state and current ERC-1155 balance/approval. Dependencies are contract deployment, event indexer, PostgreSQL, and API. **P0; yes.**

## 8. Purchase persistence

**🟠 Prototype/static/client-only.** `src/lib/marketplace.js` verifies a purchase receipt in the browser, and `PurchasePanel.jsx` refreshes local ownership after confirmation. No purchase/order/transaction record exists outside the wallet and chain.

This is insufficient for support, duplicate retries, payment reconciliation, analytics, refunds/disputes policy, and reorg recovery. Required change: create an idempotent purchase record keyed by chain ID, transaction hash, and log index; store buyer, seller, token contract, token ID, quantity, price, fee, royalty, block number/hash, confirmation state, and reconciliation timestamps. Write a pending transaction before or immediately after submission, then finalize only after indexed event verification and finality. Dependencies are database, indexer, API, and chain finality policy. **P0; yes.**

## 9. Blockchain event indexing

**🔴 Missing.** The only on-chain reads are direct `eth_call` and receipt polling in `src/lib/web3.js` and `src/lib/marketplace.js`. No `eth_getLogs` indexer, provider websocket, block cursor, event decoder, retry policy, or backfill command exists.

Required change: implement a durable Avalanche C-Chain/Fuji indexer that stores canonical block cursors, fetches bounded log ranges, decodes ERC-1155 `TransferSingle` and `TransferBatch`, `ApprovalForAll`, marketplace events, and relevant contract events, and retries provider failures. Make event ingestion idempotent. Dependencies are RPC providers, database, contract ABIs, start blocks, and reorg handling. **P0; yes.**

## 10. Ownership indexing

**🟠 Prototype/static/client-only.** `src/lib/web3.js` loops over configured token IDs and calls `balanceOf` directly for the connected wallet. `src/lib/collection.js` normalizes records in browser memory. This is useful as a fallback or immediate freshness check, but it is not an ownership index.

Direct balance reads do not provide historical ownership, transfer audit, scalable collector pages, reliable snapshots, or a consistent answer during RPC failure. Required change: derive balances from indexed transfers, persist wallet/token/contract/chain balances, maintain a block watermark, periodically reconcile selected balances with `balanceOf`, and expose an `updatedAt`/block number to authorization decisions. Dependencies are event indexing, database, and chain finality. **P0; yes.**

## 11. Experience indexing and authorization

**🟡 Implemented but needs production hardening.** `src/lib/experience-service.js` has catalog snapshots, artist ownership checks, grant issuance hooks, gateway decisions, audit adapters, and redemption transitions. `src/lib/collection.js` resolves access from locally supplied ownership records. The implementation is deliberately adapter-based, as documented by `docs/PHASE-7-FINAL-PLATFORM.md`.

The missing production change is to move catalog versions, artist permissions, ownership checks, access decisions, and redemption transitions behind the API and database. Authorization must use an indexed ownership watermark and an explicit finality/staleness policy. Artist changes require authenticated operator/artist authorization and audit records. Dependencies are database, signature verifier, ownership indexer, and API. **P0; yes.**

## 12. Secure media delivery

**⚠️ Security risk.** `README.md` lines 45–61 explicitly states that full audio is in `public/assets/audio/` and can be downloaded without ownership. `src/lib/audio.js` chooses full versus preview sources in the browser. `src/lib/media-auth.js` only creates authorization data; `vercel.json` serves static assets and has no media protection.

Required change: remove full-length files from the public directory, place originals in private object storage, and implement a server-side grant endpoint plus a streaming or short-lived signed-URL endpoint. Validate grant, wallet, experience, media type, expiry, revocation, and current ownership. Use range-request support, CDN controls, origin isolation, and rate limits. Assume an authorized collector can still record or redistribute playback; the goal is to prevent unauthenticated direct downloads. Dependencies are API auth, private storage, grant database, and observability. **P0; yes.**

## 13. Nonce and replay protection

**🔴 Missing / ⚠️ Security risk.** `createMediaChallenge` accepts a caller-supplied `nonce`; `issueMediaGrant` does not persist or consume it. `randomId` uses `Math.random()` and `Date.now()` in `src/lib/experience-service.js`, which is not a security nonce source.

Required change: generate cryptographically random server nonces, store a hash with wallet, scope, issuance, expiry, and consumed timestamp, enforce one-time use atomically, and bind the signed payload to the exact domain, URI, chain, experience, media type, and server nonce. Use an EIP-4361-style SIWE message or a carefully specified EIP-712 typed message. Dependencies are database, server crypto, and auth endpoint. **P0; yes.**

## 14. Transaction verification

**🟡 Implemented but needs production hardening.** `verifyPurchaseReceipt` checks receipt status, marketplace target, settlement event topic, buyer, seller, token contract, token ID, quantity, and price. `listingIdFromReceipt` extracts a creation event. `waitForReceipt` only polls until a receipt appears.

Browser verification is useful for UX but cannot be the platform record. It also does not wait for confirmations, verify the canonical block, compare against indexed state, or recover from replacement, dropped, or reorged transactions. Required change: move verification to a server/indexer reconciliation flow; retain client checks as immediate feedback only. Track transaction lifecycle from submitted to mined, confirmed, finalized, failed, replaced, or reorged. Dependencies are database, indexer, finality policy, and notification/error UX. **P0; yes.**

## 15. Reorg and finality handling

**🔴 Missing.** `src/lib/web3.js` uses the `latest` tag for calls and treats the first receipt as final. No block hash cursor, confirmation count, canonicality check, rollback, or replay exists.

Required change: configure separate mined and finalized states, wait for a documented Avalanche confirmation depth, store block hashes, detect parent-hash divergence, roll back affected derived events, and replay from the last safe cursor. Do not grant durable ownership or finalize purchases from a transaction that is only observed in a non-final block. Dependencies are indexer, database, chain configuration, and operational alerts. **P0; yes.**

## 16. Error recovery

**🟡 Implemented but needs production hardening.** The UI has error states and `ErrorBoundary`; transaction states include submitted, pending, confirmed, failed, rejected, and expired. The indexer/API/job recovery system is absent.

Required change: add bounded retries with exponential backoff and jitter, idempotency keys, dead-letter job records, provider failover, resumable block cursors, stale-transaction reconciliation, and operator replay commands. API errors must have stable codes and request IDs. Dependencies are queue, database, provider pool, and monitoring. **P1; yes.**

## 17. Background jobs and cron

**🔴 Missing.** No cron, queue, worker, or scheduled job is tracked. The project needs continuous or frequent deterministic work, not a user-triggered Manus task.

Required jobs are event indexing, ownership reconciliation, listing expiry reconciliation, transaction reconciliation, media grant cleanup/revocation, catalog publication, audit retention, and health checks. Use a persistent application worker or managed scheduled jobs. A lightweight first deployment can use Vercel Cron for low-frequency reconciliation plus a dedicated worker for indexing; high-frequency polling must not be implemented as repeated full interactive sessions. Dependencies are API/database deployment, queue, RPC provider, and alerting. **P0 for indexer and transaction reconciliation; P1 for cleanup/maintenance; yes.**

## 18. Environment variables and secrets

**🔴 Missing.** No `.env.example`, runtime configuration module, secret validation, or production secret documentation exists. Addresses and public RPC URLs are hardcoded in `src/lib/web3.js`; marketplace configuration is hardcoded as disabled in `src/lib/marketplace.js`.

Required change: add a checked-in `.env.example` and server-only validated configuration for database URL, RPC URLs, chain IDs, contract addresses, marketplace deployment, indexer start blocks, private storage bucket, signing/session secrets, rate-limit store, error-monitoring DSN, and admin/worker authentication. Never expose private keys or server secrets to Vite client variables. Public chain IDs and contract addresses may be separately compiled into a public config. Dependencies are the API and deployment provider. **P0; yes.**

## 19. Vercel configuration

**🟡 Implemented but needs production hardening.** `vercel.json` correctly supports SPA routing and immutable cache headers for `/assets` and `/fonts`. It rewrites `/(.*)` to `/index.html`, which would also capture any future API or media route unless explicit API rewrites/functions are added before the catch-all.

Required change: preserve the SPA rewrite but add explicit server-function routes, protected media routes, security headers, compression/cache policy, and separate cache rules for catalog/API responses. Do not place protected originals under `public/`. If the indexer or long-running worker cannot fit serverless execution, deploy it separately and keep Vercel for the web/API edge. Dependencies are the chosen backend topology and private storage. **P0 for media/API routing; yes.**

## 20. Production logging and monitoring

**🔴 Missing.** There is no structured server logging, tracing, metrics, error reporting, health endpoint, alerting, or audit sink. Browser messages and local audit storage are not operational telemetry.

Required change: add structured JSON logs with request ID, wallet pseudonymization policy, chain, tx hash, block, event, job, and error code; add exception monitoring; add metrics for RPC latency/errors, indexer lag, stale ownership, grant denials, purchase failures, queue depth, and media abuse; add alerts and dashboards. Keep security/audit logs append-only and redact signatures and secrets. Dependencies are API, worker, database, and monitoring vendor. **P1; yes.**

## 21. Testing

**🟡 Implemented but needs production hardening.** `npm test` currently passes **7 test files and 42 tests**. Tests cover pure web3 encoding, ownership helpers, marketplace state/receipt logic, media authorization contracts, and experience state transitions. `npm run lint` and `npm run build` also pass.

Coverage is not sufficient for production because there are no browser integration tests, API tests, database transaction tests, contract tests, fork tests, reorg tests, indexer replay tests, signature-vector tests, media authorization tests against private storage, or load/rate-limit tests. Required change: add contract tests with malicious ERC-1155 and royalty recipients, Fuji/fork integration tests, auth replay vectors, API/database integration tests, indexer fixtures, reorg simulations, and end-to-end purchase/list/cancel flows. Dependencies are the backend and deployed testnet contract. **P0 for security and transaction tests; P1 for broader E2E; yes.**

## 22. CI/CD

**🟡 Implemented but needs production hardening.** `.github/workflows/ci.yml` runs checkout, Node 20, `npm ci`, lint, tests, and build on pull requests and `main`. This is a good baseline.

It does not deploy the Vercel app, build/test a server, run contract tests, validate migrations, scan dependencies, verify secrets/configuration, or protect production release approval. Required change: add separate web/API/worker build jobs, contract compilation and test job, database migration check, dependency and secret scanning, preview deployment, protected production deployment, artifact provenance, and rollback procedure. Use pinned versions or controlled update policy for CI actions and runtime. Dependencies are the chosen backend and contract toolchain. **P1; yes.**

## 23. Avalanche production and testnet requirements

**🟡 Implemented but needs production hardening.** `src/lib/web3.js` defines Avalanche C-Chain mainnet (`43114`) and a custom Grotto chain (`36463`) with RPCs and token addresses. Direct `balanceOf` reads and wallet chain switching exist.

The repository lacks a Fuji configuration, deployed marketplace address, contract deployment records, verified source, start blocks, RPC failover, gas policy, confirmation policy, ownership of deployer/admin keys, treasury/fee recipient controls, and runbooks. The Grotto chain also needs explicit production supportability, explorer, RPC reliability, finality, and indexer strategy before it can be treated as equivalent to C-Chain.

Required change: create explicit Fuji and mainnet network records; deploy and verify the ERC-1155 and marketplace contracts; document contract addresses, ABI, bytecode, deployer/admin role, fee recipient, royalty behavior, start block, RPC providers, chain finality, and incident procedure. Run a full testnet rehearsal before mainnet. Dependencies are contract review, RPC vendor, indexer, treasury, and deployment secrets. **P0; yes.**

## Production-ready and preserved architecture

The following should be preserved rather than rewritten:

| Area | Classification | Existing files | Why preserve it |
|---|---|---|---|
| React/Vite shell and routing | 🟢 | `src/App.jsx`, `src/components/Layout.jsx`, `src/components/ErrorBoundary.jsx` | Builds cleanly and provides a coherent application shell. |
| Artist/release/edition/experience domain vocabulary | 🟢 | `src/domain/models.js`, `src/data.js` | The domain language is already aligned with the music-native product. |
| Wallet provider discovery and lifecycle | 🟡 | `src/lib/WalletContext.jsx`, `src/lib/wallet-context.js` | EIP-6963 and legacy support are useful; add server authority, not a replacement wallet UX. |
| Ownership/collector presentation | 🟡 | `src/lib/collection.js`, `src/components/Reliquary.jsx` | Keep the collector experience; replace its source of truth with indexed API records. |
| Marketplace client state machine and raw ABI client | 🟡 | `src/lib/marketplace.js`, `src/components/ListingPanel.jsx`, `src/components/PurchasePanel.jsx` | Keep immediate wallet UX and client receipt feedback; add server persistence/reconciliation. |
| Experience and redemption contracts | 🟡 | `src/lib/experience-service.js`, `src/lib/media-auth.js` | These are appropriate adapter contracts; connect them to real server implementations. |
| Unit-test baseline and CI | 🟢 | `src/lib/*.test.js`, `.github/workflows/ci.yml` | Existing validation is valuable and should be expanded, not discarded. |

## Exact implementation order

1. **Freeze and document the current foundation.** Tag the current `main` commit, record all existing token contracts, chain IDs, token IDs, catalog identifiers, and the intended marketplace contract behavior. Do not move or delete working client modules.
2. **Threat-model and review the marketplace contract.** Add Foundry/Hardhat contract tests, malicious receiver tests, royalty/fee boundary tests, approval/balance race tests, and event assertions. Decide pause, admin, and fee-recipient policy.
3. **Add environment/configuration boundaries.** Create `.env.example`, server-only configuration validation, public chain configuration, contract deployment records, and Fuji/mainnet separation. Remove reliance on hardcoded marketplace enablement.
4. **Deploy the marketplace to Avalanche Fuji.** Verify source and bytecode, record deployment block and addresses, configure treasury/royalty recipients, and run the full contract integration suite.
5. **Define and migrate the PostgreSQL schema.** Add migrations for catalog, contracts, blocks, transfers, balances, listings, transactions, purchases, nonces, grants, audit events, redemptions, and jobs. Add indexes and idempotency constraints before writing API logic.
6. **Implement the API service.** Add health, catalog, auth challenge/verify, ownership, listing, purchase reconciliation, experience authorization, media grant, and operator/redemption endpoints. Reuse `experience-service.js` and `media-auth.js` contracts behind server adapters.
7. **Implement server authentication.** Generate cryptographic one-time challenges, verify EIP-191 or EIP-712 signatures, bind domain/chain/URI/experience/media/expiry, consume nonces atomically, rate-limit attempts, and issue short-lived server sessions or grants.
8. **Implement the Avalanche indexer.** Backfill from deployment/start blocks, decode ERC-1155 and marketplace events, maintain canonical cursors, store raw event identity, support retries, and expose lag/health metrics.
9. **Implement ownership projections and reconciliation.** Derive balances from finalized transfers, expose watermark metadata, periodically compare selected balances with `balanceOf`, and repair projections idempotently.
10. **Implement listing and purchase read models.** Index all marketplace events, persist transaction lifecycle, reconcile client-submitted hashes, handle replacement/dropped transactions, and expose API reads for marketplace discovery and collector history.
11. **Implement finality and reorg handling.** Define confirmation depth, canonical block storage, rollback/replay behavior, and authorization policy for stale or non-final ownership.
12. **Move full media to private storage.** Remove full tracks from `public/assets/audio/`, retain previews as public assets, add private originals, signed/streaming delivery, range support, grant revocation, rate limits, and abuse metrics.
13. **Connect the frontend to authoritative APIs.** Preserve wallet signing and transaction submission, but use API catalog, indexed ownership, marketplace listings, grant issuance, and purchase status. Keep client checks as optimistic UX only.
14. **Add background jobs and operational recovery.** Run indexing, reconciliation, cleanup, expiry, and audit jobs with retries, dead letters, idempotency, and operator replay tools.
15. **Add observability and release controls.** Add structured logs, error monitoring, metrics, dashboards, alerts, security headers, dependency scanning, migration checks, preview deployments, protected production deployment, and rollback documentation.
16. **Complete testnet rehearsal.** Exercise list, cancel, expire, buy, transfer, ownership refresh, media grant, replay rejection, stale index behavior, provider outage, reorg simulation, and redemption workflows on Fuji.
17. **Mainnet launch gate.** Require contract review sign-off, successful rehearsal, private media verification, database backup/restore test, alert test, key custody confirmation, runbook review, and a staged release before enabling `MARKETPLACE_CONFIG.enabled` for mainnet.

## P0 blockers

1. No backend/API trust boundary.
2. Full-length audio is publicly downloadable.
3. No cryptographic server signature verification or one-time nonce store.
4. No database for ownership, listings, purchases, grants, audit logs, or redemptions.
5. No Avalanche event indexer or ownership projection.
6. No reorg/finality policy or server-side transaction reconciliation.
7. Marketplace is not deployed/configured; `MARKETPLACE_CONFIG.enabled` is `false`.
8. No verified Fuji/mainnet deployment records, contract test suite, or operational key/treasury procedure.
9. No production-safe environment/secrets configuration.
10. No end-to-end testnet rehearsal for financial settlement and secure media.

## P1 blockers

1. Durable retry, queue, dead-letter, and operator replay system.
2. Structured production logging, error monitoring, metrics, dashboards, and alerts.
3. CI/CD for API, worker, migrations, contract tests, preview deployments, and protected releases.
4. API schema validation, rate limits, request IDs, and stable error codes.
5. RPC failover, provider health checks, indexer lag alerts, and reconciliation jobs.
6. Browser integration and E2E coverage for wallet, list, buy, cancel, media grant, and redemption flows.
7. Private media CDN/range delivery hardening and abuse controls.

## P2 work

1. Catalog administration and artist-facing publishing workflow.
2. Rich marketplace search, pagination, activity history, and analytics.
3. Collector notifications and transaction status UX.
4. Grotto chain production supportability, explorer integration, and dedicated indexer policy.
5. Audit retention, archival, privacy policy, and data export tooling.
6. Performance tuning, cache warming, image/metadata pinning verification, and multi-provider IPFS strategy.
7. Disaster-recovery drills, backup retention policy, and formal incident postmortems.

## Recommended infrastructure stack

The recommended stack preserves the current repository and adds a small production control plane:

| Layer | Recommendation | Reason |
|---|---|---|
| Web frontend | Existing React/Vite on Vercel | Already builds and routes correctly. |
| API | TypeScript Node service using the existing domain contracts | Adds a real trust boundary without rewriting the client domain. Deploy as Vercel functions only if request durations and media behavior fit; otherwise use a managed Node service. |
| Database | Managed PostgreSQL | Transactions, unique event identity, ownership projections, audit records, and migrations are required. |
| Queue/jobs | Managed queue plus a persistent worker, or a managed worker platform | Indexing and reconciliation need retries, backpressure, and replay. Do not rely on browser tabs or interactive scheduled sessions. |
| Blockchain access | Two independent Avalanche RPC providers with rate limits and health checks | Avoid a single public RPC as the production source of truth. |
| Indexing | Repository-owned TypeScript indexer with database cursors and raw event storage | Keeps ownership and marketplace semantics under project control. A third-party indexer can be an accelerator, not the only source of truth. |
| Media | Private S3-compatible object storage, CDN, and signed streaming endpoint | Prevents direct public download of protected masters. |
| Auth | EIP-4361-style wallet challenge or EIP-712 typed message, server nonce store, short-lived session/grant | Provides verifiable wallet ownership and replay resistance. |
| Observability | Structured logs, error monitoring, metrics, uptime checks, and alert routing | Required for indexer lag, payment failures, media denials, and RPC outages. |
| Contract tooling | Foundry or Hardhat with Fuji and Avalanche fork tests | Needed for deployment verification and adversarial settlement tests. |
| CI/CD | GitHub Actions with protected environments and Vercel preview/production deployment | Extends the existing passing CI without replacing it. |

## Exact next prompt/task to execute

> Work directly against `VoidcallerOC/The-Void` on `main`. Do not rewrite the existing frontend or domain architecture. Implement **Phase 8A: production backend boundary and database schema only**, without deploying or enabling mainnet marketplace functionality.
>
> First inspect and preserve `src/domain/models.js`, `src/lib/experience-service.js`, `src/lib/media-auth.js`, `src/lib/marketplace.js`, `src/lib/collection.js`, and the existing tests. Add a server/API package in the repository with validated server-only environment configuration, a versioned health/catalog/auth skeleton, PostgreSQL migrations, and typed persistence models for catalog snapshots, contracts, chain blocks, ERC-1155 transfers, ownership balances, listings, marketplace transactions, purchases, nonces, media grants, audit events, and redemptions. Implement cryptographic one-time challenge creation and EIP-191 or EIP-712 signature verification with replay protection, but do not expose protected media or enable production purchases yet. Add integration tests for nonce consumption, signature rejection, idempotent event identity, and transactional redemption transitions. Add `.env.example` without secrets. Preserve all existing client behavior. Update CI to lint, test, build, and validate migrations. Do not modify `public/assets/audio/` in this task; secure media migration is the next task. Run `npm run lint`, `npm test`, `npm run build`, and all new server tests, and report exact files changed and remaining blockers.

## References

[1]: README.md "Voidcaller repository README and known production limitation"
[2]: docs/PHASE-7-FINAL-PLATFORM.md "Phase 7 final platform foundation and production handoff"
[3]: src/lib/experience-service.js "Experience, media grant, audit, and redemption adapter contracts"
[4]: src/lib/media-auth.js "Media challenge and short-lived authorization grant contract"
[5]: src/lib/marketplace.js "Marketplace client encoding, state, and receipt verification"
[6]: src/lib/web3.js "Wallet RPC, ownership reads, chain configuration, and receipt polling"
[7]: contracts/MusicMarketplace.sol "ERC-1155 marketplace contract source"
[8]: vercel.json "Vercel SPA rewrite and static cache configuration"
[9]: .github/workflows/ci.yml "Existing lint, test, and build workflow"
[10]: package.json "Existing Vite, test, lint, and build scripts"
[11]: src/components/PurchasePanel.jsx "Client purchase flow and local ownership refresh"
[12]: src/components/ListingPanel.jsx "Client listing and approval flow"
[13]: src/lib/collection.js "Client ownership normalization and experience access resolution"
[14]: src/lib/WalletContext.jsx "Wallet discovery, account lifecycle, and ownership refresh"

## Verification performed

The audit ran the repository’s existing commands without source changes:

- `npm run lint` — passed.
- `npm test -- --reporter=dot` — passed: **7 test files, 42 tests**.
- `npm run build` — passed: Vite production build completed successfully.

## Phase 8A implementation handoff

The Phase 8A backend boundary and persistence foundation described above has now been implemented in this repository. The implementation preserves the existing React/Vite frontend and domain modules while adding a server-side control plane under `server/`:

| Area | Implemented files | Result |
|---|---|---|
| Configuration and database | `server/config.js`, `server/db.js`, `server/migrate.js`, `.env.example` | Validated server-only configuration, PostgreSQL pool, and versioned migration runner. |
| Persistence | `server/migrations/001_initial_persistence.sql`, `002_api_idempotency.sql`, `003_indexer_state.sql`, `server/repositories.js` | Catalog, contracts, chain blocks, transfers, balances, listings, marketplace transactions, purchases, nonces, grants, audit events, redemptions, jobs, idempotency, and indexer checkpoints. |
| API boundary | `server/index.js`, `server/api-http.js`, `server/api-runtime.js`, `server/api-service.js`, `server/api-errors.js`, `server/validation.js` | Health, catalog, auth, ownership, listing, purchase reconciliation, media-grant, and redemption boundaries with request IDs, stable errors, validation, rate limiting, and transactional state changes. |
| Blockchain indexing | `server/indexer.js`, `server/indexer-rpc.js`, `server/indexer-store.js`, `server/indexer-reconcile.js`, `server/indexer-utils.js` | Durable cursors, retryable RPC sync, raw event identity, finalized-block progression, ERC-1155 ownership projection, and reconciliation hooks. |
| Tests | `server/api.test.js`, `server/persistence.test.js`, `server/indexer.test.js` | Boundary, idempotency, replay, transactional redemption, interruption recovery, and reconciliation coverage. |

Current verification after restoration and implementation: `npm test -- --reporter=dot` passed with **10 test files and 63 tests**, `npm run lint` passed, and `npm run build` passed. Directly executing Vitest files with `node server/*.test.js` is not a supported test command and fails because those files require the Vitest runtime; the package script is the authoritative runner. `npm audit --omit=dev` reports **2 production dependency advisories** (1 moderate, 1 high), which must be remediated or accepted before production release.

The repository is not production-ready merely because this foundation exists. The remaining P0 gates are real PostgreSQL provisioning and migration execution, cryptographic wallet challenge/signature verification wired to a production authenticator, deployed and verified Avalanche contracts, private media migration, and a production worker/RPC/finality rehearsal. No mainnet marketplace functionality has been enabled.

## Superseding next task

> Work directly against `VoidcallerOC/The-Void` on `main`. Preserve the existing frontend, Phase 8A API boundary, persistence schema, and indexer modules. Implement **Phase 8B: cryptographic wallet authentication and authoritative blockchain reconciliation**. Add EIP-4361-style challenge creation with domain, URI, chain ID, issued-at, expiration, and one-time nonce binding; verify EIP-191 or EIP-712 signatures server-side; issue short-lived sessions or grants; enforce atomic nonce consumption and rate limits; wire the API to the indexer-backed ownership and listing reads; add production RPC configuration with provider health checks and finalized-block policy; and add tests for valid signatures, wrong-account signatures, expired challenges, replay, chain mismatch, stale ownership, and RPC interruption. Do not enable mainnet purchases, do not expose protected masters, and do not rewrite existing client domain modules. Run `npm run lint`, `npm test`, `npm run build`, and `npm audit --omit=dev`, then report exact remaining P0 blockers.
