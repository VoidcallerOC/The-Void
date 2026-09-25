BEGIN;

CREATE TABLE IF NOT EXISTS primary_sale_projections (
  chain_id bigint NOT NULL,
  sale_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  token_id numeric(78,0) NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sale_address, transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS primary_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  sale_contract_address text NOT NULL,
  token_contract_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  buyer_wallet text NOT NULL,
  token_id numeric(78,0) NOT NULL,
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  paid_wei numeric(78,0) NOT NULL CHECK (paid_wei > 0),
  artist_cut_wei numeric(78,0) NOT NULL CHECK (artist_cut_wei >= 0),
  platform_cut_wei numeric(78,0) NOT NULL CHECK (platform_cut_wei >= 0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'FAILED', 'REORGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  reconciled_at timestamptz,
  UNIQUE (chain_id, transaction_hash, log_index),
  CHECK (artist_cut_wei + platform_cut_wei = paid_wei)
);

CREATE INDEX IF NOT EXISTS primary_purchases_buyer_idx ON primary_purchases (buyer_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS primary_purchases_token_idx ON primary_purchases (chain_id, token_contract_address, token_id);

COMMIT;
