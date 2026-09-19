-- Artist verification: applications, artist identity, reviewer authorization.
-- Status is an explicit state machine — never a lone boolean.

create table if not exists artist_profiles (
  id text primary key,
  user_id text not null unique,
  slug text not null unique,
  artist_name text not null,
  legal_name text not null,
  email text not null,
  location text not null,
  artist_type text not null,
  artist_bio text not null,
  work_description text not null,
  years_active text not null,
  website_url text,
  instagram_url text,
  tiktok_url text,
  youtube_url text,
  spotify_url text,
  apple_music_url text,
  soundcloud_url text,
  bandcamp_url text,
  other_url text,
  portfolio_url text,
  work_urls_json text not null default '[]',
  -- Derived from the governing application row. Never client-written.
  verification_status text not null default 'NOT_APPLIED'
    check (verification_status in ('NOT_APPLIED', 'PENDING', 'VERIFIED', 'DECLINED', 'REVOKED')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists artist_profiles_status_idx
  on artist_profiles (verification_status, artist_name);
create index if not exists artist_profiles_slug_idx
  on artist_profiles (slug);

create table if not exists artist_verification_applications (
  id text primary key,
  public_id text not null unique,
  user_id text not null,
  artist_profile_id text not null references artist_profiles(id) on delete cascade,
  artist_name text not null,
  legal_name text not null,
  email text not null,
  location text not null,
  artist_type text not null,
  website_url text,
  instagram_url text,
  tiktok_url text,
  youtube_url text,
  spotify_url text,
  apple_music_url text,
  soundcloud_url text,
  bandcamp_url text,
  other_url text,
  artist_bio text not null,
  work_description text not null,
  years_active text not null,
  work_urls_json text not null default '[]',
  portfolio_url text,
  verification_evidence text not null,
  additional_information text,
  status text not null
    check (status in (
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'NEEDS_INFORMATION',
      'VERIFIED',
      'DECLINED',
      'REVOKED'
    )),
  reviewer_id text,
  review_notes text,
  decision_reason text,
  information_request text,
  applicant_response text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists verification_apps_user_idx
  on artist_verification_applications (user_id, submitted_at desc);
create index if not exists verification_apps_status_idx
  on artist_verification_applications (status, submitted_at desc);
create index if not exists verification_apps_profile_idx
  on artist_verification_applications (artist_profile_id, submitted_at desc);

-- One live application per account. Terminal states (declined / revoked) free the slot for reapplication.
create unique index if not exists verification_one_live_app_per_user
  on artist_verification_applications (user_id)
  where status in ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'VERIFIED');

create table if not exists verification_reviewers (
  user_id text primary key,
  granted_by text,
  created_at timestamptz not null default now()
);

create table if not exists verification_status_events (
  id text primary key,
  application_id text not null references artist_verification_applications(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id text not null,
  actor_role text not null check (actor_role in ('APPLICANT', 'REVIEWER', 'SYSTEM')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists verification_events_app_idx
  on verification_status_events (application_id, created_at);

create table if not exists verification_rate_limits (
  user_id text not null,
  action text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, action, window_start)
);
