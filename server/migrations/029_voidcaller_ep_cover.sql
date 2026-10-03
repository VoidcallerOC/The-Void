BEGIN;

-- The self-titled VOIDCALLER EP's cover is the robed-figure artwork
-- (/assets/voidcaller_ep_cover.webp), at the owner's request (2026-10-03).
-- Only the release and edition cover change. Track/token artwork, token
-- metadata, contracts, ownership and the IPFS media for each song stay as-is.

UPDATE releases
SET release_metadata = jsonb_set(COALESCE(release_metadata, '{}'::jsonb), '{artwork}', '"/assets/voidcaller_ep_cover.webp"'::jsonb),
    updated_at = now()
WHERE id = 'voidcaller-legacy-genesis';

UPDATE editions
SET application_metadata = jsonb_set(COALESCE(application_metadata, '{}'::jsonb), '{artwork}', '"/assets/voidcaller_ep_cover.webp"'::jsonb),
    updated_at = now()
WHERE id = 'voidcaller-legacy-edition';

COMMIT;
