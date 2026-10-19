import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService } from "./studio-service.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { planCatalogExperiences } from "../src/lib/studio-experiences.js";

// Re-attaching files the artist already registered: the owner-only listing, the server checks that make
// reuse safe (ownership, PROTECTED visibility, type, one edition per file), and a catalog save that
// reuses the existing assets and previews without any upload.

const owner = "0x1111111111111111111111111111111111111111";
const stranger = "0x9999999999999999999999999999999999999999";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const request = { requestId: "request-1", headers: {} };
const NEW_PREVIEW = "ipfs://bafybeinewerpreviewclip";
const OLD_PREVIEW = "ipfs://bafybeiolderpreviewclip";

const FULL = { assetId: "asset-master", mediaType: "AUDIO", contentType: "audio/wav" };
const DEMO = { assetId: "asset-demo", mediaType: "DEMO", contentType: "audio/wav" };
const FORM = { editionId: "edition-1", productType: "DEMO", experienceTitle: "Stranger Things", experienceDescription: "", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };

const SECOND_MASTER = { id: "asset-master-2", artist_id: "artist-1", storage_key: "bafyprivatemaster2", media_type: "AUDIO", visibility: "PROTECTED", created_at: "2026-10-18T20:30:00Z", metadata: { byteSize: 5000, contentSha256: "c".repeat(64) }, contentType: "audio/wav" };

