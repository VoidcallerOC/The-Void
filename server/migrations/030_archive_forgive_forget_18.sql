BEGIN;

-- Retire the remaining Fuji "Forgive & Forget" from discovery, at the owner's
-- request (2026-10-03). The earlier duplicates were archived in 026. This one
-- was kept because it had the preview, but it is on the previous release
-- contract and cannot be sold from the new open-edition sale:
--   forgive-forget-18
--   release-b96d6a64-3379-4da0-b834-ae2e00bf9571
--   edition-e2e5abb4-bf03-42d1-9aea-c0b8492c3267
--   experience-0fe2d5b8-1d1a-4889-8854-54c4b9ff4a53 (Stranger Things)
-- Only lifecycle status changes. The token, sale, ownership, and purchases stay.
-- Reversal: set these rows back to PUBLISHED.

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND (
    release_id = 'release-b96d6a64-3379-4da0-b834-ae2e00bf9571'
    OR edition_id = 'edition-e2e5abb4-bf03-42d1-9aea-c0b8492c3267'
  );

UPDATE editions
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND release_id = 'release-b96d6a64-3379-4da0-b834-ae2e00bf9571';

UPDATE releases
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND id = 'release-b96d6a64-3379-4da0-b834-ae2e00bf9571';

COMMIT;
