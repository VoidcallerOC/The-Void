import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiService } from "./api-service.js";
import { loadServerConfig } from "./config.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { migrate, migrationBody, migrationsDirectory } from "./migrate.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { createPersistenceRepository } from "./repositories.js";
import { LEGACY_ALBUM_ID, LEGACY_CHAIN_ID, LEGACY_CONTRACT, LEGACY_EDITION_ID, LEGACY_TOKENS, legacyExperienceId } from "../src/lib/legacy-genesis.js";

const SEED = "019_seed_voidcaller_legacy.sql";
const OWNER_WALLET = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const HOLDER = "0x1111111111111111111111111111111111111111";
const NON_HOLDER = "0x2222222222222222222222222222222222222222";
const verifierConfig = { authAllowedChainIds: [43113], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 };
const mediaConfig = { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" };
const quiet = { info() {}, error() {}, warn() {} };
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";

async function seedSql() { return readFile(join(migrationsDirectory, SEED), "utf8"); }

// Holds token 1 only. Anything else reads a zero balance.
function fakeMainnetClient() {
  return { balanceOf: vi.fn(async ({ wallet, tokenId }) => (wallet === HOLDER && String(tokenId) === "1" ? 1n : 0n)) };
}

describe("019 legacy catalog seed (static checks)", () => {
  it("is a data-only, idempotent seed that matches the legacy-genesis constants", async () => {
    const sql = await seedSql();
    const body = migrationBody(sql, SEED).replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+/i);
    const inserts = body.match(/\bINSERT\s+INTO\b/gi) || [];
    expect(inserts.length).toBeGreaterThanOrEqual(8);
    expect((body.match(/\bON\s+CONFLICT\b/gi) || []).length).toBe(inserts.length);
    expect(body).toContain(`'${LEGACY_CONTRACT}'`);
    expect(body).toContain(String(LEGACY_CHAIN_ID));
    expect(body).toContain(`'${LEGACY_ALBUM_ID}'`);
    expect(body).toContain(`'${LEGACY_EDITION_ID}'`);
    expect(body).toContain("'voidcaller-legacy-track-' || t.token_id");
    expect(body).toContain(`'${OWNER_WALLET}'`);
  });

  it("references only public preview audio and never a master path, storage key, or CID", async () => {
    const sql = await seedSql();
    const audio = sql.match(/[^"'\s]+\.(?:mp3|wav|flac|m4a|aiff?)/gi) || [];
    expect(audio.length).toBeGreaterThan(0);
    for (const path of audio) expect(path.startsWith("/assets/audio-preview/")).toBe(true);
    for (const track of LEGACY_TOKENS) expect(sql).toContain(track.previewSrc);
    expect(sql).not.toMatch(/private-media|storageKey|storage_key|assetId|ipfs:\/\/|\bbaf[a-z2-7]{20,}|\bQm[1-9A-HJ-NP-Za-km-z]{44,}/);
    expect(sql).not.toMatch(/indexer_checkpoints|listings|primary_sale/i);
  });
});

describe("experience grants use persisted requirements", () => {
  it("passes the stored legacy requirement to the verifier and 404s unknown experiences", async () => {
    const requirement = { type: "erc1155-balance", contract: LEGACY_CONTRACT, tokenIds: ["1"], minAmount: "1", chainId: LEGACY_CHAIN_ID };
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: legacyExperienceId(1), requirements: [requirement], media_config: { protected: true, protectedMedia: [] } }] }) };
    const ownershipVerifier = vi.fn().mockResolvedValue({ owns: false, state: "UNAUTHORIZED" });
    const service = new ApiService({ db, repository: { createGrant: vi.fn() }, authenticator: async () => ({ wallet: NON_HOLDER }), ownershipVerifier, logger: quiet });
    await expect(service.issueExperienceGrant({ request: {}, input: { wallet: NON_HOLDER, experienceId: "missing", mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "EXPERIENCE_NOT_FOUND", status: 404 });
    expect(ownershipVerifier).not.toHaveBeenCalled();
    await expect(service.issueExperienceGrant({ request: {}, input: { wallet: NON_HOLDER, experienceId: legacyExperienceId(1), mediaType: "AUDIO" } })).resolves.toMatchObject({ grant: null });
    expect(ownershipVerifier).toHaveBeenCalledWith(expect.objectContaining({ experienceId: legacyExperienceId(1), requirements: [requirement] }));
  });
});

