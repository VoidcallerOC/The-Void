# Pending migrations (not applied)

Files here are reviewed but **not active**. The API runs `db:migrate` on every start (`npm run start:api`) and
applies every `NNN_name.sql` in `server/migrations`. Nothing in this directory is read by the runner
(`server/migrate.js` lists only `server/migrations`), so merging a file here changes nothing in production.

## 049_retire_forgive_forget_6_replaced_by_sequential.sql

Retires the published mainnet Forgive & Forget `forgive-forget-6` in the application (lifecycle status plus an
`abandoned` marker), so the replacement release on the sequential-ID factory is the only active Forgive & Forget.

| Row | ID |
|---|---|
| release | `release-e3743294-2ea3-46ae-b006-f0402606af65` |
| edition | `edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d` (and any other edition of that release) |
| experiences | every experience of that release or edition (production: `…-experience-audio`, `…-full-track`) |

Chain records (clone `0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d`, token `2567…3312`, 0 minted) are not changed.

### Activation (owner-approved, one step)

1. Before activating, re-check read-only that the old edition still has no holder and no configured sale:
   `edition(25679935302133066722236771263728427871936411831072189551573738559199048803312).mintedSupply == 0` on the clone,
   and `sales(...)`.configured `== false` on `0xa0000f9489c940e2b99d654700bd425ca36f6921`.
2. Open a separate PR that moves this file into `server/migrations/` under the next free number (049 if still free;
   if renumbered, update the `migration` name inside the file and in the tests to match), and points
   `server/retire-forgive-forget-6-pending-migration.test.js` and `server/retire-forgive-forget-6.db.test.js` at
   the new path. Merging that PR applies it on the next API deploy. Activate it **before** saving the replacement
   edition's catalog structure, so the private full track and demo are no longer reserved by the old experiences.

### Verification after it applies (read-only)

```sql
SELECT id, status, release_metadata->'abandoned' FROM releases WHERE id='release-e3743294-2ea3-46ae-b006-f0402606af65';
SELECT id, status, application_metadata->'abandoned' FROM editions WHERE release_id='release-e3743294-2ea3-46ae-b006-f0402606af65';
SELECT id, status FROM experiences WHERE release_id='release-e3743294-2ea3-46ae-b006-f0402606af65'
  OR edition_id='edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d';
SELECT payload FROM audit_events WHERE event_type='STUDIO_RELEASE_ARCHIVED_BY_MIGRATION'
  AND payload->>'migration'='049_retire_forgive_forget_6_replaced_by_sequential.sql';
SELECT count(*) FROM tokens t JOIN editions e ON e.id=t.edition_id WHERE e.release_id='release-e3743294-2ea3-46ae-b006-f0402606af65'; -- unchanged
```

Expected: all three ARCHIVED with the marker, exactly one audit row, token rows unchanged. Public checks:
`GET /api/releases` and `GET /api/editions` no longer list `forgive-forget-6`; `/api/health/ready` no longer lists
clone `0xf9c4…` or sale `0xa000…` (abandoned releases are not indexed).

### Reversal

The reversal SQL is in the migration's header comment. It restores the rows to PUBLISHED and removes the marker.
