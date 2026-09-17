BEGIN;
-- Sequence repair only. Migration 007 was omitted from the checked-in history;
-- keep later migration filenames and checksums stable for any database that has
-- already recorded 008_wallet_auth.sql or later. No schema change is required.
COMMIT;
