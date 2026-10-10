import { describe, expect, it, vi } from "vitest";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const request = { requestId: "request-1", headers: {} };

function repository() {
  const repo = {
    saveRelease: vi.fn(async (input) => ({ id: input.id, artist_id: input.artistId, status: input.status, release_metadata: input.metadata })),
    saveContract: vi.fn(async () => ({ id: "contract-uuid" })),
    saveEdition: vi.fn(async (input) => ({ id: input.id, release_id: input.releaseId, status: input.status })),
    saveToken: vi.fn(async (input) => input),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}

// route(sql, params) returns the rows for one query; anything unmatched gets no rows.
function service(route) {
  const repo = repository();
  const db = { query: vi.fn(async (sql, params) => ({ rows: route(String(sql), params) || [] })) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn(), error: vi.fn() } });
  return { instance, repo, db };
}

const release = (id, releaseType, status = "DRAFT", artistId = "artist-1") => ({ id, artist_id: artistId, slug: id, title: id, description: null, status, release_metadata: releaseType === undefined ? {} : { releaseType }, published_at: null, owner_wallet: owner });

describe("release types", () => {
  it("creates SINGLE, EP and ALBUM releases and rejects anything else", async () => {
    for (const type of ["single", "EP", "Album"]) {
      const { instance, repo } = service((sql) => (sql.includes("FROM artists a") ? [{ id: "artist-1", slug: "a", display_name: "A", status: "ACTIVE", owner_wallet: owner }] : []));
      await instance.createRelease({ request, artistId: "artist-1", input: { title: `T ${type}`, releaseType: type } });
      expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe(type.toUpperCase());
    }
    const { instance } = service((sql) => (sql.includes("FROM artists a") ? [{ id: "artist-1", slug: "a", display_name: "A", status: "ACTIVE", owner_wallet: owner }] : []));
    await expect(instance.createRelease({ request, artistId: "artist-1", input: { title: "Mixtape", releaseType: "MIXTAPE" } })).rejects.toMatchObject({ status: 400, code: "INVALID_RELEASE_TYPE" });
  });

  it("locks the release type once any edition is published, and allows the change before that", async () => {
    const locked = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "EP", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(locked.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } })).rejects.toMatchObject({ status: 409, code: "RELEASE_TYPE_LOCKED" });
    // A legacy untyped release is EP; changing it after publication is a change too.
    const legacy = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", undefined, "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(legacy.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "ALBUM" } })).rejects.toMatchObject({ code: "RELEASE_TYPE_LOCKED" });
    await expect(legacy.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "EP", title: "Renamed" } })).resolves.toBeTruthy();
    expect(locked.repo.saveRelease).not.toHaveBeenCalled();

    const draft = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "EP")] : []));
    await draft.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } });
    expect(draft.repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("SINGLE");
  });

  it("keeps the stored type when a client replaces release metadata wholesale", async () => {
    const { instance, repo } = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "SINGLE")] : []));
    await instance.updateRelease({ request, releaseId: "release-1", input: { metadata: { note: "x" } } });
    expect(repo.saveRelease.mock.calls[0][0].metadata).toEqual({ note: "x", releaseType: "SINGLE" });
  });

  it("refuses a second edition on a published SINGLE but not on an EP", async () => {
    const single = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("single-1", "SINGLE", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(single.instance.createEdition({ request, releaseId: "single-1", input: { trackTitle: "B-side", quantity: "5" } })).rejects.toMatchObject({ status: 409, code: "SINGLE_ALREADY_PUBLISHED" });
    expect(single.repo.saveEdition).not.toHaveBeenCalled();

    const ep = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("ep-1", "EP", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(ep.instance.createEdition({ request, releaseId: "ep-1", input: { trackTitle: "Track 2", quantity: "5" } })).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("refuses to publish metadata for a second edition of a published SINGLE before any storage write", async () => {
    const repo = repository();
    const metadataStorage = { write: vi.fn() };
    const db = { query: vi.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM releases r JOIN artists a")) return { rows: [{ ...release("single-1", "SINGLE", "PUBLISHED"), display_name: "A" }] };
      if (text.includes("e.status IN ('DRAFT','REVIEW')")) return { rows: [{ id: "edition-2", release_id: "single-1", title: "B-side", status: "DRAFT", application_metadata: {} }] };
      if (text.includes("status='PUBLISHED'")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    }) };
    const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, metadataStorage, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn(), error: vi.fn() } });
    await expect(instance.publishMetadata({ request, releaseId: "single-1", input: {} })).rejects.toMatchObject({ status: 409, code: "SINGLE_ALREADY_PUBLISHED" });
    expect(metadataStorage.write).not.toHaveBeenCalled();
  });

  it("lets an unpublished SINGLE create its edition", async () => {
    const { instance } = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("single-1", "SINGLE")] : []));
    await expect(instance.createEdition({ request, releaseId: "single-1", input: { trackTitle: "A-side", quantity: "5" } })).resolves.toMatchObject({ status: "DRAFT" });
  });
});

