BEGIN;

-- Persisted, verified Genesis transfer-scan checkpoint (server/genesis-scan-checkpoint-store.js). One row per
-- claim contract: the raw Genesis TransferSingle/TransferBatch logs in [from_block, end_block], the hash of
-- end_block, earlier verified (block, hash) anchors for reorg rewinds, and a digest over all of it. The row is
-- written in one statement inside one transaction, only after a whole range was scanned, and only when the
-- stored row still matches what the writer last verified (compare-and-set). Additive and derived: the API
-- rebuilds it from C-Chain when it is missing, corrupt or on another fork, so deleting the row is always safe.
CREATE TABLE IF NOT EXISTS genesis_scan_checkpoints (
  claim_contract text PRIMARY KEY CHECK (claim_contract ~ '^0x[0-9a-f]{40}$'),
  from_block bigint NOT NULL CHECK (from_block > 0),
  end_block bigint NOT NULL CHECK (end_block >= from_block),
  end_hash text NOT NULL CHECK (end_hash ~ '^0x[0-9a-f]{64}$'),
  anchors jsonb NOT NULL DEFAULT '[]'::jsonb,
  logs jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep the table out of the PostgREST surface (see 017, 036-039).
ALTER TABLE genesis_scan_checkpoints ENABLE ROW LEVEL SECURITY;

COMMIT;