describe.skipIf(!testDatabaseUrl)("019 legacy catalog seed (database)", () => {
  let adminPool;
  const created = [];
  const pools = [];

  beforeAll(async () => { adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 }); });

  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => {});
    for (const name of created) await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await adminPool.end();
  });

  async function scratchDatabase() {
    const name = `void_seed_test_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${name}"`);
    created.push(name);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    const config = loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" });
    const pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    pools.push(pool);
    return { pool, config };
  }

  async function snapshot(pool) {
    const q = async (sql) => (await pool.query(sql)).rows;
    return {
      artists: await q("SELECT id, slug, display_name, status, application_metadata FROM artists ORDER BY id"),
      profiles: await q("SELECT artist_id, bio, website_url, social_links, profile_metadata FROM artist_profiles ORDER BY artist_id"),
      owners: await q("SELECT artist_id, owner_wallet, role FROM artist_owners ORDER BY artist_id, owner_wallet"),
      contracts: await q("SELECT id, chain_id, chain_key, address, contract_type, name, verified_source_url, metadata FROM contracts ORDER BY chain_id, address"),
      releases: await q("SELECT id, artist_id, slug, title, description, status, release_metadata, published_at FROM releases ORDER BY id"),
      editions: await q("SELECT id, release_id, contract_id, title, tier, description, supply, status, application_metadata FROM editions ORDER BY id"),
      tokens: await q("SELECT id, edition_id, contract_id, token_id, metadata_uri, metadata FROM tokens ORDER BY token_id"),
      experiences: await q("SELECT id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status FROM experiences ORDER BY id"),
    };
  }

  it("seeds the legacy catalog once and yields identical rows when migrations and the seed body run again", async () => {
    const { pool, config } = await scratchDatabase();
    const first = await migrate({ pool, config });
    expect(first.applied).toContain(SEED);
    const before = await snapshot(pool);

    expect(before.artists).toEqual([expect.objectContaining({ id: "voidcaller", slug: "voidcaller", status: "ACTIVE" })]);
    expect(before.owners).toEqual([{ artist_id: "voidcaller", owner_wallet: OWNER_WALLET, role: "OWNER" }]);
    expect(before.contracts).toEqual([expect.objectContaining({ chain_id: String(LEGACY_CHAIN_ID), address: LEGACY_CONTRACT, contract_type: "ERC1155" })]);
    expect(before.releases).toEqual([expect.objectContaining({ id: LEGACY_ALBUM_ID, artist_id: "voidcaller", status: "PUBLISHED" })]);
    expect(before.editions).toEqual([expect.objectContaining({ id: LEGACY_EDITION_ID, release_id: LEGACY_ALBUM_ID, contract_id: before.contracts[0].id, status: "PUBLISHED" })]);
    expect(before.tokens.map((row) => row.token_id)).toEqual(["0", "1", "2", "3"]);
    expect(before.experiences.map((row) => row.id)).toEqual(LEGACY_TOKENS.map((track) => legacyExperienceId(track.tokenId)));
    for (const row of before.experiences) {
      const tokenId = row.id.split("-").pop();
      expect(row.status).toBe("PUBLISHED");
      expect(row.requirements).toEqual([{ type: "erc1155-balance", contract: LEGACY_CONTRACT, tokenIds: [tokenId], minAmount: "1", chainId: LEGACY_CHAIN_ID }]);
      expect(row.media_config).toEqual({ protected: true, protectedMedia: [] });
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM indexer_checkpoints WHERE chain_id=$1", [LEGACY_CHAIN_ID])).rows[0].n).toBe(0);

    const second = await migrate({ pool, config });
    expect(second.applied).toEqual(first.applied);
    expect(await snapshot(pool)).toEqual(before);

    // Re-apply the seed body itself, as a re-run on an already-seeded database would.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationBody(await seedSql(), SEED));
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await snapshot(pool)).toEqual(before);
  }, 120000);

  it("moves a hidden Studio alias off the 'voidcaller' slug instead of failing the deploy", async () => {
    const { pool, config } = await scratchDatabase();
    const directory = await mkdtemp(join(tmpdir(), "void-seed-migrations-"));
    try {
      for (const file of await readdir(migrationsDirectory)) if (file < SEED) await copyFile(join(migrationsDirectory, file), join(directory, file));
      await migrate({ pool, config, directory });
      await pool.query("INSERT INTO artists (id, slug, display_name) VALUES ('artist-studio-1', 'voidcaller', 'Voidcaller'), ('artist-studio-2', 'voidcaller-2', 'Voidcaller')");
      await pool.query("INSERT INTO artist_owners (artist_id, owner_wallet) VALUES ('artist-studio-1', $1)", [OWNER_WALLET]);
      const result = await migrate({ pool, config });
      expect(result.applied).toContain(SEED);
      const rows = (await pool.query("SELECT id, slug FROM artists ORDER BY id")).rows;
      expect(rows).toEqual([{ id: "artist-studio-1", slug: "voidcaller-3" }, { id: "artist-studio-2", slug: "voidcaller-2" }, { id: "voidcaller", slug: "voidcaller" }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM experiences WHERE artist_id='voidcaller'")).rows[0].n).toBe(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);

  it("serves the seeded rows from the public catalog without leaking requirements or media config", async () => {
    const { pool, config } = await scratchDatabase();
    await migrate({ pool, config });
    const service = new ApiService({ db: pool, repository: createPersistenceRepository(pool), logger: quiet });

    const artists = await service.listArtists({});
    expect(artists.map((row) => row.id)).toEqual(["voidcaller"]);
    expect(artists[0].verified).toBe(false);
    await pool.query("INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message) VALUES ('claim-1', 'voidcaller', $1, $2, $3, '0xsig', 'claim')", [OWNER_WALLET, LEGACY_CONTRACT, LEGACY_CHAIN_ID]);
    expect((await service.getArtist({ idOrSlug: "voidcaller" })).verified).toBe(true);

    const releases = await service.listReleases({});
    expect(releases).toEqual([expect.objectContaining({ id: LEGACY_ALBUM_ID, artist_slug: "voidcaller", status: "PUBLISHED" })]);
    expect(releases[0].release_metadata.tracks.map((track) => track.previewSrc)).toEqual(expect.arrayContaining(LEGACY_TOKENS.map((track) => track.previewSrc)));

    const editions = await service.listEditions({});
    expect(editions).toEqual([expect.objectContaining({ id: LEGACY_EDITION_ID, chain_id: String(LEGACY_CHAIN_ID), contract_address: LEGACY_CONTRACT, status: "PUBLISHED" })]);
    expect(editions[0].application_metadata).toMatchObject({ legacy: true, primarySale: false, tokenIds: ["0", "1", "2", "3"] });

    const experiences = await service.listExperiences({});
    expect(experiences.map((row) => row.id).sort()).toEqual(LEGACY_TOKENS.map((track) => legacyExperienceId(track.tokenId)).sort());
    for (const row of experiences) {
      expect(row).toMatchObject({ gated: true, protected: true, status: "PUBLISHED" });
      expect(row.requirements).toBeUndefined();
      expect(row.media_config).toBeUndefined();
    }
    const encoded = JSON.stringify({ artists, releases, editions, experiences });
    expect(encoded).not.toMatch(/protectedMedia|storageKey|storage_key|requirements|media_config/);
    expect(await service.listListings({})).toEqual([]);
  }, 120000);

  it("routes a seeded legacy experience to the mainnet balanceOf path and denies non-holders", async () => {
    const { pool, config } = await scratchDatabase();
    await migrate({ pool, config });
    const repository = createPersistenceRepository(pool);
    const experienceId = legacyExperienceId(1);
    const storage = { open: vi.fn() };
    const gatewayFor = (wallet, mainnetClient) => new ProtectedMediaGateway({
      db: pool,
      repository,
      authenticator: async () => ({ wallet }),
      ownershipVerifier: (input) => new IndexedOwnershipVerifier({ db: pool, config: verifierConfig, mainnetClient }).verify(input),
      storage,
      mediaConfig,
    });

    // As seeded, no protected object is attached yet, so nothing can be served.
    const seededClient = fakeMainnetClient();
    await expect(gatewayFor(HOLDER, seededClient).issueGrant({ request: {}, input: { wallet: HOLDER, experienceId, mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED", status: 503 });
    expect(seededClient.balanceOf).not.toHaveBeenCalled();

    // Simulate the owner attaching a Studio-uploaded asset later.
    await repository.saveMediaAsset({ id: "asset-legacy-test", artistId: "voidcaller", storageKey: "test/legacy-track-1-object", mediaType: "AUDIO" });
    await pool.query("UPDATE experiences SET media_config=$2 WHERE id=$1", [experienceId, { protected: true, protectedMedia: [{ assetId: "asset-legacy-test", mediaType: "AUDIO" }] }]);

    const denied = fakeMainnetClient();
    await expect(gatewayFor(NON_HOLDER, denied).issueGrant({ request: {}, input: { wallet: NON_HOLDER, experienceId, mediaType: "AUDIO" } })).rejects.toMatchObject({ status: 401 });
    expect(denied.balanceOf).toHaveBeenCalledWith({ wallet: NON_HOLDER, tokenId: "1" });
    expect((await pool.query("SELECT count(*)::int AS n FROM experience_grants")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='MEDIA_ACCESS_DENIED' AND subject_id=$1", [experienceId])).rows[0].n).toBe(1);

    const allowed = fakeMainnetClient();
    const querySpy = vi.spyOn(pool, "query");
    const grant = await gatewayFor(HOLDER, allowed).issueGrant({ request: {}, input: { wallet: HOLDER, experienceId, mediaType: "AUDIO" } });
    expect(grant.state).toBe("CONFIRMED");
    expect(allowed.balanceOf).toHaveBeenCalledWith({ wallet: HOLDER, tokenId: "1" });
    expect(querySpy.mock.calls.some(([sql]) => /indexer_checkpoints|ownership_snapshots/.test(String(sql)))).toBe(false);
    querySpy.mockRestore();
    const stored = (await pool.query("SELECT ownership_chain_id, ownership_watermark FROM experience_grants WHERE grant_id=$1", [grant.grantId])).rows[0];
    expect(stored).toEqual({ ownership_chain_id: String(LEGACY_CHAIN_ID), ownership_watermark: "43114:legacy:43114:1:live" });

    // Holding token 1 does not unlock token 2's experience.
    await pool.query("UPDATE experiences SET media_config=$2 WHERE id=$1", [legacyExperienceId(2), { protected: true, protectedMedia: [{ assetId: "asset-legacy-test", mediaType: "AUDIO" }] }]);
    await expect(gatewayFor(HOLDER, fakeMainnetClient()).issueGrant({ request: {}, input: { wallet: HOLDER, experienceId: legacyExperienceId(2), mediaType: "AUDIO" } })).rejects.toMatchObject({ status: 401 });

    // The generic experience-grant endpoint now applies the same requirement.
    const service = new ApiService({ db: pool, repository, authenticator: async () => ({ wallet: NON_HOLDER }), ownershipVerifier: (input) => new IndexedOwnershipVerifier({ db: pool, config: verifierConfig, mainnetClient: fakeMainnetClient() }).verify(input), logger: quiet });
    await expect(service.issueExperienceGrant({ request: {}, input: { wallet: NON_HOLDER, experienceId, mediaType: "AUDIO" } })).rejects.toMatchObject({ status: 401 });
  }, 120000);
});
