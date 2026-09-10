# Fuji staging runbook

## Environment boundary

Fuji staging uses chain ID **43113**, a dedicated managed PostgreSQL database, one HTTPS API service, and one persistent indexer worker. The API and worker use the same image but run different commands: `npm run start:api` and `npm run start:indexer`. TLS is terminated by the hosting provider in front of the API; the worker has no public listener. The staging frontend must use the API's HTTPS origin and the Fuji marketplace address only.

## Secrets

Put these values into the hosting provider's secret manager, not into Git, Docker build arguments, `.env.example`, logs, or deployment URLs: `DATABASE_URL`, `INDEXER_RPC_URL` when private, authentication signing/session secrets, secure-media secrets, and any deployer/signer tokens. Non-secret values are `NODE_ENV=production`, `INDEXER_CHAIN_ID=43113`, `DATABASE_SSL=true`, `PUBLIC_APP_URL`, `AUTH_DOMAIN`, `AUTH_URI`, `API_ALLOWED_ORIGINS`, `INDEXER_CONFIRMATIONS`, `INDEXER_POLL_INTERVAL_MS`, `INDEXER_CONTRACTS_JSON`, `MARKETPLACE_ADDRESS`, and `MARKETPLACE_CHAIN_ID=43113`.

## Database procedure

1. Provision a dedicated PostgreSQL database with TLS enabled and obtain its secret-manager connection URL.
2. Run `npm run db:migrate` from the release image. The migration runner takes a PostgreSQL advisory lock and records SHA-256 checksums in `schema_migrations`.
3. Run `npm run db:validate`. It fails if a migration is missing, changed, or unknown migrations exist.
4. Do not point this runbook at the existing `ForgeCT` Supabase project without explicit authorization: its current migration inventory is empty and it is not identified as this application's staging database.

## Contract and indexer procedure

After the Fuji marketplace and ERC-1155 contracts are deployed, put each real address and deployment start block into `INDEXER_CONTRACTS_JSON`. Do not use `startBlock=0` unless a full historical replay is intended. Confirm the event-topic map matches the deployed ABI. The worker starts from the persisted checkpoint, advances only through `latest - INDEXER_CONFIRMATIONS`, and updates the checkpoint after each canonical block. Stop and restart the worker; the next run must read the same checkpoint and continue rather than replaying projections. Event identity is the immutable `(chain_id, contract_address, transaction_hash, log_index)` key.

## API verification

After deployment, verify:

```sh
curl -fsS https://<staging-api>/api/health
curl -fsS https://<staging-api>/api/health/ready
```

`/api/health` confirms process availability. `/api/health/ready` reports database migration visibility, Fuji RPC connectivity, latest block, finalized checkpoint, indexer lag, stale status, and overall readiness. It returns HTTP 503 until all required checks pass. CORS responses are emitted only for origins listed in `API_ALLOWED_ORIGINS`.

## Worker monitoring

Monitor process restart count and structured `indexer.worker.failed` events. Alert when `indexer.lag` exceeds the operational threshold, the checkpoint is stale for four polling intervals, RPC connectivity fails, or `reconciliation-required` records increase. The API readiness endpoint is the minimum external probe; database and worker logs should be retained by the host.

## Current task status

The repository-side Fuji configuration, validation command, readiness endpoint, worker entrypoint, Docker image, and runbook are present. Actual staging is **not complete in this session**: no dedicated staging PostgreSQL URL, hosting deployment target, authentication/media secrets, Fuji contract addresses, or persistent-worker hosting authorization were available. The existing authenticated Supabase project is healthy but has zero application migrations, is named `ForgeCT`, and currently exposes only unrelated `stripe_webhook_events` and `api_rate_limits` tables; it was not modified. The public Fuji RPC endpoint was verified on 2026-09-10: `eth_chainId=0xa869` (43113) and `eth_blockNumber=0x37997b6`. This proves RPC reachability only; it does not constitute a deployed indexer or API.
