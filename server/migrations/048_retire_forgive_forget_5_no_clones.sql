BEGIN;

-- Third clean reset of "Forgive & Forget": retire the draft the owner saved after migration 047.
-- Draft release release-7bc53df7-abc7-4b10-8328-f7aec4c3b601 (slug forgive-forget-5) was abandoned by the owner, who
-- wants no release contracts at all. A createRelease transaction had nevertheless been sent from Studio on Avalanche
-- C-Chain mainnet (tx 0xd6e6813a35c575dd2228f7193f696921029e7daf17c3c8f227dbe432a587b0ff, block 98286124, empty clone
-- 0xf57e38454e5321f55dd7ca8bbe8be805f4737018). That transaction and clone are immutable chain history; this
-- migration does not reconcile, bind, reuse or erase them.
--
-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so merging this file applies it to
-- production on the next deploy. Do not merge until the owner has reviewed the target ID below.
--
-- Exact row, by ID, lifecycle status only (DRAFT or REVIEW to ARCHIVED) plus an "abandoned" marker:
--   releases     1  release-7bc53df7-abc7-4b10-8328-f7aec4c3b601
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- This release has no editions, experiences, tokens, media assets or release_contracts row (checked read-only on
-- 2026-10-23), so nothing else is touched.
-- Never changed: release_provisioning_requests (the SUBMITTED request keeps the transaction hash for audit; the API
-- refuses to bind, submit or refresh any archived release), contracts, factory_releases (indexer-owned chain history,
-- including the clone), release_contracts, tokens, editions, experiences, provenance_proofs, media assets, sales,
-- purchases, ownership, other releases, and every on-chain record. An already ARCHIVED or PUBLISHED release is
-- skipped. Re-running is a no-op.
-- Reversal: UPDATE releases SET status='DRAFT', release_metadata = release_metadata - 'abandoned' WHERE id = '<id above>'.

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED',
      release_metadata = coalesce(release_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '048_retire_forgive_forget_5_no_clones.sql', 'reason', 'OWNER_RESET_NO_CLONES')),
      updated_at = now()
  WHERE status IN ('DRAFT', 'REVIEW')
    AND id = 'release-7bc53df7-abc7-4b10-8328-f7aec4c3b601'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '048_retire_forgive_forget_5_no_clones.sql',
    'authorization', 'owner',
    'reason', 'OWNER_RESET_NO_CLONES',
    'releaseContractAddress', '0xf57e38454e5321f55dd7ca8bbe8be805f4737018',
    'creationTransactionHash', '0xd6e6813a35c575dd2228f7193f696921029e7daf17c3c8f227dbe432a587b0ff',
    'creationBlock', 98286124
  )
FROM archived;

COMMIT;
