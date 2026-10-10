BEGIN;

-- A standalone SINGLE release keeps its own release, contract, edition, provenance
-- and ownership history. Appearing on an album is an explicit, append-only
-- relationship between the two releases; neither release row is rewritten.
CREATE TABLE IF NOT EXISTS release_album_singles (
  album_release_id text NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  single_release_id text NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  single_edition_id text NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  track_position integer NOT NULL CHECK (track_position BETWEEN 1 AND 999),
  associated_by_wallet text NOT NULL CHECK (associated_by_wallet ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_release_id, single_release_id),
  UNIQUE (album_release_id, track_position),
  CHECK (album_release_id <> single_release_id)
);
CREATE INDEX IF NOT EXISTS release_album_singles_single_idx ON release_album_singles (single_release_id);

-- Keep the table out of the PostgREST surface (see 017, 036 and 037).
ALTER TABLE release_album_singles ENABLE ROW LEVEL SECURITY;

COMMIT;
