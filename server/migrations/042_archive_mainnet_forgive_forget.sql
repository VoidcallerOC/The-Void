BEGIN;

-- Retire the original mainnet "Forgive & Forget" from discovery and new
-- purchases, at the owner's decision (2026-10-20). Its primary sale credits the
-- platform fee instead of paying it and is immutable, so it is being replaced by
-- a release from VoidReleaseFactoryV2RoyaltySettled (see FACTORY-FEE-FIX.md).
--   release-83611741-c9ee-4487-a438-b6fa844762e6
--   edition-6e35101c-4987-4695-ac96-d83061ef2673 (published)
--   edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7 (draft; its experiences were published)
-- Only lifecycle status changes. The contract, sale, token, ownership,
-- metadata, media and purchases stay. This does not disable the on-chain sale.
-- The draft release release-273f5476-0cdb-45d3-83d3-5908eb42bc6c is not touched.
-- Reversal: set these rows back to PUBLISHED.

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND release_id = 'release-83611741-c9ee-4487-a438-b6fa844762e6';

UPDATE editions
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND release_id = 'release-83611741-c9ee-4487-a438-b6fa844762e6';

UPDATE releases
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND id = 'release-83611741-c9ee-4487-a438-b6fa844762e6';

COMMIT;
