# Fuji staging runbook

## Environment boundary

Fuji staging uses chain ID **43113**, a dedicated managed PostgreSQL database, one HTTPS API, and one persistent indexer worker. The canonical deployment is split across the `VoidcallerOC/The-Void` GitHub repository: Vercel project `the-void` serves the static frontend, Render service `the-void-api-fuji` serves the API, and Render worker `the-void-indexer-fuji` runs `npm run start:indexer`.

Do **not** reuse the ForgeCT Supabase project. Do **not** reuse the paused Vercel Marketplace project `supabase-cyan-pebble` (`rnzheflamxlsbenlyozo`) unless it is explicitly renamed and isolated as The-Void Fuji.

## Canonical deployment targets

Vercel is frontend-only. Its `vercel.json` contains a single `/api/:path*` rewrite to Render; there are no Vercel API functions or cron jobs. Use the direct Render API URL for backend verification:

```sh
curl -fsS https://the-void-api-fuji.onrender.com/api/health
curl -S https://the-void-api-fuji.onrender.com/api/health/ready
curl -S https://the-void-api-fuji.onrender.com/api/artists
```

The Vercel frontend should proxy the same paths unchanged, for example `https://the-void-alpha.vercel.app/api/health`. `/api/health` must return JSON `{ "data": { "ok": true, "service": "voidcaller-api" } }`. `/api/health/ready` reports database, RPC, and indexer readiness.

Set API and worker secrets in Render, never in git. The API and worker use the same dedicated database and Fuji indexer configuration:

- `DATABASE_URL` — dedicated The-Void Fuji Postgres URI (TLS). Create a new Supabase project named `the-void-fuji`.
- `DATABASE_SSL=true`
- `PUBLIC_APP_URL=https://the-void-alpha.vercel.app`
- `API_ALLOWED_ORIGINS` — frontend origins, comma-separated (Fuji defaults already cover the Vercel and grotto origins if this is omitted)
- `INDEXER_CONTRACTS_JSON` — only after Fuji contracts are deployed
- `MARKETPLACE_ADDRESS` — only after marketplace deploy

The Render API runs migrations through the normal Render deployment/runbook process. The worker does not expose HTTP routes; it maintains durable checkpoints and leases in PostgreSQL.

## Database procedure

1. Create a **new** Supabase project named `the-void-fuji` (not ForgeCT, not `supabase-cyan-pebble`).
2. Copy the URI from **Project Settings → Database → Connection string → URI**. Enable SSL.
3. Set it as `DATABASE_URL` on both Render services and set `DATABASE_SSL=true`.
4. Run `npm run db:migrate` then `npm run db:validate` against the Render database before restarting the API and worker.
   - If `db:migrate` fails with `relation "artists" already exists` while `db:validate` reports `Migration is not applied: 001_initial_persistence.sql`, the database holds the 001 schema without a migration record. Follow [DB-RECOVERY-RUNBOOK.md](./DB-RECOVERY-RUNBOOK.md): `npm run db:baseline`, then `npm run db:migrate`, then `npm run db:validate`.
5. Confirm `GET /api/health/ready` JSON includes `database.ok: true` (indexer may still be not-ready until contracts exist).

## Contract and indexer procedure

After the Fuji marketplace and ERC-1155 contracts are deployed, put each real address and deployment start block into `INDEXER_CONTRACTS_JSON` on the Render worker. The persistent worker polls the configured RPC, acquires the database lease, and maintains checkpoints. Event identity remains `(chain_id, contract_address, transaction_hash, log_index)`.

## API verification

```sh
curl -fsS https://the-void-alpha.vercel.app/api/health
curl -S https://the-void-alpha.vercel.app/api/health/ready
curl -fsS https://the-void-api-fuji.onrender.com/api/health
curl -S https://the-void-api-fuji.onrender.com/api/health/ready
```

`/api/health` is process liveness. `/api/health/ready` reports database migration visibility, Fuji RPC connectivity, checkpoint, lag, and marketplace configuration. CORS is emitted only for origins listed in `API_ALLOWED_ORIGINS`.

## Current task status

Repository-side Fuji configuration, Render API/worker Docker services, JSON health/readiness, and the Vercel frontend rewrite are present. The dedicated The-Void Fuji database and Render secrets must remain configured on Render before readiness and indexing can be considered operational. The paused Marketplace project `supabase-cyan-pebble` and the ForgeCT database were not used.
