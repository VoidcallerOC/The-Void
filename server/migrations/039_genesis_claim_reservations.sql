BEGIN;

-- Genesis claim ledger (server/genesis-claim-ledger.js): one row per wallet that was issued a claim
-- voucher. Off-chain eligibility accounting only; Genesis tokens are never moved, burned or locked.
-- The row records the C-Chain block of issuance and the one Genesis unit (used_token_id) the claim
-- uses; that used unit follows later transfers. balances is the wallet's Genesis holding at issuance,
-- kept for audit. EXPIRED rows (voucher never redeemed before its deadline) use no unit.
CREATE TABLE IF NOT EXISTS genesis_claim_reservations (
  claim_contract text NOT NULL CHECK (claim_contract ~ '^0x[0-9a-f]{40}$'),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  eligibility_block bigint NOT NULL CHECK (eligibility_block > 0),
  used_token_id text NOT NULL CHECK (used_token_id IN ('0', '1', '2', '3')),
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
