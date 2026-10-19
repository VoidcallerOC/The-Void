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

function world({ wallet = owner, assets, experiences = [] } = {}) {
  const state = {
    wallet,
    editions: [{ id: "edition-1", release_id: "release-1", artist_id: "artist-1" }, { id: "edition-2", release_id: "release-2", artist_id: "artist-1" }],
    assets: assets || [
      { id: "asset-master", artist_id: "artist-1", storage_key: "bafyprivatemaster", media_type: "AUDIO", visibility: "PROTECTED", created_at: "2026-10-18T20:20:39Z", metadata: { byteSize: 65861868, contentSha256: "a".repeat(64) }, contentType: "audio/wav" },
      { id: "asset-demo", artist_id: "artist-1", storage_key: "bafyprivatedemo", media_type: "DEMO", visibility: "PROTECTED", created_at: "2026-10-18T20:23:22Z", metadata: { byteSize: 10584246, contentSha256: "b".repeat(64) }, contentType: "audio/wav" },
      { id: "asset-other-artist", artist_id: "artist-2", storage_key: "bafyother", media_type: "AUDIO", visibility: "PROTECTED", created_at: "2026-10-18T10:00:00Z", metadata: { byteSize: 1000 }, contentType: "audio/wav" },
      { id: "asset-public", artist_id: "artist-1", storage_key: "bafypublicthing", media_type: "AUDIO", visibility: "PUBLIC", created_at: "2026-10-18T10:00:00Z", metadata: { byteSize: 1000 }, contentType: "audio/wav" },
    ],
    experiences: new Map(experiences.map((row) => [row.id, row])),
    previews: [
      { uri: OLD_PREVIEW, content_type: "audio/mpeg", byte_size: "481115", uploaded_at: "2026-10-18T18:45:56Z" },
      { uri: NEW_PREVIEW, content_type: "audio/mpeg", byte_size: "721695", uploaded_at: "2026-10-18T20:20:25Z" },
    ],
  };
  const tokens = [{ token_id: "7", contract_address: contract, chain_id: 43113 }];
  let clock = 0;
  const rows = () => [...state.experiences.values()];
  const db = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("FROM artists a JOIN artist_owners")) return { rows: params[0] === "artist-1" && String(params[1]).toLowerCase() === owner ? [{ id: "artist-1", owner_wallet: owner }] : [] };
      if (text.includes("FROM editions e JOIN releases r")) return { rows: params[1] === owner ? state.editions.filter((edition) => edition.id === params[0]) : [] };
      if (text.includes("FROM experiences WHERE edition_id=$1 OR id=$2")) return { rows: rows().filter((row) => row.edition_id === params[0] || row.id === params[1]) };
      if (text.includes("FROM experiences WHERE edition_id<>$1 AND media_config::text LIKE $2")) return { rows: rows().filter((row) => row.edition_id !== params[0] && JSON.stringify(row.media_config).includes(String(params[1]).replaceAll("%", ""))).slice(0, 1) };
      if (text.includes("FROM tokens")) return { rows: tokens };
      if (text.includes("payload->>'uri' IS NOT NULL")) return { rows: [...state.previews].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)) };
      if (text.includes("payload->>'uri'=$2")) return { rows: state.previews.some((preview) => preview.uri === params[1]) ? [{ id: "audit-preview" }] : [] };
      if (text.includes("FROM media_assets a WHERE a.artist_id=$1")) {
        const attached = (id) => rows().some((row) => JSON.stringify(row.media_config).includes(id));
        return { rows: state.assets.filter((asset) => asset.artist_id === params[0] && asset.visibility === "PROTECTED" && !attached(asset.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((asset) => ({ id: asset.id, media_type: asset.media_type, created_at: asset.created_at, byte_size: String(asset.metadata.byteSize), content_type: asset.contentType })) };
      }
      if (text.includes("FROM media_assets WHERE artist_id=$1 AND storage_key=$2")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0] && asset.storage_key === String(params[1])).map((asset) => ({ id: asset.id })) };
      if (text.includes("FROM media_assets WHERE artist_id=$1")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0]) };
      return { rows: [] };
    }),
  };
  const repository = {
    saveExperience: vi.fn(async (input) => {
      clock += 1;
      const row = { id: input.id, artist_id: input.artistId, release_id: input.releaseId, edition_id: input.editionId, title: input.title, description: input.description || null, experience_type: input.experienceType, requirements: input.requirements, media_config: input.mediaConfig, version: (state.experiences.get(input.id)?.version || 0) + 1, status: state.experiences.get(input.id)?.status || input.status || "DRAFT", updated_at: clock };
      state.experiences.set(row.id, row);
      return row;
    }),
    saveMediaAsset: vi.fn(),
    appendAuditEvent: vi.fn(async () => ({})),
    inTransaction: vi.fn(async (operation) => operation(repository)),
  };
  const studio = new ArtistStudioService({ db: verifiedArtistDb(db), repository, authenticator: vi.fn(async () => ({ wallet: state.wallet })), logger: { info() {}, error() {} } });
  const uploads = ["createMediaUploadUrl", "registerMediaUpload", "uploadProtectedMedia"].map((name) => vi.spyOn(studio, name));
  return { state, db, repository, studio, uploads };
}

const save = async (w, files, editionId = "edition-1") => {
  const plans = planCatalogExperiences({ ...FORM, editionId, ...files });
  for (const plan of plans) await w.studio.createExperience({ request, editionId, input: plan.payload });
  return plans;
};
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
