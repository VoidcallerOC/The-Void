BEGIN;

-- Retire the original mainnet "Forgive & Forget" release so its replacement
-- (release-273f5476-0cdb-45d3-83d3-5908eb42bc6c, slug forgive-forget-2) can be the
-- active release. The owner explicitly authorized this retirement on 2026-10-22 and
-- accepts that holders' playback of the retired editions stops (the media gateway
-- serves only PUBLISHED experiences). Studio refuses this on its own
-- (MINTABLE_RELEASE_LOCKED: the release has a published edition with an on-chain token),
-- so, as in 030, it is a reviewed migration limited to these exact rows:
--   release-83611741-c9ee-4487-a438-b6fa844762e6  (slug forgive-forget)
--   edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7
--   edition-6e35101c-4987-4695-ac96-d83061ef2673
--   and the experiences of those editions
-- It mirrors ArtistStudioService.archiveReleaseChildren: lifecycle status only. The
-- release, editions, experiences, media assets and their associations, tokens, sales,
-- ownership, purchases and every on-chain record stay as they are. The replacement
-- release and its edition are not listed and are not touched.
-- Re-running is a no-op: only rows not yet ARCHIVED change, and the audit row is
-- written only when the release itself changed.
-- Reversal: set these rows back to PUBLISHED (edition-11e2e1a2 was DRAFT).

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status <> 'ARCHIVED'
  AND (
    release_id = 'release-83611741-c9ee-4487-a438-b6fa844762e6'
    OR edition_id IN (
      'edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7',
      'edition-6e35101c-4987-4695-ac96-d83061ef2673'
    )
  );

UPDATE editions
SET status = 'ARCHIVED', updated_at = now()
WHERE status <> 'ARCHIVED'
  AND release_id = 'release-83611741-c9ee-4487-a438-b6fa844762e6';

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED', updated_at = now()
  WHERE status <> 'ARCHIVED'
    AND id = 'release-83611741-c9ee-4487-a438-b6fa844762e6'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '043_archive_forgive_forget_original.sql',
    'authorization', 'owner',
    'replacementReleaseId', 'release-273f5476-0cdb-45d3-83d3-5908eb42bc6c',
    'editionIds', jsonb_build_array('edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7', 'edition-6e35101c-4987-4695-ac96-d83061ef2673')
  )
FROM archived;

COMMIT;
