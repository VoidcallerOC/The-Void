import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { createIndexerStore } from "./indexer-store.js";
import { migrate } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: the indexer registers every factory release on start. A release the artist abandoned
// (ARCHIVED, and its contract has no transfer, purchase or owner) must not be tracked, but a retired release
// that still has a holder must stay tracked, because the holder's protected media depends on that ownership.
// Skipped without TEST_DATABASE_URL. Nothing here reads or writes production.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CHAIN = 43114;
const FACTORY = "0xe744d58fa8138042f5f00a28d39f89081539c19b";
const hex = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const key = (n) => `0x${n.toString(16).padStart(64, "0")}`;

// [name, release status or null (no release row), activity]
const CASES = [
  ["abandoned", "ARCHIVED", null],
  ["archived with a transfer", "ARCHIVED", "transfer"],
  ["archived with a purchase", "ARCHIVED", "purchase"],
  ["archived with an owner", "ARCHIVED", "owner"],
  ["live draft", "DRAFT", null],
  ["published", "PUBLISHED", null],
  ["no release row", null, null],
];

describe.skipIf(!testDatabaseUrl)("Indexer does not track abandoned releases (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let tracked;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_abandoned_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('a','a','A')");
    for (const [index, [, status, activity]] of CASES.entries()) {
      const n = index + 1;
      const clone = hex(n);
      await pool.query(
        "INSERT INTO factory_releases (chain_id, factory_address, release_contract_address, release_key, artist_wallet, primary_sale_address, provenance_anchor_address, implementation_address, factory_index, implementation_version, deployment_block_number, transaction_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,$10,$11)",
        [CHAIN, FACTORY, clone, key(n), hex(900), hex(100 + n), clone, hex(800), index, 1000 + n, key(5000 + n)]);
      if (status) await pool.query("INSERT INTO releases (id, artist_id, slug, title, status, release_metadata) VALUES ($1,'a',$1,'T',$2,$3)", [`release-${n}`, status, JSON.stringify({ releaseKey: key(n) })]);
      if (activity === "transfer") await pool.query("INSERT INTO transfers (chain_id, contract_address, token_id, from_wallet, to_wallet, amount, transaction_hash, block_number, block_hash, log_index, event_type, block_timestamp) VALUES ($1,$2,1,$3,$4,1,$5,1,$6,0,'MINT',now())", [CHAIN, clone, hex(0), hex(901), key(7000 + n), key(8000 + n)]);
      if (activity === "purchase") await pool.query("INSERT INTO primary_purchases (chain_id, sale_contract_address, token_contract_address, transaction_hash, log_index, buyer_wallet, token_id, quantity, paid_wei, artist_cut_wei, platform_cut_wei, block_number, block_hash) VALUES ($1,$2,$3,$4,0,$5,1,1,10,9,1,1,$6)", [CHAIN, hex(100 + n), clone, key(7000 + n), hex(901), key(8000 + n)]);
      if (activity === "owner") await pool.query("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,1,$3,1,1,$4,'FINALIZED')", [CHAIN, clone, hex(901), key(8000 + n)]);
    }
    tracked = (await createIndexerStore(pool).listFactoryReleases({ chainId: CHAIN, factoryAddress: FACTORY })).map((row) => row.release_contract_address);
  });

  afterAll(async () => { await dropScratchDatabase(adminPool, dbName, { pool }); await adminPool?.end(); });

  it("skips only the abandoned release (archived with no transfer, purchase or owner)", () => {
    expect(tracked).not.toContain(hex(1));
  });

  it("keeps a retired release that still has a transfer, a purchase or an owner", () => {
    for (const n of [2, 3, 4]) expect(tracked).toContain(hex(n));
  });

  it("keeps live, published and unknown releases", () => {
    for (const n of [5, 6, 7]) expect(tracked).toContain(hex(n));
  });

  it("still returns the kept releases oldest first with their sale and deployment block", async () => {
    const rows = await createIndexerStore(pool).listFactoryReleases({ chainId: CHAIN, factoryAddress: FACTORY });
    expect(rows.map((row) => Number(row.deployment_block_number))).toEqual([1002, 1003, 1004, 1005, 1006, 1007]);
    expect(rows[0].primary_sale_address).toBe(hex(102));
  });
});
