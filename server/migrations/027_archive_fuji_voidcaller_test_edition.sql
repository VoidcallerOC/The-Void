BEGIN;

-- Retire the Fuji VOIDCALLER test release from discovery, at the owner's
-- request (2026-10-03). It was published by the Studio-created alias artist
-- voidcaller-7 on the certified Fuji contract and showed up next to the real
-- legacy EP (voidcaller-legacy-genesis) as a second "VOIDCALLER":
--   release-8f6d5a9f-585d-4948-b05b-7098125d16cf
--   edition-ecf27444-94b7-40d5-bace-5f061792f55e
--   token 3377880292…6576739 on 0x82b26da2…82e5
-- Only lifecycle status changes. The contract, tokens, holders, listing 1,
-- sales, purchases, transfers, proofs and the alias artist row are untouched.
-- Reversal: set the same three rows back to PUBLISHED.

UPDATE experiences
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND (
    release_id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf'
    OR edition_id = 'edition-ecf27444-94b7-40d5-bace-5f061792f55e'
  );

UPDATE editions
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND release_id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf';

UPDATE releases
SET status = 'ARCHIVED', updated_at = now()
WHERE status = 'PUBLISHED'
  AND id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf';

COMMIT;
