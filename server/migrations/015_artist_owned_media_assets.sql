BEGIN;

-- Artist-owned private media. media_assets already stored experience-bound
-- objects; these columns let an upload register a file before an experience
-- exists. Experiences store the asset id, never a client-supplied CID.
-- storage_key stays unique. Only the upload path inserts rows.

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS artist_id text REFERENCES artists(id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS id text;
UPDATE media_assets SET id = media_key WHERE id IS NULL;
ALTER TABLE media_assets ALTER COLUMN id SET NOT NULL;
ALTER TABLE media_assets ALTER COLUMN experience_id DROP NOT NULL;
ALTER TABLE media_assets ALTER COLUMN chain_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_id_uidx ON media_assets (id);
CREATE INDEX IF NOT EXISTS media_assets_artist_idx ON media_assets (artist_id);

COMMIT;
