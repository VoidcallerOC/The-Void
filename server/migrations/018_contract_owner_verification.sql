BEGIN;

-- On-chain contract-owner artist verification (mainnet owner() proof).
-- Idempotent. API writes only; PostgREST stays locked out via RLS.

CREATE TABLE IF NOT EXISTS artist_contract_verify_challenges (
  nonce text PRIMARY KEY,
  artist_slug text NOT NULL,
  contract_address text NOT NULL,
  chain_id integer NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artist_contract_verify_challenges_expiry_idx
  ON artist_contract_verify_challenges (expires_at);

CREATE TABLE IF NOT EXISTS artist_contract_verifications (
  id text PRIMARY KEY,
  artist_slug text NOT NULL,
  wallet_address text NOT NULL,
  contract_address text NOT NULL,
  chain_id integer NOT NULL,
  signature text NOT NULL,
  message text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artist_contract_verifications_unique_claim
  ON artist_contract_verifications (artist_slug, contract_address, chain_id);

ALTER TABLE artist_contract_verify_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_contract_verifications ENABLE ROW LEVEL SECURITY;

COMMIT;
