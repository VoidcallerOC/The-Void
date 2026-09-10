BEGIN;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('SUBMITTED', 'PENDING', 'OBSERVED', 'MINED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'REVERTED', 'REPLACED', 'STALE', 'RECONCILIATION_REQUIRED', 'REORGED'));
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS confirmation_status text NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'MATCHED';
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status IN ('PENDING', 'OBSERVED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'REVERTED', 'REPLACED', 'STALE', 'RECONCILIATION_REQUIRED', 'REORGED'));
ALTER TABLE purchases ADD CONSTRAINT purchases_confirmation_status_check CHECK (confirmation_status IN ('PENDING', 'CONFIRMED', 'FINALIZED', 'FAILED'));
ALTER TABLE purchases ADD CONSTRAINT purchases_reconciliation_status_check CHECK (reconciliation_status IN ('MATCHED', 'REQUIRED', 'RESOLVED'));
CREATE INDEX IF NOT EXISTS purchases_reconciliation_idx ON purchases (chain_id, reconciliation_status, created_at DESC);

COMMIT;
