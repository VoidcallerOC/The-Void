import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const checkSqlPath = join(dirname(fileURLToPath(import.meta.url)), "../scripts/check-rls.sql");

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlStatements(source) {
  return source
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")));
}

async function ensureApiRoles(pool) {
  const existing = new Set((await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).rows.map((row) => row.rolname));
  if (!existing.has("anon")) await pool.query("CREATE ROLE anon NOLOGIN");
  if (!existing.has("authenticated")) await pool.query("CREATE ROLE authenticated NOLOGIN");
}

async function grantSupabaseApiDefaults(pool) {
  await pool.query("GRANT USAGE ON SCHEMA public TO anon, authenticated");
  await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated");
  await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated");
  await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated");
}

async function attemptAs(client, role, sql) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(sql);
    return { denied: false, rowCount: result.rowCount ?? result.rows.length };
  } catch (error) {
    return { denied: true, code: error.code, message: error.message };
  } finally {
    await client.query("ROLLBACK");
  }
}

function ignoreAdminTerminate(error) {
  // DROP DATABASE / pg_terminate_backend emit 57P01 on any still-open
  // pooled client. Swallow it so teardown cannot become an uncaught exception.
  if (!error) return;
  if (error.code === "57P01") return;
  if (String(error.message || "").includes("administrator command")) return;
}

async function closePool(pool) {
  if (!pool) return;
  pool.on("error", ignoreAdminTerminate);
  await pool.end().catch(ignoreAdminTerminate);
}

