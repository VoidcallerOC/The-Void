BEGIN;
-- Migrations 034 and 035 added release-contract and provisioning tables after
-- migration 017's deny-by-default sweep. Keep those tables out of the
-- PostgREST surface as well; the Node API uses its table-owning connection.
ALTER TABLE release_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_provisioning_requests ENABLE ROW LEVEL SECURITY;
COMMIT;
