BEGIN;

-- Optional X (Twitter) account link. Identity-linking only: it never grants wallet
-- ownership, creator permissions or marketplace privileges. The wallet session stays
-- the authority; the stable numeric X user id (not the username) is the external key.
-- No X access or refresh tokens are stored.
CREATE TABLE IF NOT EXISTS x_account_links (
  wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  x_user_id text NOT NULL UNIQUE CHECK (x_user_id ~ '^[0-9]{1,25}$'),
  x_username text NOT NULL CHECK (x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  x_display_name text,
  x_profile_image_url text,
  status text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per authorization attempt. state is stored only as a SHA-256 hash; the PKCE
-- verifier is short-lived (deleted/consumed on first callback) and never an X credential.
-- session_hash binds the attempt to the initiating Void session.
CREATE TABLE IF NOT EXISTS x_link_attempts (
  state_hash text PRIMARY KEY,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  session_hash text NOT NULL,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS x_link_attempts_wallet_idx ON x_link_attempts (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS x_link_attempts_expiry_idx ON x_link_attempts (expires_at);

-- PostgREST: deny all. The Node API uses its table-owning connection.
ALTER TABLE x_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE x_link_attempts ENABLE ROW LEVEL SECURITY;

COMMIT;
