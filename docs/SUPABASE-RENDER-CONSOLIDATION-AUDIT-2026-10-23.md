# Supabase → Render Consolidation: Read-Only Safety & Success-Gate Audit

**Audit date:** 2026-10-23 (evidence timestamps 22:10–23:10 UTC)
**Mode:** strictly read-only. No source, configuration, secret, database, deployment, DNS, billing, or plan was changed. Only `SELECT`/catalog queries and read-only platform APIs were used.
**Auditor:** Claude (chief counsel / editor role). Not legal advice; no implementation performed.
**Status vocabulary:** `COMPLETE | PARTIAL | BLOCKED | UNVERIFIED | NOT STARTED`.

---

## 0. Executive verdict

**Overall: `BLOCKED`.**

| Scope | Verdict | One-line reason |
|---|---|---|
| The-Void **Mainnet** | `BLOCKED` | F5 is now *mechanically explained* (a point-in-time restore on 2026-10-17 01:39 UTC rolled the database back ~14 h) but the restore is **unattributed** and the lost-write window is **unreconciled**. Hard rule applies. |
| The-Void **Fuji** | `BLOCKED` | F1 confirmed: Fuji is at migration 039, `main` is at 049 and the Fuji indexer auto-deploys `main`. |
| ForgeCT | `READY FOR PLANNING` | Plain-Postgres port is small (12 SECURITY DEFINER functions, 6 tables); Stripe test-mode plan still required. |
| Life Tracker | `READY FOR PLANNING` | Plain `pg`, no Supabase features; needs Render CA/TLS answer and a session (non-pooled) connection. |
| TCG calculator | `READY FOR PLANNING` (retire path) | Live scanner/pricing do not touch Supabase; admin + nightly sync are broken/failing and are retire candidates pending owner decision. |
| Harris in Wonderland | `UNVERIFIED` | Its database is **not** any of the five Supabase projects in the org; the real host could not be identified read-only. |
| Render target | `NOT STARTED` | The Render workspace has **zero** Postgres instances; nothing exists yet to validate. |
| Invoice six-ID mapping | `PARTIAL` | Five IDs mapped with evidence; the sixth is `UNVERIFIED` (invoice itself was not reachable from this session). |

**Exact next action (one owner):** Nick opens Supabase → project *The Void Mainnet* (`utgyamnzfcffjqmoboup`) → **Database → Backups** and records whether a *Restore* from the **2026-10-16 ~11:31 UTC** daily backup was initiated at **2026-10-17 01:39 UTC**, and by whom. If the page shows no restore record, open a Supabase support ticket quoting those timestamps. Nothing else on the mainnet path can be unblocked before this answer exists (§4, F5).

---

## 1. Baseline and what was reused

* The prompt's baseline (invoice $65.45/mo, six project IDs, two-instance Render architecture at $28/mo, Hobby workspace, $37.45/mo estimated savings) was taken as given and **verified where possible** (§5, §9).
* The prior repository audit `docs/PRODUCTION-INFRASTRUCTURE-AUDIT.md` (2026-09-09) and `docs/THE-VOID-DATABASE-RLS-INVESTIGATION.md` were read and reused for architecture context.
* **Not found anywhere reachable:** a document titled "Supabase exit addendum" or a prior audit carrying the F1–F5 numbering. Searched: this repo (all branches: only `main` and this audit branch exist), `VoidcallerOC/war-room` (`MASTER.md` has no Supabase/Render content), ForgeCT `docs/` and `WAR-ROOM/`, life-tracker `docs/`, tcg-buy-calculator reports, Google Drive (`fullText contains 'Supabase'`), Gmail. The F1–F5 findings were therefore **re-derived from current evidence** (§4) rather than copied. Where this report agrees with the prompt's description of F1–F5, that is independent confirmation.
* The prior findings that *were* reused without re-doing them: the TCG "scanner does not depend on Supabase" finding (`TCG_BUY_CALCULATOR_NUKE_AUDIT_2026-10-11.md` F-01), the ForgeCT `FULL-NUMBERS-NUKE-AUDIT-2026-10-09.md` reconciliation (D14/D15), and the life-tracker Phase 3A/3B Postgres docs.

---

## 2. Six-project invoice mapping

The invoice file itself was **not available** to this session (not in Gmail, Drive, or any repo; no attachment reached the session). Mapping below is from the live Supabase Management API (`list_organizations`, `list_projects`, `get_organization`), the Vercel integrations list, and Gmail.

**Organization visible to the MCP token:** `VoidcallerOC's Org` (`wtbvqhlinvuecrxzdcou`), plan **Pro** (`tier_pro`).

| # | Project ref | Name | Region | Created | PG | DB size (live) | Application | Billing status |
|---|---|---|---|---|---|---|---|---|
| 1 | `utgyamnzfcffjqmoboup` | The Void Mainnet | us-east-2 | 2026-09-09 | 17.6.1.166 | 30 MB | The-Void mainnet API + indexer (Render), thevoidstudio.xyz | In Pro org (`VERIFIED`) |
| 2 | `qobyzszcydznuutqqhmf` | The-Void | us-east-1 | 2026-09-10 | 17.6.1.166 | **2,106 MB** | The-Void Fuji API + indexer (Render), the-void-alpha.vercel.app | In Pro org (`VERIFIED`) |
| 3 | `dnkhtmtgtauctyvzktck` | ForgeCT | us-west-2 | 2026-09-06 | 17.6.1.166 | 12 MB | forge-ct.com (Vercel `forgect`) **+ legacy TCG schema** (§3) | In Pro org (`VERIFIED`) |
| 4 | `agscctnjusfqcpisirsq` | TCG Calculator | ca-central-1 | 2026-09-16 | 17.6.1.166 | 64 MB | tcg-buy-calculator admin + nightly sync only | In Pro org (`VERIFIED`) |
| 5 | `snjzevsotrtdwhngesxi` | life-tracker | us-east-2 | 2026-10-03 | 17.11.0.002 | 12 MB | nicklife.xyz (Vercel `life-tracker`) | In Pro org (`VERIFIED`) |
| 6 | **`UNVERIFIED`** | — | — | — | — | — | — | — |

**Sixth ID — evidence and hypotheses**

