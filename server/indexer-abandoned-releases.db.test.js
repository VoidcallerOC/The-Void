import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadIndexerConfig, loadServerConfig } from "./config.js";
import { BlockchainIndexer } from "./indexer.js";
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
const hex = (n) => `0x${"cd".repeat(18)}${n.toString(16).padStart(4, "0")}`;
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

  // ---- Startup, restart, explicit configuration, health and integrity ----
  const MARKETPLACE = hex(700);
  const UNRELATED_COLLECTION = hex(950);
  const count = async (table) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const TABLES = ["releases", "factory_releases", "contracts", "transfers", "primary_purchases", "ownership_snapshots", "blockchain_events", "indexer_checkpoints"];
  const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await count(table)])));
  // Explicit INDEXER_CONTRACTS_JSON entries for an abandoned clone and its sale, a kept clone, and an unrelated collection.
  const explicitConfigs = () => loadIndexerConfig({
    INDEXER_RPC_URL: "https://rpc.example",
    INDEXER_CHAIN_ID: String(CHAIN),
    INDEXER_INCLUDE_RELEASE_MANIFEST: "false",
    INDEXER_CONTRACTS_JSON: JSON.stringify([
      { address: FACTORY, contractType: "RELEASE_FACTORY", startBlock: 1 },
      { address: MARKETPLACE, contractType: "MARKETPLACE", startBlock: 1 },
      { address: hex(1), contractType: "ERC1155", startBlock: 1 },
      { address: hex(2), contractType: "ERC1155", startBlock: 1 },
      { address: UNRELATED_COLLECTION, contractType: "ERC1155", startBlock: 1 },
    ]),
  }).contracts;
  const startIndexer = async () => {
    const indexer = new BlockchainIndexer({ rpc: {}, store: createIndexerStore(pool), configs: [...explicitConfigs()], logger: { info() {}, warn() {}, error() {} } });
    await indexer.loadRegisteredReleases();
    return indexer;
  };
  const addresses = (indexer) => indexer.configs.map((item) => item.address.toLowerCase());

  it("registers the live release's clone and sale at startup (forgive-forget-6 stays indexed)", async () => {
    const indexer = await startIndexer();
    expect(addresses(indexer)).toContain(hex(5));
    expect(addresses(indexer)).toContain(hex(105));
  });

  it("never registers an abandoned release, from factory discovery or explicit configuration, and not after a restart", async () => {
    for (let restart = 0; restart < 3; restart += 1) {
      const indexer = await startIndexer();
      expect(addresses(indexer)).not.toContain(hex(1));
      expect(addresses(indexer)).not.toContain(hex(101));
      expect(indexer.addRelease({ chainId: CHAIN, address: hex(1), startBlock: 1, factoryAddress: FACTORY })).toBe(false);
      expect(indexer.addPrimarySale({ chainId: CHAIN, address: hex(101), startBlock: 1, tokenAddress: hex(1) })).toBe(false);
    }
  });

  it("does not touch factories, marketplaces, retired releases with holders, or unrelated collections", async () => {
    const tracked = addresses(await startIndexer());
    for (const kept of [FACTORY, MARKETPLACE, UNRELATED_COLLECTION, hex(2), hex(3), hex(4), hex(6), hex(7)]) expect(tracked).toContain(kept.toLowerCase());
  });

  it("is idempotent and read-only: nothing is deleted or changed, so history and foreign keys stay intact", async () => {
    const before = await snapshot();
    await startIndexer();
    await startIndexer();
    expect(await snapshot()).toEqual(before);
    const orphans = (await pool.query("SELECT count(*) AS n FROM release_contracts rc LEFT JOIN releases r ON r.id=rc.release_id WHERE r.id IS NULL")).rows[0].n;
    expect(Number(orphans)).toBe(0);
  });

  it("leaves ownership records of existing holders exactly as they were", async () => {
    const owners = async () => (await pool.query("SELECT lower(contract_address) AS c, wallet_address, amount::text FROM ownership_snapshots ORDER BY 1,2")).rows;
    const before = await owners();
    await startIndexer();
    expect(await owners()).toEqual(before);
    expect(before.map((row) => row.c)).toContain(hex(4));
  });

  it("keeps the frozen checkpoints of abandoned contracts out of the health lag", async () => {
    const store = createIndexerStore(pool);
    const checkpoint = (address, contractType, last) => store.setCheckpoint({ chainId: CHAIN, address, contractType, nextBlock: last + 1, lastProcessedBlock: last, finalizedBlock: last, latestKnownBlock: 5000, status: "IDLE" });
    await checkpoint(hex(1), "ERC1155", 100);
    await checkpoint(hex(101), "PRIMARY_SALE", 100);
    await checkpoint(hex(5), "ERC1155", 4990);
    const [health] = await store.getIndexerHealth({ chainId: CHAIN });
    expect(Number(health.indexer_lag)).toBe(10);
    expect(health.contracts.map((item) => item.address)).not.toContain(hex(1));
  });
});
