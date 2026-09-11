# Fuji staging runbook

## Environment boundary

Fuji staging uses chain ID **43113**, a dedicated managed PostgreSQL database, one HTTPS API, and an indexer. The original Render blueprint (`the-void-api-fuji` + `the-void-indexer-fuji`) remains valid. Until Render is authorized, the same Node API runs as Vercel serverless functions under `/api/*` on the existing `the-void` project, with a once-a-minute cron hitting `/api/indexer/tick`.

Do **not** reuse the ForgeCT Supabase project. Do **not** reuse the paused Vercel Marketplace project `supabase-cyan-pebble` (`rnzheflamxlsbenlyozo`) unless it is explicitly renamed and isolated as The-Void Fuji.

## Vercel API (current path)

The SPA rewrite no longer swallows `/api`. After deploy:

```sh
curl -fsS https://the-void-alpha.vercel.app/api/health
curl -S https://the-void-alpha.vercel.app/api/health/ready
```

`/api/health` must return JSON `{ "data": { "ok": true, "service": "voidcaller-api" } }`. `/api/health/ready` returns JSON 503 until `DATABASE_URL` is set and migrations plus indexer checkpoints exist. That 503 is a real API response, not the frontend HTML.

Set these on the Vercel `the-void` project (Production + Preview), never in git:

- `DATABASE_URL` — dedicated The-Void Fuji Postgres URI (TLS). Create a new Supabase project named `the-void-fuji`.
- `DATABASE_SSL=true`
- `PUBLIC_APP_URL=https://the-void-alpha.vercel.app`
- `API_ALLOWED_ORIGINS` — frontend origins, comma-separated
- `INDEXER_CONTRACTS_JSON` — only after Fuji contracts are deployed
- `MARKETPLACE_ADDRESS` — only after marketplace deploy

On first request with `DATABASE_URL` present, the function applies SQL migrations.

## Render (optional, equivalent runtime)

`render.yaml` still defines `the-void-api-fuji` and `the-void-indexer-fuji`. Apply the Blueprint from the GitHub repo when a Render workspace exists. Same secrets as above. Worker command is `npm run start:indexer`.

## Database procedure

1. Provision a dedicated PostgreSQL database with TLS enabled (`the-void-fuji`) and store the URI in Vercel/Render secret manager.
2. First API request migrates automatically on Vercel. On Render, run `npm run db:migrate` then `npm run db:validate`.
3. Do not point this runbook at ForgeCT or `supabase-cyan-pebble` without explicit authorization.

## Contract and indexer procedure

After the Fuji marketplace and ERC-1155 contracts are deployed, put each real address and deployment start block into `INDEXER_CONTRACTS_JSON`. The Vercel cron calls `/api/indexer/tick` every minute and no-ops until that JSON and `DATABASE_URL` exist. Event identity remains `(chain_id, contract_address, transaction_hash, log_index)`.

## API verification

```sh
curl -fsS https://the-void-alpha.vercel.app/api/health
curl -S https://the-void-alpha.vercel.app/api/health/ready
```

`/api/health` is process liveness. `/api/health/ready` reports database migration visibility, Fuji RPC connectivity, checkpoint, lag, and marketplace configuration. CORS is emitted only for origins listed in `API_ALLOWED_ORIGINS`.

## Current task status

Repository-side Fuji configuration, Vercel `/api` adapter, JSON health/readiness, optional indexer cron, Docker image, and Render blueprint are present. A dedicated `the-void-fuji` database URI still has to be pasted into Vercel (or Render) before readiness can pass. The paused Marketplace project `supabase-cyan-pebble` and the ForgeCT database were not used.
