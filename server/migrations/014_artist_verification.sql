BEGIN;

-- Artist verification applications. Source of truth for the verified mark.
-- Existing artists.status (ACTIVE/ARCHIVED) is catalog lifecycle, not verification.

CREATE TABLE IF NOT EXISTS artist_verification_applications (
  id text PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  wallet_address text NOT NULL,
  artist_id text REFERENCES artists(id) ON DELETE SET NULL,
  slug text NOT NULL,
  artist_name text NOT NULL,
  legal_name text NOT NULL,
  email text NOT NULL,
  location text NOT NULL,
  artist_type text NOT NULL,
  website_url text,
  instagram_url text,
  tiktok_url text,
  youtube_url text,
  spotify_url text,
  apple_music_url text,
  soundcloud_url text,
  bandcamp_url text,
  other_url text,
  artist_bio text NOT NULL,
  work_description text NOT NULL,
  years_active text NOT NULL,
  work_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  portfolio_url text,
  verification_evidence text NOT NULL,
  additional_information text,
  status text NOT NULL CHECK (status IN (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'NEEDS_INFORMATION',
    'VERIFIED',
    'DECLINED',
    'REVOKED'
  )),
  reviewer_wallet text,
  review_notes text,
  decision_reason text,
  information_request text,
  applicant_response text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_apps_wallet_idx
  ON artist_verification_applications (wallet_address, submitted_at DESC);
CREATE INDEX IF NOT EXISTS verification_apps_status_idx
  ON artist_verification_applications (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS verification_apps_artist_idx
  ON artist_verification_applications (artist_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS verification_one_live_app_per_wallet
  ON artist_verification_applications (wallet_address)
  WHERE status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'VERIFIED');

CREATE TABLE IF NOT EXISTS verification_reviewers (
  wallet_address text PRIMARY KEY,
  granted_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_status_events (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES artist_verification_applications(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_wallet text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('APPLICANT', 'REVIEWER', 'SYSTEM')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_events_app_idx
  ON verification_status_events (application_id, created_at);

CREATE TABLE IF NOT EXISTS verification_rate_limits (
  wallet_address text NOT NULL,
  action text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet_address, action, window_start)
);

-- PostgREST: deny all. The Render API is superuser and bypasses RLS.
ALTER TABLE artist_verification_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_rate_limits ENABLE ROW LEVEL SECURITY;

COMMIT;