describe.skipIf(!testDatabaseUrl)("row level security lockdown", () => {
  let adminPool;
  const created = [];
  const scratchPools = [];
  const scratchClients = [];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    adminPool.on("error", ignoreAdminTerminate);
    await ensureApiRoles(adminPool);
  });

  afterAll(async () => {
    // Close every client and pool *before* dropping the scratch database so a
    // 57P01 from WITH (FORCE) / terminate cannot surface as unhandled.
    for (const client of scratchClients) {
      client.on?.("error", ignoreAdminTerminate);
      try { client.release(); } catch { /* already released or terminated */ }
    }
    scratchClients.length = 0;
    for (const pool of scratchPools) await closePool(pool);
    scratchPools.length = 0;
    for (const name of created) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`).catch(ignoreAdminTerminate);
    }
    await closePool(adminPool);
  });

  async function scratchDatabase() {
    const name = `void_rls_test_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE ${quoteIdent(name)}`);
    created.push(name);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    pool.on("error", ignoreAdminTerminate);
    scratchPools.push(pool);
    return { pool, config };
  }

  it("denies anon and authenticated while the table owner keeps full CRUD", async () => {
    const { pool, config } = await scratchDatabase();
    const client = await pool.connect();
    client.on("error", ignoreAdminTerminate);
    scratchClients.push(client);
    try {
      await grantSupabaseApiDefaults(pool);
      await pool.query("CREATE TABLE rls_grant_probe (id integer PRIMARY KEY)");
      const before = await pool.query(`
        SELECT has_table_privilege('anon', 'public.rls_grant_probe', 'SELECT') AS can_select,
               has_table_privilege('anon', 'public.rls_grant_probe', 'INSERT') AS can_insert,
               has_table_privilege('authenticated', 'public.rls_grant_probe', 'UPDATE') AS can_update,
               has_table_privilege('authenticated', 'public.rls_grant_probe', 'DELETE') AS can_delete
      `);
      expect(before.rows[0]).toEqual({ can_select: true, can_insert: true, can_update: true, can_delete: true });

      const migrated = await migrate({ pool, config });
      expect(migrated.applied).toContain("017_rls_lockdown.sql");

      const locked = await pool.query(`
        SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname
      `);
      expect(locked.rows.length).toBeGreaterThan(0);
      expect(locked.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === false)).toBe(true);
      expect(locked.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        "auth_nonces",
        "experience_grants",
        "purchases",
        "audit_events",
        "media_assets",
        "provenance_proofs",
        "chain_blocks",
        "chain_block_observations",
        "artists",
        "schema_migrations",
        "rls_grant_probe",
      ]));

      const privileges = await pool.query(`
        SELECT c.relname AS table_name, r.rolname, p.privilege
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND has_table_privilege(r.rolname, c.oid, p.privilege)
      `);
      expect(privileges.rows).toEqual([]);

      const sequencePrivileges = await pool.query(`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
          AND (
            has_sequence_privilege('anon', c.oid, 'USAGE')
            OR has_sequence_privilege('anon', c.oid, 'SELECT')
            OR has_sequence_privilege('anon', c.oid, 'UPDATE')
            OR has_sequence_privilege('authenticated', c.oid, 'USAGE')
            OR has_sequence_privilege('authenticated', c.oid, 'SELECT')
            OR has_sequence_privilege('authenticated', c.oid, 'UPDATE')
          )
      `);
      expect(sequencePrivileges.rows).toEqual([]);

      const defaults = await pool.query(`
        SELECT d.defaclacl::text AS acl
        FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public'
          AND d.defaclacl::text ~ '(anon|authenticated)='
      `);
      expect(defaults.rows).toEqual([]);

      const policies = await pool.query("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname");
      expect(policies.rows).toEqual([
        { tablename: "artist_profiles", policyname: "artist_profiles_select_active" },
        { tablename: "artists", policyname: "artists_select_active" },
      ]);

      const columns = new Map((await pool.query(`
        SELECT c.relname AS table_name, min(a.attname) AS column_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        GROUP BY c.relname
      `)).rows.map((row) => [row.table_name, row.column_name]));

      for (const role of ["anon", "authenticated"]) {
        for (const row of locked.rows) {
          const table = `public.${quoteIdent(row.table_name)}`;
          const column = quoteIdent(columns.get(row.table_name));
          const select = await attemptAs(client, role, `SELECT * FROM ${table}`);
          if (!(select.denied || select.rowCount === 0)) throw new Error(`${role} SELECT ${row.table_name} returned ${select.rowCount} rows`);
          const insert = await attemptAs(client, role, `INSERT INTO ${table} DEFAULT VALUES`);
          if (!insert.denied) throw new Error(`${role} INSERT ${row.table_name} succeeded`);
          const update = await attemptAs(client, role, `UPDATE ${table} SET ${column} = ${column}`);
          if (!(update.denied || update.rowCount === 0)) throw new Error(`${role} UPDATE ${row.table_name} changed ${update.rowCount} rows`);
          const deleted = await attemptAs(client, role, `DELETE FROM ${table}`);
          if (!(deleted.denied || deleted.rowCount === 0)) throw new Error(`${role} DELETE ${row.table_name} removed ${deleted.rowCount} rows`);
        }
      }

      await client.query("BEGIN");
      await client.query(`
        INSERT INTO artists (id, slug, display_name, status)
        VALUES ('rls-visible', 'rls-visible', 'Visible', 'ACTIVE')
      `);
      await client.query(`
        INSERT INTO auth_nonces (nonce_hash, wallet_address, purpose, issued_at, expires_at, domain, origin, uri, chain_id)
        VALUES ('rls-nonce', '0xd1b4367dd9f235f9ee61878019d66e31511e98ee', 'wallet-auth', now(), now() + interval '10 minutes', 'app.voidcaller.example', 'https://app.voidcaller.example', 'https://app.voidcaller.example', 43113)
      `);
      expect((await client.query("SELECT count(*)::int AS n FROM artists WHERE id = 'rls-visible'")).rows[0].n).toBe(1);
      expect((await client.query("SELECT count(*)::int AS n FROM auth_nonces WHERE nonce_hash = 'rls-nonce'")).rows[0].n).toBe(1);
      await client.query("ROLLBACK");

      const hiddenArtists = await attemptAs(client, "anon", "SELECT id FROM artists");
      expect(hiddenArtists.denied || hiddenArtists.rowCount === 0).toBe(true);
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO artists (id, slug, display_name, status)
        VALUES ('rls-visible', 'rls-visible', 'Visible', 'ACTIVE')
      `);
      await client.query("SET LOCAL ROLE anon");
      let artistLeak = 0;
      try {
        artistLeak = (await client.query("SELECT id FROM artists WHERE status = 'ACTIVE'")).rowCount;
      } catch (error) {
        expect(error.code).toBe("42501");
      }
      expect(artistLeak).toBe(0);
      await client.query("ROLLBACK");

      await pool.query(`
        INSERT INTO auth_nonces (nonce_hash, wallet_address, purpose, issued_at, expires_at, domain, origin, uri, chain_id)
        VALUES ('rls-owner-nonce', '0xd1b4367dd9f235f9ee61878019d66e31511e98ee', 'wallet-auth', now(), now() + interval '10 minutes', 'app.voidcaller.example', 'https://app.voidcaller.example', 'https://app.voidcaller.example', 43113)
      `);
      await pool.query("UPDATE auth_nonces SET purpose = 'wallet-auth' WHERE nonce_hash = 'rls-owner-nonce'");
      expect((await pool.query("SELECT purpose FROM auth_nonces WHERE nonce_hash = 'rls-owner-nonce'")).rows[0].purpose).toBe("wallet-auth");
      expect((await pool.query("DELETE FROM auth_nonces WHERE nonce_hash = 'rls-owner-nonce'")).rowCount).toBe(1);

      const audit = await pool.query("INSERT INTO audit_events (event_type) VALUES ('RLS_OWNER_CHECK') RETURNING id");
      await pool.query("UPDATE audit_events SET subject_type = 'rls' WHERE id = $1", [audit.rows[0].id]);
      expect((await pool.query("DELETE FROM audit_events WHERE id = $1", [audit.rows[0].id])).rowCount).toBe(1);

      await pool.query("INSERT INTO collectors (wallet_address) VALUES ('0xd1b4367dd9f235f9ee61878019d66e31511e98ee')");
      await pool.query("UPDATE collectors SET application_metadata = '{\"ok\":true}'::jsonb WHERE wallet_address = '0xd1b4367dd9f235f9ee61878019d66e31511e98ee'");
      expect((await pool.query("DELETE FROM collectors WHERE wallet_address = '0xd1b4367dd9f235f9ee61878019d66e31511e98ee'")).rowCount).toBe(1);

      const [summary, drift, detail, sequences, defaultAcls] = sqlStatements(await readFile(checkSqlPath, "utf8"));
      const summaryResult = await pool.query(summary);
      expect(Number(summaryResult.rows[0].tables_without_rls)).toBe(0);
      expect(Number(summaryResult.rows[0].tables_with_force_rls)).toBe(0);
      expect(Number(summaryResult.rows[0].tables_with_anon_or_authenticated_grants)).toBe(0);
      expect(summaryResult.rows[0].chain_blocks_exists).toBe(true);
      expect(summaryResult.rows[0].chain_block_observations_exists).toBe(true);
      const driftResult = await pool.query(drift);
      expect(driftResult.rows[0].chain_blocks_exists).toBe(true);
      expect(driftResult.rows[0].chain_block_observations_exists).toBe(true);
      const detailResult = await pool.query(detail);
      expect(detailResult.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === false && row.anon_authenticated_grants === "")).toBe(true);
      expect(Number(detailResult.rows.find((row) => row.table_name === "artists").policy_count)).toBe(1);
      expect((await pool.query(sequences)).rows).toEqual([]);
      expect((await pool.query(defaultAcls)).rows).toEqual([]);
    } finally {
      try { client.release(); } catch { /* already released or terminated */ }
      const idx = scratchClients.indexOf(client);
      if (idx >= 0) scratchClients.splice(idx, 1);
      await closePool(pool);
      const poolIdx = scratchPools.indexOf(pool);
      if (poolIdx >= 0) scratchPools.splice(poolIdx, 1);
    }
  }, 120000);
});
