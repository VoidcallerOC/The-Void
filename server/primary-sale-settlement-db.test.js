import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { id } from "ethers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig, primarySaleIndexerConfig, releaseIndexerConfig } from "./config.js";
import { BlockchainIndexer, decodePrimarySaleSettlementLog } from "./indexer.js";
import { IndexerStore } from "./indexer-store.js";
import { migrate } from "./migrate.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres (migrations 001..041). Fixture logs only: nothing here reads mainnet. The addresses are the
// established mainnet identities so the fixtures mirror the activation path: a VoidPrimarySaleSettled that is NOT
// factory-registered, listed as a PRIMARY_SALE for the EXISTING release, and a legacy sale for comparison.
// Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CHAIN = 43114;
const RELEASE = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103";
const LEGACY_SALE = "0x6ae84a51f100f10f0535a514555043ae9edf9aa3";
const SETTLED_SALE = "0x5555555555555555555555555555555555555555";
const ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const PLATFORM = "0xb65c575cae01574296fab6e620b9a15cc0121ce4";
const BUYER = "0x6a86efa012feda64b70112022487fee22e67d2fb";
const BUYER_TWO = "0x7777777777777777777777777777777777777777";
const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN_ID = 25679935302133066722236771263728427871936411831072189551573738559199048803312n;
const PRICE = 250000000000000000n;
const PLATFORM_CUT = 6250000000000000n;
const ARTIST_CUT = PRICE - PLATFORM_CUT;

const TOPICS = {
  TransferSingle: id("TransferSingle(address,address,address,uint256,uint256)"),
  Purchased: id("Purchased(uint256,address,uint256,uint256,uint256,uint256)"),
  PlatformPaid: id("PlatformPaid(address,uint256)"),
  Withdrawn: id("Withdrawn(address,uint256)"),
};
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addrTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const hashOf = (label) => `0x${Buffer.from(label.padEnd(32, "-")).toString("hex")}`;
const blockOf = (number, label = `b${number}`) => ({ number, hash: hashOf(label), parentHash: hashOf(`b${number - 1}`), timestamp: 1_792_488_000 + number });
const logBase = (block, tx, logIndex) => ({ blockNumber: block.number, blockHash: block.hash, transactionHash: hashOf(tx), logIndex, transactionIndex: 1, removed: false });
const mintLog = (block, { sale, tx = "tx-purchase", logIndex = 1, to = BUYER } = {}) => ({ ...logBase(block, tx, logIndex), address: RELEASE, topics: [TOPICS.TransferSingle, addrTopic(sale), addrTopic(ZERO), addrTopic(to)], data: `0x${word(TOKEN_ID)}${word(1)}` });
const platformPaidLog = (block, { sale = SETTLED_SALE, tx = "tx-purchase", logIndex = 2, recipient = PLATFORM, amount = PLATFORM_CUT, address = sale } = {}) => ({ ...logBase(block, tx, logIndex), address, topics: [TOPICS.PlatformPaid, addrTopic(recipient)], data: `0x${word(amount)}` });
const purchasedLog = (block, { sale = SETTLED_SALE, tx = "tx-purchase", logIndex = 3, buyer = BUYER } = {}) => ({ ...logBase(block, tx, logIndex), address: sale, topics: [TOPICS.Purchased, `0x${word(TOKEN_ID)}`, addrTopic(buyer)], data: `0x${word(1)}${word(PRICE)}${word(ARTIST_CUT)}${word(PLATFORM_CUT)}` });
const withdrawnLog = (block, { sale = SETTLED_SALE, tx = "tx-withdraw", logIndex = 0, account = ARTIST, amount = ARTIST_CUT } = {}) => ({ ...logBase(block, tx, logIndex), address: sale, topics: [TOPICS.Withdrawn, addrTopic(account)], data: `0x${word(amount)}` });

