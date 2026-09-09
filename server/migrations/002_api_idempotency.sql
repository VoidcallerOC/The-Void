BEGIN;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_idx ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
COMMIT;
