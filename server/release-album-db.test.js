import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Interface } from "ethers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiService } from "./api-service.js";
import { loadServerConfig, releaseIndexerConfig } from "./config.js";
import { BlockchainIndexer } from "./indexer.js";
import { createIndexerStore } from "./indexer-store.js";
import { migrate } from "./migrate.js";
import { createPersistenceRepository } from "./repositories.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: VoidRelease1155V4 album logs flow through the unmodified indexer and
// store into migration 037's tables, survive a fresh connection, reach the public
// edition API, and are rewound by handleReorg. Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };
const CHAIN_ID = 43113;
const RELEASE = `0x${"a1".repeat(20)}`;
const FACTORY = `0x${"fa".repeat(20)}`;
const ARTIST_WALLET = `0x${"a3".repeat(20)}`;
const IMPLEMENTATION = `0x${"1a".repeat(20)}`;
const KEY = `0x${"aa".repeat(32)}`;
const MINT_END = "1900000000";

const source = readFileSync(join(import.meta.dirname, "..", "contracts", "VoidRelease1155V4.sol"), "utf8");
const iface = new Interface(["AlbumCreated", "AlbumTrackCreated", "AlbumClosed", "ExpandedReleaseApproved"].map((name) => `event ${name}(${source.match(new RegExp(`event ${name}\\(([^)]*)\\);`))[1]})`));
const blockHash = (number) => `0x${number.toString(16).padStart(64, "0")}`;
const block = (number) => ({ number, hash: blockHash(number), parentHash: blockHash(number - 1), timestamp: 1_700_000_000 + number });
let txCounter = 0;
function albumLog(name, args, blockNumber, logIndex) {
  const encoded = iface.encodeEventLog(name, args);
  txCounter += 1;
  return { address: RELEASE, topics: encoded.topics, data: encoded.data, transactionHash: `0x${txCounter.toString(16).padStart(64, "0")}`, blockNumber, blockHash: blockHash(blockNumber), logIndex };
}