function world({ wallet = owner, assets, experiences = [], locks = true, extraAssets = [] } = {}) {
  const state = {
    wallet,
    editions: [{ id: "edition-1", release_id: "release-1", artist_id: "artist-1" }, { id: "edition-2", release_id: "release-2", artist_id: "artist-1" }],
    assets: [...(assets || [
      { id: "asset-master", artist_id: "artist-1", storage_key: "bafyprivatemaster", media_type: "AUDIO", visibility: "PROTECTED", created_at: "2026-10-18T20:20:39Z", metadata: { byteSize: 65861868, contentSha256: "a".repeat(64) }, contentType: "audio/wav" },
      { id: "asset-demo", artist_id: "artist-1", storage_key: "bafyprivatedemo", media_type: "DEMO", visibility: "PROTECTED", created_at: "2026-10-18T20:23:22Z", metadata: { byteSize: 10584246, contentSha256: "b".repeat(64) }, contentType: "audio/wav" },
      { id: "asset-other-artist", artist_id: "artist-2", storage_key: "bafyother", media_type: "AUDIO", visibility: "PROTECTED", created_at: "2026-10-18T10:00:00Z", metadata: { byteSize: 1000 }, contentType: "audio/wav" },
      { id: "asset-public", artist_id: "artist-1", storage_key: "bafypublicthing", media_type: "AUDIO", visibility: "PUBLIC", created_at: "2026-10-18T10:00:00Z", metadata: { byteSize: 1000 }, contentType: "audio/wav" },
    ]), ...extraAssets],
    experiences: new Map(experiences.map((row) => [row.id, row])),
    previews: [
      { uri: OLD_PREVIEW, content_type: "audio/mpeg", byte_size: "481115", uploaded_at: "2026-10-18T18:45:56Z" },
      { uri: NEW_PREVIEW, content_type: "audio/mpeg", byte_size: "721695", uploaded_at: "2026-10-18T20:20:25Z" },
    ],
  };
  const tokens = [{ token_id: "7", contract_address: contract, chain_id: 43113 }];
  let clock = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const advisory = new Map(); // lock key -> promise released when the holder's transaction ends
  const lockLog = []; // advisory locks in the order they were acquired
  const rows = () => [...state.experiences.values()];
  const db = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("FROM artists a JOIN artist_owners")) return { rows: params[0] === "artist-1" && String(params[1]).toLowerCase() === owner ? [{ id: "artist-1", owner_wallet: owner }] : [] };
      if (text.includes("FROM editions e JOIN releases r")) return { rows: params[1] === owner ? state.editions.filter((edition) => edition.id === params[0]) : [] };
      if (text.includes("FROM experiences x JOIN artist_owners")) return { rows: params[1] === owner ? rows().filter((row) => row.id === params[0]).map((row) => ({ ...row, owner_wallet: owner })) : [] };
      if (text.includes("FROM experiences WHERE edition_id=$1 AND id<>$2")) return { rows: rows().filter((row) => row.edition_id === params[0] && row.id !== params[1]) };
      if (text.includes("FROM experiences WHERE edition_id=$1 OR id=$2")) return { rows: rows().filter((row) => row.edition_id === params[0] || row.id === params[1]) };
      if (text.includes("FROM experiences WHERE release_id=$1")) return { rows: rows().filter((row) => row.release_id === params[0]) };
      if (text.includes("FROM experiences WHERE id=$1 FOR UPDATE")) return { rows: rows().filter((row) => row.id === params[0]) };
      if (text.includes("FROM experiences WHERE edition_id<>$1 AND media_config::text LIKE $2")) return { rows: rows().filter((row) => row.edition_id !== params[0] && JSON.stringify(row.media_config).includes(String(params[1]).replaceAll("%", ""))).slice(0, 1) };
      if (text.includes("FROM tokens")) return { rows: tokens };
      if (text.includes("payload->>'uri' IS NOT NULL")) return { rows: [...state.previews].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)) };
      if (text.includes("payload->>'uri'=$2")) return { rows: state.previews.some((preview) => preview.uri === params[1]) ? [{ id: "audit-preview" }] : [] };
      if (text.includes("FROM media_assets a WHERE a.artist_id=$1")) {
        const attached = (id) => rows().some((row) => JSON.stringify(row.media_config).includes(`"${id}"`));
        return { rows: state.assets.filter((asset) => asset.artist_id === params[0] && asset.visibility === "PROTECTED" && !attached(asset.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((asset) => ({ id: asset.id, media_type: asset.media_type, created_at: asset.created_at, byte_size: String(asset.metadata.byteSize), content_type: asset.contentType })) };
      }
      if (text.includes("FROM media_assets WHERE artist_id=$1 AND storage_key=$2")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0] && asset.storage_key === String(params[1])).map((asset) => ({ id: asset.id })) };
      if (text.includes("FROM media_assets WHERE artist_id=$1")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0]) };
      return { rows: [] };
    }),
  };
  const repository = {
    saveExperience: vi.fn(async (input) => {
      await tick(); // a real write takes time: this is the window the lock must cover
      clock += 1;
      const row = { id: input.id, artist_id: input.artistId, release_id: input.releaseId, edition_id: input.editionId, title: input.title, description: input.description || null, experience_type: input.experienceType, requirements: input.requirements, media_config: input.mediaConfig, version: (state.experiences.get(input.id)?.version || 0) + 1, status: input.status || state.experiences.get(input.id)?.status || "DRAFT", updated_at: clock };
      state.experiences.set(row.id, row);
      return row;
    }),
    saveMediaAsset: vi.fn(),
    appendAuditEvent: vi.fn(async () => ({})),
    // A transaction whose connection honours advisory locks until it ends, like Postgres.
    inTransaction: vi.fn(async (operation) => {
      const held = [];
      const connection = {
        query: async (sql, params = []) => {
          if (String(sql).includes("pg_advisory_xact_lock")) {
            if (!locks) return { rows: [] };
            const key = params[0];
            while (advisory.has(key)) await advisory.get(key).done;
            let release;
            advisory.set(key, { done: new Promise((resolve) => { release = resolve; }) });
            lockLog.push(key.replace('void:media-asset:', ''));
            held.push([key, release]);
            return { rows: [] };
          }
          await tick();
          return db.query(sql, params);
        },
      };
      try { return await operation({ ...repository, db: connection }); } finally { for (const [key, release] of held) { advisory.delete(key); release(); } }
    }),
  };
  const logger = { info() {}, error() {} };
  const studio = new ArtistStudioService({ db: verifiedArtistDb(db), repository, authenticator: vi.fn(async () => ({ wallet: state.wallet })), logger });
  const uploads = ["createMediaUploadUrl", "registerMediaUpload", "uploadProtectedMedia"].map((name) => vi.spyOn(studio, name));
  return { state, db, repository, studio, uploads, lockLog, advisory };
}

