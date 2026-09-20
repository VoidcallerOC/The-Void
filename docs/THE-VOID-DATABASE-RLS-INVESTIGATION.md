# The Void — Database Connectivity and RLS Investigation

**Investigation date:** 2026-09-19/20  
**Repository reviewed:** `VoidcallerOC/The-Void`, `main`, commit `44067ae`  
**Scope:** Read-only investigation. No schema, RLS, policy, credential, networking, or deployment configuration was changed.

## Executive conclusion

The currently serving application can reach PostgreSQL. The public Render API readiness response reported `database.ok: true` with approximately 81 ms database latency, and the current Vercel production deployment reported `database.ok: true` with approximately 13 ms latency. Therefore, the reported `CONNECT_TIMEOUT` after approximately 5,027 ms is not reproduced on the active application request path.

The strongest explanation is that the failing test is using a different database endpoint, a stale deployment/environment value, a different network origin, or a different database component than the active Render API. The repository's default PostgreSQL pool timeout is exactly 5,000 ms, which explains the similarity between the reported duration and an application-side timeout, but it does not prove that the active database is failing.

The RLS finding also has evidence of a target mismatch. The scanner reported `chain_blocks`, while the current migration set defines `chain_block_observations` and does not define `chain_blocks`. The current repository enables RLS only for the artist-domain tables introduced in migration 013 and 014; none of the 17 reported tables has an RLS enablement statement or policy in the checked-in migrations. This means the finding is credible for the database being scanned, but the repository alone cannot prove that it is the same database used by the active Render API.

No remediation should be applied until the exact database endpoint, database identity, and scanner target are reconciled.

## 1. Database connectivity

### 1.1 Application configuration

The root API loads its database connection from `DATABASE_URL`, falling back to `POSTGRES_URL` when `DATABASE_URL` is absent (`server/config.js:82`). The connection is created with `node-postgres` and a connection string (`server/db.js:18-28`). The configured defaults are:

| Setting | Repository evidence | Finding |
|---|---|---|
| Host | Supplied inside the masked `DATABASE_URL` or `POSTGRES_URL` value | The exact hostname cannot be determined without decrypting a production secret; it was not exposed. |
| Port | Supplied inside the connection URL | No hard-coded port is present. PostgreSQL's URL default would be 5432 if omitted. |
| Database | Supplied inside the connection URL | No hard-coded database name is present. |
| TLS | `DATABASE_SSL=true` in both Render API and worker definitions; `server/db.js` removes `sslmode` from the URL and passes `ssl: { rejectUnauthorized }` | TLS is required by the deployment configuration. Certificate verification is controlled by `DATABASE_SSL_REJECT_UNAUTHORIZED`; the repository default is false unless explicitly set. |
| Pool size | `DATABASE_POOL_MAX=10` | Maximum of ten connections per process by deployment manifest. |
| Idle timeout | `DATABASE_POOL_IDLE_TIMEOUT_MS=30000` | 30 seconds. |
| Connection timeout | `DATABASE_POOL_CONNECTION_TIMEOUT_MS=5000` | Five seconds. This closely matches the reported 5,027 ms failure. |
| Connection mode | `pg.Pool` direct PostgreSQL protocol | The code uses a direct PostgreSQL connection string. It does not use Supabase PostgREST for persistence. |

The Render blueprint states that the API and indexer should receive the same dedicated The Void Fuji Supabase connection string through `DATABASE_URL`. It does not reveal the secret's actual hostname, port, user, or database.

### 1.2 Pooled versus direct PostgreSQL endpoint

The active code does not determine whether the secret's hostname is Supabase's pooler endpoint or Supabase's direct database endpoint. It only proves that the value is consumed as a normal PostgreSQL URL by `pg.Pool`. The checked-in repository does not contain a literal Supabase pooler hostname, direct project database hostname, or connection mode marker.

