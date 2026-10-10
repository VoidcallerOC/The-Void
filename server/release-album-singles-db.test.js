import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiService } from "./api-service.js";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";

// Real Postgres: migration 038 links a published standalone SINGLE to an ALBUM without
// rewriting either release, and the public API exposes the link from both sides.
// Skipped without TEST_DATABASE_URL.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };
const CHAIN_ID = 43113;
const WALLET = `0x${"b1".repeat(20)}`;
const SINGLE_CONTRACT = `0x${"c1".repeat(20)}`;
const SECOND_CONTRACT = `0x${"c2".repeat(20)}`;
const request = { requestId: "request-db", headers: {} };

describe.skipIf(!testDatabaseUrl)("standalone single on an album (Postgres)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;

  const snapshot = async () => ({
    releases: (await pool.query("SELECT * FROM releases WHERE id IN ('single-a','single-b') ORDER BY id")).rows,
    editions: (await pool.query("SELECT * FROM editions WHERE release_id IN ('single-a','single-b') ORDER BY id")).rows,
    tokens: (await pool.query("SELECT * FROM tokens WHERE edition_id IN ('edition-a','edition-b') ORDER BY edition_id")).rows,
    contracts: (await pool.query("SELECT * FROM contracts WHERE address IN ($1,$2) ORDER BY address", [SINGLE_CONTRACT, SECOND_CONTRACT])).rows,
  });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_album_singles_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });

    const repository = createPersistenceRepository(pool);
    await repository.saveArtist({ id: "artist-s", slug: "single-artist", displayName: "Single Artist" });
    await repository.assignArtistOwner({ artistId: "artist-s", wallet: WALLET });
    await repository.saveArtist({ id: "artist-other", slug: "other-artist", displayName: "Other Artist" });
    await repository.saveRelease({ id: "album-1", artistId: "artist-s", slug: "the-album", title: "The Album", status: "PUBLISHED", metadata: { releaseType: "ALBUM" }, publishedAt: new Date("2026-10-01T00:00:00Z") });
    for (const [releaseId, editionId, contractAddress, tokenId] of [["single-a", "edition-a", SINGLE_CONTRACT, "11"], ["single-b", "edition-b", SECOND_CONTRACT, "12"]]) {
      await repository.saveRelease({ id: releaseId, artistId: "artist-s", slug: releaseId, title: releaseId, status: "PUBLISHED", metadata: { releaseType: "SINGLE" }, publishedAt: new Date("2026-09-01T00:00:00Z") });
      const contract = await repository.saveContract({ chainId: CHAIN_ID, chainKey: String(CHAIN_ID), address: contractAddress, contractType: "ERC1155", name: "VoidRelease1155V4" });
      await repository.saveEdition({ id: editionId, releaseId, contractId: contract.id, title: releaseId, supply: "10", status: "PUBLISHED" });
      await repository.saveToken({ editionId, contractId: contract.id, tokenId, metadataUri: `ipfs://${editionId}` });
    }
    await repository.saveRelease({ id: "foreign-single", artistId: "artist-other", slug: "foreign-single", title: "Foreign", status: "PUBLISHED", metadata: { releaseType: "SINGLE" }, publishedAt: new Date() });
    studio = new ArtistStudioService({ db: pool, repository, authenticator: vi.fn().mockResolvedValue({ wallet: WALLET }), logger: quiet });
  });

  afterAll(async () => {
    await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("creates the link table with row level security and no API-role grants", async () => {
    const { rows } = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='release_album_singles'");
    expect(rows).toEqual([{ relrowsecurity: true }]);
    for (const role of (await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows.map((row) => row.rolname)) {
      expect((await pool.query("SELECT has_table_privilege($1, 'public.release_album_singles', 'SELECT') AS allowed", [role])).rows[0]).toEqual({ allowed: false });
    }
  });

  it("links singles to the album without rewriting any single release, edition, token or contract row", async () => {
    const before = await snapshot();
    await expect(studio.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-a", trackPosition: 2 } })).resolves.toMatchObject({ albumReleaseId: "album-1", singleReleaseId: "single-a", singleEditionId: "edition-a", trackPosition: 2 });
    await expect(studio.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-b", trackPosition: 5 } })).resolves.toMatchObject({ trackPosition: 5 });
    expect(await snapshot()).toEqual(before);

    await expect(studio.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-a", trackPosition: 9 } })).rejects.toMatchObject({ code: "ALBUM_SINGLE_ALREADY_ADDED" });
    await expect(studio.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "foreign-single", trackPosition: 7 } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    // Linked rows cannot be deleted out from under the album.
    await expect(pool.query("DELETE FROM releases WHERE id='single-a'")).rejects.toMatchObject({ code: "23503" });
    const audit = await pool.query("SELECT event_type FROM audit_events WHERE subject_id='album-1' AND event_type='STUDIO_ALBUM_SINGLE_ASSOCIATED'");
    expect(audit.rows).toHaveLength(2);
  });

  it("rejects a taken track position at the database, not only in the service", async () => {
    await pool.query("UPDATE release_album_singles SET track_position=track_position WHERE album_release_id='album-1'");
    await expect(pool.query("INSERT INTO release_album_singles (album_release_id, single_release_id, single_edition_id, track_position, associated_by_wallet) VALUES ('album-1','single-b','edition-b',2,$1)", [WALLET])).rejects.toMatchObject({ code: "23505" });
  });

  it("serves the album's singles and the single's albums from the public API", async () => {
    const api = new ApiService({ db: pool, repository: createPersistenceRepository(pool), logger: quiet });
    const album = await api.getRelease({ idOrSlug: "the-album" });
    expect(album.albumSingles).toEqual([
      { trackPosition: 2, releaseId: "single-a", slug: "single-a", title: "single-a", editionId: "edition-a", chainId: CHAIN_ID, contractAddress: SINGLE_CONTRACT, tokenId: "11" },
      { trackPosition: 5, releaseId: "single-b", slug: "single-b", title: "single-b", editionId: "edition-b", chainId: CHAIN_ID, contractAddress: SECOND_CONTRACT, tokenId: "12" },
    ]);
    const single = await api.getRelease({ idOrSlug: "single-a" });
    expect(single.appearsOnAlbums).toEqual([{ releaseId: "album-1", slug: "the-album", title: "The Album", trackPosition: 2 }]);
    // The single still resolves as its own release with its own type.
    expect(single).toMatchObject({ id: "single-a", release_metadata: { releaseType: "SINGLE" } });
    expect(single).not.toHaveProperty("albumSingles");
  });
});
