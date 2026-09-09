BEGIN;

ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS latest_known_block bigint;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS last_run_started_at timestamptz;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS last_successful_run_at timestamptz;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS last_completed_run_at timestamptz;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS rpc_failures integer NOT NULL DEFAULT 0;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS database_failures integer NOT NULL DEFAULT 0;
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS indexer_worker_leases (
  lease_key text PRIMARY KEY,
  owner_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_rebuild_jobs (
  chain_id bigint PRIMARY KEY,
  from_block bigint NOT NULL CHECK (from_block >= 0),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS indexer_checkpoint_health_idx
  ON indexer_checkpoints (chain_id, status, updated_at DESC);

COMMIT;
