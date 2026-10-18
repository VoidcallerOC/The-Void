import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService } from "./studio-service.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { mapPublishedCatalog } from "../src/lib/catalog-source.js";
import { planCatalogExperiences } from "../src/lib/studio-experiences.js";

// The full song and the 30-second demo are two separate private files and two
// separate collector experiences. The public preview is a third, independent
// asset. These tests follow the real code from "Save catalog structure"
// (planner -> createExperience) through publish and the public catalog to the
// collector's playback grant, against a database fake that behaves like the
// experiences / media_assets tables.

const owner = "0x1111111111111111111111111111111111111111";
const holder = "0x3333333333333333333333333333333333333333";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const request = { requestId: "request-1", headers: {} };
const RELEASE = { id: "release-1", artist_id: "artist-1" };
const PREVIEW_URI = "ipfs://bafypublicpreviewclip";

const MASTER = { assetId: "asset-master", mediaType: "AUDIO", contentType: "audio/x-wav", filename: "Forgive-Forget-master.wav" };
const DEMO = { assetId: "asset-demo", mediaType: "DEMO", contentType: "audio/x-wav", filename: "stranger-demo-30s.wav" };
const FORM = { editionId: "edition-1", productType: "DEMO", experienceTitle: "Stranger Things", experienceDescription: "Stranger things have happened...", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };

function world({ extraExperiences = [], extraAssets = [] } = {}) {
  const state = {
    editions: [{ id: "edition-1", release_id: "release-1", artist_id: "artist-1" }],
    assets: [
      { id: "asset-master", artist_id: "artist-1", storage_key: "bafyprivatemaster", media_type: "AUDIO" },
      { id: "asset-demo", artist_id: "artist-1", storage_key: "bafyprivatedemo", media_type: "DEMO" },
      ...extraAssets,
    ],
    experiences: new Map(extraExperiences.map((row) => [row.id, row])),
  };
  const tokens = [{ token_id: "7", contract_address: contract, chain_id: 43113 }];
  const rows = () => [...state.experiences.values()];
  const db = {
    query: vi.fn(async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("FROM editions e JOIN releases r")) return { rows: params[1] === owner ? state.editions.filter((edition) => edition.id === params[0]) : [] };
      if (text.includes("FROM experiences WHERE edition_id=$1 OR id=$2")) return { rows: rows().filter((row) => row.edition_id === params[0] || row.id === params[1]) };
      if (text.includes("FROM experiences x JOIN artist_owners")) return { rows: params[1] === owner ? rows().filter((row) => row.id === params[0]).map((row) => ({ ...row, owner_wallet: owner })) : [] };
      if (text.includes("FROM experiences WHERE release_id=$1")) return { rows: rows().filter((row) => row.release_id === params[0]) };
      if (text.includes("FROM experiences WHERE id=$1 AND status='PUBLISHED'")) return { rows: rows().filter((row) => row.id === params[0] && row.status === "PUBLISHED") };
      if (text.includes("FROM tokens")) return { rows: tokens };
      if (text.includes("FROM audit_events WHERE event_type='STUDIO_AUDIO_PREVIEW_UPLOADED'")) return { rows: params[1] === PREVIEW_URI ? [{ id: "audit-preview" }] : [] };
      if (text.includes("FROM media_assets WHERE artist_id=$1 AND storage_key=$2")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0] && asset.storage_key === String(params[1])) };
      if (text.includes("FROM media_assets WHERE artist_id=$1")) return { rows: state.assets.filter((asset) => asset.artist_id === params[0]) };
      if (text.includes("FROM media_assets WHERE ($1")) return { rows: state.assets.filter((asset) => asset.id === params[0]) };
      return { rows: [] };
    }),
  };
  const repository = {
    saveExperience: vi.fn(async (input) => {
      const row = { id: input.id, artist_id: input.artistId, release_id: input.releaseId, edition_id: input.editionId, title: input.title, description: input.description, experience_type: input.experienceType, requirements: input.requirements, media_config: input.mediaConfig, version: input.version ?? 1, status: input.status ?? "DRAFT" };
      state.experiences.set(row.id, row);
      return row;
    }),
    appendAuditEvent: vi.fn(async () => ({})),
    inTransaction: vi.fn(async (operation) => operation(repository)),
    createGrant: vi.fn(async (input) => ({ grant_id: input.grantId, expires_at: input.expiresAt.toISOString(), ...input })),
    recordMediaAuthorization: vi.fn().mockResolvedValue({ id: "audit-row" }),
  };
  const studio = new ArtistStudioService({ db: verifiedArtistDb(db), repository, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info() {}, error() {} } });
  const gateway = new ProtectedMediaGateway({
    db,
    repository,
    authenticator: async () => ({ wallet: holder }),
    ownershipVerifier: vi.fn().mockResolvedValue({ owns: true, state: "FINALIZED", chainId: 43113, watermark: "100:0" }),
    storage: { open: vi.fn().mockResolvedValue({ type: "redirect", url: "https://media.example/protected?sig=opaque" }) },
    mediaConfig: { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "test-audit-secret" },
  });
  return { state, db, repository, studio, gateway };
}

