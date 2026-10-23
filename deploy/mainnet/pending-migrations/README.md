# Pending migrations (not applied)

Files here are reviewed but **not active**. The API runs `db:migrate` on every start (`npm run start:api`) and
applies every `NNN_name.sql` in `server/migrations`. Nothing in this directory is read by the runner
(`server/migrate.js` lists only `server/migrations`), so merging a file here changes nothing in production.

There is currently no pending migration here.

## Activated

- `049_retire_forgive_forget_6_replaced_by_sequential.sql`: reviewed here, then moved unchanged (apart from its header
  comment) to `server/migrations/` by the runbook step-5 PR. Its activation, verification and reversal are in
  `deploy/mainnet/SEQUENTIAL-LAUNCH.md` step 5 and in the migration's header comment.
