# Database migration recovery runbook (Render / Fuji)

Applies to the dedicated The-Void Fuji Supabase/PostgreSQL database used by `the-void-api-fuji` on Render.

## Symptom

```
npm run db:migrate
→ error: relation "artists" already exists (Postgres 42P07)

npm run db:validate
→ Migration is not applied: 001_initial_persistence.sql
```

The database already contains the schema created by `001_initial_persistence.sql`, but `schema_migrations` has no record of it. The migration runner is correct to refuse: it will not overwrite existing tables.

## Recovery command

`npm run db:baseline` records `001_initial_persistence.sql` as applied **only** when the live schema is proven to be exactly what that migration produces. It is fail-closed:

- takes the same advisory lock (`481562901`) as `npm run db:migrate`, so it cannot race a deploy-time migration;
- refuses unless the SHA-256 of `server/migrations/001_initial_persistence.sql` (line endings normalized to LF, so the pin holds on any checkout) matches the checksum pinned in `server/baseline.js`;
- replays migration 001 into a throwaway shadow schema inside a transaction that is **always rolled back**, then compares the live `public` schema against it: tables, columns, types, nullability, defaults, primary keys, unique constraints, foreign keys, check constraints, indexes (including partial indexes), and required extensions (`pgcrypto`);
- on any missing, differing, or unexpected object it prints a mismatch report, exits non-zero, and writes nothing;
- records only `001_initial_persistence.sql`; migrations 002–006 are never marked as applied;
- is idempotent: if 001 is already recorded with a matching checksum it reports `already-recorded` and changes nothing. If other migration records exist without 001, it refuses and asks for manual review.

`npm run db:baseline:check` performs the same verification and prints the outcome without writing a migration record. Run it first.

## Operator sequence

Run from the Render service shell for `the-void-api-fuji` (`DATABASE_URL` and `DATABASE_SSL` already present in the environment — do not change them):

```sh
npm run db:baseline:check   # optional dry run: verification only, no writes
npm run db:baseline
npm run db:migrate
npm run db:validate
```

Expected output:

1. `db:baseline` → `{"baselined":true,"reason":"recorded","name":"001_initial_persistence.sql","checksum":"…","applied":["001_initial_persistence.sql"]}`
2. `db:migrate` → `{"applied":["001_initial_persistence.sql", … ,"006_private_media.sql"]}` (six entries; 002–006 applied transactionally)
3. `db:validate` → `{"ok":true, …}` with six migration records, matching checksums, and a `schema` section confirming every required table and extension exists.

Then verify the deployed API:

```powershell
curl.exe -sS -i "https://the-void-api-fuji.onrender.com/api/health/ready"
```

`database.ok` must be `true`.

## If `db:baseline` fails

The report names each mismatch, for example:

```
Live schema does not match the intended result of 001_initial_persistence.sql; no changes were made.
  - missing index: releases.releases_discovery_idx (expected CREATE INDEX …)
  - differing column: artists.display_name
      expected: text NOT NULL
      actual:   text
```

No database changes were made. Do not hand-patch the schema with pasted SQL and do not insert rows into `schema_migrations` manually. Decide with the report in hand:

- objects missing entirely → the database holds a partial 001; restore or rebuild the database and run `npm run db:migrate` on an empty database;
- objects that differ → the live schema drifted from the repository; reconcile the drift deliberately in a new migration, or rebuild.

`--allow-extra-objects` (`node server/baseline.js --allow-extra-objects`) relaxes only the "unexpected object" check, for a database that legitimately carries extra columns/indexes on baseline tables. Missing and differing objects still fail.

## Local verification

The recovery paths are covered by `server/baseline.test.js` against a real PostgreSQL instance:

```sh
docker run -d --name voidpg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
```

Without `TEST_DATABASE_URL` the database-backed tests are skipped. CI provides a `postgres:16` service and runs them.
