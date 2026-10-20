BEGIN;

-- Real settlement evidence for VoidPrimarySale / VoidPrimarySaleSettled, kept apart from the
-- allocations in primary_purchases (artist_cut_wei / platform_cut_wei are allocations, never transfers).
--
-- primary_sale_platform_transfers: PlatformPaid(recipient, amount), emitted by VoidPrimarySaleSettled
-- when it pushes the platform share to the recipient inside the purchase transaction. The legacy
-- VoidPrimarySale never emits it, so a legacy platform share has no row here.
CREATE TABLE IF NOT EXISTS primary_sale_platform_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  sale_contract_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  recipient_wallet text NOT NULL,
  amount_wei numeric(78,0) NOT NULL CHECK (amount_wei > 0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'FINALIZED', 'REORGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS primary_sale_platform_transfers_sale_idx ON primary_sale_platform_transfers (chain_id, sale_contract_address);

-- primary_sale_withdrawals: Withdrawn(account, amount), emitted by withdraw() on either sale
-- implementation after the sale has sent the account's whole balance.
CREATE TABLE IF NOT EXISTS primary_sale_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  sale_contract_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  account_wallet text NOT NULL,
  amount_wei numeric(78,0) NOT NULL CHECK (amount_wei > 0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'FINALIZED', 'REORGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS primary_sale_withdrawals_sale_idx ON primary_sale_withdrawals (chain_id, sale_contract_address, account_wallet);

COMMIT;
