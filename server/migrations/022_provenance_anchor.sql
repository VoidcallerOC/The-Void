BEGIN;

-- Anchor confirmation fields for an existing provenance proof.
-- The row still stores hashes and chain references only. No media bytes,
-- storage keys, or gateway URLs. RLS from 021 is unchanged: no new policy
-- and no grant to anon or authenticated.

ALTER TABLE provenance_proofs
  ADD COLUMN IF NOT EXISTS block_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS anchor_contract text,
  ADD COLUMN IF NOT EXISTS anchor_event text;

ALTER TABLE provenance_proofs DROP CONSTRAINT IF EXISTS provenance_anchor_contract_chk;
ALTER TABLE provenance_proofs ADD CONSTRAINT provenance_anchor_contract_chk
  CHECK (anchor_contract IS NULL OR anchor_contract ~ '^0x[0-9a-f]{40}$');

ALTER TABLE provenance_proofs DROP CONSTRAINT IF EXISTS provenance_anchor_event_chk;
ALTER TABLE provenance_proofs ADD CONSTRAINT provenance_anchor_event_chk
  CHECK (anchor_event IS NULL OR anchor_event ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$');

ALTER TABLE provenance_proofs DROP CONSTRAINT IF EXISTS provenance_anchor_complete_chk;
ALTER TABLE provenance_proofs ADD CONSTRAINT provenance_anchor_complete_chk CHECK (
  anchor_status <> 'ANCHORED'
  OR (
    chain_id IS NOT NULL
    AND chain_key IS NOT NULL
    AND transaction_hash IS NOT NULL
    AND block_number IS NOT NULL
    AND block_timestamp IS NOT NULL
    AND anchor_contract IS NOT NULL
    AND anchor_event IS NOT NULL
  )
);

COMMIT;