* Published Supabase pricing (fetched 2026-10-23): Pro is $25/mo including $10 compute credit; each project's Micro compute is $10/mo. Five Micro projects → $25 + 5×$10 − $10 = **$65.00**. The invoice total of **$65.45 incl. tax** is arithmetically consistent with **five** compute-billed projects plus a small tax/usage line. This does **not** prove the invoice lists only five billable IDs; the prompt says six.
* A sixth Supabase project exists outside the visible org: **`rnzheflamxlsbenlyozo` "supabase-cyan-pebble"**, created through the **Vercel Marketplace** installation `icfg_we6Tv1URS5kmcdyCpxXXALxq` (installed 2026-08-17, billing plan "Supabase Free Plan — $0/month"), in org **"nickhsousa96-8307's projects"**. Supabase emailed on 2026-09-19 08:39 UTC that it had been **auto-paused** (Gmail message `1a0b8d21757cf9f7`; an earlier pause/restore cycle is visible in messages `1a061608…`, `1a066a9a…`, `1a0b38ec…`). The Management API returns *"You do not have permission"* for it. A Free-plan Marketplace project is billed by Vercel, not on the Pro org invoice, so it is a **weak** candidate for the sixth billed ID.
* A **deleted** project that existed during the billing period (pro-rated compute) would also appear as a sixth ID. The ForgeCT project contains an abandoned TCG schema dated 2026-09-14, two days before the standalone TCG project was created, so project churn in that window is plausible. `UNVERIFIED`.
* **Resolution path (owner):** open the invoice PDF in Supabase → Organization → Billing → Invoices and read the six project refs against this table.

---

## 3. Dependency disposition table

Dispositions: `MIGRATE` (move data/schema to Render), `REPLACE` (swap mechanism), `RETIRE` (remove), `KEEP TEMPORARILY` (retain through rollback window), `UNVERIFIED`.

### 3.1 The-Void Mainnet (project 1) — must be **last**

| Dependency | Evidence | Disposition |
|---|---|---|
| Postgres via `DATABASE_URL` (Supabase **session pooler**, verified TLS via `DATABASE_SSL_CA`) from Render `the-void-api-mainnet` (`srv-db8ib9ajnfac73fs5r20`) and `the-void-indexer-mainnet` (`srv-db8j8o8u01pc738cubsg`) | `deploy/mainnet/render.mainnet.yaml`; `server/db.js` (`isSupabaseDatabaseUrl`, CA requirement); `server/config.js:212` (`DATABASE_URL || POSTGRES_URL`) | `MIGRATE` (last) |
| 56 public tables, 49 repo migrations applied (`001…049`, 049 applied 2026-10-23 22:19 UTC), **0 sequences**, 0 public functions, 0 triggers, extensions `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault` | `public.schema_migrations`; `pg_extension` | `MIGRATE` (vault is Supabase-only and unused by code: `RETIRE`) |
| RLS: all 56 tables RLS-enabled; only 2 policies (`artists_select_active`, `artist_profiles_select_active` for `anon, authenticated`); all grants are `service_role` (392) + owner `postgres` | `pg_policies`, `role_table_grants`; advisor `rls_enabled_no_policy` ×54 (INFO) | `REPLACE` → single app role on Render; policies are irrelevant without PostgREST but migrations 013/017 **reference `anon`/`authenticated`** and will fail unless those NOLOGIN roles exist (CI creates them: `.github/workflows/ci.yml:121`) |
| Indexer lease (`indexer_worker_leases`, key `voidcaller-indexer`, heartbeat 2026-10-23 23:06 UTC), checkpoints per contract (6 rows, all `IDLE`, 0 failures), replay via `chain_blocks`/`chain_block_observations` | `server/indexer-worker.js:60-75,136-182`; live rows | `MIGRATE` (lease/checkpoint rows must be copied or the indexer re-synced from contract start blocks) |
| **Supabase GitHub integration ("Supabase workflow") attached to this project, running on every push to `main`** | `workflow_run_logs`: "Cloning git repo… git_ref=main", "Pulling migrations…", "All migrations are up to date", "No functions to deploy" at 00:56, 01:20, 01:44 UTC on 2026-10-17 and 09:42 UTC on 2026-10-22, each matching a Render deploy of the same commit | **`RETIRE`** before cancellation (new finding; not previously inventoried) |
| Supabase pooler receiving **129 failed `password authentication failed for user "postgres"`/day** | `supavisor_logs` 2026-10-22 22:30→2026-10-23 22:30 UTC | `UNVERIFIED` source; security hygiene item (rotate/identify before migration so the stale client does not follow) |
| Supabase Storage / Auth / Edge Functions / Realtime | 0 buckets, 0 auth users, 0 edge functions | `RETIRE` (unused) |
| Vercel `the-void-vercel-mainnet` (thevoidstudio.xyz): only `VITE_STUDIO_ONCHAIN_DEPLOY`; no Supabase env | `filter_project_envs` | none |

### 3.2 The-Void Fuji (project 2)

