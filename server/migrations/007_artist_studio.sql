BEGIN;

-- Artist Studio explicitly models wallet-scoped artist administration. This
-- preserves the public Artist → Release → Edition → Experience catalog while
-- preventing a signed wallet from modifying another artist's records.
CREATE TABLE IF NOT EXISTS artist_owners (
  artist_id text NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  owner_wallet text NOT NULL,
  role text NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER', 'MANAGER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artist_id, owner_wallet)
);
CREATE INDEX IF NOT EXISTS artist_owners_wallet_idx
  ON artist_owners (owner_wallet, artist_id);

-- REVIEW is an explicit editorial stage. PUBLISHED records remain immutable
-- with respect to lifecycle regression in the application service.
ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_status_check;
ALTER TABLE releases ADD CONSTRAINT releases_status_check
  CHECK (status IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'));
ALTER TABLE editions DROP CONSTRAINT IF EXISTS editions_status_check;
ALTER TABLE editions ADD CONSTRAINT editions_status_check
  CHECK (status IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'));
ALTER TABLE experiences DROP CONSTRAINT IF EXISTS experiences_status_check;
ALTER TABLE experiences ADD CONSTRAINT experiences_status_check
  CHECK (status IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'));

CREATE INDEX IF NOT EXISTS releases_artist_lifecycle_idx
  ON releases (artist_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS editions_release_lifecycle_idx
  ON editions (release_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS experiences_edition_lifecycle_idx
  ON experiences (edition_id, status, updated_at DESC);

COMMIT;