describe("standalone single on an album", () => {
  const album = release("album-1", "ALBUM");
  const single = release("single-1", "SINGLE", "PUBLISHED");
  function harness({ albumRow = album, singleRow = single, edition = { id: "edition-s1" }, insert } = {}) {
    return service((sql) => {
      if (sql.includes("FROM releases r JOIN artist_owners")) return albumRow ? [albumRow] : [];
      if (sql.includes("SELECT r.* FROM releases r WHERE r.id=$1")) return singleRow ? [singleRow] : [];
      if (sql.includes("FROM editions WHERE release_id=$1 AND status='PUBLISHED' ORDER BY")) return edition ? [edition] : [];
      if (sql.includes("INSERT INTO release_album_singles")) {
        if (insert) return insert();
        return [{ album_release_id: "album-1", single_release_id: "single-1", single_edition_id: "edition-s1", track_position: 3, created_at: "2026-10-10T00:00:00.000Z" }];
      }
      return [];
    });
  }

  it("records the link without touching the single's release, edition or token", async () => {
    const { instance, repo, db } = harness();
    await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 3 } })).resolves.toEqual({ albumReleaseId: "album-1", singleReleaseId: "single-1", singleEditionId: "edition-s1", trackPosition: 3, createdAt: "2026-10-10T00:00:00.000Z" });
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_album_singles"));
    expect(insert[1]).toEqual(["album-1", "single-1", "edition-s1", 3, owner]);
    expect(repo.saveRelease).not.toHaveBeenCalled();
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => /UPDATE\s+(releases|editions|tokens|contracts)/i.test(String(sql)))).toBe(false);
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_ALBUM_SINGLE_ASSOCIATED", subjectId: "album-1" }));
  });

  it("requires an ALBUM on one side and a published SINGLE of the same artist on the other", async () => {
    const cases = [
      [{ albumRow: release("ep-1", "EP") }, 409, "ALBUM_RELEASE_REQUIRED"],
      [{ albumRow: release("album-1", "ALBUM", "ARCHIVED") }, 409, "ALBUM_RELEASE_ARCHIVED"],
      [{ albumRow: null }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: release("single-1", "SINGLE", "PUBLISHED", "artist-2") }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: null }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: release("ep-2", "EP", "PUBLISHED") }, 409, "SINGLE_RELEASE_REQUIRED"],
      [{ singleRow: release("single-1", "SINGLE", "DRAFT") }, 409, "SINGLE_NOT_PUBLISHED"],
      [{ edition: null }, 409, "SINGLE_NOT_PUBLISHED"],
    ];
    for (const [options, status, code] of cases) {
      const { instance, db } = harness(options);
      await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 1 } })).rejects.toMatchObject({ status, code });
      expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_album_singles"))).toBe(false);
    }
  });

  it("validates the track position and maps duplicates to clear conflicts", async () => {
    for (const trackPosition of [0, 1000, 1.5, "x", undefined]) {
      const { instance } = harness();
      await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition } })).rejects.toMatchObject({ status: 400, code: "INVALID_TRACK_POSITION" });
    }
    const unique = (constraint) => () => { throw Object.assign(new Error("duplicate key"), { code: "23505", constraint }); };
    const taken = harness({ insert: unique("release_album_singles_album_release_id_track_position_key") });
    await expect(taken.instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 2 } })).rejects.toMatchObject({ status: 409, code: "ALBUM_TRACK_POSITION_TAKEN" });
    const twice = harness({ insert: unique("release_album_singles_pkey") });
    await expect(twice.instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 2 } })).rejects.toMatchObject({ status: 409, code: "ALBUM_SINGLE_ALREADY_ADDED" });
  });
});
