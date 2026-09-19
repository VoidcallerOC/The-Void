import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate, migrationsDirectory } from "./migrate.js";
import { baselineDatabase, baselineMigrationChecksum, baselineMigrationName, normalizedChecksum, requiredExtensions, stripTransactionControl } from "./baseline.js";
import { validateDatabase } from "./validate-db.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const localMigrations = join(dirname(fileURLToPath(import.meta.url)), "migrations");

describe("baseline inputs", () => {
  it("keeps the pinned baseline checksum in sync with the migration file", async () => {
    const sql = await readFile(join(migrationsDirectory, baselineMigrationName), "utf8");
    expect(normalizedChecksum(sql)).toBe(baselineMigrationChecksum);
    expect(normalizedChecksum(sql.replace(/\r?\n/g, "\r\n"))).toBe(baselineMigrationChecksum);
  });

  it("strips outer transaction control and refuses partial transaction statements", () => {
    expect(stripTransactionControl("BEGIN;\nCREATE TABLE a (id text);\nCOMMIT;")).toBe("CREATE TABLE a (id text);");
    expect(stripTransactionControl("BEGIN;\r\nCREATE TABLE a (id text);\r\nCOMMIT;\r\n")).toBe("CREATE TABLE a (id text);");
    expect(() => stripTransactionControl("BEGIN;\nROLLBACK;")).toThrow(/ROLLBACK/);
  });

  it("collects the extensions a migration requires", async () => {
    expect(requiredExtensions(await readFile(join(migrationsDirectory, baselineMigrationName), "utf8"))).toContain("pgcrypto");
  });
});

describe.skipIf(!testDatabaseUrl)("database recovery paths", () => {
  let adminPool;
  const created = [];

  beforeAll(async () => { adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 }); });

  afterAll(async () => {
    for (const name of created) await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await adminPool.end();
  });

  async function scratchDatabase() {
    const name = `void_baseline_test_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    return { pool, config };
  }

  async function migrationSql(name = baselineMigrationName) { return readFile(join(localMigrations, name), "utf8"); }

  async function appliedMigrationNames(pool) {
    const table = (await pool.query("SELECT to_regclass('public.schema_migrations') AS table")).rows[0].table;
    if (!table) return null;
    return (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((row) => row.name);
  }

  it("applies 001 through 006 on an empty database", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      const result = await migrate({ pool, config });
      expect(result.applied).toHaveLength(12);
      const validation = await validateDatabase({ pool, config });
      expect(validation.ok).toBe(true);
      expect(validation.migrations).toHaveLength(12);
      expect(validation.schema.verifiedTables).toContain("artists");
      expect(validation.schema.exactMatch).toBe(true);
    } finally { await pool.end(); }
  }, 120000);

  it("fails validation when the live schema drifts from migrations 001 through 006", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await migrate({ pool, config });
      await pool.query("ALTER TABLE artists ADD COLUMN legacy_note text");
      await expect(validateDatabase({ pool, config })).rejects.toThrow(/unexpected column: artists.legacy_note/);
    } finally { await pool.end(); }
  }, 120000);

  it("baselines a compatible pre-existing 001 schema and then migrates 002 through 006", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      const baseline = await baselineDatabase({ pool, config, directory: localMigrations });
      expect(baseline).toMatchObject({ baselined: true, reason: "recorded", name: baselineMigrationName });
      expect(await appliedMigrationNames(pool)).toEqual([baselineMigrationName]);
      const migrated = await migrate({ pool, config });
      expect(migrated.applied).toHaveLength(12);
      const validation = await validateDatabase({ pool, config });
      expect(validation.ok).toBe(true);
      expect(validation.migrations.map((item) => item.name)).toHaveLength(12);
    } finally { await pool.end(); }
  }, 120000);

  it("is idempotent when 001 is already recorded", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      await baselineDatabase({ pool, config, directory: localMigrations });
      const second = await baselineDatabase({ pool, config, directory: localMigrations });
      expect(second).toMatchObject({ baselined: false, reason: "already-recorded" });
      expect(await appliedMigrationNames(pool)).toEqual([baselineMigrationName]);
    } finally { await pool.end(); }
  }, 120000);

  it("refuses an existing 001 record with a mismatched checksum", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      await pool.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [baselineMigrationName, "not-the-repository-checksum"]);
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/differs from the repository checksum/);
      expect((await pool.query("SELECT checksum FROM schema_migrations WHERE name = $1", [baselineMigrationName])).rows[0].checksum).toBe("not-the-repository-checksum");
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline a partially created schema and writes no migration record", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      const sql = await migrationSql();
      await pool.query(`${sql.slice(0, sql.indexOf("CREATE TABLE IF NOT EXISTS releases"))}\nCOMMIT;`);
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/missing table: releases/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when a check constraint drifted", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      await pool.query("ALTER TABLE artists DROP CONSTRAINT artists_status_check");
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/missing constraint: artists.artists_status_check/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when an index drifted", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      await pool.query("DROP INDEX releases_discovery_idx");
      await pool.query("CREATE INDEX releases_discovery_idx ON releases (status)");
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/differing index: releases.releases_discovery_idx/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when a column type or nullability drifted", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      await pool.query("ALTER TABLE artists ALTER COLUMN display_name DROP NOT NULL");
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/differing column: artists.display_name/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when an unexpected column exists on a baseline table", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      await pool.query("ALTER TABLE artists ADD COLUMN legacy_note text");
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/unexpected column: artists.legacy_note/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when the migration file checksum changed", async () => {
    const { pool, config } = await scratchDatabase();
    const directory = await mkdtemp(join(tmpdir(), "void-migrations-"));
    try {
      for (const file of await readdir(localMigrations)) await copyFile(join(localMigrations, file), join(directory, file));
      await pool.query(await migrationSql());
      await writeFile(join(directory, baselineMigrationName), `${await migrationSql()}\n-- local edit\n`);
      await expect(baselineDatabase({ pool, config, directory })).rejects.toThrow(/checksum does not match the pinned baseline checksum/);
      expect(await appliedMigrationNames(pool)).toBeNull();
    } finally { await pool.end(); }
  }, 120000);

  it("refuses to baseline when unrelated migration records already exist", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await migrate({ pool, config });
      await pool.query("DELETE FROM schema_migrations WHERE name = $1", [baselineMigrationName]);
      await expect(baselineDatabase({ pool, config, directory: localMigrations })).rejects.toThrow(/not a baselining case/);
      expect(await appliedMigrationNames(pool)).not.toContain(baselineMigrationName);
    } finally { await pool.end(); }
  }, 120000);

  it("reports compatibility without writing anything in check mode", async () => {
    const { pool, config } = await scratchDatabase();
    try {
      await pool.query(await migrationSql());
      const result = await baselineDatabase({ pool, config, directory: localMigrations, dryRun: true });
      expect(result).toMatchObject({ baselined: false, reason: "dry-run" });
      expect(result.report.compatible).toBe(true);
      expect(await appliedMigrationNames(pool)).toBeNull();
      expect((await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'void_baseline_shadow%'")).rowCount).toBe(0);
    } finally { await pool.end(); }
  }, 120000);
});
