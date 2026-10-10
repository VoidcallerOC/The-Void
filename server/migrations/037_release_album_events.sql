BEGIN;

-- Chain-derived album state for VoidRelease1155V4 clones. Both tables are indexer
-- projections of AlbumCreated / ExpandedReleaseApproved / AlbumClosed /
-- AlbumTrackCreated logs: handleReorg removes (or, for repeated approvals, rewinds)
-- state at or above the reorg block and the rewound checkpoint re-applies it.
CREATE TABLE IF NOT EXISTS release_albums (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  release_key text,
  created_transaction_hash text,
  created_block_number bigint,
  created_block_hash text,
  created_log_index integer,
  closed_transaction_hash text,
  closed_block_number bigint,
  closed_block_hash text,
  closed_log_index integer,
  expanded_max_tracks numeric(78,0),
  expanded_max_singles numeric(78,0),
  expanded_transaction_hash text,
  expanded_block_number bigint,
  expanded_block_hash text,
  expanded_log_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address),
  CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  CHECK (release_key IS NULL OR release_key ~ '^0x[0-9a-f]{64}$'),
  CHECK (expanded_max_tracks IS NULL OR expanded_max_tracks >= 0),
  CHECK (expanded_max_singles IS NULL OR expanded_max_singles >= 0)
);

-- One row per album track token. mint_end is the on-chain uint64 (0 = no deadline).
CREATE TABLE IF NOT EXISTS release_album_tracks (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  token_id numeric(78,0) NOT NULL,
  is_single boolean NOT NULL,
  mint_end numeric(20,0) NOT NULL CHECK (mint_end >= 0),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address, token_id),
  CHECK (contract_address ~ '^0x[0-9a-f]{40}$')
);
CREATE INDEX IF NOT EXISTS release_album_tracks_block_idx ON release_album_tracks (chain_id, block_number);

-- Keep both tables out of the PostgREST surface (see 017 and 036).
ALTER TABLE release_albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_album_tracks ENABLE ROW LEVEL SECURITY;

COMMIT;