// "Save catalog structure": exactly what the Studio does, in order.
async function studioSave(w, files, overrides = {}) {
  const plans = planCatalogExperiences({ ...FORM, ...overrides, ...files });
  for (const plan of plans) await w.studio.createExperience({ request, editionId: "edition-1", input: plan.payload });
  return plans;
}
const publish = (w) => w.studio.publishReleaseExperiences(RELEASE);
const stored = (w, role) => w.state.experiences.get(`experience-edition-1-${role}`);
const assetIdsOf = (row) => row.media_config.protectedMedia.map((entry) => entry.assetId);

// The public experience listing row the catalog is built from (EXPERIENCE_PUBLIC_SELECT).
function publicListing(w) {
  return [...w.state.experiences.values()].filter((row) => row.status === "PUBLISHED").map((row) => ({ id: row.id, artist_id: row.artist_id, release_id: row.release_id, edition_id: row.edition_id, title: row.title, description: row.description, experience_type: row.experience_type, status: row.status, gated: row.requirements.length > 0, protected: row.media_config?.protected === true }));
}
// What a collector's player does: ask for the experience's own type, then read which private object the grant resolves to.
async function collectorPlays(w, experience, mediaType = experience.media.type) {
  w.repository.createGrant.mockClear();
  await w.gateway.issueGrant({ request: { headers: {}, requestId: "request-2" }, input: { wallet: holder, experienceId: experience.id, mediaType } });
  return w.repository.createGrant.mock.calls[0][0].metadata.storageKey;
}