describe("settlement topics and decoder (no database)", () => {
  const eventTopics = { PlatformPaid: TOPICS.PlatformPaid, Withdrawn: TOPICS.Withdrawn };
  const block = blockOf(100);
  const decode = (log, saleAddress = SETTLED_SALE) => decodePrimarySaleSettlementLog(log, { chainId: CHAIN, saleAddress, eventTopics });

  it("decodes PlatformPaid and Withdrawn with the indexed wallet and the amount", () => {
    expect(decode(platformPaidLog(block))).toMatchObject({ eventType: "PlatformPaid", saleAddress: SETTLED_SALE, recipientWallet: PLATFORM, amountWei: PLATFORM_CUT.toString(), blockNumber: 100, logIndex: 2 });
    expect(decode(withdrawnLog(block))).toMatchObject({ eventType: "Withdrawn", saleAddress: SETTLED_SALE, accountWallet: ARTIST, amountWei: ARTIST_CUT.toString() });
  });

  it("ignores every other topic and rejects malformed or foreign logs", () => {
    expect(decode(purchasedLog(block))).toBeNull();
    expect(() => decode(withdrawnLog(block, { amount: 0n }))).toThrow(/positive/);
    expect(() => decode({ ...platformPaidLog(block), data: `0x${word(1)}${word(1)}` })).toThrow(/one amount word/);
    expect(() => decode({ ...platformPaidLog(block), topics: [TOPICS.PlatformPaid] })).toThrow(/one indexed address/);
    expect(() => decode(platformPaidLog(block, { address: "0x6666666666666666666666666666666666666666" }))).toThrow(/configured sale/);
  });
});

describe("settlement dispatch for both sale contract types (store double)", () => {
  for (const contractType of ["PRIMARY_SALE", "PRIMARY_SALE_V2"]) {
    it(`${contractType} routes PlatformPaid and Withdrawn to the settlement store, not to Purchased decoding`, async () => {
      const applied = [];
      const events = [];
      const store = { recordEvent: async (event) => { events.push(event); return event; }, recordIndexerError: async () => {}, applyPrimarySaleSettlement: async (event) => { applied.push(event); return { duplicate: false }; }, applyPrimaryPurchase: async () => { throw new Error("Purchased path must not run for settlement logs"); } };
      const config = contractType === "PRIMARY_SALE"
        ? primarySaleIndexerConfig({ chainId: CHAIN, address: SETTLED_SALE, startBlock: 0, tokenAddress: RELEASE })
        : { chainId: CHAIN, address: SETTLED_SALE, contractType, startBlock: 0, tokenAddress: null, eventTopics: { Purchased: "0x01", PlatformPaid: TOPICS.PlatformPaid, Withdrawn: TOPICS.Withdrawn } };
      const dispatcher = new BlockchainIndexer({ rpc: {}, store, configs: [config], logger: { info() {}, error() {}, warn() {} } });
      const block = blockOf(100);
      await dispatcher.processLog(config, platformPaidLog(block), block);
      await dispatcher.processLog(config, withdrawnLog(block), block);
      expect(events.map((event) => event.eventType)).toEqual(["PlatformPaid", "Withdrawn"]);
      expect(applied.map((event) => [event.eventType, event.saleAddress])).toEqual([["PlatformPaid", SETTLED_SALE], ["Withdrawn", SETTLED_SALE]]);
    });
  }
});

