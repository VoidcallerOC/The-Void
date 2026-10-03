BEGIN;

-- Admin-controlled marketplace presentation. The marketplace hero artwork is
-- its own asset, set explicitly by a platform admin. It is never derived from
-- a release, edition, token or listing image. A single row (id = true).
CREATE TABLE IF NOT EXISTS marketplace_presentation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  hero_artwork text CHECK (hero_artwork IS NULL OR length(hero_artwork) <= 2048),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PostgREST: deny all. The Render API is superuser and bypasses RLS.
ALTER TABLE marketplace_presentation ENABLE ROW LEVEL SECURITY;

COMMIT;
