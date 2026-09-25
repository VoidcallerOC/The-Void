BEGIN;

-- Deny-by-default for Supabase PostgREST roles (audit S4).
--
-- The API uses node-postgres as the table owner and bypasses row level
-- security. Row level security is not forced.
--
-- Policies from 013_artist_rls.sql and 014_artist_verification.sql are not
-- dropped or replaced. This migration only enables RLS where it is still
-- off, then revokes anon and authenticated privileges. A policy without a
-- grant cannot be exercised through PostgREST.
--
-- A future public read surface (published experiences, active listings)
-- must be a safe view with an explicit column list, not a table grant to
-- anon or authenticated.

DO $lockdown$
DECLARE
  rec record;
  api_role text;
BEGIN
  FOR rec IN
    SELECT t.schemaname AS schema_name, t.tablename AS table_name
    FROM pg_tables t
    JOIN pg_namespace n ON n.nspname = t.schemaname
    JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = n.oid
    WHERE t.schemaname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', rec.schema_name, rec.table_name);
  END LOOP;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
  END LOOP;
END
$lockdown$;

COMMIT;
