BEGIN;

-- Isolated, disabled-by-default cross-chain Genesis entitlement ledger.
-- No live API route or voucher path reads these tables. Existing direct-claim reservations remain authoritative.
CREATE TABLE IF NOT EXISTS genesis_cross_chain_operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^0x[0-9a-f]{64}$'),
  source_chain_id bigint NOT NULL CHECK (source_chain_id > 0),
  destination_chain_id bigint NOT NULL CHECK (destination_chain_id > 0),
  source_bridge text NOT NULL CHECK (source_bridge ~ '^0x[0-9a-f]{40}$'),
  destination_bridge text NOT NULL CHECK (destination_bridge ~ '^0x[0-9a-f]{40}$'),
  source_tx_hash text NOT NULL CHECK (source_tx_hash ~ '^0x[0-9a-f]{64}$'),
  source_block bigint NOT NULL CHECK (source_block > 0),
  destination_tx_hash text CHECK (destination_tx_hash IS NULL OR destination_tx_hash ~ '^0x[0-9a-f]{64}$'),
  destination_block bigint CHECK (destination_block IS NULL OR destination_block > 0),
  sender_wallet text NOT NULL CHECK (sender_wallet ~ '^0x[0-9a-f]{40}$'),
  recipient_wallet text NOT NULL CHECK (recipient_wallet ~ '^0x[0-9a-f]{40}$'),
  quantities jsonb NOT NULL,
  finality_status text NOT NULL CHECK (finality_status IN ('PROVISIONAL','FINALIZED','DISPUTED','INVALIDATED')),
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('UNRESOLVED','RECONCILED','INELIGIBLE')),
  evidence_complete boolean NOT NULL DEFAULT false,
  source_range_complete boolean NOT NULL DEFAULT false,
  destination_range_complete boolean NOT NULL DEFAULT false,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_chain_id, source_tx_hash),
  UNIQUE (destination_chain_id, destination_tx_hash)
);

CREATE TABLE IF NOT EXISTS genesis_cross_chain_messages (
  message_id text PRIMARY KEY CHECK (message_id ~ '^0x[0-9a-f]{64}$'),
  operation_id text NOT NULL REFERENCES genesis_cross_chain_operations(operation_id),
  direction text NOT NULL CHECK (direction IN ('FORWARD','REVERSE')),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint NOT NULL CHECK (block_number > 0),
  status text NOT NULL CHECK (status IN ('PROVISIONAL','FINALIZED','DISPUTED','INVALIDATED')),
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^0x[0-9a-f]{64}$'),
  UNIQUE (direction, tx_hash),
  UNIQUE (operation_id, direction)
);

-- ERC-1155 quantities are aggregate provenance buckets, never invented per-unit identities.
-- quantity is the immutable observed quantity; available_quantity decreases on a reservation;
-- consumed_quantity increases only on a redeemed claim.
CREATE TABLE IF NOT EXISTS genesis_cross_chain_provenance (
  operation_id text NOT NULL REFERENCES genesis_cross_chain_operations(operation_id),
  token_id text NOT NULL CHECK (token_id ~ '^[0-9]+$'),
  owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  available_quantity numeric(78,0) NOT NULL CHECK (available_quantity >= 0 AND available_quantity <= quantity),
  consumed_quantity numeric(78,0) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0 AND consumed_quantity <= quantity),
  state text NOT NULL CHECK (state IN ('UNRESOLVED','UNUSED','PROVISIONALLY_RESERVED','CONSUMED','DISPUTED','RETURNED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, token_id, owner_wallet)
);

CREATE TABLE IF NOT EXISTS genesis_cross_chain_claims (
  claim_id text PRIMARY KEY CHECK (claim_id ~ '^0x[0-9a-f]{64}$'),
  operation_id text NOT NULL REFERENCES genesis_cross_chain_operations(operation_id),
  token_id text NOT NULL CHECK (token_id ~ '^[0-9]+$'),
  claimant_wallet text NOT NULL CHECK (claimant_wallet ~ '^0x[0-9a-f]{40}$'),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('PENDING','REDEEMED','EXPIRED','DISPUTED')),
  reservation_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  UNIQUE (operation_id, token_id, reservation_reference)
);

CREATE INDEX IF NOT EXISTS genesis_cross_chain_operations_reconciliation_idx
  ON genesis_cross_chain_operations (reconciliation_status, finality_status);
CREATE INDEX IF NOT EXISTS genesis_cross_chain_provenance_owner_idx
  ON genesis_cross_chain_provenance (owner_wallet, state);

-- Keep all cross-chain accounting state out of the PostgREST surface.
ALTER TABLE genesis_cross_chain_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE genesis_cross_chain_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE genesis_cross_chain_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE genesis_cross_chain_claims ENABLE ROW LEVEL SECURITY;
COMMIT;
