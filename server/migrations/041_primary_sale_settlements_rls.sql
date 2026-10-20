BEGIN;
-- Migration 040 added the settlement tables after migration 017's deny-by-default sweep. Keep them out
-- of the PostgREST surface; the Node API uses its table-owning connection.
ALTER TABLE primary_sale_platform_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE primary_sale_withdrawals ENABLE ROW LEVEL SECURITY;
COMMIT;
