BEGIN;

-- Genesis claim ledger (server/genesis-claim-ledger.js): one row per wallet that was issued a claim
-- voucher. The row records the C-Chain block and the Genesis balances (IDs 0-3) read at issuance;
-- those units count as used and the used count follows them through later transfers. EXPIRED rows
-- (voucher never redeemed before its deadline) no longer use any units.
CREATE TABLE IF NOT EXISTS genesis_claim_reservations (
  claim_contract text NOT NULL CHECK (claim_contract ~ '^0x[0-9a-f]{40}$'),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  eligibility_block bigint NOT NULL CHECK (eligibility_block > 0),
  balances jsonb NOT NULL,
  deadline bigint NOT NULL CHECK (deadline > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'REDEEMED', 'EXPIRED')),
  voucher jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_contract, wallet)
);

-- Keep the table out of the PostgREST surface (see 017, 036, 037 and 038).
ALTER TABLE genesis_claim_reservations ENABLE ROW LEVEL SECURITY;

COMMIT;
