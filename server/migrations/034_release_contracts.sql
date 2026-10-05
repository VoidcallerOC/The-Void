BEGIN;

-- New release-per-contract path. Existing shared ERC-1155 deployments are deliberately
-- not backfilled as independent releases; those records remain legacy/address-scoped.
CREATE TABLE IF NOT EXISTS release_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  chain_id bigint NOT NULL,
  release_contract_id uuid NOT NULL REFERENCES contracts(id),
  factory_contract_id uuid REFERENCES contracts(id),
  primary_sale_contract_id uuid REFERENCES contracts(id),
  provenance_anchor_contract_id uuid REFERENCES contracts(id),
  release_key text NOT NULL,
  artist_wallet text NOT NULL,
  implementation_address text NOT NULL,
  implementation_version smallint NOT NULL CHECK (implementation_version > 0),
  deployment_tx_hash text,
  deployment_block_number bigint,
  creation_log_index integer,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DEPLOYED', 'VERIFIED', 'FAILED', 'LEGACY_SHARED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, chain_id),
  UNIQUE (chain_id, release_contract_id),
  UNIQUE (chain_id, release_key)
);
CREATE INDEX IF NOT EXISTS release_contracts_release_idx ON release_contracts (release_id, status);
CREATE INDEX IF NOT EXISTS release_contracts_chain_status_idx ON release_contracts (chain_id, status);

-- Durable factory-event registry for indexer discovery/restart. It intentionally can
-- precede application linkage: the release key is the bridge to a pending deployment row.
CREATE TABLE IF NOT EXISTS factory_releases (
  chain_id bigint NOT NULL,
  factory_address text NOT NULL,
  release_contract_address text NOT NULL,
  release_key text NOT NULL,
  artist_wallet text NOT NULL,
  primary_sale_address text NOT NULL,
  provenance_anchor_address text NOT NULL,
  implementation_address text NOT NULL,
  factory_index numeric(78,0) NOT NULL,
  implementation_version smallint NOT NULL CHECK (implementation_version > 0),
  deployment_block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, factory_address, release_contract_address),
  UNIQUE (chain_id, factory_address, release_key),
  UNIQUE (chain_id, release_contract_address)
);
CREATE INDEX IF NOT EXISTS factory_releases_factory_idx ON factory_releases (chain_id, factory_address, deployment_block_number ASC);

COMMIT;
