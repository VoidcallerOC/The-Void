BEGIN;

-- Artist-owned private media. media_assets already stored experience-bound
-- objects; these columns let an upload register a file before an experience
-- exists. Experiences store the asset id, never a client-supplied CID.
-- storage_key stays unique. Only the upload path inserts rows.

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS artist_id text REFERENCES artists(id);
UPDATE media_assets m SET artist_id = e.artist_id
FROM experiences e WHERE m.experience_id = e.id AND m.artist_id IS NULL;

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS id text;
UPDATE media_assets SET id = media_key WHERE id IS NULL;
ALTER TABLE media_assets ALTER COLUMN id SET NOT NULL;
ALTER TABLE media_assets ALTER COLUMN experience_id DROP NOT NULL;
ALTER TABLE media_assets ALTER COLUMN chain_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_id_uidx ON media_assets (id);
CREATE INDEX IF NOT EXISTS media_assets_artist_idx ON media_assets (artist_id);

-- Experiences published before asset ids stored a storageKey only. Attach the
-- artist's media_assets.id for the same storage_key so grants keep resolving.
UPDATE experiences e
SET media_config = jsonb_set(
  e.media_config,
  '{protectedMedia}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(elements.item) = 'object'
         AND COALESCE(elements.item->>'assetId', '') = ''
         AND COALESCE(elements.item->>'storageKey', '') <> ''
         AND asset.id IS NOT NULL
        THEN elements.item || jsonb_build_object('assetId', asset.id)
        ELSE elements.item
      END
      ORDER BY elements.ord
    )
    FROM jsonb_array_elements(e.media_config->'protectedMedia') WITH ORDINALITY AS elements(item, ord)
    LEFT JOIN media_assets asset
      ON asset.storage_key = elements.item->>'storageKey'
     AND asset.artist_id = e.artist_id
  )
)
WHERE jsonb_typeof(e.media_config->'protectedMedia') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(e.media_config->'protectedMedia') AS elements(item)
    JOIN media_assets asset
      ON asset.storage_key = elements.item->>'storageKey'
     AND asset.artist_id = e.artist_id
    WHERE jsonb_typeof(elements.item) = 'object'
      AND COALESCE(elements.item->>'assetId', '') = ''
      AND COALESCE(elements.item->>'storageKey', '') <> ''
  );

COMMIT;
