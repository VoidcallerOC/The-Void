# Fuji staging runbook

## Environment boundary

Fuji staging uses chain ID **43113**, a dedicated managed PostgreSQL database, one HTTPS API, and an indexer. The original Render blueprint (`the-void-api-fuji` + `the-void-indexer-fuji`) remains valid. Until Render is authorized, the same Node API runs as Vercel serverless functions under `/api/*` on the existing `the-void` project, with a once-a-minute cron hitting `/api/indexer/tick`.

Do **not** reuse the ForgeCT Supabase project. Do **not** reuse the paused Vercel Marketplace project `supabase-cyan-pebble` (`rnzheflamxlsbenlyozo`) unless it is explicitly renamed and isolated as The-Void Fuji.

## Vercel API (current path)

The SPA rewrite no longer swallows `/api`. Nested `/api/*` paths are rewritten to `/api/gateway` because Vercel's Vite function mapper only filesystems one path segment (`/api/health` works; `/api/health/ready` does not without a rewrite). Dedicated functions exist for readiness (`/api/ready`) and the indexer cron (`/api/indexer/tick`). After deploy:

```sh
curl -fsS https://the-void-alpha.vercel.app/api/health
curl -S https://the-void-alpha.vercel.app/api/health/ready
curl -S https://the-void-alpha.vercel.app/api/indexer/tick
curl -S https://the-void-alpha.vercel.app/api/listings
```

`/api/health` must return JSON `{ "data": { "ok": true, "service": "voidcaller-api" } }`. `/api/health/ready` returns JSON 503 until `DATABASE_URL` is set and migrations plus indexer checkpoints exist. `/api/indexer/tick` returns `{ "data": { "skipped": true, "reason": "database_not_configured" } }` until then. Those 503/skip bodies are real API JSON, not the frontend HTML.

Set these on the Vercel `the-void` project (Production + Preview), never in git:

- `DATABASE_URL` — dedicated The-Void Fuji Postgres URI (TLS). Create a new Supabase project named `the-void-fuji`.
- `DATABASE_SSL=true`
- `PUBLIC_APP_URL=https://the-void-alpha.vercel.app`
- `API_ALLOWED_ORIGINS` — frontend origins, comma-separated (Fuji defaults already cover the Vercel and grotto origins if this is omitted)
- `INDEXER_CONTRACTS_JSON` — only after Fuji contracts are deployed
- `MARKETPLACE_ADDRESS` — only after marketplace deploy

On first request with `DATABASE_URL` present, the function applies SQL migrations.

## Render (optional, equivalent runtime)

`render.yaml` still defines `the-void-api-fuji` and `the-void-indexer-fuji`. Apply the Blueprint from the GitHub repo when a Render workspace exists. Same secrets as above. Worker command is `npm run start:indexer`.

## Database procedure

1. Create a **new** Supabase project named `the-void-fuji` (not ForgeCT, not `supabase-cyan-pebble`).
2. Copy the URI from **Project Settings → Database → Connection string → URI**. Enable SSL.
3. In Vercel project `the-void` → Settings → Environment Variables, paste it as `DATABASE_URL` for Production and Preview. Also set `DATABASE_SSL=true`.
4. Redeploy. First `/api/*` request migrates automatically. On Render, run `npm run db:migrate` then `npm run db:validate`.
5. Confirm `GET /api/health/ready` JSON includes `database.ok: true` (indexer may still be not-ready until contracts exist).

## Contract and indexer procedure

After the Fuji marketplace and ERC-1155 contracts are deployed, put each real address and deployment start block into `INDEXER_CONTRACTS_JSON`. The Vercel cron calls `/api/indexer/tick` every minute and no-ops until that JSON and `DATABASE_URL` exist. Event identity remains `(chain_id, contract_address, transaction_hash, log_index)`.

## API verification

```sh
curl -fsS https://the-void-alpha.vercel.app/api/health
curl -S https://the-void-alpha.vercel.app/api/health/ready
curl -S https://the-void-alpha.vercel.app/api/indexer/tick
```

`/api/health` is process liveness. `/api/health/ready` reports database migration visibility, Fuji RPC connectivity, checkpoint, lag, and marketplace configuration. CORS is emitted only for origins listed in `API_ALLOWED_ORIGINS`.

## Current task status

Repository-side Fuji configuration, Vercel `/api` adapter (including nested health/ready and indexer tick), JSON health/readiness, optional indexer cron, Docker image, and Render blueprint are present. A dedicated `the-void-fuji` database URI still has to be pasted into Vercel (or Render) before readiness can pass. The paused Marketplace project `supabase-cyan-pebble` and the ForgeCT database were not used.
