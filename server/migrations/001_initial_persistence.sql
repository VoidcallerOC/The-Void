BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE artists (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  application_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artist_profiles (
  artist_id text PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  bio text,
  website_url text,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
  id text PRIMARY KEY,
  artist_id text NOT NULL REFERENCES artists(id),
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  release_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artist_id, slug)
);
CREATE INDEX releases_discovery_idx ON releases (status, published_at DESC);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  chain_key text NOT NULL,
  address text NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('ERC1155', 'MARKETPLACE', 'OTHER')),
  name text,
  deployment_tx_hash text,
  deployment_block_number bigint,
  verified_source_url text,
  bytecode_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address)
);
CREATE INDEX contracts_type_idx ON contracts (contract_type, chain_id);

CREATE TABLE editions (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES releases(id),
  contract_id uuid REFERENCES contracts(id),
  title text NOT NULL,
  tier text,
  description text,
  supply numeric(78,0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  application_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editions_release_idx ON editions (release_id, status);

CREATE TABLE tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id text NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES contracts(id),
  token_id numeric(78,0) NOT NULL,
  metadata_uri text,
  metadata jsonb,
  metadata_version text,
  last_metadata_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, token_id)
);
CREATE INDEX tokens_edition_idx ON tokens (edition_id, token_id);

CREATE TABLE experiences (
  id text PRIMARY KEY,
  artist_id text REFERENCES artists(id),
  release_id text REFERENCES releases(id),
  edition_id text REFERENCES editions(id),
  title text NOT NULL,
  description text,
  experience_type text NOT NULL,
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  media_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX experiences_discovery_idx ON experiences (status, release_id, edition_id);

CREATE TABLE collectors (
  wallet_address text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  application_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE chain_blocks (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  block_timestamp timestamptz NOT NULL,
  is_canonical boolean NOT NULL DEFAULT true,
  finalized_at timestamptz,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, block_number),
  UNIQUE (chain_id, block_hash)
);
CREATE INDEX chain_blocks_cursor_idx ON chain_blocks (chain_id, is_canonical, block_number DESC);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  token_id numeric(78,0) NOT NULL,
  from_wallet text NOT NULL,
  to_wallet text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount >= 0),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  log_index integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('TransferSingle', 'TransferBatch', 'MINT', 'BURN')),
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  block_timestamp timestamptz NOT NULL,
  is_canonical boolean NOT NULL DEFAULT true,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, transaction_hash, log_index)
);
CREATE INDEX transfers_wallet_idx ON transfers (chain_id, from_wallet, block_number DESC);
CREATE INDEX transfers_recipient_idx ON transfers (chain_id, to_wallet, block_number DESC);
CREATE INDEX transfers_asset_idx ON transfers (chain_id, contract_address, token_id, block_number DESC);

CREATE TABLE ownership_snapshots (
  chain_id bigint NOT NULL,
  contract_address text NOT NULL,
  token_id numeric(78,0) NOT NULL,
  wallet_address text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount >= 0),
  source_block_number bigint NOT NULL,
  source_block_hash text NOT NULL,
  synchronization_watermark text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address, token_id, wallet_address)
);
CREATE INDEX ownership_wallet_idx ON ownership_snapshots (wallet_address, chain_id, updated_at DESC);
CREATE INDEX ownership_asset_idx ON ownership_snapshots (chain_id, contract_address, token_id, amount DESC);

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  from_wallet text,
  to_address text,
  transaction_type text NOT NULL CHECK (transaction_type IN ('LISTING_CREATE', 'LISTING_CANCEL', 'PURCHASE', 'TRANSFER', 'OTHER')),
  status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'MINED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'REPLACED', 'REORGED')),
  block_number bigint,
  block_hash text,
  nonce numeric(78,0),
  value_wei numeric(78,0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  mined_at timestamptz,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, transaction_hash)
);
CREATE INDEX transactions_status_idx ON transactions (chain_id, status, updated_at DESC);

CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  marketplace_contract_id uuid NOT NULL REFERENCES contracts(id),
  listing_id numeric(78,0) NOT NULL,
  seller_wallet text NOT NULL,
  token_contract_id uuid NOT NULL REFERENCES contracts(id),
  token_id numeric(78,0) NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount >= 0),
  remaining_amount numeric(78,0) NOT NULL CHECK (remaining_amount >= 0),
  price_wei numeric(78,0) NOT NULL CHECK (price_wei > 0),
  currency text NOT NULL DEFAULT 'native',
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED', 'REORGED')),
  created_tx_hash text,
  created_block_number bigint,
  created_block_hash text,
  created_log_index integer,
  application_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, marketplace_contract_id, listing_id),
  CHECK (remaining_amount <= amount)
);
CREATE INDEX listings_discovery_idx ON listings (status, expires_at, created_at DESC);
CREATE INDEX listings_asset_idx ON listings (token_contract_id, token_id, status, price_wei);
CREATE INDEX listings_seller_idx ON listings (seller_wallet, status, updated_at DESC);

CREATE TABLE listing_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED', 'REORGED')),
  transaction_hash text,
  block_number bigint,
  block_hash text,
  log_index integer,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, transaction_hash, log_index)
);

CREATE TABLE purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id),
  transaction_id uuid REFERENCES transactions(id),
  chain_id bigint NOT NULL,
  transaction_hash text NOT NULL,
  settlement_log_index integer NOT NULL,
  buyer_wallet text NOT NULL,
  seller_wallet text NOT NULL,
  token_contract_address text NOT NULL,
  token_id numeric(78,0) NOT NULL,
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  sale_price_wei numeric(78,0) NOT NULL CHECK (sale_price_wei > 0),
  platform_fee_wei numeric(78,0) NOT NULL DEFAULT 0,
  royalty_wei numeric(78,0) NOT NULL DEFAULT 0,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'FINALIZED', 'REORGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (chain_id, transaction_hash, settlement_log_index)
);
CREATE INDEX purchases_buyer_idx ON purchases (buyer_wallet, created_at DESC);
CREATE INDEX purchases_listing_idx ON purchases (listing_id, created_at DESC);

CREATE TABLE experience_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id text NOT NULL UNIQUE,
  experience_id text NOT NULL REFERENCES experiences(id),
  wallet_address text NOT NULL,
  media_type text NOT NULL,
  challenge_nonce_hash text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ownership_chain_id bigint,
  ownership_watermark text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (expires_at > issued_at)
);
CREATE INDEX grants_wallet_expiry_idx ON experience_grants (wallet_address, expires_at DESC);

CREATE TABLE redemptions (
  id text PRIMARY KEY,
  experience_id text NOT NULL REFERENCES experiences(id),
  wallet_address text NOT NULL,
  redemption_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('AVAILABLE', 'RESERVED', 'REDEEMED', 'CANCELLED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_at timestamptz,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redemptions_wallet_idx ON redemptions (wallet_address, state, updated_at DESC);
CREATE UNIQUE INDEX redemptions_active_experience_wallet_idx ON redemptions (experience_id, wallet_address) WHERE state IN ('AVAILABLE', 'RESERVED', 'REDEEMED');

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_wallet text,
  subject_type text,
  subject_id text,
  request_id text,
  chain_id bigint,
  transaction_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_subject_idx ON audit_events (subject_type, subject_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_events (actor_wallet, created_at DESC);

CREATE TABLE media_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES experience_grants(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  experience_id text NOT NULL REFERENCES experiences(id),
  media_type text NOT NULL,
  action text NOT NULL CHECK (action IN ('GRANT_ISSUED', 'MEDIA_AUTHORIZED', 'MEDIA_DENIED', 'REVOKED')),
  request_id text,
  ip_hash text,
  user_agent_hash text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_auth_wallet_idx ON media_authorizations (wallet_address, created_at DESC);
CREATE INDEX media_auth_grant_idx ON media_authorizations (grant_id, created_at DESC);

CREATE TABLE auth_nonces (
  nonce_hash text PRIMARY KEY,
  wallet_address text NOT NULL,
  purpose text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_id text,
  UNIQUE (wallet_address, purpose, nonce_hash)
);
CREATE INDEX auth_nonces_expiry_idx ON auth_nonces (expires_at) WHERE consumed_at IS NULL;

COMMIT;
