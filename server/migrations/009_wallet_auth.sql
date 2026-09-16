BEGIN;

ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS uri text;
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS chain_id bigint;
UPDATE auth_nonces SET domain = COALESCE(domain, 'unconfigured'), origin = COALESCE(origin, 'unconfigured'), uri = COALESCE(uri, 'unconfigured'), chain_id = COALESCE(chain_id, 43113) WHERE domain IS NULL OR origin IS NULL OR uri IS NULL OR chain_id IS NULL;
ALTER TABLE auth_nonces ALTER COLUMN domain SET NOT NULL;
ALTER TABLE auth_nonces ALTER COLUMN origin SET NOT NULL;
ALTER TABLE auth_nonces ALTER COLUMN uri SET NOT NULL;
ALTER TABLE auth_nonces ALTER COLUMN chain_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  wallet_address text NOT NULL,
  chain_id bigint NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  request_id text,
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_wallet_idx ON auth_sessions (wallet_address, expires_at DESC) WHERE revoked_at IS NULL;

COMMIT;