describe.skipIf(!testDatabaseUrl)("primary-sale settlement ledger (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let store;
  let indexer;
  const releaseConfig = () => releaseIndexerConfig({ chainId: CHAIN, address: RELEASE, startBlock: 0, factoryAddress: "0x262b774cf9a1949170b58e2d57f6189980fe757b", skipMintOperators: [SETTLED_SALE, LEGACY_SALE] });
  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const feed = async (config, log, block) => { await store.recordBlock({ chainId: CHAIN, blockNumber: block.number, blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp }); return indexer.processLog(config, log, block); };
  let release;
  let settledSale;
  let legacySale;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_sale_settle_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    store = new IndexerStore(pool);
    release = releaseConfig();
    settledSale = primarySaleIndexerConfig({ chainId: CHAIN, address: SETTLED_SALE, startBlock: 0, tokenAddress: RELEASE });
    legacySale = primarySaleIndexerConfig({ chainId: CHAIN, address: LEGACY_SALE, startBlock: 0, tokenAddress: RELEASE });
    indexer = new BlockchainIndexer({ rpc: {}, store, configs: [release, settledSale, legacySale], logger: { info() {}, error() {}, warn() {} } });
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("creates both settlement tables with row level security and no API-role grants", async () => {
    const tables = await rows("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('primary_sale_platform_transfers','primary_sale_withdrawals') ORDER BY relname");
    expect(tables).toEqual([{ relname: "primary_sale_platform_transfers", relrowsecurity: true }, { relname: "primary_sale_withdrawals", relrowsecurity: true }]);
    for (const table of ["primary_sale_platform_transfers", "primary_sale_withdrawals"]) {
      for (const role of ["anon", "authenticated"]) expect((await rows("SELECT has_table_privilege($1, $2, 'SELECT') AS allowed", [role, `public.${table}`]))[0]).toEqual({ allowed: false });
    }
  });

  it("indexes a settled-sale purchase for the existing release: purchase, mint, platform transfer, with ownership credited once", async () => {
    const block = blockOf(100);
    await feed(release, mintLog(block, { sale: SETTLED_SALE }), block);
    await feed(settledSale, platformPaidLog(block), block);
    await feed(settledSale, purchasedLog(block), block);

    const purchase = (await rows("SELECT * FROM primary_purchases WHERE sale_contract_address=$1", [SETTLED_SALE]))[0];
    expect(purchase).toMatchObject({ token_contract_address: RELEASE, buyer_wallet: BUYER, status: "CONFIRMED", block_number: "100" });
    expect(BigInt(purchase.paid_wei)).toBe(PRICE);
    expect(BigInt(purchase.artist_cut_wei)).toBe(ARTIST_CUT);
    expect(BigInt(purchase.platform_cut_wei)).toBe(PLATFORM_CUT); // an ALLOCATION
    const transfer = (await rows("SELECT * FROM primary_sale_platform_transfers"))[0];
    expect(transfer).toMatchObject({ sale_contract_address: SETTLED_SALE, recipient_wallet: PLATFORM, status: "CONFIRMED", block_number: "100" });
    expect(BigInt(transfer.amount_wei)).toBe(PLATFORM_CUT); // evidence of an actual push
    // The mint is recorded as a transfer but the sale is a known mint operator, so ownership comes only from Purchased.
    expect((await rows("SELECT event_type FROM transfers WHERE transaction_hash=$1", [hashOf("tx-purchase")]))).toEqual([{ event_type: "MINT" }]);
    expect(await rows("SELECT amount::text AS amount FROM ownership_snapshots WHERE wallet_address=$1 AND contract_address=$2", [BUYER, RELEASE])).toEqual([{ amount: "1" }]);
  });

  it("a replay of the same logs changes nothing", async () => {
    const block = blockOf(100);
    const before = { purchases: await rows("SELECT count(*)::int AS n FROM primary_purchases"), transfers: await rows("SELECT count(*)::int AS n FROM primary_sale_platform_transfers"), owned: await rows("SELECT amount::text AS amount FROM ownership_snapshots WHERE wallet_address=$1", [BUYER]) };
    const again = await feed(settledSale, platformPaidLog(block), block);
    expect(again).toMatchObject({ duplicate: true, eventType: "PlatformPaid", projectionApplied: false });
    await feed(release, mintLog(block, { sale: SETTLED_SALE }), block);
    await feed(settledSale, purchasedLog(block), block);
    expect({ purchases: await rows("SELECT count(*)::int AS n FROM primary_purchases"), transfers: await rows("SELECT count(*)::int AS n FROM primary_sale_platform_transfers"), owned: await rows("SELECT amount::text AS amount FROM ownership_snapshots WHERE wallet_address=$1", [BUYER]) }).toEqual(before);
  });

  it("a legacy-sale purchase records the allocation but NO platform transfer", async () => {
    const block = blockOf(101);
    await feed(release, mintLog(block, { sale: LEGACY_SALE, tx: "tx-legacy", to: BUYER_TWO }), block);
    await feed(legacySale, purchasedLog(block, { sale: LEGACY_SALE, tx: "tx-legacy", logIndex: 3, buyer: BUYER_TWO }), block);
    expect(BigInt((await rows("SELECT platform_cut_wei FROM primary_purchases WHERE sale_contract_address=$1", [LEGACY_SALE]))[0].platform_cut_wei)).toBe(PLATFORM_CUT);
    expect(await rows("SELECT 1 FROM primary_sale_platform_transfers WHERE sale_contract_address=$1", [LEGACY_SALE])).toEqual([]);
  });

  it("indexes withdrawals on either sale as separate evidence and never mixes them with purchases", async () => {
    const block = blockOf(105);
    await feed(settledSale, withdrawnLog(block), block);
    await feed(legacySale, withdrawnLog(block, { sale: LEGACY_SALE, tx: "tx-legacy-withdraw", account: PLATFORM, amount: PLATFORM_CUT }), block);
    const rowsOut = await rows("SELECT sale_contract_address, account_wallet, amount_wei::text AS amount_wei, status FROM primary_sale_withdrawals ORDER BY sale_contract_address");
    expect(rowsOut).toEqual([
      { sale_contract_address: SETTLED_SALE, account_wallet: ARTIST, amount_wei: ARTIST_CUT.toString(), status: "CONFIRMED" },
      { sale_contract_address: LEGACY_SALE, account_wallet: PLATFORM, amount_wei: PLATFORM_CUT.toString(), status: "CONFIRMED" },
    ]);
    expect(Number((await rows("SELECT count(*)::int AS n FROM primary_purchases"))[0].n)).toBe(2);
  });

  it("promotes only canonical, sufficiently old rows to FINALIZED, idempotently", async () => {
    expect(await store.finalizePrimarySaleSettlements({ chainId: CHAIN, saleAddress: SETTLED_SALE, finalizedBlock: 102 })).toEqual({ finalized: 1 });
    expect(await rows("SELECT status FROM primary_sale_withdrawals WHERE sale_contract_address=$1", [SETTLED_SALE])).toEqual([{ status: "CONFIRMED" }]);
    expect(await store.finalizePrimarySaleSettlements({ chainId: CHAIN, saleAddress: SETTLED_SALE, finalizedBlock: 110 })).toEqual({ finalized: 1 });
    expect(await store.finalizePrimarySaleSettlements({ chainId: CHAIN, saleAddress: SETTLED_SALE, finalizedBlock: 110 })).toEqual({ finalized: 0 });
    expect((await rows("SELECT status, finalized_at IS NOT NULL AS stamped FROM primary_sale_platform_transfers"))[0]).toEqual({ status: "FINALIZED", stamped: true });
  });

  it("a reorg marks rows at or above the fork REORGED, keeps older ones, and a re-index re-confirms at the new block without duplicating", async () => {
    await store.handleReorg({ chainId: CHAIN, fromBlock: 105, replacementHash: hashOf("replacement-105") });
    expect(await rows("SELECT sale_contract_address, status FROM primary_sale_withdrawals ORDER BY sale_contract_address")).toEqual([
      { sale_contract_address: SETTLED_SALE, status: "REORGED" },
      { sale_contract_address: LEGACY_SALE, status: "REORGED" },
    ]);
    expect((await rows("SELECT status FROM primary_sale_platform_transfers"))[0]).toEqual({ status: "FINALIZED" });
    const replacement = { ...blockOf(106, "replacement-106") };
    await feed(settledSale, withdrawnLog(replacement), replacement);
    const row = await rows("SELECT status, block_number::text AS block_number, block_hash, finalized_at FROM primary_sale_withdrawals WHERE sale_contract_address=$1", [SETTLED_SALE]);
    expect(row).toEqual([{ status: "CONFIRMED", block_number: "106", block_hash: hashOf("replacement-106"), finalized_at: null }]);
  });

  it("a rebuild replays settlement events from canonical events only, and the re-index re-applies the rest", async () => {
    await store.rebuildDerivedState({ chainId: CHAIN });
    // The platform transfer (block 100) is canonical and is replayed. The withdrawals' original events were
    // reorged out of block 105 (blockchain_events keeps its first row for a tx/log, so it stays non-canonical),
    // hence nothing counts until the rewound checkpoint re-indexes them, exactly as for purchases.
    expect(Number((await rows("SELECT count(*)::int AS n FROM primary_sale_platform_transfers"))[0].n)).toBe(1);
    expect(await rows("SELECT 1 FROM primary_sale_withdrawals")).toEqual([]);
    const replacement = blockOf(106, "replacement-106");
    await feed(settledSale, withdrawnLog(replacement), replacement);
    expect(await rows("SELECT sale_contract_address, status, block_number::text AS block_number FROM primary_sale_withdrawals")).toEqual([{ sale_contract_address: SETTLED_SALE, status: "CONFIRMED", block_number: "106" }]);
  });

  it("records malformed settlement logs as MALFORMED events without touching the ledger", async () => {
    const block = blockOf(120);
    const before = Number((await rows("SELECT count(*)::int AS n FROM primary_sale_withdrawals"))[0].n);
    const zero = await feed(settledSale, withdrawnLog(block, { tx: "tx-zero", amount: 0n }), block);
    const foreign = await feed(settledSale, platformPaidLog(block, { tx: "tx-foreign", logIndex: 4, address: "0x6666666666666666666666666666666666666666" }), block);
    expect(zero).toMatchObject({ malformed: true });
    expect(foreign).toMatchObject({ malformed: true });
    expect(Number((await rows("SELECT count(*)::int AS n FROM primary_sale_withdrawals"))[0].n)).toBe(before);
    expect((await rows("SELECT count(*)::int AS n FROM indexer_errors WHERE error_type='MALFORMED_PRIMARY_SALE_EVENT'"))[0].n).toBeGreaterThanOrEqual(2);
  });
});