describe.skipIf(!testDatabaseUrl)("album track events persisted from chain (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let url;
  const config = releaseIndexerConfig({ chainId: CHAIN_ID, address: RELEASE, startBlock: 1, factoryAddress: FACTORY });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_album_events_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });

    const repository = createPersistenceRepository(pool);
    await repository.saveArtist({ id: "artist-album", slug: "album-artist", displayName: "Album Artist", metadata: {} });
    await repository.saveRelease({ id: "release-album", artistId: "artist-album", slug: "album", title: "Album", status: "PUBLISHED", metadata: {}, publishedAt: new Date() });
    const contract = await repository.saveContract({ chainId: CHAIN_ID, chainKey: "fuji", address: RELEASE, contractType: "ERC1155", name: "VoidRelease1155V4", metadata: {} });
    await repository.saveReleaseContract({ releaseId: "release-album", chainId: CHAIN_ID, releaseContractId: contract.id, releaseKey: KEY, artistWallet: ARTIST_WALLET, implementationAddress: IMPLEMENTATION, implementationVersion: 1, status: "DEPLOYED" });
    for (const [id, tokenId] of [["edition-single", "5"], ["edition-track", "6"], ["edition-plain", "7"]]) {
      await repository.saveEdition({ id, releaseId: "release-album", contractId: contract.id, title: id, supply: "25", status: "PUBLISHED", metadata: {} });
      await repository.saveToken({ editionId: id, contractId: contract.id, tokenId, metadataUri: `ipfs://${id}` });
    }
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("creates both album tables with row level security and no API-role grants", async () => {
    const { rows } = await pool.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('release_albums','release_album_tracks') ORDER BY relname");
    expect(rows).toEqual([{ relname: "release_album_tracks", relrowsecurity: true }, { relname: "release_albums", relrowsecurity: true }]);
    const roles = (await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows.map((row) => row.rolname);
    for (const role of roles) {
      const grant = await pool.query("SELECT has_table_privilege($1, 'public.release_album_tracks', 'SELECT') AS tracks, has_table_privilege($1, 'public.release_albums', 'SELECT') AS albums", [role]);
      expect(grant.rows[0]).toEqual({ tracks: false, albums: false });
    }
  });

  it("indexes album logs idempotently and serves isAlbumSingle/mintEnd after a fresh connection", async () => {
    const indexer = new BlockchainIndexer({ rpc: {}, store: createIndexerStore(pool), configs: [config], logger: quiet });
    const logs = [
      albumLog("AlbumCreated", [KEY], 5, 0),
      albumLog("ExpandedReleaseApproved", [20n, 6n], 5, 1),
      albumLog("AlbumTrackCreated", [5n, true, BigInt(MINT_END)], 5, 2),
      albumLog("AlbumTrackCreated", [6n, false, 0n], 5, 3),
    ];
    for (const log of logs) await indexer.processLog(config, log, block(5));
    for (const log of logs) await indexer.processLog(config, log, block(5));

    const tracks = await pool.query("SELECT token_id::text, is_single, mint_end::text, block_number::int FROM release_album_tracks WHERE chain_id=$1 AND contract_address=$2 ORDER BY token_id", [CHAIN_ID, RELEASE]);
    expect(tracks.rows).toEqual([{ token_id: "5", is_single: true, mint_end: MINT_END, block_number: 5 }, { token_id: "6", is_single: false, mint_end: "0", block_number: 5 }]);
    const events = await pool.query("SELECT event_type FROM blockchain_events WHERE contract_address=$1 ORDER BY log_index", [RELEASE]);
    expect(events.rows.map((row) => row.event_type)).toEqual(["AlbumCreated", "ExpandedReleaseApproved", "AlbumTrackCreated", "AlbumTrackCreated"]);

    // A new pool stands in for an API restart: nothing is held in memory.
    const reloaded = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 2 });
    try {
      const api = new ApiService({ db: reloaded, repository: createPersistenceRepository(reloaded), logger: quiet });
      await expect(api.getEdition({ id: "edition-single" })).resolves.toMatchObject({ token_id: "5", isAlbumSingle: true, mintEnd: MINT_END, albumClosed: false });
      await expect(api.getEdition({ id: "edition-track" })).resolves.toMatchObject({ token_id: "6", isAlbumSingle: false, mintEnd: "0", albumClosed: false });
      const plain = await api.getEdition({ id: "edition-plain" });
      expect(plain).toMatchObject({ token_id: "7" });
      expect(plain).not.toHaveProperty("isAlbumSingle");
      expect(plain).not.toHaveProperty("mintEnd");
      const listed = await api.listEditions({ releaseId: "release-album" });
      expect(Object.fromEntries(listed.map((row) => [row.id, row.isAlbumSingle]))).toEqual({ "edition-single": true, "edition-track": false, "edition-plain": undefined });
    } finally {
      await reloaded.end();
    }
  });

  it("rewinds album state at or above a reorg block and lets re-indexing restore it", async () => {
    const store = createIndexerStore(pool);
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [config], logger: quiet });
    const late = [
      albumLog("ExpandedReleaseApproved", [24n, 8n], 9, 0),
      albumLog("AlbumTrackCreated", [9n, true, 0n], 9, 1),
      albumLog("AlbumClosed", [KEY], 9, 2),
    ];
    for (const log of late) await indexer.processLog(config, log, block(9));
    const album = async () => (await pool.query("SELECT release_key, created_block_number::int AS created, closed_block_number::int AS closed, expanded_max_tracks::text AS max_tracks, expanded_max_singles::text AS max_singles, expanded_block_number::int AS expanded FROM release_albums WHERE chain_id=$1 AND contract_address=$2", [CHAIN_ID, RELEASE])).rows[0];
    const trackIds = async () => (await pool.query("SELECT token_id::text FROM release_album_tracks WHERE chain_id=$1 ORDER BY token_id", [CHAIN_ID])).rows.map((row) => row.token_id);
    expect(await album()).toEqual({ release_key: KEY, created: 5, closed: 9, max_tracks: "24", max_singles: "8", expanded: 9 });
    expect(await trackIds()).toEqual(["5", "6", "9"]);

    await store.handleReorg({ chainId: CHAIN_ID, fromBlock: 9, replacementHash: blockHash(9) });
    expect(await album()).toEqual({ release_key: KEY, created: 5, closed: null, max_tracks: "20", max_singles: "6", expanded: 5 });
    expect(await trackIds()).toEqual(["5", "6"]);

    // The rewound checkpoint re-processes the canonical replacement logs.
    for (const log of late) await indexer.processLog(config, log, block(9));
    expect(await album()).toMatchObject({ closed: 9, max_tracks: "24", expanded: 9 });
    expect(await trackIds()).toEqual(["5", "6", "9"]);

    await store.handleReorg({ chainId: CHAIN_ID, fromBlock: 5, replacementHash: blockHash(5) });
    expect(await album()).toBeUndefined();
    expect(await trackIds()).toEqual([]);
    const api = new ApiService({ db: pool, repository: createPersistenceRepository(pool), logger: quiet });
    expect(await api.getEdition({ id: "edition-single" })).not.toHaveProperty("isAlbumSingle");
  });
});