const save = async (w, files, editionId = "edition-1") => {
  const plans = planCatalogExperiences({ ...FORM, editionId, ...files });
  for (const plan of plans) await w.studio.createExperience({ request, editionId, input: plan.payload });
  return plans;
};
const RELEASE_1 = { id: "release-1", artist_id: "artist-1" };
const noUpload = (w) => { for (const spy of w.uploads) expect(spy).not.toHaveBeenCalled(); expect(w.repository.saveMediaAsset).not.toHaveBeenCalled(); };

describe("listing registered media (owner only)", () => {
  it("returns the artist's unattached PROTECTED files and previously uploaded previews, newest first", async () => {
    const w = world();
    const listing = await w.studio.listRegisteredMedia({ request, artistId: "artist-1" });
    expect(listing.protected.map((item) => [item.assetId, item.mediaType, item.byteSize, item.contentType])).toEqual([["asset-demo", "DEMO", 10584246, "audio/wav"], ["asset-master", "AUDIO", 65861868, "audio/wav"]]);
    expect(listing.previews.map((item) => item.uri)).toEqual([NEW_PREVIEW, OLD_PREVIEW]); // the older one is listed, never altered
  });

  it("never lists another artist's file, a non-PROTECTED file, or a file an experience already uses", async () => {
    const w = world({ experiences: [{ id: "experience-edition-1-full-track", edition_id: "edition-1", media_config: { protectedMedia: [{ assetId: "asset-master" }] } }] });
    const ids = (await w.studio.listRegisteredMedia({ request, artistId: "artist-1" })).protected.map((item) => item.assetId);
    expect(ids).toEqual(["asset-demo"]);
    expect(ids).not.toContain("asset-other-artist");
    expect(ids).not.toContain("asset-public");
  });

  it("exposes no storage key, hash, link or token", async () => {
    const text = JSON.stringify(await world().studio.listRegisteredMedia({ request, artistId: "artist-1" }));
    expect(text).not.toMatch(/bafyprivate|storage|sha256|contentSha|a{64}|https?:|sig=|token/i);
    expect(Object.keys(JSON.parse(text).protected[0]).sort()).toEqual(["assetId", "byteSize", "contentType", "mediaType", "registeredAt"]);
  });

  it("refuses a wallet that does not own the artist", async () => {
    await expect(world({ wallet: stranger }).studio.listRegisteredMedia({ request, artistId: "artist-1" })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(world().studio.listRegisteredMedia({ request, artistId: "artist-2" })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
  });
});

describe("saving the catalog from registered assets, without uploading", () => {
  it("creates exactly two experiences from the existing asset ids: full song primary, demo not", async () => {
    const w = world();
    await save(w, { fullTrack: FULL, experienceAudio: DEMO });
    expect([...w.state.experiences.keys()].sort()).toEqual(["experience-edition-1-experience-audio", "experience-edition-1-full-track"]);
    const full = w.state.experiences.get("experience-edition-1-full-track");
    const demo = w.state.experiences.get("experience-edition-1-experience-audio");
    expect(full).toMatchObject({ experience_type: "AUDIO" });
    expect(demo).toMatchObject({ experience_type: "DEMO" });
    expect(full.media_config.protectedMedia.map((entry) => [entry.assetId, entry.mediaType])).toEqual([["asset-master", "AUDIO"]]);
    expect(demo.media_config.protectedMedia.map((entry) => [entry.assetId, entry.mediaType])).toEqual([["asset-demo", "DEMO"]]);
    expect(full.media_config.primary).toBe(true);
    expect(demo.media_config.primary).toBe(false);
    noUpload(w);
  });

  it("is idempotent: saving again keeps two experiences, the same ids, assets and primary", async () => {
    const w = world();
    await save(w, { fullTrack: FULL, experienceAudio: DEMO });
    const before = JSON.stringify([...w.state.experiences.values()].map((row) => [row.id, row.media_config]));
    await save(w, { fullTrack: FULL, experienceAudio: DEMO });
    await save(w, { fullTrack: FULL, experienceAudio: DEMO });
    expect(w.state.experiences.size).toBe(2);
    expect(JSON.stringify([...w.state.experiences.values()].map((row) => [row.id, row.media_config]))).toBe(before);
    noUpload(w);
  });

  it("uses the existing public preview only through the edition metadata and keeps it apart from private files", async () => {
    const w = world();
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: NEW_PREVIEW })).resolves.toBe(NEW_PREVIEW);
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: "ipfs://bafyneveruploaded" })).rejects.toMatchObject({ code: "PREVIEW_AUDIO_NOT_REGISTERED" });
    // A preview address that is really a private object is refused.
    w.state.previews.push({ uri: "ipfs://bafyprivatemaster", content_type: "audio/mpeg", byte_size: "1", uploaded_at: "2026-10-18T21:00:00Z" });
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: "ipfs://bafyprivatemaster" })).rejects.toMatchObject({ code: "PREVIEW_AUDIO_IS_PRIVATE" });
    // And no private experience ever carries the preview address.
    await save(w, { fullTrack: FULL, experienceAudio: DEMO });
    expect(JSON.stringify([...w.state.experiences.values()])).not.toContain("newerpreview");
  });
});

