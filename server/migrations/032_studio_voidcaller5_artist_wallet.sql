BEGIN;

-- Voidcaller (voidcaller-5) was created under the Fuji contract admin/deployer
-- wallet during Studio work. Forgive & Forget on that profile belongs to the
-- platform artist wallet, not the admin deployer. Reassign ownership so
-- GET /studio/catalog (artist_owners) lists it for the artist wallet only.
-- Idempotent: no-op when the slug is missing or already owned correctly.

WITH target AS (
  SELECT id
  FROM artists
  WHERE slug = 'voidcaller-5'
  LIMIT 1
)
DELETE FROM artist_owners
WHERE artist_id IN (SELECT id FROM target)
  AND lower(owner_wallet) = '0xabd3746e8b852f55be52fc44fab6cab908b1c174';

INSERT INTO artist_owners (artist_id, owner_wallet, role)
SELECT id, '0x284c09a7cc187e096cbbdc88d99defe6df32180a', 'OWNER'
FROM artists
WHERE slug = 'voidcaller-5'
ON CONFLICT (artist_id, owner_wallet) DO UPDATE
SET role = EXCLUDED.role,
    updated_at = now();

COMMIT;
