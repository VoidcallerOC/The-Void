-- Read-only RLS and grant audit for the public schema.
-- Paste into the Supabase SQL editor before and after migration 017.
-- This script does not insert, update, delete, grant, revoke, or alter anything.
--
-- After 017, expect:
--   tables_without_rls = 0
--   tables_with_force_rls = 0
--   tables_with_anon_or_authenticated_grants = 0
--   no sequence grants and no default privileges for anon or authenticated
-- chain_blocks is reported only. Do not drop or rename it from this script.

SELECT
  count(*) FILTER (WHERE NOT relrowsecurity) AS tables_without_rls,
  count(*) FILTER (WHERE relforcerowsecurity) AS tables_with_force_rls,
  count(*) FILTER (WHERE anon_authenticated_grants <> '') AS tables_with_anon_or_authenticated_grants,
  bool_or(chain_blocks_exists) AS chain_blocks_exists,
  bool_or(chain_block_observations_exists) AS chain_block_observations_exists
FROM (
  SELECT
    c.relrowsecurity,
    c.relforcerowsecurity,
    COALESCE((
      SELECT string_agg(priv.grantee || ' ' || priv.privilege_type, ', ' ORDER BY priv.grantee, priv.privilege_type)
      FROM information_schema.role_table_grants priv
      WHERE priv.table_schema = n.nspname
        AND priv.table_name = c.relname
        AND priv.grantee IN ('anon', 'authenticated')
    ), '') AS anon_authenticated_grants,
    to_regclass('public.chain_blocks') IS NOT NULL AS chain_blocks_exists,
    to_regclass('public.chain_block_observations') IS NOT NULL AS chain_block_observations_exists
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
) audit;

SELECT
  to_regclass('public.chain_blocks') IS NOT NULL AS chain_blocks_exists,
  to_regclass('public.chain_block_observations') IS NOT NULL AS chain_block_observations_exists,
  CASE
    WHEN to_regclass('public.chain_blocks') IS NOT NULL
     AND to_regclass('public.chain_block_observations') IS NOT NULL
      THEN 'both tables exist; 017 does not drop or rename chain_blocks'
    WHEN to_regclass('public.chain_blocks') IS NOT NULL
      THEN 'chain_blocks exists and chain_block_observations does not'
    WHEN to_regclass('public.chain_block_observations') IS NOT NULL
      THEN 'chain_block_observations exists and chain_blocks does not'
    ELSE 'neither chain_blocks nor chain_block_observations exists'
  END AS schema_drift_note;

SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity,
  c.relforcerowsecurity,
  (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
  COALESCE((
    SELECT string_agg(DISTINCT pol.polname, ', ' ORDER BY pol.polname)
    FROM pg_policy pol
    WHERE pol.polrelid = c.oid
  ), '') AS policy_names,
  COALESCE((
    SELECT string_agg(priv.grantee || ' ' || priv.privilege_type, ', ' ORDER BY priv.grantee, priv.privilege_type)
    FROM information_schema.role_table_grants priv
    WHERE priv.table_schema = n.nspname
      AND priv.table_name = c.relname
      AND priv.grantee IN ('anon', 'authenticated')
  ), '') AS anon_authenticated_grants
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

SELECT
  n.nspname AS schema_name,
  c.relname AS sequence_name,
  r.rolname AS grantee,
  acl.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL aclexplode(c.relacl) AS acl ON true
JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY c.relname, r.rolname, acl.privilege_type;

SELECT
  pg_get_userbyid(d.defaclrole) AS grantor,
  n.nspname AS schema_name,
  d.defaclobjtype AS object_type,
  d.defaclacl::text AS default_acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
  AND d.defaclacl::text ~ '(anon|authenticated)=';