describe("server checks that make reuse safe", () => {
  it("refuses a file owned by another artist", async () => {
    const w = world();
    await expect(save(w, { fullTrack: { ...FULL, assetId: "asset-other-artist" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_OWNED" });
    expect(w.state.experiences.size).toBe(0);
  });

  it("refuses a file that is not PROTECTED", async () => {
    const w = world();
    await expect(save(w, { fullTrack: { ...FULL, assetId: "asset-public" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_PROTECTED" });
    expect(w.state.experiences.size).toBe(0);
  });

  it("refuses a file declared as the wrong type", async () => {
    const w = world();
    await expect(save(w, { fullTrack: { ...FULL, assetId: "asset-demo", mediaType: "AUDIO" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_TYPE_MISMATCH" });
  });

  it("refuses to attach a file already used by a different edition, and still allows its own edition", async () => {
    const w = world();
    await save(w, { fullTrack: FULL, experienceAudio: DEMO }, "edition-1");
    await expect(save(w, { fullTrack: FULL }, "edition-2")).rejects.toMatchObject({ code: "PROTECTED_MEDIA_IN_USE" });
    await expect(save(w, { experienceAudio: DEMO }, "edition-2")).rejects.toMatchObject({ code: "PROTECTED_MEDIA_IN_USE" });
    expect([...w.state.experiences.values()].every((row) => row.edition_id === "edition-1")).toBe(true);
    await expect(save(w, { fullTrack: FULL, experienceAudio: DEMO }, "edition-1")).resolves.toHaveLength(2);
    expect(w.state.experiences.size).toBe(2);
  });
});

describe("cross-edition exclusivity under concurrent saves", () => {
  const attach = (w, editionId) => w.studio.createExperience({ request, editionId, input: planCatalogExperiences({ ...FORM, editionId, fullTrack: FULL })[0].payload });
  const owners = (w) => [...w.state.experiences.values()].filter((row) => JSON.stringify(row.media_config).includes('"asset-master"')).map((row) => row.edition_id);

  it("lets exactly one of two simultaneous saves to different editions claim the file", async () => {
    const w = world();
    const results = await Promise.allSettled([attach(w, "edition-1"), attach(w, "edition-2")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected.reason).toMatchObject({ status: 409, code: "PROTECTED_MEDIA_IN_USE" });
    expect(owners(w)).toHaveLength(1);
    expect(new Set(owners(w)).size).toBe(1);
  });

  it("holds the same for many simultaneous saves, whatever the order", async () => {
    const w = world();
    const results = await Promise.allSettled([attach(w, "edition-2"), attach(w, "edition-1"), attach(w, "edition-2"), attach(w, "edition-1")]);
    const winner = owners(w);
    expect(new Set(winner).size).toBe(1); // never attached to both editions
    expect(results.filter((result) => result.status === "rejected").every((result) => result.reason.code === "PROTECTED_MEDIA_IN_USE")).toBe(true);
  });

  it("takes the per-file lock before the check and saves inside the same transaction", async () => {
    const w = world();
    await attach(w, "edition-1");
    expect(w.repository.inTransaction).toHaveBeenCalledTimes(1);
    const statements = w.db.query.mock.calls.map(([sql]) => String(sql));
    // The fake routes transaction statements through db.query after the lock, so the check ran on the transaction connection.
    expect(statements.some((sql) => sql.includes("edition_id<>$1 AND media_config::text LIKE $2"))).toBe(true);
  });

  it("control: without the lock the same two saves both pass the check (the race this guards against)", async () => {
    const w = world({ locks: false });
    const results = await Promise.allSettled([attach(w, "edition-1"), attach(w, "edition-2")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(new Set(owners(w)).size).toBe(2);
  });

  it("the update path is guarded the same way", async () => {
    const w = world();
    await attach(w, "edition-1");
    await w.studio.createExperience({ request, editionId: "edition-2", input: planCatalogExperiences({ ...FORM, editionId: "edition-2", experienceAudio: DEMO })[0].payload });
    const demoId = "experience-edition-2-experience-audio";
    await expect(w.studio.updateExperience({ request, experienceId: demoId, input: { mediaConfig: { protected: true, protectedMedia: [{ assetId: "asset-master", mediaType: "AUDIO" }] }, productType: "FULL_RECORD" } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_IN_USE" });
    expect(owners(w)).toEqual(["edition-1"]);
  });
});

describe("publication cannot restore a file another edition has claimed", () => {
  const attach = (w, editionId, fullTrack = FULL) => w.studio.createExperience({ request, editionId, input: planCatalogExperiences({ ...FORM, editionId, fullTrack })[0].payload });
  const holders = (w, assetId) => [...w.state.experiences.values()].filter((row) => JSON.stringify(row.media_config).includes(`"${assetId}"`)).map((row) => `${row.edition_id}:${row.status}`);
  const fullTrackId = (editionId) => `experience-${editionId}-full-track`;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Publication reads edition-1's experience (asset-master), then, before it writes, edition-1 gives the
  // file up and edition-2 claims it: the stale snapshot must not put it back.
  async function raceWithPublication(w) {
    await attach(w, "edition-1");
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const original = w.studio.bindProtectedExperience.bind(w.studio);
    let paused = false;
    let first = true;
    vi.spyOn(w.studio, "bindProtectedExperience").mockImplementation(async (arg) => {
      const result = await original(arg);
      if (first) { first = false; paused = true; await gate; }
      return result;
    });
    const publishing = w.studio.publishReleaseExperiences(RELEASE_1);
    while (!paused) await tick();
    // The competing operations commit while publication holds its stale read.
    await w.studio.updateExperience({ request, experienceId: fullTrackId("edition-1"), input: { mediaConfig: { protected: true, protectedMedia: [{ assetId: "asset-master-2", mediaType: "AUDIO" }] } } });
    await attach(w, "edition-2");
    open();
    await publishing;
  }

  it("never attaches the file to both editions when publication holds a stale read", async () => {
    const w = world({ extraAssets: [SECOND_MASTER] });
    await raceWithPublication(w);
    expect(holders(w, "asset-master")).toEqual(["edition-2:DRAFT"]); // edition-2 keeps the claim; publication did not restore it
    const first = w.state.experiences.get(fullTrackId("edition-1"));
    expect(first.status).toBe("PUBLISHED");
    expect(first.media_config.protectedMedia.map((entry) => entry.assetId)).toEqual(["asset-master-2"]); // the CURRENT configuration was published
    noUpload(w);
  });

  it("takes the extra lock the current configuration needs, in sorted order, and releases every lock", async () => {
    const w = world({ extraAssets: [SECOND_MASTER] });
    await raceWithPublication(w);
    // create(e1): master · update(e1): master-2 · create(e2): master · publication try 1: master (its snapshot),
    // which finds the row now needs master-2 · publication try 2: master then master-2 (sorted union).
    expect(w.lockLog).toEqual(["asset-master", "asset-master-2", "asset-master", "asset-master", "asset-master", "asset-master-2"]);
    expect(w.advisory.size).toBe(0);
  });

  it("publishes a valid experience unchanged, and publishing twice changes nothing more", async () => {
    const w = world({ extraAssets: [SECOND_MASTER] });
    await w.studio.createExperience({ request, editionId: "edition-1", input: planCatalogExperiences({ ...FORM, fullTrack: FULL, experienceAudio: DEMO }).find((plan) => plan.role === "full-track").payload });
    await w.studio.createExperience({ request, editionId: "edition-1", input: planCatalogExperiences({ ...FORM, fullTrack: FULL, experienceAudio: DEMO }).find((plan) => plan.role === "experience-audio").payload });
    const before = [...w.state.experiences.values()].map((row) => [row.id, JSON.stringify(row.media_config), row.title]);
    await w.studio.publishReleaseExperiences(RELEASE_1);
    await w.studio.publishReleaseExperiences(RELEASE_1);
    const rows = [...w.state.experiences.values()];
    expect(rows.map((row) => row.status)).toEqual(["PUBLISHED", "PUBLISHED"]);
    expect(rows.map((row) => [row.id, JSON.stringify(row.media_config), row.title])).toEqual(before);
    expect(rows.map((row) => row.media_config.primary).sort()).toEqual([false, true]);
    expect(rows.every((row) => row.version === rows.find((other) => other.id === row.id).version)).toBe(true);
  });

  it("leaves an experience unpublished, and writes nothing for it, when its file already belongs to another edition", async () => {
    const claimed = { id: "experience-edition-2-full-track", artist_id: "artist-1", release_id: "release-2", edition_id: "edition-2", title: "Other", description: null, experience_type: "AUDIO", requirements: [{ type: "erc1155-balance", contract, chainId: 43113, tokenIds: ["7"], minAmount: "1" }], media_config: { protected: true, protectedMedia: [{ assetId: "asset-master", mediaType: "AUDIO" }] }, version: 1, status: "DRAFT" };
    const mine = { ...claimed, id: "experience-edition-1-full-track", release_id: "release-1", edition_id: "edition-1", title: "Mine" };
    const w = world({ experiences: [claimed, mine] });
    const logger = w.studio.logger;
    const errors = vi.spyOn(logger, "error");
    await w.studio.publishReleaseExperiences(RELEASE_1);
    expect(w.state.experiences.get(mine.id).status).toBe("DRAFT");
    expect(w.repository.saveExperience).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("studio.publication.experience_blocked", expect.objectContaining({ experienceId: mine.id }));
    expect(w.state.experiences.get(claimed.id).status).toBe("DRAFT"); // other editions are never touched
  });

  it("a failed write leaves no partial change and releases its locks", async () => {
    const w = world({ extraAssets: [SECOND_MASTER] });
    await attach(w, "edition-1");
    const before = JSON.stringify(w.state.experiences.get(fullTrackId("edition-1")));
    w.repository.saveExperience.mockRejectedValueOnce(new Error("disk full"));
    await expect(w.studio.publishReleaseExperiences(RELEASE_1)).rejects.toThrow("disk full");
    expect(JSON.stringify(w.state.experiences.get(fullTrackId("edition-1")))).toBe(before);
    expect(w.advisory.size).toBe(0);
    await expect(attach(w, "edition-2")).rejects.toMatchObject({ code: "PROTECTED_MEDIA_IN_USE" }); // and the guard still holds
  });

  it("takes locks for several files in sorted order whatever order they are listed in, without deadlocking", async () => {
    const w = world({ extraAssets: [SECOND_MASTER] });
    const two = (editionId, order) => w.studio.createExperience({ request, editionId, input: { ...planCatalogExperiences({ ...FORM, editionId, fullTrack: FULL })[0].payload, mediaConfig: { protected: true, protectedMedia: order.map((assetId) => ({ assetId, mediaType: "AUDIO" })) } } });
    const results = await Promise.allSettled([two("edition-1", ["asset-master-2", "asset-master"]), two("edition-2", ["asset-master", "asset-master-2"])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); // exactly one edition wins both files
    for (let index = 0; index < w.lockLog.length; index += 2) expect(w.lockLog.slice(index, index + 2)).toEqual(["asset-master", "asset-master-2"]);
    expect(w.advisory.size).toBe(0);
  });
});
