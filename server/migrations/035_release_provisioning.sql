BEGIN;

-- One provisioning request per application release and chain. The unique release key
-- and transaction hash provide recovery/idempotency across browser reloads and retries.
CREATE TABLE IF NOT EXISTS release_provisioning_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL,
  release_key text NOT NULL,
  artist_wallet text NOT NULL,
  factory_address text NOT NULL,
  authorization_digest text NOT NULL,
  expected_parameters jsonb NOT NULL,
  transaction_hash text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SUBMITTED','CONFIRMED','FAILED','RECONCILING')),
  release_contract_address text,
  primary_sale_address text,
  provenance_anchor_address text,
  deployment_block_number bigint,
  creation_log_index integer,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  UNIQUE (release_id, chain_id),
  UNIQUE (chain_id, release_key),
  UNIQUE (chain_id, transaction_hash),
  CHECK (release_key ~ '^0x[0-9a-f]{64}$'),
  CHECK (artist_wallet ~ '^0x[0-9a-f]{40}$'),
  CHECK (factory_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (authorization_digest ~ '^0x[0-9a-f]{64}$'),
  CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CHECK (creation_log_index IS NULL OR creation_log_index >= 0)
);
CREATE INDEX IF NOT EXISTS release_provisioning_state_idx
  ON release_provisioning_requests (state, updated_at);

COMMIT;