Vercel production metadata contains masked variables named `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, and `POSTGRES_URL_NON_POOLING`, as well as `POSTGRES_HOST`, `POSTGRES_DATABASE`, `SUPABASE_URL`, and Supabase key variables. Because their values were not decrypted, this metadata is evidence that multiple integration variables exist, not evidence that they point to the same database. The source code uses `DATABASE_URL`/`POSTGRES_URL`; it does not reference `POSTGRES_URL_NON_POOLING` or `POSTGRES_PRISMA_URL`.

The Vercel project configuration also rewrites `/api/*` to `https://the-void-api-fuji.onrender.com/api/*`. Thus the normal production API path is Render-backed, even though Vercel has database-related environment variables and also contains serverless handler files.

### 1.3 Where the timeout was and was not reproduced

The following read-only checks were performed:

| Origin or component | Observation | Interpretation |
|---|---|---|
| Render API `/api/health` | HTTP 200; service health response | The process is serving requests. This route alone does not exercise PostgreSQL. |
| Render API `/api/health/ready` | HTTP 503; `database.ok: true`, database latency about 81 ms; indexer unhealthy with no checkpoints | PostgreSQL connectivity works from the deployed Render API. Readiness is correctly failing for the indexer, not for the database. |
| Vercel current production deployment `/api/health` | HTTP 200 | The Vercel deployment is serving the API handler or forwarding it successfully. |
| Vercel current production deployment `/api/health/ready` | HTTP 503; `database.ok: true`, database latency about 13 ms; indexer unhealthy with no checkpoints | PostgreSQL connectivity also works from the Vercel production execution path at the time of the check. |
| Vercel production runtime logs | Repeated `/api/indexer/tick` requests returned HTTP 200; no database timeout was observed in the narrowed log sample | The cron/serverless path is executing, although HTTP 200 does not by itself establish successful indexing. |
| Local investigation environment | No production `DATABASE_URL` was available to test. DNS resolution of the public Render API succeeded. | A local direct-PostgreSQL test against the production database was not attempted because the endpoint and credentials were intentionally not exposed. |
| Supabase itself | No Supabase database connection diagnostic or SQL introspection was available through the configured connectors. | The source of the reported scanner timeout cannot be attributed to Supabase itself. |
| Security/audit scanner | The reported duration is approximately 5,027 ms, close to the application's 5,000 ms pool timeout. | The scanner may be using a stale, incorrect, IPv6-only, firewall-blocked, pooler-incompatible, or otherwise different endpoint. This remains unconfirmed. |

The public alias `https://the-void.vercel.app` returned an unrelated SvelteKit-style page and 404s for the API health paths. The current project deployment URL returned the expected Voidcaller application and health responses. This is additional evidence that aliases and deployment targets need to be reconciled before treating a public URL as the authoritative production surface.

### 1.4 IPv4, IPv6, firewall, and pooling assessment

The public Render hostname resolved to IPv4 addresses during the check. No IPv6 address was returned for that hostname. This does not test the hidden database hostname. IPv4/IPv6 preference, egress firewall rules, Supabase network restrictions, and pooler capacity therefore remain open questions for the failing scanner path.

The active application reached the database quickly enough to return a database health result. There is no evidence in the available application logs of pool exhaustion or a database connection storm. The database readiness check executes `SELECT 1`; the full readiness checker then validates schema migrations and queries indexer checkpoint state. A successful `/api/health` response is intentionally possible when PostgreSQL is unavailable because the liveness route does not call the database. A successful `/api/health/ready` database result is stronger evidence and was observed in both active paths.

### 1.5 Most likely cause of `CONNECT_TIMEOUT`

The likely cause is **endpoint/configuration divergence**, not bad credentials and not an outage of the database reached by the active API. The leading possibilities are:

1. The scanner is testing a masked Vercel integration endpoint rather than Render's `DATABASE_URL`.
2. The scanner is testing an old or different Supabase project, possibly one with a direct endpoint that is not reachable from the scanner network.
3. The scanner is using a pooled endpoint with an incompatible connection mode or a direct endpoint from a network that cannot reach it.
4. The scanner is resolving a different address family or encountering an egress/firewall restriction.
5. The scanner is testing the wrong database entirely. The `chain_blocks` versus `chain_block_observations` discrepancy supports this possibility.

Credentials should not be rotated based on the current evidence. A TCP timeout occurs before authentication and is not, by itself, evidence of an invalid password.

## 2. Application database dependency

### 2.1 Components that require direct PostgreSQL access

The root application has one direct PostgreSQL persistence layer using `node-postgres`:

- The Render web API creates a pool and uses repositories and services for catalog, collector, marketplace, wallet authentication, media authorization, studio, and operational health.
- The Render indexer worker creates a pool and writes blockchain events, block observations, transfers, ownership snapshots, listings, purchases, transactions, checkpoints, errors, and reconciliation state.
- The Vercel handler can also create the same pool when `DATABASE_URL` is present. It runs migrations on first use and supports the cron indexer tick. In the configured Vercel routing, however, `/api/*` is rewritten to Render.
- The nested `artist-verification` application has a separate `DATABASE_URL`-driven Postgres path and an embedded PGLite fallback when no database URL is present. Its auth source is separate from the root API and should not be assumed to use the same database without deployment inspection.

### 2.2 Components using Supabase APIs

The checked-in root application contains no Supabase client initialization and no `.from(...)` PostgREST persistence calls. The root server uses direct SQL through `pg`.

Vercel production has masked Supabase URL, publishable/anon, secret, service-role, and JWT variables. Their presence is configuration evidence only. No root application source reviewed in this investigation consumes the Supabase service-role key or calls Supabase Auth/PostgREST directly.

### 2.3 Service-role credentials

The Vercel project metadata includes a masked `SUPABASE_SERVICE_ROLE_KEY` and a masked `SUPABASE_SECRET_KEY`. The repository's root runtime does not reference these names. The root persistence comments describe the server connection as a superuser/service-role-like connection that bypasses RLS, but the actual database role is encoded in the hidden PostgreSQL URL and was not revealed.

The security consequence is still important: enabling RLS on tables without first designing policies for the actual database role and all application paths could break the server or could create a false sense of protection if the connection role bypasses RLS.

### 2.4 Readiness and liveness behavior

`/api/health` is a liveness check. It can return success while direct database connectivity is unavailable.

`/api/health/ready` calls database health, migration/schema validation, RPC health, and indexer checkpoint queries. The observed response had `database.ok: true` and `indexer.ok: false`. This proves that the application can distinguish database availability from indexer readiness. It also means a generic successful API response must not be used as proof that the database is healthy; the readiness endpoint must be used.

## 3. RLS inventory

The table inventory below is based on the current migration files and application SQL. The scanner's actual grants and policies were not available for direct read-only SQL inspection, so the “existing policy evidence” column distinguishes repository evidence from live-database facts.

**Important:** The scanner reported `chain_blocks`, but the current repository defines `chain_block_observations` instead. `chain_blocks` is therefore marked as a target-mismatch item rather than silently mapped to another table.

| Table | Purpose and data classification | User-owned/private? | Public read? | Write model | Existing policy evidence and application use | Recommended policy model |
|---|---|---|---|---|---|---|
| `collectors` | Wallet-level collector identity and last-seen state. | Low-to-moderate privacy; wallet addresses are public-chain identifiers but still user-linked. | Prefer no direct public table read. Expose only the authenticated wallet's derived view through the API. | Server/indexer only. | Created/updated by indexer; read by authenticated collector API. No RLS statement in current migrations. | Enable RLS. Deny anon/authenticated direct access. Permit server role only, or use narrowly scoped authenticated self-read if direct PostgREST access is required. |
| `chain_blocks` | Reported by scanner, but not defined in current migrations. | Unknown until schema identity is confirmed. | Do not decide before identifying the database/schema. | Unknown. | No current migration definition found; repository uses `chain_block_observations`. | First reconcile scanner target and schema. Do not enable or disable anything based on this name alone. |
| `transfers` | Indexed token transfer history, including wallets, token IDs, block data, and event payload. | Wallet-linked activity; not secret, but sensitive as a user activity profile. | A filtered public catalog may be safe, but raw table exposure is not recommended. | Indexer/server only. | Read by collection activity and reconciliation; written by indexer. No RLS statement in current migrations. | Enable RLS. Deny direct writes. Allow only server role, or a carefully filtered read surface that excludes unnecessary wallet/activity detail. |
| `experiences` | Published experience/catalog records and entitlement requirements. | Mixed: public catalog fields and potentially private entitlement/media configuration. | Only explicitly public/published fields should be exposed. | Studio/server only. | Public API reads published experiences; media service reads requirements and media configuration. No RLS statement in current migrations. | Enable RLS. Allow public read only through a view or policy limited to `status='PUBLISHED'` and safe columns. Keep requirements and media configuration server-only unless separately classified. |
| `ownership_snapshots` | Current token ownership balances and synchronization metadata. | User-linked private/semiprivate state; also authoritative authorization input. | No raw table read. | Indexer/reconciliation/server only. | Read for collector and media authorization; written by indexer/reconciliation. No RLS statement in current migrations. | Enable RLS. Server-only access is the safest default. Do not allow client writes. |
| `listing_status_history` | Immutable/history records for marketplace listing state changes. | Contains transaction and listing activity; not secret but operationally sensitive. | Public history may be acceptable after API shaping. | Indexer/server only. | Written/read by marketplace/indexer code; no RLS statement in current migrations. | Enable RLS. Server-only writes. Public reads only through a safe view or API, not raw PostgREST access. |
| `transactions` | Blockchain transaction lifecycle, wallet addresses, hashes, and status. | Wallet-linked financial/marketplace activity. | Do not expose raw table by default. | API submission plus indexer/reconciliation writes. | API creates pending transactions; indexer updates them; marketplace API reads them. No RLS statement in current migrations. | Enable RLS. Server-only writes. Authenticated self-scoped reads may be implemented through API; public raw reads should be avoided. |
| `purchases` | Marketplace settlement records, buyer/seller, quantity, sale price, and status. | Yes, user-linked commerce data. | No raw public read. A redacted public sale history may be intentional, but should be an API/view decision. | Indexer/reconciliation/server only. | Marketplace API reads; indexer writes and reconciles. No RLS statement in current migrations. | Enable RLS. Server-only writes. Limit reads to server/API or wallet-scoped authenticated policy. |
| `listings` | Marketplace offers, seller, price, asset, expiry, and status. | Seller wallet and commercial data; public active listings are product data. | Active listing catalog can be public if only safe columns are exposed. | Server/indexer only; user actions are submitted to server and then observed on-chain. | Public marketplace API reads active listings; server/indexer writes. No RLS statement in current migrations. | Enable RLS. Public SELECT only for safe active, non-expired listings. No client INSERT/UPDATE/DELETE. Server role handles mutations. |
| `experience_grants` | Short-lived entitlement grants tied to wallet, experience, media type, nonce hash, expiry, and revocation. | Highly private/security-sensitive. | No. | Server/media authorization only. | Media service and repository use it; no RLS statement in current migrations. | Enable RLS. Strict server-only access. Do not expose via anon/authenticated PostgREST. Consider extra audit and expiry controls. |
| `redemptions` | Wallet-specific experience redemption state and metadata. | Yes; entitlement and user activity state. | No raw read. | Server-only state transitions. | Repository reads/writes redemption records; no RLS statement in current migrations. | Enable RLS. Server-only. If users need status, return a minimal wallet-scoped API response. |
| `audit_events` | Security and operational audit trail, including actor, request ID, transaction hash, and arbitrary payload. | Highly sensitive because payload may contain security or personal context. | No. | Server-only append; controlled administrative read. | Repository inserts events; no RLS statement in current migrations. | Enable RLS. Deny anon/authenticated. Restrict reads to audited operator/service role; avoid broad superuser use for routine reads. |
| `media_authorizations` | Media grant/deny/revoke audit records, IP and user-agent hashes, request IDs, and reasons. | Highly sensitive. | No. | Server/media service only. | Media service/repository writes and reads; no RLS statement in current migrations. | Enable RLS. Strict server-only. Never expose raw rows to clients. |
| `blockchain_events` | Raw indexed chain event data and payloads, canonicality, and malformed-event diagnostics. | Operationally sensitive; payload may include wallet and contract activity. | Not directly. Public catalog/API projections may be safe. | Indexer only. | Indexer store writes and queries; no RLS statement in current migrations. | Enable RLS. Server/indexer-only writes and reads. Publish only derived safe data. |
| `chain_block_observations` | Observed block hashes, parent hashes, timestamps, and canonicality used for reorg detection. | Operational integrity data. | No raw direct access. | Indexer only. | Defined in migration 003 and used by indexer store; no RLS statement in current migrations. | Enable RLS. Server/indexer-only. Treat as integrity-critical and immutable except controlled reconciliation. |
| `indexer_errors` | Indexer error type, message, chain coordinates, and JSON payload. | Operationally sensitive; payload may contain internal details. | No. | Indexer/server append; restricted operator read. | Defined in migration 003 and written by indexer store; no RLS statement in current migrations. | Enable RLS. Server/operator-only. Sanitize error payloads before any external reporting. |
| `auth_nonces` | Wallet authentication challenge hashes, purpose, origin/domain/URI, expiry, and consumption state. | **Authentication/security-sensitive.** | No. | Wallet auth service only. | Wallet auth service creates, consumes, and verifies nonces; no RLS statement in current migrations. | Enable RLS. Strict server-only. Never expose raw rows or nonce metadata through public APIs. Pair with short expiry, one-time consumption, and audit controls. |

### 3.1 Tables that should be server-only

At minimum, `experience_grants`, `redemptions`, `audit_events`, `media_authorizations`, `blockchain_events`, `chain_block_observations`, `indexer_errors`, `auth_nonces`, `ownership_snapshots`, `collectors`, `transfers`, `transactions`, and `purchases` should be treated as server/indexer-only tables. `listings` and `experiences` can have public product surfaces, but those surfaces should be implemented through safe views or API responses rather than broad raw-table grants.

### 3.2 Tables that may safely expose public reads

Only selected projections are candidates for public reads:

- `experiences`: published rows and explicitly public catalog fields.
- `listings`: active, non-expired listings with public commercial fields.
- Potentially selected `listing_status_history` or `transfers` projections if the product intentionally publishes that history and wallet privacy has been considered.

No reported table should receive public write access. No table containing authentication, entitlement, authorization, audit, or raw indexer data should receive public read access.

### 3.3 Existing RLS evidence

Migration 013 enables RLS on `artists`, `artist_profiles`, and `artist_owners`. It creates public SELECT policies only for active artists and profiles; `artist_owners` has no public policy. Migration 014 enables RLS on the verification application, reviewer, status-event, and rate-limit tables without adding public policies. The 17 reported tables have no corresponding `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` statements in the checked-in current migration set.

This is a repository finding, not a live SQL grant dump. The live scanner's report should be supplemented with a read-only query of `pg_class`, `pg_policies`, and `information_schema.role_table_grants` against the exact database used by Render and the exact database used by the scanner.

## 4. Evidence and limitations

Evidence collected:

- Repository source and migrations at commit `44067ae`.
- Render blueprint and Vercel routing configuration.
- Vercel project/deployment metadata, including current production deployment `dpl_EuRdxk8fQ3nXCMfcikjsaMCiDt4B`.
- Vercel environment-variable names with values kept masked.
- Public health/readiness probes of Render and the current generated Vercel deployment.
- Narrowed Vercel runtime logs for the current production deployment.

Limitations:

- The production PostgreSQL URL was not decrypted or printed.
- No direct read-only SQL session to Supabase was available, so live grants, policies, `relrowsecurity`, endpoint identity, and server-side role attributes were not independently queried.
- Render environment values and Render service logs were not available through the configured read-only connector.
- The original scanner request, source IP, resolved address, exact hostname, port, TLS mode, and target project ID were not provided.

## 5. Exact remediation steps, after the target is reconciled

1. **Freeze the target identity.** Record, in a protected operator channel, the Supabase project reference, database name, endpoint hostname, port, database role, SSL mode, and whether the endpoint is pooled or direct. Compare this record with Render's `DATABASE_URL`, Vercel's effective runtime variables, the nested artist-verification deployment, and the security scanner target. Do not print passwords or keys.
2. **Capture a redacted connection fingerprint.** From each deployment, log only hostname, resolved address family, port, database name, role name if safe, SSL requirement, and a non-secret database/project fingerprint. Do not log the full URL.
3. **Re-run connectivity from each origin.** Test DNS A/AAAA resolution, TCP connect, TLS negotiation, and authenticated `SELECT 1` separately from local development, Render web, Render worker, Vercel serverless, and the scanner network. Keep the five-second application timeout separate from the scanner timeout. Record whether the endpoint is pooler or direct.
4. **Inspect live RLS and grants read-only.** For every reported table, query `pg_class.relrowsecurity`, `pg_class.relforcerowsecurity`, `pg_policies`, `information_schema.role_table_grants`, and relevant default privileges. Run the query against the exact database fingerprint, not merely a project URL copied from an environment integration.
5. **Resolve schema drift.** Determine why the scanner sees `chain_blocks` while the current migration set uses `chain_block_observations`. Compare the live migration ledger and schema fingerprint with migrations 001–014. Do not rename, drop, or create tables during this investigation.
6. **Design policies by data class.** Use server-only policies for security, authorization, audit, wallet-authentication, and indexer-integrity tables. Use explicit public SELECT policies or safe views only for published experiences and active listings. Keep all writes server-side.
7. **Review the server database role.** Confirm whether the `DATABASE_URL` role is a true PostgreSQL superuser, a Supabase service role, or a restricted application role. If it bypasses RLS, document that fact and use database privileges plus API isolation as defense in depth; do not claim that RLS protects the bypassing role.
8. **Apply changes only through reviewed migrations.** Any RLS or grants change must include policy tests for anon, authenticated, server, and unauthorized wallet cases. No blanket enablement should be used without per-table policies and application regression tests.

## 6. Tests required after remediation

The following tests are required before production security sign-off:

- From each runtime origin, verify TCP, TLS, and authenticated PostgreSQL connection using the confirmed endpoint and expected timeout.
- Verify the liveness endpoint can remain up while readiness correctly fails when the database is unavailable.
- Verify readiness returns database failure when `SELECT 1` or migration validation fails, and returns indexer failure independently when checkpoints are absent or stale.
- For every table, test anon SELECT/INSERT/UPDATE/DELETE, authenticated SELECT/INSERT/UPDATE/DELETE, server-role behavior, and unauthorized wallet access.
- Test that public catalog reads cannot retrieve private columns, security payloads, raw wallet activity, grants, nonces, audit events, media authorization records, or indexer diagnostics.
- Test that client requests cannot write listings, purchases, transactions, ownership, grants, redemptions, or indexer state directly.
- Test wallet authentication nonce expiry, one-time consumption, domain/origin binding, replay rejection, and absence of nonce disclosure.
- Test media authorization fail-closed behavior, revocation, expiry, ownership loss, and audit logging.
- Test indexer writes, reorganization recovery, canonicality changes, checkpoint leasing, and error recording under the final policy model.
- Confirm schema migration validation and backup/restore procedures against the same database fingerprint used in production.
- Repeat the original security scan only after confirming its target fingerprint matches the application database.

## 7. What must be fixed before production can be considered secure

- The application, Vercel integration, Render services, and security scanner must be proven to reference the same intended database, or their separation must be explicitly documented.
- The source of the 5,027 ms `CONNECT_TIMEOUT` must be identified and reproduced or ruled out from each relevant network origin; the current active API path is healthy at the database layer.
- The `chain_blocks` versus `chain_block_observations` schema discrepancy must be resolved as target drift, schema drift, or scanner error.
- Live RLS state, policies, grants, and role bypass attributes must be captured for the exact production database.
- RLS and grants must be designed per table, with server-only controls for authentication, entitlement, audit, media authorization, and indexer data; blanket disablement or blanket enablement is not acceptable.
- Public reads must be limited to intentionally public catalog projections such as published experiences and active listings, with no client writes.
- Readiness and indexer health must remain failing until the indexer has valid checkpoints and recent successful runs.
- The production environment must not rely on untracked, ambiguous, or stale database variables, and no secret values may appear in logs or audit output.

**STATUS: INVESTIGATION COMPLETE**

## References

[1]: https://github.com/VoidcallerOC/The-Void "The Void source repository"
[2]: https://github.com/VoidcallerOC/The-Void/blob/main/render.yaml "The Void Render deployment configuration"
[3]: https://github.com/VoidcallerOC/The-Void/blob/main/vercel.json "The Void Vercel routing and cron configuration"
[4]: https://github.com/VoidcallerOC/The-Void/blob/main/server/db.js "The Void PostgreSQL pool implementation"
[5]: https://github.com/VoidcallerOC/The-Void/blob/main/server/readiness.js "The Void readiness checker"
[6]: https://the-void-api-fuji.onrender.com/api/health/ready "The Void public Render readiness endpoint"
[7]: https://the-void-88vbdm6qj-nickhsousa96-8307s-projects.vercel.app/api/health/ready "The Void current Vercel deployment readiness endpoint"
[8]: https://vercel.com/nickhsousa96-8307s-projects/the-void/EuRdxk8fQ3nXCMfcikjsaMCiDt4B "The Void current Vercel production deployment"
