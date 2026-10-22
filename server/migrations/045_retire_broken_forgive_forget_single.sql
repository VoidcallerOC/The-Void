BEGIN;

-- Retire the broken "Forgive & Forget" Single so the artist can start one entirely new release.
-- Draft release release-cd9c689c-8b90-41ee-b4e4-0124a63d6819 diverged from its immutable on-chain edition:
-- the edition was created on-chain (tx 0x7d1746aaf2b944aad17822b0ca4396c85dabb93447415368b86f330a6e98a639,
-- URI ipfs://QmTExGu6JA9CWD7dBRvjSEevwQiSMBrXhyj1H2RuD7hw95) but Studio was never told, and the draft's metadata
-- was republished afterwards (ipfs://QmfBD1x4ofcPPqU236kHYaQzfiWJzuEgW5Vcq7cuqSwXfH). Its on-chain edition
-- cannot be changed or erased, and this migration does not try to reconcile or adopt it.
--
-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so merging this file applies it to
-- production on the next deploy. Do not merge until the owner has reviewed the target IDs below.
--
-- Exact rows, by ID, lifecycle status only (DRAFT or REVIEW to ARCHIVED) plus an "abandoned" marker:
--   releases     1  release-cd9c689c-8b90-41ee-b4e4-0124a63d6819  (slug forgive-and-forget)
--   editions     2  edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad  (the on-chain edition's draft)
--                   edition-a5a399c6-5712-4be5-b70b-dfa032dae77d  (left over from the first save)
--   experiences  2  experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-experience-audio  (DEMO)
--                   experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-full-track        (AUDIO)
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- The abandoned marker is release_metadata.abandoned / application_metadata.abandoned (jsonb), so the old draft
-- can never be mistaken for the new release.
-- Never changed: tokens (including both token rows of the edition), contracts, release_contracts (the clone
-- 0x8192cc13caec165afd802af691f952573bb3d817 stays bound to this retired release and is never reused),
-- release_provisioning_requests, provenance_proofs, media assets, sales, purchases, ownership and every
-- on-chain record. A row that is already ARCHIVED or PUBLISHED is skipped. Re-running is a no-op.
-- Reversal: set the rows back to DRAFT and remove the "abandoned" key
-- (UPDATE ... SET status='DRAFT', release_metadata = release_metadata - 'abandoned' ...).

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status IN ('DRAFT', 'REVIEW')
  AND id IN (
    'experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-experience-audio',
    'experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-full-track'
  )
  AND release_id = 'release-cd9c689c-8b90-41ee-b4e4-0124a63d6819'
  AND edition_id = 'edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad';

UPDATE editions
SET status = 'ARCHIVED',
    application_metadata = coalesce(application_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '045_retire_broken_forgive_forget_single.sql', 'reason', 'ON_CHAIN_EDITION_DIVERGED_FROM_DRAFT')),
    updated_at = now()
WHERE status IN ('DRAFT', 'REVIEW')
  AND id IN (
    'edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad',
    'edition-a5a399c6-5712-4be5-b70b-dfa032dae77d'
  )
  AND release_id = 'release-cd9c689c-8b90-41ee-b4e4-0124a63d6819';

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED',
      release_metadata = coalesce(release_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '045_retire_broken_forgive_forget_single.sql', 'reason', 'ON_CHAIN_EDITION_DIVERGED_FROM_DRAFT')),
      updated_at = now()
  WHERE status IN ('DRAFT', 'REVIEW')
    AND id = 'release-cd9c689c-8b90-41ee-b4e4-0124a63d6819'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '045_retire_broken_forgive_forget_single.sql',
    'authorization', 'owner',
    'reason', 'ON_CHAIN_EDITION_DIVERGED_FROM_DRAFT',
    'releaseContractAddress', '0x8192cc13caec165afd802af691f952573bb3d817',
    'creationTransactionHash', '0x7d1746aaf2b944aad17822b0ca4396c85dabb93447415368b86f330a6e98a639',
    'onChainMetadataUri', 'ipfs://QmTExGu6JA9CWD7dBRvjSEevwQiSMBrXhyj1H2RuD7hw95',
    'draftMetadataUri', 'ipfs://QmfBD1x4ofcPPqU236kHYaQzfiWJzuEgW5Vcq7cuqSwXfH',
    'editionIds', jsonb_build_array('edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad', 'edition-a5a399c6-5712-4be5-b70b-dfa032dae77d'),
    'experienceIds', jsonb_build_array(
      'experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-experience-audio',
      'experience-edition-5c5f87f0-6e15-4e3d-8a42-2aa7497ec0ad-full-track'
    )
  )
FROM archived;

COMMIT;