| Dependency | Evidence | Disposition |
|---|---|---|
| Postgres via `DATABASE_URL` from Render `the-void-api-fuji` (**free plan**, autodeploy off) and `the-void-indexer-fuji` (autodeploy **on**, `main`) | `render.yaml`; `list_services` | `MIGRATE` (after F1) |
| 51 tables; migrations **001–039 only** (039 applied 2026-10-12 01:54 UTC); `040…049` missing | `public.schema_migrations` | `BLOCKED` by F1 |
| **35 policies**: 33 × `deny_anon_authenticated [ALL]` + the two select policies. The 33 come from Supabase-dashboard migrations `20260920014348 enable_deny_by_default_rls` and `20260920110816 artists_policy_cleanup_20260920`, **not** from repo files | `supabase_migrations.schema_migrations`; `pg_policies` | `REPLACE` (same effect as Mainnet's "RLS on, no policy, service_role only"; reconcile deliberately, do not copy blindly) |
| Dataset: 2,106 MB total of which `chain_block_observations` 1,113 MB + `chain_blocks` 976 MB (2,273,595 rows); **all application data ≈ 16 MB** | size query | `MIGRATE` app tables; chain tables `REPLACE` by re-index from RPC (saves ~2 GB of transfer/storage) — architectural option, owner decision |
| 25 indexer checkpoints; several with high failure counters (`RELEASE_FACTORY 0xa5cba0f9 failures=223`, `PRIMARY_SALE 0x3671e193 failures=197`, four `RUNNING`) | `indexer_checkpoints` | `UNVERIFIED` health; must be green before cutover |
| Storage bucket `voidcaller-fuji-masters` (private) — **0 objects** | `storage.buckets/objects` | `RETIRE` |
| Vercel `the-void` (Fuji front end, the-void-alpha.vercel.app): Supabase-integration-injected `POSTGRES_*`, `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*` (integration `icfg_mbF5k4qmZBzZQ4jtIKeunjpT`, 2026-09-13) **not read by the Vite front end** | env names; `src/` has no Supabase client | `RETIRE` (remove integration + vars) |

### 3.3 ForgeCT (project 3)

| Dependency | Evidence | Disposition |
|---|---|---|
| PostgREST **RPC over `fetch`** with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (no supabase-js, no `pg`) in 4 modules (`_webhook-store`, `_proposal-store`, `_lead-store`, `_ratelimit`) | `nitro/server/core/*.js` (mirrored in `api/`) | `REPLACE` with a `pg` pool calling the **same** functions |
| 12 SECURITY DEFINER functions (`claim/mark/release_stripe_webhook_event`, `increment_rate_limit`, `insert_inquiry_lead`, `update_inquiry_lead_delivery`, 6 × `proposal_*`), 6 tables, RLS on with **no policies**, EXECUTE granted to `service_role` only (live, verified) | `pg_proc`, `routine_privileges` | `MIGRATE` (portable plpgsql; re-grant to the Render app role) |
| Live data: `stripe_webhook_events` 12 (all `processed`), `proposals` 1 (`PAYMENT_PENDING`), `inquiry_leads` 1 | counts | `MIGRATE` (small; export before cutover) |
| Supabase CLI migrations applied: `…stripe_webhook_events_and_rate_limits` (2026-09-30), `…forgect_inquiry_leads` (2026-10-09) → closes the 10-09 audit's open D14 item | `supabase_migrations` | — |
| **Legacy TCG schema inside the ForgeCT project**: `tcg_*` tables, `tcg_is_admin`, `tcg_publish_pricing_import`, `tcg_assert_production_publish_allowed`, `tcg_catalog_search`, trigger `tcg_production_publish_gate`, 15 TCG policies, with **EXECUTE granted to `anon`/`authenticated`** on `tcg_publish_pricing_import` | live catalog; migrations dated 2026-09-14 | **`RETIRE`** (new finding; do not migrate; the standalone TCG project superseded it on 2026-09-16) |
| Edge Functions `tcgplayer-sync`, `tcgcsv-sync`, `justtcg-sync` deployed in **this** project (ACTIVE, v2, 2026-09-14) — referenced by nothing in ForgeCT; the TCG repo's admin page calls `/functions/v1/justtcg-sync` on the *TCG* project, where they are not deployed | `list_edge_functions` | `RETIRE` |
| Scheduled: GitHub `production-smoke-schedule.yml` every 6 h (GET-only, no DB) | workflow | `KEEP TEMPORARILY` |
| Vercel `forgect` env: Supabase-integration vars + hand-set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Stripe + Resend names | env names | `REPLACE` (`DATABASE_URL` for Render) then `RETIRE` Supabase names |

### 3.4 TCG calculator (project 4)

| Dependency | Evidence | Disposition |
|---|---|---|
| Live scanner + pricing (`/api/cards`, `/api/games`, `/api/identify`) → JustTCG via `JUSTTCG_API_KEY`; Supabase branch is env-gated and **Vercel has no Supabase env** | `api/cards.js:142-146,319-326`; Vercel env (only `JUSTTCG_API_KEY`); browser test `tests/browser/card-list.spec.js:133-139` | **No Supabase dependency** (`VERIFIED` from code + env; reuse of 10-11 audit F-01) |
| Admin page: Supabase Auth password sign-in + RPC `tcg_publish_pricing_import` (missing live), tables `tcg_condition_policies`/`tcg_source_compliance` (missing live), 0 auth users, 0 admins | `admin/admin.js`; live catalog | `RETIRE` or `REPLACE` (owner decision) |
| Nightly GitHub workflow `catalog-sync.yml` (03:17 UTC; secrets `JUSTTCG_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; hard-coded project URL) | workflow; live `tcg_catalog_sync_runs`: **42 of 42 runs failed**, last 2026-10-23 08:36 UTC, error "Quota exceeded…"; it still inserts rows and fetches prices (latest `fetched_at` 2026-10-23 08:45 UTC) | `RETIRE` (disable schedule first; it burns JustTCG quota daily) |
| Hard-coded `https://agscctnjusfqcpisirsq.supabase.co` in `vercel.json` CSP `connect-src`, `data/config.json` (+ publishable key), workflow, admin test | files | `RETIRE` with admin |
| Live data: catalog 2 games/113 sets/2,761 cards/13,010 variants/67,491 prices (rebuildable from JustTCG), `tcg_clients` 1 (`Hard Hittin`, i.e. the debrand migration `20261007235500` was **not** applied), 4 of 8 repo migrations applied | live | `RETIRE` after an export archive |

### 3.5 Life Tracker (project 5)

| Dependency | Evidence | Disposition |
|---|---|---|
| Plain `pg` via **`LIFE_TRACKER_POSTGRES_URL`** (production ignores `DATABASE_URL`), **mandatory `DATABASE_CA_CERT`** (`rejectUnauthorized: true, ca`), IPv4 forced, pools 4+2+2 per instance | `lib/postgresConnection.ts:30-111` | `REPLACE` URL + CA |
| Schemas `life_tracker_phase2` (tasks **10**, operations 20, audits 20, domain_control 1), `life_tracker_phase35` (agents 1, operations 1, audits 1), `life_tracker_idempotency` (reservations 10); all owned by `postgres`; required schema comments present; **RLS disabled on all 10 tables**; latest task write 2026-10-16 01:07 UTC | live | `MIGRATE` (role must own schemas; keep comments) |
| Production flags live: `CANONICAL_TASK_STORE=postgres`, `IDEMPOTENCY_STORE=postgres` (docs say unset — docs are stale) | Vercel env | `KEEP` |
| **Session-level `pg_advisory_lock`** in schema setup | `lib/*Pg.ts` | Incompatible with Render's **transaction-mode** PgBouncer → use the direct connection |
| Vercel Blob (`Client1_READ_WRITE_TOKEN` wins over `BLOB_READ_WRITE_TOKEN`); War Room log/state stored in Blob `war-room-log.json`, not Postgres | `lib/blob.ts`, `lib/warRoom.ts` | `KEEP` (independent) |
| Supabase Auth/PostgREST/Storage/Edge/RLS | none in code; 0 auth users | `RETIRE` |

### 3.6 Harris in Wonderland (not in the five projects)

| Dependency | Evidence | Disposition |
|---|---|---|
| `pg` via Vercel **`DATABASE_URL`** (sensitive; created 2026-09-09, updated 2026-09-10), two default pools (10+10), **no `ssl` option, no `pool.on('error')`** | `src/lib/db.ts:114`, `src/lib/auth/server.ts:122`; env names | `MIGRATE` (host `UNVERIFIED`) |
| Build-time migrator (`vite build && npm run db:migrate`) **connected successfully on 2026-09-20 17:31 UTC** ("[migrate] up to date.") | Vercel deployment `dpl_3u621LSB1oQFKJWgSwgwAhh9KNu9` build log | host reachable then |
| Harris tables (`sugar_glider_holds`, `sugar_glider_payment_attempts`, `app_user_roles`, `app_audit_log`, `_migrations`, Better Auth `"user"/"session"/"account"/"verification"`, `site_copy`) exist in **none** of the five org projects, in any schema | `information_schema.tables` on all five | host is **outside** the visible org |
| Supabase-integration vars (`POSTGRES_*`, `SUPABASE_*`) also present on the Vercel project but **not read by code** | env names | `RETIRE` |
| Square payments (idempotency key stored with UNIQUE; one pending attempt per hold) — Square is the system of record; no Stripe, no webhooks | `src/lib/sugar-glider-holds.ts` | `KEEP` |
| `VoidcallerOC/Harris` repo = static template, no DB | repo | none |

### 3.7 Ininite-Heros and the Marketplace organization

| Dependency | Evidence | Disposition |
|---|---|---|
| Code is Supabase-native (Auth + Postgres CMS, 9 migrations) **but the Vercel project has no Supabase env** → runs on hard-coded fallback content; admin/analytics inert | repo + env names | `UNVERIFIED` whether anything live uses it; `RETIRE` or `REPLACE` is an owner decision |
| Vercel project env is Upstash KV/Redis + `NUXT_SQUARE_*` (does not match this repo) | env names | `UNVERIFIED` which codebase deploys there |
| Marketplace project `rnzheflamxlsbenlyozo` (Free, paused 2026-09-19) | Gmail; Vercel integration | Not in the $65.45 invoice (Free). `UNVERIFIED` whether it holds Ininite-Heros or Harris data. **Do not delete** until Harris's host is known. |

---

## 4. The-Void blocker register

| ID | Severity | Status | Evidence (2026-10-23 unless noted) |
|---|---|---|---|
| **F1** Fuji schema drift | High | `BLOCKED` | Fuji `schema_migrations` ends at `039` (2026-10-12); `main` ships `040…049`; Mainnet has all 49 (049 at 2026-10-23 22:19 UTC). `the-void-indexer-fuji` autodeploys `main` (`autoDeploy: yes`), so Fuji runs indexer code built for 040+ tables (`primary_sale_settlements`, `x_account_links`, …). Fuji's 33 deny policies live only in Supabase-dashboard migrations. Fix is an implementation task (apply 040–049 on Fuji or pin the Fuji indexer), out of scope here. |
| **F2** No pool error handling | High | `BLOCKED` (confirmed) | `server/db.js` creates `pg.Pool` with **no `pool.on('error')`**; `server/indexer-worker.js:252-254` ends the process on failure. Render recorded `server_failed nonZeroExit:1` on `the-void-indexer-mainnet` at **01:39:33, 01:39:37, 01:39:56 UTC on 2026-10-17** — the exact seconds Postgres was shut down (§F5). Render auto-restarted it (`server_available`). On Render Postgres the same crash will recur on every maintenance restart/failover. |
| **F3** Pooler connection budget | Medium | `PARTIAL` | Config: `DATABASE_POOL_MAX=10` on both mainnet services → 20 app connections through the Supabase **session** pooler. Published limits for Micro: 60 direct connections, 200 pooler clients (`compute-and-disk` doc); the per-project Supavisor `pool_size` default was not readable from docs this session (`UNVERIFIED`, commonly 15). Live sample: `pg_stat_activity` showed only 2 idle Supavisor backends; **no** `too many`/`MaxClients` log hits in the last 24 h on Mainnet or Fuji. The 10-09 RLS investigation's 5 s pool timeout remains. On Render: 100 connections (<8 GB RAM), PgBouncer pool = 90 — ample for 20+20. |
| **F5** 2026-10-17 restore | **Critical** | `BLOCKED` (explained, unattributed, unreconciled) | **Postgres logs, project `utgyamnzfcffjqmoboup`:** 01:36:46 UTC `checkpoint complete … lsn=4/DC009C10`; 01:39:32 `received fast shutdown request`; 01:39:41 `the database system is starting up`; 01:39:43 `restored log file "000000010000000300000036" from archive`, `completed backup recovery with redo LSN 3/35000028`, `recovery stopping after WAL location (LSN) "3/37004108"`, `redo done at 3/37004108`; 01:39:44 `selected new timeline ID: 2`, `archive recovery complete`, `ready to accept connections`; 01:39:55 second fast shutdown; 01:40:09 back. **Dating the target:** LSN `3/35000080` was checkpointed at **2026-10-16 11:31:27 UTC** and `3/380059A0` at 11:36:30 UTC → the restore point is **≈ 2026-10-16 11:33 UTC**, i.e. the daily physical backup (a forced checkpoint at 11:31:27 marks backup start). **Missing-write window ≈ 14 h 06 m (2026-10-16 ~11:33 → 2026-10-17 01:39 UTC).** **Data corroboration:** `chain_blocks` rows per `indexed_at` hour run ~79/h all day on 10-16, drop to 44 in the 11:00 hour, are **absent until 03:00 UTC on 10-17**, then show catch-up (275, 261, 168) — the indexer re-derived chain data after the rollback. `audit_events` on 10-16 (09:53–10:00 UTC, three STUDIO_* events) predate the restore point and survived; **no row of any kind survives from inside the window**, so whether user/API writes (auth sessions, nonces, listings, provisioning requests, genesis reservations, media authorizations, X links) occurred in it is `UNVERIFIED` and cannot be proven from the database alone. **Attribution:** Supabase mgmt-API calls hit the project at 01:37:48 UTC (`auth/v1/health`, `network-bans/retrieve` — the pattern of an open dashboard session) two minutes before the shutdown; the GitHub-integration workflow runs at 00:56/01:20/01:44 were no-ops. No organization audit log is exposed to the MCP. **Who/why remains `UNVERIFIED`.** A further plain restart (fast shutdown, no recovery) occurred **2026-10-22 10:12:38 UTC** (`pg_postmaster_start_time` = 10:13:51), cause `UNVERIFIED`. |
| N1 (new) Supabase GitHub integration on Mainnet | Medium | `UNVERIFIED` scope | See §3.1. Runs on each push to `main`; harmless today ("All migrations are up to date") but it is an undocumented production dependency and must be disconnected before cancellation. |
| N2 (new) 129 failed `postgres` logins/day on Mainnet pooler | Medium | `UNVERIFIED` | `supavisor_logs` 24 h: `ClientHandler: Exchange error: password authentication failed for user "postgres"` ×129 (Fuji: 0). Some client holds a stale/rotated credential and retries continuously. |

**Hard rule applied:** Mainnet migration readiness is `BLOCKED` while F5 is unattributed and the window is unreconciled, and until F1–F3 are fixed and verified.

**Migration mechanics (read-only review):** `server/migrate.js` sorts files numerically, takes `pg_advisory_lock(481562901)`, records SHA-256 checksums, applies each file in its own transaction and refuses checksum drift — repeatable and safe to re-run. Baseline recovery is documented in `docs/DB-RECOVERY-RUNBOOK.md`. Roles `anon`/`authenticated` must pre-exist (CI creates them) before 013.

---

## 5. Render readiness and cost assessment

### 5.1 Verified from the live Render account

* Workspace `tea-dahg5av40ujc73aiu5sg` ("My Workspace", owner voidcalleroc@gmail.com). **Workspace plan is not exposed by the Render MCP** → `UNVERIFIED` here; the owner's screenshot says Hobby.
* **Postgres instances: none** (`list_postgres_instances` → "No Postgres instances found"). Every database gate in §7 therefore starts at `NOT STARTED`.
* Services (region **ohio**): `the-void-api-mainnet` (web, `0.5c-512mb`, build plan starter, auto-deploy on commit, IP allow-list `0.0.0.0/0`), `the-void-indexer-mainnet` (worker, `0.5c-512mb`), `the-void-indexer-fuji` (worker, `0.5c-512mb`), `the-void-api-fuji` (web, **free**, auto-deploy off).
* Headroom (24 h to 2026-10-23 22:00 UTC): mainnet API 56–117 MB and indexer 62–109 MB of 512 MB; CPU < 0.002 cores. Mainnet API returned a handful of 503/409 responses in the 12:00 UTC hour on 10-23 (6 and 2) — `UNVERIFIED` cause.
* No Render events for plan changes, suspensions, or disk alerts in the window reviewed.

### 5.2 From published Render documentation (fetched 2026-10-23)

| Topic | Published statement | Implication |
|---|---|---|
| Instance prices | Basic-256mb **$6/mo** (0.1 CPU, 256 MB); Basic-1gb **$19/mo** (0.5 CPU, 1 GB); storage **$0.30/GB/mo**, increase-only in 5 GB steps per one reviewer (`UNVERIFIED`) | Matches the $28 base case |
| Backups / PITR | "Render continually backs up paid Render Postgres databases to provide point-in-time recovery." Window: **Hobby 3 days, Pro 7 days**; restores create a **new instance**; cannot restore within 10 min of now; logical backups on demand, downloadable, kept 7 days; **Free compute has no recovery** | Hobby is sufficient **if** an off-platform nightly `pg_dump` is added; Pro buys only 4 extra days |
| Connection pooling | Built-in PgBouncer on paid instances, **transaction mode only**, port 6432, pool = `max_connections − 10`, enabling **restarts the database**; session advisory locks, `SET SESSION`, temp tables, LISTEN/NOTIFY need direct connections | The-Void migrate lock and Life Tracker schema locks must use the **direct** URL; app query paths may use the pool |
| Connection limits | < 8 GB RAM → **100** connections | 20 (Mainnet) + 20 (Fuji) + ≤8/instance (Life Tracker) + Harris 20/instance fits |
| TLS | External connections always TLS; `sslmode=disable` rejected; **no CA bundle for `verify-full` is documented** on the connection page | `UNVERIFIED` whether Life Tracker's mandatory `DATABASE_CA_CERT`/`rejectUnauthorized:true` can be satisfied; must be proven in a preview deployment before planning Life Tracker's cutover. The-Void only demands a CA for `*.supabase.com` hosts |
| Network / IP | External URL reachable from any IP by default; allow-list configurable; internal URL only for same-workspace services | Vercel apps use the external URL (public internet); Render-hosted The-Void services can use the internal URL |
| Workspace plans | Render changelog 2026-04-23: **Pro $25/mo flat** replaces Professional $19/user; Hobby remains free, capped at 25 services; legacy plans migrate by 2026-08-01 | The prompt's $25 Pro assumption matches the changelog; the live pricing page could not be parsed (dynamic) → `UNVERIFIED` |

### 5.3 Architectural assumptions (not verified)

* "Critical" Basic-1gb = Mainnet + ForgeCT (+ Harris if its data is ever located). "Secondary" Basic-256mb = Fuji + Life Tracker + anything retained from TCG.
* **Risk:** Fuji's indexer generates heavy WAL churn (2.27 M chain rows, ~49 MB of WAL per 5-minute checkpoint on Mainnet alone) and ~2 GB of scratch tables. A 256 MB instance shared with Life Tracker is not isolation; it is co-tenancy of the noisiest workload with the War-Room idempotency store. Either re-derive Fuji chain tables on Render (16 MB app data only) or put Fuji alone on the 256 MB instance and Life Tracker with the critical set. Owner decision; load evidence required (§7 G3).
* Monitoring/alerting on Hobby is Render's built-in metrics and email on failure; no external alerting is configured anywhere today (`UNVERIFIED` beyond what the MCP shows).

### 5.4 Cost comparison (monthly / annual, before tax on Render, USD)

| Scenario | Monthly | Annual | Net saving vs $65.45 (mo / yr) |
|---|---|---|---|
| Current Supabase (verified invoice figure from prompt) | 65.45 | 785.40 | — |
| Render two-instance base ($19 + $6 + 2×5 GB×$0.30) | **28.00** | 336.00 | **37.45 / 449.40** |
| Base + PostgREST service ($7) | 35.00 | 420.00 | 30.45 / 365.40 |
| Base + Pro workspace ($25) | 53.00 | 636.00 | 12.45 / 149.40 |
| Base + both extras | 60.00 | 720.00 | 5.45 / 65.40 |

Assumptions and exclusions: Render storage billed from 5 GB per instance (actual need ≈ 0.2 GB without Fuji chain tables, ≈ 2.3 GB with them); existing Render compute (three `0.5c-512mb` services and one free) excluded as instructed; Render bandwidth overage ($0.15/GB beyond allowance) not modelled — Vercel→Render database traffic is external egress and should be measured in the observation period; Supabase side: the Marketplace Free project costs $0 and does not change the comparison. **The PostgREST extra is unnecessary on the evidence:** ForgeCT's only PostgREST use is 12 RPC calls that a `pg` client can call directly; TCG's admin (the only Supabase Auth consumer) is a retire candidate. **The Pro workspace is not required** by any identified capability; recommend staying on Hobby and adding an off-platform logical backup job. Savings are estimates, not guaranteed; they drop to ≈$5/mo if both extras are adopted, so the decision in §7 G6/G9 materially changes the business case.

---

## 6. Application-by-application migration requirements (future work; none performed)

**TCG calculator (retire path, pending G6):** disable `catalog-sync.yml` schedule; delete GitHub secret `SUPABASE_SERVICE_ROLE_KEY` (and review `JUSTTCG_API_KEY` sharing); remove `admin/`, `lib/supabase-catalog-repository.js`, `lib/catalog-sync.js`, `lib/tcgplayer-publisher.js`, `api/catalog-status.js`, the Supabase branches in `api/cards.js`/`api/games.js`, `supabaseConfigured` in `lib/production-gate.js`; strip `https://agscctnjusfqcpisirsq.supabase.co` from `vercel.json` CSP and `pricing_backend_*` from `data/config.json`; archive `supabase/`; update tests and docs listed in the TCG inventory. Export `tcg_catalog_prices` first if a price-history archive is wanted. Nothing customer-facing is lost.

**Life Tracker:** set `LIFE_TRACKER_POSTGRES_URL` (Render **direct** external URL, **no `sslmode` param**) and `DATABASE_CA_CERT` (the CA that signs Render's certificate — identity `UNVERIFIED`); app role must own/create the three schemas (restore with `--no-owner` as the app role, keep `COMMENT ON SCHEMA`); keep `IDEMPOTENCY_STORE`/`CANONICAL_TASK_STORE`; prove with `/api/internal/postgres-identity` (cluster `system_identifier` must change from `7690937621030482216`) and `/api/internal/storage-diagnostic`. Cutover: freeze agent workflows, final `pg_dump -n life_tracker_*`, switch env, redeploy. Rollback: restore old env + redeploy; **never** use `CANONICAL_TASK_STORE=legacy` as rollback (Blob lacks the 10 Postgres tasks); copy back any Render-side writes by hand.

**The-Void Fuji:** resolve F1 (apply 040–049 or pin indexer), reconcile the 33 dashboard policies into repo migrations or document them as intentionally not ported, decide chain-table re-index vs copy, create `anon`/`authenticated`/`service_role` NOLOGIN roles on Render before `npm run db:migrate`, set `DATABASE_URL` (direct URL for the migrate step), `DATABASE_SSL=true`, and drop `DATABASE_SSL_CA` only if Render's chain verifies with system CAs (`UNVERIFIED`). Add `pool.on('error')` (F2) first.

**ForgeCT:** replace the four `supabaseRpc()` helpers with a `pg` pool (same function names, same jsonb return shapes), keep fail-closed when the URL is missing, export the 14 live rows, re-grant EXECUTE to the app role, drop the legacy TCG objects, keep `WEBHOOK_EVENT_STORE`/`PROPOSAL_STORE`/`LEAD_STORE`/`RATE_LIMIT_STORE` switches. Stripe verification plan: **test mode only** — a Stripe test webhook endpoint pointed at a preview deployment backed by a disposable Postgres, exercising `checkout.session.completed` twice (claim → processed → duplicate ignored), a forced failure (release → Stripe retry), and lease expiry; no live events, no payments. Not executed now.

**Harris:** first identify the host (owner reads `DATABASE_URL`'s hostname in Vercel; or inspect any failed build log, which prints sanitized host/user). Then: full `pg_dump` including `_migrations` **before** changing `DATABASE_URL` (the build-time migrator would otherwise create an empty schema first); same `BETTER_AUTH_SECRET`; confirm no `pending`/`processing` payment attempts at cutover; harden pools (`max`, `on('error')`, explicit `ssl`).

**The-Void Mainnet (last):** everything in Fuji plus: freeze (scale indexer to 0 and put API in maintenance), copy lease/checkpoint rows or restart indexing from recorded start blocks (97619965/97619978), verify `/api/health/ready` against the new host, disconnect the Supabase GitHub integration, identify the N2 client. Not before F5 is closed (§4).

**Ininite-Heros:** owner decides retire (static fallback already live) vs replace; nothing to migrate unless `rnzheflamxlsbenlyozo` is proven to hold its data.

---

## 7. Go/No-Go gate matrix

| Gate ID | Requirement | Evidence required | Current status | Risk if skipped | Owner | Rollback requirement | Next action |
|---|---|---|---|---|---|---|---|
| G1 | Project/dependency inventory complete (six invoice IDs mapped, every app's DB host known) | Invoice PDF refs matched to §2; Harris host named; Marketplace project contents known | `PARTIAL` | Cancelling a project that still serves Harris/Ininite-Heros | Nick | n/a | Read the invoice refs in Supabase Billing; read Harris `DATABASE_URL` host in Vercel |
| G2 | F1/F2/F3/F5 resolved | F1: Fuji `schema_migrations` lists 049; F2: `pool.on('error')` present + restart test survives a DB bounce; F3: pool sums ≤ pooler size with headroom, no limit hits over 7 days; F5: restore attributed in Supabase Backups/support record **and** window reconciled or formally accepted | `BLOCKED` | Data loss repeats on Render; indexer crash loops | Nick (F5 attribution), The-Void engineer (F1–F3) | n/a | Supabase Backups page check (§0) |
| G3 | Render configuration, connectivity, security, capacity validated | Instance plans, direct+pooled URLs, IP allow-list, TLS mode proven from Vercel preview and Render services, connection budget table, Fuji WAL load decision | `NOT STARTED` (no instances exist) | Outages discovered at cutover | Nick | Delete test instances | Create instances only when G2 permits planning (not now) |
| G4 | Backup and independent restore procedure proven | A logical backup of each Supabase project stored off-platform + a documented restore into a disposable Render instance with row-count match | `NOT STARTED` | Irrecoverable loss | Nick | n/a | Schedule a restore drill after G3 |
| G5 | Schema, roles, grants, functions, policies reconciled | `pg_dump -s` diff Supabase vs Render = empty except intended; roles `anon/authenticated/service_role`/app role created; Fuji's 33 policies decided | `PARTIAL` (catalogued, not reconciled) | Migrations 013/017 fail; silent privilege drift | The-Void engineer | n/a | Decide policy porting after F1 |
| G6 | TCG decision and cleanup plan approved | Written owner decision (retire vs replace admin), workflow disabled, secrets removed, CSP cleaned | `NOT STARTED` (evidence ready) | Nightly job keeps burning quota and writing to a project slated for deletion | Nick | Re-enable workflow | Approve retire plan |
| G7 | Life Tracker migration plan and rollback proven | Preview deployment proves TLS/CA against Render; dump/restore of three schemas with counts (10/20/20/1; 1/0/0/1/1; 10) matching; identity route shows new cluster; rollback rehearsed | `NOT STARTED` | War Room log POSTs with `Idempotency-Key` fail 503 | Nick | Old env + redeploy | Resolve Render CA question first |
| G8 | Fuji migration readiness proven | G2-F1 green, indexer checkpoints without failure growth for 7 days, chain-table strategy chosen | `BLOCKED` | Broken staging hides mainnet issues | The-Void engineer | Repoint `DATABASE_URL` | After F1 |
| G9 | ForgeCT replacement + Stripe test-mode plan approved | `pg` port reviewed, test-mode runbook approved, disposable DB available | `NOT STARTED` | Double-charging or lost deposits | Nick | Repoint to Supabase URL | Approve §6 plan |
| G10 | Harris database mapped and plan approved | Host identified; dump taken; payment state quiet | `UNVERIFIED` | Losing holds/payment reconciliation data | Nick | Repoint `DATABASE_URL` | Identify host (G1) |
| G11 | Mainnet migration readiness approved last | All other gates `COMPLETE`; F5 closed; freeze plan; owner sign-off | `BLOCKED` | Production loss | Nick | Repoint + retained Supabase | After G2–G10 |
| G12 | Data parity and application acceptance checks defined | Per-table row counts + ordered-row md5 checksums, sequence values (none in The-Void), FK/constraint counts, critical journeys list per app | `NOT STARTED` | Silent partial copies | The-Void engineer | n/a | Draft check scripts |
| G13 | Cutover and rollback runbooks reviewed | Written runbook per app with freeze, copy, verify, switch, rollback triggers | `NOT STARTED` (outline in §8) | Improvised cutover | Nick | n/a | Review §8 |
| G14 | 14-day post-cutover observation completed | Error rate, latency, connection saturation, job failures, webhook results, indexer lag logged daily for 14 days per app | `NOT STARTED` | Cancelling before latent faults surface | Nick | Keep Supabase | Start after each cutover |
| G15 | All Supabase references and scheduled jobs eliminated or intentionally retained | GitHub integration disconnected; Vercel Supabase integrations removed; env names purged; `catalog-sync.yml` gone; CSP clean; `supabase_vault` ignored | `NOT STARTED` | Hidden jobs break after cancellation | Nick | n/a | Inventory in §3 is the checklist |
| G16 | Cancellation authorization and final invoice verification | Final `pg_dump` archive of every project; written owner authorization; downgrade to Free or delete; next invoice shows $0 for the org | `NOT STARTED` | Billing continues / data gone | Nick | None after deletion | Last |

---

## 8. Future verification, cutover, backup and rollback runbook (not executed)

1. **Source backups.** For each Supabase project: `pg_dump -Fc --no-owner --no-acl` of application schemas (+ `public.schema_migrations`), stored off-platform (not only in Supabase), checksum recorded. Verify by restoring into a disposable Render instance and comparing row counts. Supabase daily backups (which the F5 restore used) are not a substitute: they are inside the account being cancelled.
2. **Write-consistent migration.** No dual writes. Per app: announce a freeze window; stop writers (Render: suspend the indexer and set API maintenance; Vercel apps: disable scheduled workflows and, for Life Tracker, rotate `WAR_ROOM_AGENT_CREDENTIALS` if agents cannot be paused); take the final dump; restore; verify; switch env; redeploy; unfreeze. Harris: restore **before** the first build against the new URL.
3. **Reconciliation.** Row counts per table; `md5(string_agg(row::text order by pk))` per table; constraint/index/function counts from `pg_dump -s` diff; sequences (none in The-Void; check Harris/ForgeCT); schema comments (Life Tracker); grants to the app role.
4. **Application health and critical journeys.** The-Void: `/api/health/ready` `database.ok=true`, indexer lease acquired, checkpoints advancing, one listing read, one media grant; ForgeCT: contact form lead row, proposal read, Stripe **test** webhook claim/dup/release; Life Tracker: identity route, storage diagnostic, one idempotent task mutation + replay, War Room log POST; Harris: public page, admin login, hold creation with Square **sandbox**; TCG: scanner unaffected (no DB).
5. **Correct-database proof.** Compare `pg_control_system().system_identifier` seen by the app (Life Tracker route; add equivalent read to The-Void health) with the Render instance; confirm new rows appear in Render and **not** in Supabase during the observation period.
6. **Monitoring.** Render metrics (CPU, memory, active connections) and logs; Vercel runtime errors; indexer checkpoint lag and `failure_count`; ForgeCT webhook `processed` count vs Stripe dashboard deliveries; Life Tracker 503 `STORAGE_UNAVAILABLE` count. Thresholds and daily sign-off recorded for 14 days (G14).
7. **Rollback decision.** Roll back if: health fails for >15 min, any parity check fails, webhook claims fail, indexer cannot acquire its lease, or connection saturation hits the Render limit. Rollback = restore the previous env values and redeploy; **writes made on Render after cutover must be copied back manually** before unfreezing writers on Supabase (split-brain avoidance). Supabase stays read-only and untouched through the rollback window.
8. **Retention.** Keep each Supabase project (paused if plan allows, otherwise live) until G14 completes for that app and a final archive dump exists; only then move to G15/G16.
9. **Restore drill.** Separate Render instance, separate credentials, restore from the off-platform dump, run the parity checks, destroy. Required before any production cutover (G4).
10. **Automation vs approval.** Automatable later: dumps, checksums, schema diff, health probes, daily metric capture. Requires explicit owner approval: freeze windows, env switches, rollback execution, Stripe/Square sandbox tests, project deletion, cancellation.

---

## 9. Supabase cancellation checklist (do not start before G1–G15)

- [ ] F5 attributed and reconciled; written acceptance of the 2026-10-16 11:33 → 2026-10-17 01:39 UTC window.
- [ ] Final off-platform `pg_dump` archive of all five projects (+ Harris's host, wherever it is), checksummed and restore-tested.
- [ ] 14-day observation complete for every migrated app.
- [ ] Supabase GitHub integration disconnected from `VoidcallerOC/The-Void`.
- [ ] Vercel Supabase integrations `icfg_mbF5k4qmZBzZQ4jtIKeunjpT` and `icfg_we6Tv1URS5kmcdyCpxXXALxq` removed; injected `POSTGRES_*`/`SUPABASE_*` vars deleted from `the-void`, `forgect`, `harris-wonderland`.
- [ ] TCG `catalog-sync.yml` deleted; GitHub secret `SUPABASE_SERVICE_ROLE_KEY` deleted; CSP and `config.json` cleaned.
- [ ] ForgeCT and life-tracker production env no longer contain any Supabase name.
- [ ] N2 stale client identified and stopped.
- [ ] Marketplace project `rnzheflamxlsbenlyozo` disposition decided (it is billed via Vercel, not this invoice).
- [ ] Owner authorization recorded; org downgraded to Free (or projects deleted); next invoice verified at $0; the sixth ID explained.

---

## 10. Evidence index

* Supabase Management API (2026-10-23 22:11–23:07 UTC): `list_organizations`, `list_projects`, `get_organization`, `get_project(utgyamnzfcffjqmoboup)`, `list_migrations`, `list_edge_functions`, `list_tables`, `get_advisors(security)`, read-only `execute_sql` on all five projects (sizes, `pg_stat_activity`, `pg_policies`, grants, `schema_migrations`, checkpoints, leases, row counts), `query_logs` (Mainnet: 2026-10-14, 10-15, 10-16, 10-17 00:00–23:59, 10-22 09:30–11:00, 10-22 22:30→10-23 22:30; Fuji: last 24 h).
* Render API: `list_workspaces`, `list_postgres_instances`, `list_services`, `list_events` (both mainnet services, 2026-10-14→10-21), `list_logs` (10-16 12:00→10-18 12:00, no matches), `get_metrics` (24 h).
* Vercel API: `list_projects`, `filter_project_envs` (names only; no decryption) for the-void-vercel-mainnet, the-void, life-tracker, forgect, harris-wonderland, tcg-buy-calculator, ininite-heros, niko; `list_integration_configurations`; `list_project_domains`; `list_deployments` + build log `dpl_3u621LSB1oQFKJWgSwgwAhh9KNu9` (harris-wonderland, 2026-09-20).
* Gmail: Supabase pause notices for `rnzheflamxlsbenlyozo` (latest 2026-09-19 08:39 UTC). No Supabase invoice found by search.
* Repositories (shallow clones, read-only): `VoidcallerOC/The-Void` (`main` @ `96565dc`, this branch), `war-room` (`0df0079`), `life-tracker` (`7f81083`), `Harris` (`0b13487`), `ForgeCT` (`a83c2c4`), `tcg-buy-calculator` (`6de6511`), `harris-wonderland` (`b490425`), `Ininite-Heros` (`a35fb36`). Per-repo inventories were produced by read-only sub-audits and are summarised in §3.
* Public docs fetched: Render `postgresql-backups`, `postgresql-connection-pooling`, `postgresql-creating-connecting`; Supabase `pricing`, `compute-and-disk`, `connecting-to-postgres`, `connection-management`; Render pricing/plan changelog via web search (live pricing page not machine-readable).
* HTTP reachability (GET only): harrisinwonderland.com 200, www.forge-ct.com 200, www.nicklife.xyz 307→/login, www.thevoidstudio.xyz 200, the-void-api-mainnet.onrender.com/api/health 200.

---

## 11. War Room handoff

**STATUS:** `BLOCKED`
**TASK:** Supabase → Render consolidation safety/readiness audit (read-only).
**VERIFIED:** Five of six Supabase projects mapped with sizes and roles; Render workspace has no Postgres yet; F1 (Fuji at 039 vs main 049, indexer auto-deploys main), F2 (no pool error handler; indexer crashed 3× at 01:39 UTC on 10-17 during the DB shutdown), F5 mechanics (archive recovery to LSN 3/37004108 ≈ 2026-10-16 11:33 UTC; ~14 h rollback; chain-block gap 10-16 11:00 → 10-17 03:00 UTC); Supabase GitHub integration on Mainnet; 129 failed `postgres` logins/day on the Mainnet pooler; ForgeCT holds a legacy TCG schema and three Edge Functions; TCG nightly sync 42/42 failed and still running; TCG live scanner independent of Supabase; Life Tracker production is Postgres-authoritative (10 tasks) with RLS disabled and session advisory locks; Harris tables exist in none of the five projects and its build connected to its DB on 2026-09-20.
**CHANGED:** None to any system — strictly read-only audit. (This report file was added to the repository on audit branch `claude/sweet-rubin-jryp03` as the deliverable; no runtime, config, secret, or data was touched.)
**EVIDENCE:** §10.
**UNVERIFIED:** The sixth invoice project ID; the invoice document itself; who/why initiated the 2026-10-17 restore and the 2026-10-22 restart; whether any user writes fell in the lost window; Harris's actual database host; contents of `rnzheflamxlsbenlyozo`; Render workspace plan (MCP does not expose it); Render CA/verify-full support; current Supavisor `pool_size`; live Render pricing page; whether the TCG GitHub `JUSTTCG_API_KEY` equals the Vercel key; Ininite-Heros deployment source.
**BLOCKERS:** F5 attribution + reconciliation (mainnet hard rule); F1 Fuji drift; F2 missing error handling; invoice/Harris host identification (G1); no Render instances exist (G3 cannot start); Render TLS/CA answer for Life Tracker (G7).
**DO NOT REDO:** The five per-repo dependency inventories (§3), the Vercel env-name sweep, the TCG scanner finding, the Render/Supabase pricing pull, the F5 log forensics (LSN dating), and the prior The-Void infrastructure/RLS audits — unless new evidence contradicts them.
**NEXT ACTION:** Nick checks Supabase → *The Void Mainnet* → Database → Backups for a restore initiated 2026-10-17 01:39 UTC from the 2026-10-16 backup, and records who initiated it (or files a Supabase support ticket with those timestamps).
