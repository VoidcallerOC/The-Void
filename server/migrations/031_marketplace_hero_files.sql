BEGIN;

-- Admin-uploaded marketplace header images. These are site files, not
-- Pinata or IPFS objects. Nothing here unpins or deletes existing Pinata files.
-- The API serves the bytes; the row keeps them when the API container disk is replaced.
CREATE TABLE IF NOT EXISTS marketplace_hero_files (
  filename text PRIMARY KEY CHECK (filename ~ '^marketplace-hero-[a-f0-9]{16}\.(png|jpg|gif|webp)$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 3145728),
  body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- PostgREST: deny all. The Render API is superuser and bypasses RLS.
ALTER TABLE marketplace_hero_files ENABLE ROW LEVEL SECURITY;

COMMIT;
