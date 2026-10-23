BEGIN;

-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so once this file is merged it is applied
-- to production on the next API deploy (the mainnet API deploys manually). Do not merge until the owner has reviewed
-- the target IDs below. Reviewed while staged in deploy/mainnet/pending-migrations/ (PR #278) and activated by its
-- own PR (runbook step 5). Activation precondition re-checked read-only at block 98371603 (2026-10-23 21:58Z):
-- edition(token).mintedSupply == 0 on the clone and sales(token).configured == false on the sale.
--
-- Retire the published mainnet "Forgive & Forget" release forgive-forget-6 in the application so a fresh release
-- on the sequential-ID factory (token ID 1) becomes the only active Forgive & Forget. Reason:
-- REPLACED_BY_SEQUENTIAL_RELEASE. The owner accepts that the old chain records stay publicly visible.
--
-- On-chain facts (read-only, 2026-10-23): Avalanche C-Chain 43114, release clone
-- 0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d from factory 0xE744D58fA8138042f5f00a28d39f89081539C19B, edition
-- created by tx 0x5de469e259278ef6815756ce024731baff1f7b455385a66c87d8f1b38a84dce6 (block 98342872), token
-- 25679935302133066722236771263728427871936411831072189551573738559199048803312, mintedSupply 0, no transfer ever,
-- primary sale 0xa0000f9489c940e2b99d654700bd425ca36f6921 never configured. Nobody holds it, so no holder loses
-- playback. The chain records cannot be changed or erased and this migration does not try.
--
-- Why a migration: Studio refuses to archive a release with a published edition and an on-chain token
-- (MINTABLE_RELEASE_LOCKED), so, as in 030 and 043, it is a reviewed migration limited to these exact rows:
--   releases     1  release-e3743294-2ea3-46ae-b006-f0402606af65  (slug forgive-forget-6)
--   editions     every edition of that release (production: edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d)
--   experiences  every experience of that release or edition (production:
--                experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-experience-audio  (DEMO)
--                experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-full-track        (AUDIO))
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- It mirrors ArtistStudioService.archiveReleaseChildren: lifecycle status only, plus an "abandoned" jsonb marker
-- (release_metadata.abandoned / application_metadata.abandoned) so the old release can never be mistaken for
-- the new one. Every other key of release_metadata (including releaseKey, which the indexer matches) is kept.
-- Effects that follow from ARCHIVED alone, through existing code:
--   - the public catalog (/api/releases, /api/editions) serves only PUBLISHED rows, so the release disappears;
--   - ARCHIVED experiences no longer reserve their private files (ACTIVE_MEDIA_CLAIM_SQL), so the new edition can
--     attach the same full track and demo;
--   - the indexer stops tracking the clone and its sale (abandonedReleaseSql: ARCHIVED, matching releaseKey, and
--     no transfer, purchase or owner).
-- Never changed: tokens, contracts, release_contracts, factory_releases, release_provisioning_requests,
-- provenance_proofs, media_assets, sales, purchases, ownership, listings, artists, every other release, and every
-- on-chain record. Rows already ARCHIVED are skipped. Re-running is a no-op.
--
-- Reversal (owner decision only):
--   UPDATE experiences SET status='PUBLISHED', updated_at=now()
--     WHERE release_id='release-e3743294-2ea3-46ae-b006-f0402606af65' OR edition_id='edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d';
--   UPDATE editions SET status='PUBLISHED', application_metadata = application_metadata - 'abandoned', updated_at=now()
--     WHERE id='edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d';
--   UPDATE releases SET status='PUBLISHED', release_metadata = release_metadata - 'abandoned', updated_at=now()
--     WHERE id='release-e3743294-2ea3-46ae-b006-f0402606af65';
-- (Any other edition of the release was a DRAFT before this migration; restore it to DRAFT, not PUBLISHED.)

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status <> 'ARCHIVED'
  AND (
    release_id = 'release-e3743294-2ea3-46ae-b006-f0402606af65'
    OR edition_id = 'edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d'
  );

UPDATE editions
SET status = 'ARCHIVED',
    application_metadata = coalesce(application_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '049_retire_forgive_forget_6_replaced_by_sequential.sql', 'reason', 'REPLACED_BY_SEQUENTIAL_RELEASE')),
    updated_at = now()
WHERE status <> 'ARCHIVED'
  AND release_id = 'release-e3743294-2ea3-46ae-b006-f0402606af65';

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED',
      release_metadata = coalesce(release_metadata, '{}'::jsonb) || jsonb_build_object('abandoned', jsonb_build_object('migration', '049_retire_forgive_forget_6_replaced_by_sequential.sql', 'reason', 'REPLACED_BY_SEQUENTIAL_RELEASE')),
      updated_at = now()
  WHERE status <> 'ARCHIVED'
    AND id = 'release-e3743294-2ea3-46ae-b006-f0402606af65'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '049_retire_forgive_forget_6_replaced_by_sequential.sql',
    'authorization', 'owner',
    'reason', 'REPLACED_BY_SEQUENTIAL_RELEASE',
    'editionIds', jsonb_build_array('edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d'),
    'experienceIds', jsonb_build_array(
      'experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-experience-audio',
      'experience-edition-8f5f690e-47c4-46d5-baf6-1ab969ed259d-full-track'
    ),
    'releaseContractAddress', '0xf9c48a2bbceba7577ff17a2eed20fcef70ea480d',
    'factoryAddress', '0xe744d58fa8138042f5f00a28d39f89081539c19b',
    'primarySaleAddress', '0xa0000f9489c940e2b99d654700bd425ca36f6921',
    'editionCreationTransactionHash', '0x5de469e259278ef6815756ce024731baff1f7b455385a66c87d8f1b38a84dce6',
    'editionCreationBlock', 98342872,
    'tokenId', '25679935302133066722236771263728427871936411831072189551573738559199048803312',
    'mintedSupply', 0
  )
FROM archived;

COMMIT;
