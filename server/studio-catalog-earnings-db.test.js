import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres (migrations 001..041): the artist-facing earnings figures in GET /studio/catalog, computed by the
// exact SQL the service runs, over rows inserted the way the indexer writes them. Fixture rows only: nothing here
// reads mainnet. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const CHAIN = 43114;
const FACTORY = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
const MARKETPLACE = "0x0e77116142844478a55eed2ab79de9f93770f8f5";
const PLATFORM = "0xb65c575cae01574296fab6e620b9a15cc0121ce4";
const ARTIST_A = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const ARTIST_B = "0x9999999999999999999999999999999999999999";
const A = { release: "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103", saleOld: "0x6ae84a51f100f10f0535a514555043ae9edf9aa3", saleNew: "0x5555555555555555555555555555555555555555" };
const B = { release: "0x8888888888888888888888888888888888888888", sale: "0x7777777777777777777777777777777777777777" };
const BUYER = "0x6a86efa012feda64b70112022487fee22e67d2fb";
const TOKEN_A = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const TOKEN_B = "42";
const eth = (value) => BigInt(Math.round(Number(value) * 1e18)).toString();
const hash = (label) => `0x${Buffer.from(label.padEnd(32, "-")).toString("hex")}`;

describe.skipIf(!testDatabaseUrl)("Studio catalog earnings (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let ids;
  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const catalogFor = async (wallet) => new ArtistStudioService({ db: pool, repository: {}, authenticator: async () => ({ wallet }) }).listCatalog({ request: { headers: {} } });

  async function contract(address, type) {
    const { rows: out } = await pool.query("INSERT INTO contracts (chain_id, chain_key, address, contract_type) VALUES ($1,'avalanche',$2,$3) RETURNING id", [CHAIN, address, type]);
    return out[0].id;
  }

  async function seedArtist({ artistId, owner, releaseId, release, sale, artistWallet }) {
    await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ($1,$1,$1)", [artistId]);
    await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ($1,$2)", [artistId, owner]);
    await pool.query("INSERT INTO releases (id, artist_id, slug, title, status) VALUES ($1,$2,$1,$1,'PUBLISHED')", [releaseId, artistId]);
    const releaseContract = await contract(release, "ERC1155");
    const factoryContract = ids.factory ?? (ids.factory = await contract(FACTORY, "OTHER"));
    const saleContract = await contract(sale, "OTHER");
    await pool.query("INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, release_key, artist_wallet, implementation_address, implementation_version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,'DEPLOYED')", [releaseId, CHAIN, releaseContract, factoryContract, saleContract, hash(releaseId), artistWallet, "0x8064238e8385093c9ffc8ab10f92a8dc1f2a9006"]);
    return { releaseContract };
  }

  const primary = (sale, release, log, cut, status = "FINALIZED", platformCut = "0") => pool.query(
    "INSERT INTO primary_purchases (chain_id, sale_contract_address, token_contract_address, transaction_hash, log_index, buyer_wallet, token_id, quantity, paid_wei, artist_cut_wei, platform_cut_wei, block_number, block_hash, status) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,100,$11,$12)",
    [CHAIN, sale, release, hash(`p-${sale}-${log}`), log, BUYER, TOKEN_A, (BigInt(cut) + BigInt(platformCut)).toString(), cut, platformCut, hash("blk"), status]);
  const withdrawal = (sale, account, amount, log, status = "FINALIZED") => pool.query(
    "INSERT INTO primary_sale_withdrawals (chain_id, sale_contract_address, transaction_hash, log_index, account_wallet, amount_wei, block_number, block_hash, status) VALUES ($1,$2,$3,$4,$5,$6,110,$7,$8)",
    [CHAIN, sale, hash(`w-${sale}-${account}-${log}`), log, account, amount, hash("blk"), status]);
  let listingSeq = 0;
  async function secondary(releaseContractId, release, tokenId, royalty, status, seller = BUYER) {
    const marketplaceId = ids.marketplace ?? (ids.marketplace = await contract(MARKETPLACE, "MARKETPLACE"));
    listingSeq += 1;
    const { rows: listing } = await pool.query("INSERT INTO listings (chain_id, marketplace_contract_id, listing_id, seller_wallet, token_contract_id, token_id, amount, remaining_amount, price_wei) VALUES ($1,$2,$3,$4,$5,$6,10,10,1000) RETURNING id", [CHAIN, marketplaceId, listingSeq, seller, releaseContractId, tokenId]);
    await pool.query("INSERT INTO purchases (listing_id, chain_id, transaction_hash, settlement_log_index, buyer_wallet, seller_wallet, token_contract_address, token_id, quantity, sale_price_wei, platform_fee_wei, royalty_wei, block_number, block_hash, status) VALUES ($1,$2,$3,0,$4,$5,$6,$7,1,$8,$9,$10,200,$11,$12)",
      [listing[0].id, CHAIN, hash(`s-${listingSeq}`), "0x1212121212121212121212121212121212121212", seller, release, tokenId, (BigInt(royalty) * 40n).toString(), royalty, royalty, hash("blk2"), status]);
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_catalog_earn_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    ids = {};

    // Artist A: the existing release, its legacy sale, and a settled sale attached to the same release.
    const a = await seedArtist({ artistId: "artist-a", owner: ARTIST_A, releaseId: "release-a", release: A.release, sale: A.saleOld, artistWallet: ARTIST_A });
    // Legacy sale: one 0.25 AVAX purchase (allocations only; the platform share is held), plus a failed and a pending row.
    await primary(A.saleOld, A.release, 1, eth(0.24375), "FINALIZED", eth(0.00625));
    await primary(A.saleOld, A.release, 2, eth(5), "FAILED");
    await primary(A.saleOld, A.release, 3, eth(7), "PENDING");
    // Settled sale: two good purchases and a reorged one that must not count.
    await primary(A.saleNew, A.release, 1, eth(0.975), "FINALIZED", eth(0.025));
    await primary(A.saleNew, A.release, 2, eth(0.4875), "CONFIRMED", eth(0.0125));
    await primary(A.saleNew, A.release, 3, eth(9), "REORGED");
    // Withdrawals: the artist's on the legacy sale; the PLATFORM's on the same sale (never artist money);
    // the artist's on the settled sale plus a reorged one that must not count; and another wallet's.
    await withdrawal(A.saleOld, ARTIST_A, eth(0.24375), 0);
    await withdrawal(A.saleOld, PLATFORM, eth(0.00625), 1);
    await withdrawal(A.saleOld, ARTIST_A, eth(0.11), 2, "REORGED");
    await withdrawal(A.saleNew, ARTIST_A, eth(0.5), 0);
    await withdrawal(A.saleNew, ARTIST_A, eth(0.9), 1, "REORGED");
    await withdrawal(A.saleNew, ARTIST_B, eth(0.3), 2);
    // Secondary royalties on A's token: two settled, one reorged, one pending (not settled), one failed.
    await secondary(a.releaseContract, A.release, TOKEN_A, eth(0.025), "FINALIZED");
    await secondary(a.releaseContract, A.release, TOKEN_A, eth(0.0125), "CONFIRMED");
    await secondary(a.releaseContract, A.release, TOKEN_A, eth(1), "REORGED");
    await secondary(a.releaseContract, A.release, TOKEN_A, eth(2), "PENDING");
    await secondary(a.releaseContract, A.release, TOKEN_A, eth(3), "FAILED");

    // Artist B: a different owner with their own release, sale, purchases, withdrawals and royalties.
    const b = await seedArtist({ artistId: "artist-b", owner: ARTIST_B, releaseId: "release-b", release: B.release, sale: B.sale, artistWallet: ARTIST_B });
    await primary(B.sale, B.release, 1, eth(4));
    await withdrawal(B.sale, ARTIST_B, eth(1), 5);
    await secondary(b.releaseContract, B.release, TOKEN_B, eth(8), "FINALIZED");
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("reports earned and withdrawn per sale on the bindings, counting only settled artist money", async () => {
    const catalog = await catalogFor(ARTIST_A);
    expect(catalog.releaseBindings).toHaveLength(1);
    expect(catalog.releaseBindings[0]).toMatchObject({
      release_id: "release-a", chain_id: String(CHAIN), release_contract_address: A.release, primary_sale_address: A.saleOld, factory_address: FACTORY,
      artist_earned_wei: eth(0.24375), // FAILED and PENDING purchases are not earned
      artist_withdrawn_wei: eth(0.24375), // the platform's withdrawal from the same sale is not the artist's
    });
  });

  it("returns one releaseSales row per (release, sale) with no double counting between two sales of one release", async () => {
    const { releaseSales } = await catalogFor(ARTIST_A);
    expect(releaseSales).toEqual([
      { chain_id: String(CHAIN), release_contract_address: A.release, sale_contract_address: A.saleNew, artist_earned_wei: eth(0.975 + 0.4875), artist_withdrawn_wei: eth(0.5), sales: 2 },
      { chain_id: String(CHAIN), release_contract_address: A.release, sale_contract_address: A.saleOld, artist_earned_wei: eth(0.24375), artist_withdrawn_wei: eth(0.24375), sales: 1 },
    ]);
    // Every settled purchase of the release appears in exactly one row.
    const settledPurchases = (await rows("SELECT sale_contract_address, SUM(artist_cut_wei)::text AS cut FROM primary_purchases WHERE token_contract_address=$1 AND status IN ('CONFIRMED','FINALIZED','RECONCILED') GROUP BY 1 ORDER BY 1", [A.release]));
    expect(settledPurchases.map((row) => [row.sale_contract_address, row.cut])).toEqual(releaseSales.map((row) => [row.sale_contract_address, row.artist_earned_wei]));
  });

  it("sums settled secondary royalties per token and excludes reorged, pending and failed sales", async () => {
    const { secondaryRoyalties } = await catalogFor(ARTIST_A);
    expect(secondaryRoyalties).toEqual([{ chain_id: String(CHAIN), token_contract_address: A.release, token_id: TOKEN_A, royalty_wei: eth(0.0375), sales: 2 }]);
  });

  it("never exposes platform fields or platform money in the artist-facing payload", async () => {
    const catalog = await catalogFor(ARTIST_A);
    for (const section of [catalog.releaseBindings, catalog.releaseSales, catalog.secondaryRoyalties]) {
      expect(JSON.stringify(section)).not.toMatch(/platform/i);
      expect(JSON.stringify(section)).not.toContain(PLATFORM);
    }
    expect(Object.keys(catalog.releaseSales[0]).sort()).toEqual(["artist_earned_wei", "artist_withdrawn_wei", "chain_id", "release_contract_address", "sale_contract_address", "sales"]);
  });

  it("never returns another owner's rows, in either direction", async () => {
    const b = await catalogFor(ARTIST_B);
    expect(b.releaseBindings.map((row) => row.release_id)).toEqual(["release-b"]);
    expect(b.releaseSales).toEqual([{ chain_id: String(CHAIN), release_contract_address: B.release, sale_contract_address: B.sale, artist_earned_wei: eth(4), artist_withdrawn_wei: eth(1), sales: 1 }]);
    expect(b.secondaryRoyalties).toEqual([{ chain_id: String(CHAIN), token_contract_address: B.release, token_id: TOKEN_B, royalty_wei: eth(8), sales: 1 }]);
    expect(JSON.stringify(b)).not.toContain(A.release);
    expect(JSON.stringify(await catalogFor(ARTIST_A))).not.toContain(B.release);
    // B's withdrawal from A's settled sale (a stranger's account) is not A's withdrawal.
    expect((await catalogFor(ARTIST_A)).releaseSales.find((row) => row.sale_contract_address === A.saleNew).artist_withdrawn_wei).toBe(eth(0.5));
  });

  it("returns empty earnings for a wallet that owns nothing", async () => {
    const stranger = await catalogFor("0x1212121212121212121212121212121212121212");
    expect(stranger.releaseBindings).toEqual([]);
    expect(stranger.releaseSales).toEqual([]);
    expect(stranger.secondaryRoyalties).toEqual([]);
  });

  it("treats a REORGED withdrawal that is later re-confirmed as counted once, and a reorged purchase as uncounted", async () => {
    await pool.query("UPDATE primary_sale_withdrawals SET status='CONFIRMED' WHERE sale_contract_address=$1 AND log_index=1 AND account_wallet=$2", [A.saleNew, ARTIST_A]);
    expect((await catalogFor(ARTIST_A)).releaseSales.find((row) => row.sale_contract_address === A.saleNew).artist_withdrawn_wei).toBe(eth(1.4));
    await pool.query("UPDATE primary_sale_withdrawals SET status='REORGED' WHERE sale_contract_address=$1 AND log_index=1 AND account_wallet=$2", [A.saleNew, ARTIST_A]);
    expect((await catalogFor(ARTIST_A)).releaseSales.find((row) => row.sale_contract_address === A.saleNew).artist_withdrawn_wei).toBe(eth(0.5));
  });
});
