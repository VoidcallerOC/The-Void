import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { createGenesisScanCheckpointStore } from "./genesis-scan-checkpoint-store.js";
import { migrate } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: migration 050 and the Genesis scan checkpoint store (compare-and-set under an advisory
// lock, corrupt-row detection, concurrent writers). Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CLAIM = "0x4444444444444444444444444444444444444444";
const hash = (byte) => `0x${byte.repeat(32)}`;
const LOG = { blockNumber: 15, index: 0, topics: [hash("cc")], data: "0x" };
const checkpoint = (end, byte = "aa", extra = {}) => ({ from: 10, end, endHash: hash(byte), anchors: [], logs: [LOG], ...extra });

describe.skipIf(!testDatabaseUrl)("Genesis scan checkpoint store (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let store;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_genesis_checkpoint_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 6 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    store = createGenesisScanCheckpointStore(pool);
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("creates the table with row level security and no API-role grants", async () => {
    const { rows } = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='genesis_scan_checkpoints'");
    expect(rows).toEqual([{ relrowsecurity: true }]);
    for (const role of (await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows.map((row) => row.rolname)) {
      expect((await pool.query("SELECT has_table_privilege($1, 'public.genesis_scan_checkpoints', 'SELECT') AS allowed", [role])).rows[0]).toEqual({ allowed: false });
    }
  });

  it("inserts, advances by compare-and-set, and refuses a stale writer", async () => {
    await expect(store.load(CLAIM)).resolves.toBeNull();
    await expect(store.save(CLAIM, null, checkpoint(20))).resolves.toBe(true);
    await expect(store.save(CLAIM, null, checkpoint(25))).resolves.toBe(false);
    await expect(store.save(CLAIM, { end: 20, endHash: hash("aa") }, checkpoint(30, "bb", { anchors: [{ block: 20, hash: hash("aa") }] }))).resolves.toBe(true);
    await expect(store.save(CLAIM, { end: 20, endHash: hash("aa") }, checkpoint(40))).resolves.toBe(false);
    await expect(store.load(CLAIM)).resolves.toMatchObject({ from: 10, end: 30, endHash: hash("bb"), anchors: [{ block: 20 }], logs: [LOG] });
  });

  it("two concurrent writers from the same base: exactly one wins", async () => {
    const base = { end: 30, endHash: hash("bb") };
    const results = await Promise.all([store.save(CLAIM, base, checkpoint(50, "dd")), store.save(CLAIM, base, checkpoint(60, "ee"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const loaded = await store.load(CLAIM);
    expect([50, 60]).toContain(loaded.end);
  });

  it("reports a tampered row as corrupt and discards it", async () => {
    await pool.query("UPDATE genesis_scan_checkpoints SET logs='[]'::jsonb WHERE claim_contract=$1", [CLAIM]);
    await expect(store.load(CLAIM)).rejects.toMatchObject({ name: "GenesisCheckpointCorruptError" });
    await expect(store.discard(CLAIM, { corrupt: true })).resolves.toBe(true);
    await expect(store.load(CLAIM)).resolves.toBeNull();
  });
});
