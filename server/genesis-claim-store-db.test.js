import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { createGenesisClaimReservationStore } from "./genesis-claim-store.js";
import { migrate } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: migration 039 and the Genesis claim reservation store (advisory-lock serialization,
// upsert, status settlement, rollback). Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CLAIM = "0x4444444444444444444444444444444444444444";
const OTHER_CLAIM = "0x5555555555555555555555555555555555555555";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x6666666666666666666666666666666666666666";
const record = (wallet, block, status = "PENDING") => ({
  claimContract: CLAIM, wallet, block, balances: { 0: "4", 1: "2", 2: "0", 3: "21" }, deadline: 1_800_000_300n, status,
  voucher: { claimant: wallet, nonce: "1" }, signature: `0x${"ab".repeat(65)}`,
});

describe.skipIf(!testDatabaseUrl)("Genesis claim reservation store (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let store;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_genesis_ledger_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    store = createGenesisClaimReservationStore(pool);
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("creates the table with row level security and no API-role grants", async () => {
    const { rows } = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='genesis_claim_reservations'");
    expect(rows).toEqual([{ relrowsecurity: true }]);
    for (const role of (await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows.map((row) => row.rolname)) {
      expect((await pool.query("SELECT has_table_privilege($1, 'public.genesis_claim_reservations', 'SELECT') AS allowed", [role])).rows[0]).toEqual({ allowed: false });
    }
  });

  it("stores, replaces and settles one reservation per wallet, scoped to the claim contract", async () => {
    await store.withLock(CLAIM, (tx) => tx.upsert(record(A, 100)));
    await store.withLock(CLAIM, (tx) => tx.upsert({ ...record(A, 120), status: "PENDING" }));
    await store.withLock(CLAIM, (tx) => tx.setStatus(A, "REDEEMED"));
    const listed = await store.withLock(CLAIM, (tx) => tx.list());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ wallet: A, block: 120, status: "REDEEMED", balances: { 3: "21" }, deadline: 1_800_000_300n });
    await expect(store.withLock(OTHER_CLAIM, (tx) => tx.list())).resolves.toEqual([]);
  });

  it("rolls back everything written inside a failed issuance", async () => {
    await expect(store.withLock(CLAIM, async (tx) => { await tx.upsert(record(B, 130)); throw new Error("signing failed"); })).rejects.toThrow("signing failed");
    const wallets = (await store.withLock(CLAIM, (tx) => tx.list())).map((row) => row.wallet);
    expect(wallets).not.toContain(B);
  });

  it("serializes issuance across connections: the second waits until the first commits and then sees it", async () => {
    let releaseFirst;
    const held = new Promise((resolve) => { releaseFirst = resolve; });
    let firstInside;
    const entered = new Promise((resolve) => { firstInside = resolve; });
    const order = [];
    const first = store.withLock(CLAIM, async (tx) => {
      firstInside();
      await held;
      await tx.upsert(record(B, 140));
      order.push("first-commit");
    });
    await entered;
    const second = store.withLock(CLAIM, async (tx) => {
      order.push("second-start");
      return (await tx.list()).map((row) => row.wallet);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    releaseFirst();
    await first;
    await expect(second).resolves.toContain(B);
    expect(order).toEqual(["first-commit", "second-start"]);
  });

  it("rejects malformed rows", async () => {
    await expect(store.withLock(CLAIM, (tx) => tx.upsert({ ...record(A, 150), status: "UNKNOWN" }))).rejects.toMatchObject({ code: "23514" });
  });
});
