BEGIN;

-- Second clean reset of "Forgive & Forget": retire the draft the owner created after migration 046.
-- Draft release release-88dbe3b8-dce2-4d98-857c-10b7fa8f64ca (slug forgive-forget-4) was abandoned by the owner, who
-- does not want to use any existing release contract for the new release. Studio's Create release had also sent a
-- createRelease transaction on Avalanche C-Chain mainnet (tx 0x8e28a2aabbe8e61967b4269d694ce54b400650521977310052812a1674f78317,
-- block 98257992, empty clone 0xa28a27efa7fd1dc647b2ceb1c01db4ec1d2eaa45). That transaction and clone are immutable chain
-- history; this migration does not reconcile, bind, reuse or erase them.
--
-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so merging this file applies it to
-- production on the next deploy. Do not merge until the owner has reviewed the target ID below.
--
-- Exact row, by ID, lifecycle status only (DRAFT or REVIEW to ARCHIVED) plus an "abandoned" marker:
--   releases     1  release-88dbe3b8-dce2-4d98-857c-10b7fa8f64ca
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- This release has no editions, experiences, tokens, media assets or release_contracts row (checked read-only on
-- 2026-10-22), so nothing else is touched. Archiving it also stops Studio from loading it as "the existing draft" when
-- the owner creates a new release with the same title.
-- Never changed: release_provisioning_requests (the SUBMITTED request keeps the transaction hash for audit; the API
-- refuses to bind, submit or refresh any archived release), contracts, factory_releases (indexer-owned chain history,
-- including the clone), release_contracts, tokens, editions, experiences, provenance_proofs, media assets, sales,
-- purchases, ownership, other releases, and every on-chain record. An already ARCHIVED or PUBLISHED release is
-- skipped. Re-running is a no-op.
-- Reversal: UPDATE releases SET status='DRAFT', release_metadata = release_metadata - 'abandoned' WHERE id = '<id above>'.

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED',
      release_metadata = coalesce(release_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '047_retire_forgive_forget_4_no_clone_reset.sql', 'reason', 'OWNER_RESET_NO_CONTRACT_WANTED')),
      updated_at = now()
  WHERE status IN ('DRAFT', 'REVIEW')
    AND id = 'release-88dbe3b8-dce2-4d98-857c-10b7fa8f64ca'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '047_retire_forgive_forget_4_no_clone_reset.sql',
    'authorization', 'owner',
    'reason', 'OWNER_RESET_NO_CONTRACT_WANTED',
    'releaseContractAddress', '0xa28a27efa7fd1dc647b2ceb1c01db4ec1d2eaa45',
    'creationTransactionHash', '0x8e28a2aabbe8e61967b4269d694ce54b400650521977310052812a1674f78317',
    'creationBlock', 98257992
  )
FROM archived;

COMMIT;
