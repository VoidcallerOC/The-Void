BEGIN;

-- Clean reset of "Forgive & Forget": retire the last live draft so the artist creates the correct release from scratch.
-- Draft release release-84f72628-2c74-4a53-96db-fe495f0f9220 (slug forgive-forget-3) was abandoned by the owner after its
-- createRelease transaction succeeded on Avalanche C-Chain mainnet (tx 0x3a3d27a94124535c424f3e4f56d9542431f87cd841f2e12ffd50e9aa22bff06b,
-- block 98250592, clone 0xa2f1ba71e2a65d3f9e61679e4d76def8710e6236, release key 0xcb93952a...918a2). That transaction
-- and clone are immutable chain history; this migration does not try to reconcile, bind, reuse or erase them.
--
-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so merging this file applies it to
-- production on the next deploy. Do not merge until the owner has reviewed the target ID below.
--
-- Exact row, by ID, lifecycle status only (DRAFT or REVIEW to ARCHIVED) plus an "abandoned" marker:
--   releases     1  release-84f72628-2c74-4a53-96db-fe495f0f9220
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- This release has no editions, experiences, tokens, media assets or release_contracts row, so nothing else is touched.
-- The abandoned marker is release_metadata.abandoned (jsonb), so the draft can never be mistaken for the new release.
-- Never changed: release_provisioning_requests (the SUBMITTED request keeps the transaction hash for audit; the API now
-- refuses to bind, submit or refresh any archived release), contracts, factory_releases (indexer-owned chain
-- history, including the clone), release_contracts, tokens, editions, experiences, provenance_proofs, media assets,
-- sales, purchases, ownership, other releases, and every on-chain record. An already ARCHIVED or PUBLISHED release is
-- skipped. Re-running is a no-op.
-- Reversal: UPDATE releases SET status='DRAFT', release_metadata = release_metadata - 'abandoned' WHERE id = '<id above>'.

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED',
      release_metadata = coalesce(release_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '046_retire_forgive_forget_3_clean_reset.sql', 'reason', 'OWNER_RESET_BEFORE_CONTRACT_BINDING')),
      updated_at = now()
  WHERE status IN ('DRAFT', 'REVIEW')
    AND id = 'release-84f72628-2c74-4a53-96db-fe495f0f9220'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '046_retire_forgive_forget_3_clean_reset.sql',
    'authorization', 'owner',
    'reason', 'OWNER_RESET_BEFORE_CONTRACT_BINDING',
    'releaseContractAddress', '0xa2f1ba71e2a65d3f9e61679e4d76def8710e6236',
    'creationTransactionHash', '0x3a3d27a94124535c424f3e4f56d9542431f87cd841f2e12ffd50e9aa22bff06b',
    'creationBlock', 98250592,
    'releaseKey', '0xcb93952ad8afa7eafb855ec4d6b029f3063134a4e7bb34f182ec6c98348918a2',
    'artworkUri', 'ipfs://bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i',
    'contractUri', 'ipfs://QmcHZo5ZpZNgobpCzjT7o93RbHkA9yiBeNarHi7n2o5Gyr'
  )
FROM archived;

COMMIT;
