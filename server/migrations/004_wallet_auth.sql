BEGIN;

-- Existing nonce records predate cryptographic authentication bindings. They remain
-- intentionally unverifiable until expiry; all newly issued challenges populate the
-- binding columns below and are the only records accepted by WalletAuthService.
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS chain_id bigint;
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS domain text;
ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS uri text;

CREATE INDEX IF NOT EXISTS auth_nonces_active_binding_idx
  ON auth_nonces (wallet_address, chain_id, purpose, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash text PRIMARY KEY,
  wallet_address text NOT NULL,
  chain_id bigint NOT NULL,
  purpose text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  request_id text,
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_hash_idx
  ON auth_sessions (session_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_wallet_idx
  ON auth_sessions (wallet_address, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMIT;
