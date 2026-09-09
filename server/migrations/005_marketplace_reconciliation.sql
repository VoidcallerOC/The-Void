BEGIN;

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN ('PENDING', 'ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED', 'INVALID', 'REORGED'));
ALTER TABLE listing_status_history DROP CONSTRAINT IF EXISTS listing_status_history_status_check;
ALTER TABLE listing_status_history ADD CONSTRAINT listing_status_history_status_check CHECK (status IN ('PENDING', 'ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED', 'INVALID', 'REORGED'));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('PENDING', 'SUBMITTED', 'MINED', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'FAILED', 'REPLACED', 'REORGED'));
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status IN ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'FAILED', 'REORGED'));

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
CREATE INDEX IF NOT EXISTS purchases_reconciliation_idx ON purchases (chain_id, status, reconciled_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS marketplace_event_projections (
  chain_id bigint NOT NULL,
  marketplace_address text NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  listing_id numeric(78,0) NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ListingCreated', 'ListingCancelled', 'ListingExpired', 'ListingSold')),
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, marketplace_address, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS marketplace_event_projections_listing_idx
  ON marketplace_event_projections (chain_id, marketplace_address, listing_id, projected_at DESC);

COMMIT;
