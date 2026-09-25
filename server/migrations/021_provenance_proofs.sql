BEGIN;

-- One provenance proof per canonical release edition manifest.
-- Rows reference existing releases and editions. They store SHA-256 digests
-- only: no file bytes, storage keys, gateway URLs, or protected media.
--
-- The Render API connects as the table owner and bypasses row level security.
-- RLS is enabled and not forced. There is no anon or authenticated policy, so
-- PostgREST cannot read proofs. Do not grant this table publicly; a future
-- verification surface must be a column-safe view, not a table grant.

CREATE UNIQUE INDEX IF NOT EXISTS editions_id_release_uidx ON editions (id, release_id);

CREATE TABLE IF NOT EXISTS provenance_proofs (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  release_id text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  edition_id text NOT NULL,
  creator_artist_id text NOT NULL REFERENCES artists(id),
  creator_wallet text NOT NULL,
  metadata_sha256 text NOT NULL,
  artwork_sha256 text,
  audio_sha256 text,
  experience_sha256 text,
  manifest_sha256 text NOT NULL,
  schema_version integer NOT NULL,
  proof_timestamp timestamptz NOT NULL,
  chain_key text,
  chain_id bigint,
  transaction_hash text,
  block_number bigint,
  anchor_status text NOT NULL DEFAULT 'PENDING',
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  verified_at timestamptz,
  failure_code text,
  failure_detail text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provenance_edition_release_fk FOREIGN KEY (edition_id, release_id) REFERENCES editions (id, release_id) ON DELETE CASCADE,
  CONSTRAINT provenance_release_version_uidx UNIQUE (release_id, edition_id, schema_version, manifest_sha256),
  CONSTRAINT provenance_creator_wallet_chk CHECK (creator_wallet ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT provenance_metadata_sha256_chk CHECK (metadata_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provenance_artwork_sha256_chk CHECK (artwork_sha256 IS NULL OR artwork_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provenance_audio_sha256_chk CHECK (audio_sha256 IS NULL OR audio_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provenance_experience_sha256_chk CHECK (experience_sha256 IS NULL OR experience_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provenance_manifest_sha256_chk CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provenance_schema_version_chk CHECK (schema_version >= 1),
  CONSTRAINT provenance_chain_key_chk CHECK (chain_key IS NULL OR chain_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT provenance_chain_id_chk CHECK (chain_id IS NULL OR chain_id > 0),
  CONSTRAINT provenance_tx_chk CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT provenance_block_chk CHECK (block_number IS NULL OR block_number >= 0),
  CONSTRAINT provenance_anchor_status_chk CHECK (anchor_status IN ('PENDING', 'SUBMITTED', 'ANCHORED', 'FAILED', 'REORGED')),
  CONSTRAINT provenance_verification_status_chk CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'FAILED')),
  CONSTRAINT provenance_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT provenance_failure_code_chk CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 64),
  CONSTRAINT provenance_failure_detail_chk CHECK (failure_detail IS NULL OR char_length(failure_detail) <= 240),
  CONSTRAINT provenance_failure_state_chk CHECK (
    (anchor_status IN ('FAILED', 'REORGED') AND failure_code IS NOT NULL)
    OR (anchor_status NOT IN ('FAILED', 'REORGED') AND failure_code IS NULL AND failure_detail IS NULL AND next_retry_at IS NULL)
  ),
  CONSTRAINT provenance_anchor_complete_chk CHECK (
    anchor_status <> 'ANCHORED'
    OR (
      chain_id IS NOT NULL
      AND chain_key IS NOT NULL
      AND transaction_hash IS NOT NULL
      AND block_number IS NOT NULL
    )
  ),
  CONSTRAINT provenance_verified_chk CHECK (
    (verification_status = 'VERIFIED' AND verified_at IS NOT NULL AND anchor_status = 'ANCHORED')
    OR (verification_status <> 'VERIFIED' AND verified_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS provenance_anchor_tx_uidx
  ON provenance_proofs (chain_id, transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS provenance_release_edition_idx
  ON provenance_proofs (release_id, edition_id, schema_version);

ALTER TABLE provenance_proofs ENABLE ROW LEVEL SECURITY;

COMMIT;
