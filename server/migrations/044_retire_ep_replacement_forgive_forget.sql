BEGIN;

-- Retire the EP-typed replacement "Forgive & Forget" so the intended Single can be finished
-- (release-cd9c689c-8b90-41ee-b4e4-0124a63d6819, type SINGLE, release contract deployed by the factory).
-- The owner explicitly authorized this retirement on 2026-10-22.
--
-- WARNING: the API runs `db:migrate` on every start (npm run start:api), so merging this file applies it
-- to production on the next deploy. Do not merge until the owner has reviewed the target IDs below.
--
-- Why a migration: the replacement's on-chain edition was created with metadata that says "EP". Studio
-- cannot archive these rows itself (a draft edition on a release that already has its contract cannot be
-- removed, and only a PUBLISHED experience or release can be archived). Its two DRAFT experiences still
-- reserve the full track and the demo, so the Single's edition could not attach the same files
-- (PROTECTED_MEDIA_IN_USE). ARCHIVED experiences do not reserve files (PR #257).
--
-- Exact rows, by ID, lifecycle status only (DRAFT or REVIEW to ARCHIVED):
--   releases     1  release-273f5476-0cdb-45d3-83d3-5908eb42bc6c  (slug forgive-forget-2)
--   editions     2  edition-81122aa5-c0b8-446b-8dec-09b061ebca60  (on-chain token created, never confirmed)
--                   edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9  (left over from the first failed save)
--   experiences  2  experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-experience-audio  (DEMO)
--                   experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-full-track        (AUDIO)
--   audit_events 1  one STUDIO_RELEASE_ARCHIVED_BY_MIGRATION row, written only if the release changed
-- No predicate uses a title, slug, artist, media asset or token ID. Never changed: the original release
-- (archived by 043) and its editions and experiences, the intended Single, media assets and their
-- associations, tokens, contracts and release-contract bindings, provisioning requests, sales, purchases,
-- ownership and every on-chain record. A row that is already PUBLISHED or ARCHIVED is skipped.
-- Re-running is a no-op. Reversal: set these rows back to DRAFT.

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status IN ('DRAFT', 'REVIEW')
  AND id IN (
    'experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-experience-audio',
    'experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-full-track'
  )
  AND release_id = 'release-273f5476-0cdb-45d3-83d3-5908eb42bc6c'
  AND edition_id = 'edition-81122aa5-c0b8-446b-8dec-09b061ebca60';

UPDATE editions
SET status = 'ARCHIVED', updated_at = now()
WHERE status IN ('DRAFT', 'REVIEW')
  AND id IN (
    'edition-81122aa5-c0b8-446b-8dec-09b061ebca60',
    'edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9'
  )
  AND release_id = 'release-273f5476-0cdb-45d3-83d3-5908eb42bc6c';

WITH archived AS (
  UPDATE releases
  SET status = 'ARCHIVED', updated_at = now()
  WHERE status IN ('DRAFT', 'REVIEW')
    AND id = 'release-273f5476-0cdb-45d3-83d3-5908eb42bc6c'
  RETURNING id
)
INSERT INTO audit_events (event_type, subject_type, subject_id, chain_id, payload)
SELECT 'STUDIO_RELEASE_ARCHIVED_BY_MIGRATION', 'release', id, 43114,
  jsonb_build_object(
    'migration', '044_retire_ep_replacement_forgive_forget.sql',
    'authorization', 'owner',
    'singleReleaseId', 'release-cd9c689c-8b90-41ee-b4e4-0124a63d6819',
    'editionIds', jsonb_build_array('edition-81122aa5-c0b8-446b-8dec-09b061ebca60', 'edition-485c1e90-1ef4-4f42-98a4-0e5eab8b94e9'),
    'experienceIds', jsonb_build_array(
      'experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-experience-audio',
      'experience-edition-81122aa5-c0b8-446b-8dec-09b061ebca60-full-track'
    )
  )
FROM archived;

COMMIT;
