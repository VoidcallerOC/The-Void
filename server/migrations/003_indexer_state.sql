BEGIN;

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  contract_type text NOT NULL,
  next_block bigint NOT NULL CHECK (next_block >= 0),
  last_processed_block bigint,
  last_processed_hash text,
  finalized_block bigint,
  status text NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE', 'RUNNING', 'FAILED', 'REORGING')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE IF NOT EXISTS blockchain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  event_type text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  block_timestamp timestamptz,
  is_canonical boolean NOT NULL DEFAULT true,
  is_malformed boolean NOT NULL DEFAULT false,
  error_message text,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS blockchain_events_query_idx ON blockchain_events (chain_id, contract_address, block_number, log_index);
CREATE INDEX IF NOT EXISTS blockchain_events_type_idx ON blockchain_events (chain_id, event_type, block_number DESC);
CREATE INDEX IF NOT EXISTS blockchain_events_canonical_idx ON blockchain_events (chain_id, is_canonical, block_number DESC);

CREATE TABLE IF NOT EXISTS chain_block_observations (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  block_timestamp timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  is_canonical boolean NOT NULL DEFAULT true,
  PRIMARY KEY (chain_id, block_number, block_hash),
  UNIQUE (chain_id, block_hash)
);
CREATE INDEX IF NOT EXISTS block_observations_height_idx ON chain_block_observations (chain_id, block_number DESC);

CREATE TABLE IF NOT EXISTS indexer_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  contract_address text,
  block_number bigint,
  transaction_hash text,
  log_index integer,
  error_type text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS indexer_errors_recent_idx ON indexer_errors (chain_id, created_at DESC);

COMMIT;