describe("full song and demo as separate protected experiences", () => {
  it("saves each file as its own experience, with its own asset, type and unlock", async () => {
    const w = world();
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });

    expect([...w.state.experiences.keys()].sort()).toEqual(["experience-edition-1-experience-audio", "experience-edition-1-full-track"]);
    const full = stored(w, "full-track");
    const demo = stored(w, "experience-audio");
    expect(full).toMatchObject({ experience_type: "AUDIO", title: "Forgive & Forget", description: null, edition_id: "edition-1" });
    expect(demo).toMatchObject({ experience_type: "DEMO", title: "Stranger Things", description: "Stranger things have happened...", edition_id: "edition-1" });
    expect(assetIdsOf(full)).toEqual(["asset-master"]);
    expect(assetIdsOf(demo)).toEqual(["asset-demo"]);
    expect(full.media_config.protectedMedia[0].mediaType).toBe("AUDIO");
    expect(demo.media_config.protectedMedia[0].mediaType).toBe("DEMO");
    // Both are gated to holders of this edition's own token.
    for (const row of [full, demo]) expect(row.requirements).toEqual([{ type: "erc1155-balance", contract, chainId: 43113, tokenIds: ["7"], minAmount: "1" }]);
  });

  it("keeps both files through publish and the public catalog, and each plays its own private object", async () => {
    const w = world();
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    await publish(w);

    const catalog = mapPublishedCatalog({ experiences: publicListing(w) });
    const full = catalog.experiences.find((experience) => experience.id === "experience-edition-1-full-track");
    const demo = catalog.experiences.find((experience) => experience.id === "experience-edition-1-experience-audio");
    expect(full.media).toEqual({ protected: true, type: "AUDIO" });
    expect(demo.media).toEqual({ protected: true, type: "DEMO" });

    expect(await collectorPlays(w, full)).toBe("bafyprivatemaster");
    expect(await collectorPlays(w, demo)).toBe("bafyprivatedemo");
  });

  it("fails closed instead of substituting the other file when the requested type is not configured", async () => {
    const w = world();
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    await publish(w);
    const catalog = mapPublishedCatalog({ experiences: publicListing(w) });
    const full = catalog.experiences.find((experience) => experience.id === "experience-edition-1-full-track");
    const demo = catalog.experiences.find((experience) => experience.id === "experience-edition-1-experience-audio");

    await expect(collectorPlays(w, demo, "AUDIO")).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED" });
    await expect(collectorPlays(w, full, "DEMO")).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_CONFIGURED" });
    expect(w.repository.createGrant).not.toHaveBeenCalled();
  });

  it("saving again updates the same two experiences and never duplicates them or downgrades a published one", async () => {
    const w = world();
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    expect(w.state.experiences.size).toBe(2);
    expect(stored(w, "full-track")).toMatchObject({ status: "DRAFT", version: 2 });

    await publish(w);
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    expect(w.state.experiences.size).toBe(2);
    expect(stored(w, "full-track").status).toBe("PUBLISHED");
    expect(stored(w, "experience-audio").status).toBe("PUBLISHED");
    expect(w.repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_EXPERIENCE_UPDATED" }));
  });

  it("replacing one file never changes the other experience", async () => {
    const w = world({ extraAssets: [{ id: "asset-demo-2", artist_id: "artist-1", storage_key: "bafyprivatedemo2", media_type: "DEMO" }] });
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    const fullBefore = JSON.stringify(stored(w, "full-track"));

    await studioSave(w, { experienceAudio: { ...DEMO, assetId: "asset-demo-2" } });

    expect(assetIdsOf(stored(w, "experience-audio"))).toEqual(["asset-demo-2"]);
    expect(JSON.stringify(stored(w, "full-track"))).toBe(fullBefore);
    expect(w.state.experiences.size).toBe(2);

    const w2 = world({ extraAssets: [{ id: "asset-master-2", artist_id: "artist-1", storage_key: "bafyprivatemaster2", media_type: "AUDIO" }] });
    await studioSave(w2, { fullTrack: MASTER, experienceAudio: DEMO });
    const demoBefore = JSON.stringify(stored(w2, "experience-audio"));
    await studioSave(w2, { fullTrack: { ...MASTER, assetId: "asset-master-2" } });
    expect(assetIdsOf(stored(w2, "full-track"))).toEqual(["asset-master-2"]);
    expect(JSON.stringify(stored(w2, "experience-audio"))).toBe(demoBefore);
  });

  it("does not give a second experience to a file an earlier experience on the edition already unlocks", async () => {
    const earlier = { id: "experience-legacy-random", artist_id: "artist-1", release_id: "release-1", edition_id: "edition-1", title: "Full track", description: null, experience_type: "AUDIO", requirements: [{ type: "erc1155-balance", contract, chainId: 43113, tokenIds: ["7"], minAmount: "1" }], media_config: { protected: true, protectedMedia: [{ assetId: "asset-master", mediaType: "AUDIO" }] }, version: 3, status: "PUBLISHED" };
    const w = world({ extraExperiences: [earlier] });
    await studioSave(w, { fullTrack: MASTER });
    expect(w.state.experiences.size).toBe(1);
    expect(w.state.experiences.get("experience-legacy-random")).toMatchObject({ status: "PUBLISHED", version: 4 });
  });

  it("checks stored asset types on the server", async () => {
    const w = world();
    const entry = (assetId, mediaType) => ({ protected: true, protectedMedia: [{ assetId, mediaType }] });
    // A client may not re-type a file: this asset was uploaded as DEMO.
    await expect(w.studio.createExperience({ request, editionId: "edition-1", input: { title: "x", experienceType: "AUDIO", mediaConfig: entry("asset-demo", "AUDIO") } })).rejects.toMatchObject({ status: 400, code: "PROTECTED_MEDIA_TYPE_MISMATCH" });
    // A DEMO experience cannot be backed by the AUDIO master (nothing would play).
    await expect(w.studio.createExperience({ request, editionId: "edition-1", input: { title: "x", productType: "DEMO", mediaConfig: entry("asset-master", "AUDIO") } })).rejects.toMatchObject({ status: 400, code: "EXPERIENCE_MEDIA_TYPE_MISMATCH" });
    expect(w.state.experiences.size).toBe(0);
    // Updating an experience to a type that does not match its file is refused too.
    await studioSave(w, { fullTrack: MASTER });
    await expect(w.studio.updateExperience({ request, experienceId: "experience-edition-1-full-track", input: { productType: "DEMO" } })).rejects.toMatchObject({ code: "EXPERIENCE_MEDIA_TYPE_MISMATCH" });
    expect(stored(w, "full-track").experience_type).toBe("AUDIO");
  });

  it("never overwrites another edition's or artist's experience that shares an id", async () => {
    const foreign = { id: "experience-edition-1-full-track", artist_id: "artist-9", release_id: "release-9", edition_id: "edition-9", title: "Not yours", description: null, experience_type: "AUDIO", requirements: [], media_config: { protected: true, protectedMedia: [{ assetId: "asset-x", mediaType: "AUDIO" }] }, version: 1, status: "PUBLISHED" };
    const w = world({ extraExperiences: [foreign] });
    const before = JSON.stringify(w.state.experiences.get(foreign.id));
    await expect(studioSave(w, { fullTrack: MASTER })).rejects.toMatchObject({ status: 409, code: "EXPERIENCE_ID_CONFLICT" });
    expect(JSON.stringify(w.state.experiences.get(foreign.id))).toBe(before);
    expect(w.repository.saveExperience).not.toHaveBeenCalled();
  });

  it("keeps the public preview a separate, public asset that no experience can reference or replace", async () => {
    const w = world();
    await studioSave(w, { fullTrack: MASTER, experienceAudio: DEMO });
    await publish(w);

    // The preview is not a protected media asset, so it cannot be attached to an experience.
    await expect(w.studio.createExperience({ request, editionId: "edition-1", input: { title: "x", experienceType: "AUDIO", mediaConfig: { protected: true, protectedMedia: [{ storageKey: "bafypublicpreviewclip", mediaType: "AUDIO" }] } } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_OWNED" });
    // Neither experience mentions it, and it stays a valid public animation_url.
    expect(JSON.stringify([...w.state.experiences.values()])).not.toContain("bafypublicpreviewclip");
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: PREVIEW_URI })).resolves.toBe(PREVIEW_URI);
    // The private files can never be published as the preview.
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: "ipfs://bafyprivatemaster" })).rejects.toMatchObject({ code: expect.stringMatching(/PREVIEW_AUDIO_/) });
    await expect(w.studio.vettedPreviewAudio({ artistId: "artist-1", uri: "ipfs://bafyprivatedemo" })).rejects.toMatchObject({ code: expect.stringMatching(/PREVIEW_AUDIO_/) });
    // And the preview never reaches a collector's playback grant.
    const catalog = mapPublishedCatalog({ experiences: publicListing(w) });
    for (const experience of catalog.experiences) expect(["bafyprivatemaster", "bafyprivatedemo"]).toContain(await collectorPlays(w, experience));
  });

  it("an existing single demo experience keeps working exactly as designed", async () => {
    const w = world();
    await studioSave(w, { experienceAudio: DEMO });
    await publish(w);
    expect(w.state.experiences.size).toBe(1);
    const [demo] = mapPublishedCatalog({ experiences: publicListing(w) }).experiences;
    expect(await collectorPlays(w, demo)).toBe("bafyprivatedemo");
  });
});
