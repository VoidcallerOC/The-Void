import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { createPersistenceRepository } from "./repositories.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";
import { ArtistStudioService } from "./studio-service.js";
import { lifecycleExpectationsForFactory, readCurrentReleaseEditions, readReleaseLifecycle, releaseTypeChangeBlocker } from "../src/lib/release-lifecycle.js";

// D3, against a real database: Studio's pre-activation read must return every stored token ID of the
// release, even when the owner has more than the 500 editions the owner-wide catalog returns.

const A_WALLET = "0xa11ce00000000000000000000000000000000a11";
const B_WALLET = "0xb0b000000000000000000000000000000000b0b0";
const CHAIN_ID = 43113;
const V4_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const CLONE = "0x00000000000000000000000000000000000c10e1";
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };

describe.skipIf(!testDatabaseUrl)("release-scoped lifecycle editions (database)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;
  let repository;
  let artistA;
  const asWallet = (wallet) => ({ requestId: `req-${wallet.slice(2, 8)}`, headers: { "x-test-wallet": wallet } });

  async function verify(artistId, wallet) {
    const id = `app-${randomBytes(6).toString("hex")}`;
    await pool.query(
      `INSERT INTO artist_verification_applications (id, public_id, wallet_address, artist_id, slug, artist_name, legal_name, email, location, artist_type, artist_bio, work_description, years_active, verification_evidence, status, submitted_at, reviewed_at)
       VALUES ($1,$1,$2,$3,$3,'n','n','e@x.test','l','solo','b','w','1','evidence','VERIFIED',now(),now())`,
      [id, wallet, artistId],
    );
  }

  async function verifiedArtist(name, wallet) {
    const artist = await studio.createArtist({ request: asWallet(wallet), input: { name } });
    await verify(artist.id, wallet);
    return artist;
  }

  const storedTokens = async (releaseId) => (await pool.query("SELECT t.token_id::text AS token_id FROM tokens t JOIN editions e ON e.id=t.edition_id WHERE e.release_id=$1 ORDER BY t.created_at", [releaseId])).rows.map((row) => row.token_id);

  // A Factory V2 (V4 clone) binding, as bindReleaseContract records it; editions need one first.
  let clones = 0;
  async function bindToV4Clone(releaseId, cloneAddress = null) {
    clones += 1;
    const address = cloneAddress || `0x${clones.toString(16).padStart(40, "c")}`;
    const clone = await repository.saveContract({ chainId: CHAIN_ID, chainKey: String(CHAIN_ID), address, contractType: "ERC1155", name: "VoidRelease1155V4" });
    const factory = await repository.saveContract({ chainId: CHAIN_ID, chainKey: String(CHAIN_ID), address: V4_FACTORY, contractType: "OTHER", name: "VoidReleaseFactoryV2" });
    const sale = await repository.saveContract({ chainId: CHAIN_ID, chainKey: String(CHAIN_ID), address: `0x${clones.toString(16).padStart(40, "5")}`, contractType: "OTHER", name: "VoidPrimarySale" });
    await repository.saveReleaseContract({ releaseId, chainId: CHAIN_ID, releaseContractId: clone.id, factoryContractId: factory.id, primarySaleContractId: sale.id, releaseKey: `0x${clones.toString(16).padStart(64, "a")}`, artistWallet: A_WALLET, implementationAddress: "0x45c3FFBb3C0Db3a8C87453d4612c9B3b6392E452", implementationVersion: 2, status: "DEPLOYED" });
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_lifecycle_editions_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    repository = createPersistenceRepository(pool);
    studio = new ArtistStudioService({
      db: pool,
      repository,
      metadataStorage: { write: vi.fn(async ({ name }) => ({ uri: `ipfs://${name}` })) },
      authenticator: async (request) => ({ wallet: request.headers["x-test-wallet"] }),
      logger: quiet,
    });
    artistA = await verifiedArtist("Prolific Artist", A_WALLET);
    await verifiedArtist("Other Artist", B_WALLET);
  });

  afterAll(async () => {
    if (adminPool) await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("returns a release's old edition that the owner's newest-500 catalog leaves out, so activation is refused", async () => {
    const target = await studio.createRelease({ request: asWallet(A_WALLET), artistId: artistA.id, input: { title: "Old Single", releaseType: "EP" } });
    await bindToV4Clone(target.id, CLONE);
    const oldEdition = await studio.createEdition({ request: asWallet(A_WALLET), releaseId: target.id, input: { trackTitle: "Old Single", quantity: "10" } });
    await pool.query("UPDATE editions SET created_at = now() - interval '30 days' WHERE id=$1", [oldEdition.id]);
    // 500 newer editions on another release of the same owner push the old one out of the catalog.
    const busy = await studio.createRelease({ request: asWallet(A_WALLET), artistId: artistA.id, input: { title: "Busy Release", releaseType: "EP" } });
    await pool.query("INSERT INTO editions (id, release_id, title, status) SELECT 'edition-bulk-' || g, $1, 'Bulk ' || g, 'DRAFT' FROM generate_series(1, 500) g", [busy.id]);

    const catalog = await studio.listCatalog({ request: asWallet(A_WALLET) });
    expect(catalog.editions).toHaveLength(500);
    expect(catalog.editions.some((edition) => edition.release_id === target.id)).toBe(false);

    const [oldToken] = await storedTokens(target.id);
    expect(oldToken).toMatch(/^[0-9]+$/);
    const response = await studio.releaseLifecycleEditions({ request: asWallet(A_WALLET), releaseId: target.id });
    expect(response).toMatchObject({ releaseId: target.id, complete: true, tokenIds: [oldToken] });
    expect(response.releaseBindings).toHaveLength(1);

    // The same response through Studio's real parsing and D3 decision, with a chain where the old
    // edition exists: the release is refused as standalone.
    const current = await readCurrentReleaseEditions({ fetchEditions: async () => response, releaseId: target.id, releaseContractAddress: CLONE });
    expect(current).toEqual({ tokenIds: [BigInt(oldToken)], factoryAddress: V4_FACTORY });
    // albumCreated() (no arguments) is false; maxSupplyOf(oldToken) answers, so the edition exists.
    const chain = async ({ params: [{ data }] }) => (data.length === 10 ? `0x${"0".repeat(64)}` : `0x${"0".repeat(63)}a`);
    const lifecycle = await readReleaseLifecycle(chain, CLONE, { tokenIds: current.tokenIds, expect: lifecycleExpectationsForFactory(current.factoryAddress) });
    expect(lifecycle.existingTokenIds).toEqual([BigInt(oldToken)]);
    expect(releaseTypeChangeBlocker({ toType: "ALBUM", lifecycle })).toMatchObject({ code: "STANDALONE_EDITIONS_EXIST" });
  });

  it("returns every stored token of an edition prepared again under a new title", async () => {
    const release = await studio.createRelease({ request: asWallet(A_WALLET), artistId: artistA.id, input: { title: "Draft Release", releaseType: "EP" } });
    await bindToV4Clone(release.id);
    const edition = await studio.createEdition({ request: asWallet(A_WALLET), releaseId: release.id, input: { trackTitle: "First Title", quantity: "10" } });
    const [first] = (await pool.query("SELECT token_id::text AS token_id, contract_id FROM tokens WHERE edition_id=$1", [edition.id])).rows;
    // Prepared again under the new title: a second token row for the same edition.
    await repository.saveToken({ editionId: edition.id, contractId: first.contract_id, tokenId: 987654321n });
    const response = await studio.releaseLifecycleEditions({ request: asWallet(A_WALLET), releaseId: release.id });
    expect([...response.tokenIds].sort()).toEqual([first.token_id, "987654321"].sort());
  });

  it("returns a complete empty result for an owned release with no editions", async () => {
    const release = await studio.createRelease({ request: asWallet(A_WALLET), artistId: artistA.id, input: { title: "Empty Album", releaseType: "ALBUM" } });
    await expect(studio.releaseLifecycleEditions({ request: asWallet(A_WALLET), releaseId: release.id })).resolves.toEqual({ releaseId: release.id, complete: true, tokenIds: [], releaseBindings: [] });
  });

  it("refuses another artist's release and an unknown release", async () => {
    const release = await studio.createRelease({ request: asWallet(A_WALLET), artistId: artistA.id, input: { title: "Private", releaseType: "EP" } });
    await bindToV4Clone(release.id);
    await studio.createEdition({ request: asWallet(A_WALLET), releaseId: release.id, input: { trackTitle: "Private Track", quantity: "1" } });
    await expect(studio.releaseLifecycleEditions({ request: asWallet(B_WALLET), releaseId: release.id })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
    await expect(studio.releaseLifecycleEditions({ request: asWallet(A_WALLET), releaseId: "release-does-not-exist" })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
  });
});
