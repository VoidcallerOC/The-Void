BEGIN;

-- Migration 019 was already applied in production. Keep that migration
-- immutable and apply the deterministic alias correction separately.
WITH aliases AS (
  SELECT id, row_number() OVER (ORDER BY id) AS ordinal
  FROM artists
  WHERE slug = 'voidcaller' AND id <> 'voidcaller'
), available AS (
  SELECT 'voidcaller-' || n AS slug, row_number() OVER (ORDER BY n) AS ordinal
  FROM generate_series(2, 10000) AS n
  WHERE NOT EXISTS (SELECT 1 FROM artists taken WHERE taken.slug = 'voidcaller-' || n)
), assignments AS (
  SELECT aliases.id, available.slug
  FROM aliases
  JOIN available USING (ordinal)
)
UPDATE artists
SET slug = assignments.slug,
    updated_at = now()
FROM assignments
WHERE artists.id = assignments.id;

COMMIT;
