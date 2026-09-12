BEGIN;

CREATE TABLE IF NOT EXISTS media_assets (
  media_key text PRIMARY KEY,
  experience_id text NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  media_type text NOT NULL CHECK (media_type IN ('AUDIO', 'VIDEO', 'STEMS', 'DOWNLOAD', 'DEMO', 'LIVE_RECORDING')),
  chain_id bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  visibility text NOT NULL DEFAULT 'PROTECTED' CHECK (visibility IN ('PUBLIC_PREVIEW', 'PROTECTED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_experience_idx ON media_assets (experience_id, media_type, chain_id);
CREATE INDEX IF NOT EXISTS media_authorizations_access_idx ON media_authorizations (experience_id, action, created_at DESC);

COMMIT;
