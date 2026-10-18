import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { createApiHandler } from "./api-http.js";
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const request = { requestId: "request-1", headers: {} };

function repository() {
  const repo = {
    saveRelease: vi.fn(async (input) => ({ id: input.id, artist_id: input.artistId, slug: input.slug, status: input.status, release_metadata: input.metadata })),
    saveContract: vi.fn(async () => ({ id: "contract-uuid" })),
    saveEdition: vi.fn(async (input) => ({ id: input.id, release_id: input.releaseId, status: input.status, application_metadata: input.metadata })),
    saveToken: vi.fn(async (input) => input),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}

// `state` drives the stubbed database: the stored release, the non-removed track count, the edition being edited.
function service(state = {}, extra = {}) {
  const repo = repository();
  const db = { query: vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes("AS track_count")) return { rows: [{ track_count: state.tracks ?? 0 }] };
    if (text.includes("FROM releases r JOIN artist_owners")) return { rows: state.release ? [state.release] : [] };
    if (text.includes("FROM releases r JOIN artists a")) return { rows: state.release ? [{ ...state.release, display_name: "A" }] : [] };
    if (text.includes("FROM editions e JOIN releases r")) return { rows: state.edition ? [state.edition] : [] };
    if (text.includes("SELECT release_id, status FROM editions")) return { rows: state.existingEdition ? [state.existingEdition] : [] };
    if (text.includes("e.status IN ('DRAFT','REVIEW')")) return { rows: [{ id: "edition-draft", release_id: "ep-1", title: "T", status: "DRAFT", application_metadata: {} }] };
    if (text.includes("FROM tokens WHERE edition_id")) return { rows: state.submittedMetadata ? [{ "?column?": 1 }] : [] };
    if (text.includes("FROM release_contracts rc")) return { rows: state.binding ? [state.binding] : [] };
    if (text.includes("FROM artists a")) return { rows: [{ id: "artist-1", slug: "a", display_name: "A", status: "ACTIVE", owner_wallet: owner }] };
    return { rows: [] };
  }) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn(), error: vi.fn() }, ...extra });
  return { instance, repo, db };
}

const release = (releaseType, metadata = {}, status = "DRAFT") => ({ id: "ep-1", artist_id: "artist-1", slug: "ep-1", title: "My EP", description: null, status, release_metadata: releaseType === undefined ? metadata : { releaseType, ...metadata }, published_at: null, owner_wallet: owner });
const newTrack = { trackTitle: "Track", quantity: "5" };

describe("EP track cap", () => {
  it("accepts the fifth track and rejects the sixth, for EP and untyped legacy releases", async () => {
    for (const type of ["EP", undefined]) {
      const fifth = service({ release: release(type), tracks: 4 });
      await expect(fifth.instance.createEdition({ request, releaseId: "ep-1", input: newTrack })).resolves.toMatchObject({ status: "DRAFT" });
      const sixth = service({ release: release(type), tracks: 5 });
      await expect(sixth.instance.createEdition({ request, releaseId: "ep-1", input: newTrack })).rejects.toMatchObject({ status: 409, code: "EP_TRACK_LIMIT_EXCEEDED" });
      expect(sixth.repo.saveEdition).not.toHaveBeenCalled();
      expect(sixth.repo.saveToken).not.toHaveBeenCalled();
    }
  });

  it("does not limit Singles or Albums", async () => {
    for (const type of ["SINGLE", "ALBUM"]) {
      const { instance } = service({ release: release(type), tracks: 9 });
      await expect(instance.createEdition({ request, releaseId: "ep-1", input: newTrack })).resolves.toMatchObject({ status: "DRAFT" });
    }
  });

  it("lets an over-limit EP draft keep editing its existing tracks and its own details", async () => {
    const full = service({ release: release("EP"), tracks: 7, existingEdition: { release_id: "ep-1", status: "DRAFT" } });
    await expect(full.instance.createEdition({ request, releaseId: "ep-1", input: { ...newTrack, id: "edition-1" } })).resolves.toMatchObject({ id: "edition-1" });

    const edit = service({ release: release("EP"), tracks: 7, edition: { id: "edition-1", release_id: "ep-1", title: "Old", status: "DRAFT", application_metadata: {}, owner_wallet: owner } });
    await edit.instance.updateEdition({ request, editionId: "edition-1", input: { title: "Renamed" } });
    expect(edit.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Renamed", status: "DRAFT" });

    const retitle = service({ release: release("EP", { tracks: new Array(7).fill({}) }), tracks: 7 });
    await retitle.instance.updateRelease({ request, releaseId: "ep-1", input: { title: "Better title" } });
    expect(retitle.repo.saveRelease.mock.calls[0][0]).toMatchObject({ title: "Better title" });
  });

  it("reduces an over-limit unprovisioned draft by archiving a track, never deleting it", async () => {
    const edition = { id: "edition-6", release_id: "ep-1", title: "Sixth", status: "DRAFT", application_metadata: { includes: ["x"] }, owner_wallet: owner };
    const { instance, repo, db } = service({ release: release("EP"), tracks: 6, edition });
    await instance.updateEdition({ request, editionId: "edition-6", input: { status: "ARCHIVED" } });
    expect(repo.saveEdition.mock.calls[0][0]).toMatchObject({ id: "edition-6", status: "ARCHIVED", metadata: { includes: ["x"], removedDraft: true } });
    expect(db.query.mock.calls.every(([sql]) => !/DELETE\s+FROM/i.test(String(sql)))).toBe(true);
  });

  it("never lets a client set, clear or restore the removedDraft marker", async () => {
    // A published edition taken off the site must not be hidden or stop counting toward the cap.
    const published = service({ release: release("EP", {}, "PUBLISHED"), edition: { id: "edition-1", release_id: "ep-1", status: "PUBLISHED", application_metadata: {}, owner_wallet: owner } });
    await published.instance.updateEdition({ request, editionId: "edition-1", input: { status: "ARCHIVED", metadata: { removedDraft: true, note: "x" } } });
    expect(published.repo.saveEdition.mock.calls[0][0]).toMatchObject({ status: "ARCHIVED", metadata: { note: "x" } });
    expect(published.repo.saveEdition.mock.calls[0][0].metadata).not.toHaveProperty("removedDraft");

    const created = service({ release: release("EP"), tracks: 0 });
    await created.instance.createEdition({ request, releaseId: "ep-1", input: { ...newTrack, metadata: { removedDraft: true } } });
    expect(created.repo.saveEdition.mock.calls[0][0].metadata).not.toHaveProperty("removedDraft");

    // A removed draft cannot be restored (that would add a track without passing the cap) or edited.
    const removed = service({ release: release("EP"), tracks: 5, edition: { id: "edition-6", release_id: "ep-1", status: "ARCHIVED", application_metadata: { removedDraft: true }, owner_wallet: owner } });
    await expect(removed.instance.updateEdition({ request, editionId: "edition-6", input: { status: "DRAFT", metadata: {} } })).rejects.toMatchObject({ status: 409, code: "TRACK_REMOVED" });
    expect(removed.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("counts everything except removed drafts, and refuses removal once the release has its contract", async () => {
    const { instance, db } = service({ release: release("EP"), tracks: 0 });
    await instance.releaseTrackCount("ep-1");
    const sql = String(db.query.mock.calls.at(-1)[0]);
    expect(sql).toContain("NOT (status='ARCHIVED' AND application_metadata->>'removedDraft'='true')");

    const binding = { release_contract_id: "c1", release_contract_address: "0x2222222222222222222222222222222222222222", chain_id: 43113, release_key: `0x${"1".repeat(64)}` };
    const bound = service({ release: release("EP"), binding, edition: { id: "edition-6", release_id: "ep-1", status: "DRAFT", application_metadata: {}, owner_wallet: owner } });
    await expect(bound.instance.updateEdition({ request, editionId: "edition-6", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "TRACK_REMOVAL_UNAVAILABLE" });
    expect(bound.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("never removes a draft whose metadata was already submitted, even without a contract binding", async () => {
    const submitted = service({ release: release("EP"), submittedMetadata: true, edition: { id: "edition-6", release_id: "ep-1", status: "DRAFT", application_metadata: {}, owner_wallet: owner } });
    await expect(submitted.instance.updateEdition({ request, editionId: "edition-6", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ status: 409, code: "TRACK_REMOVAL_UNAVAILABLE" });
    expect(submitted.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("grandfathers a contract-bound over-limit EP: records stay, edits work, no new track or submission", async () => {
    const binding = { release_contract_id: "c1", release_contract_address: "0x2222222222222222222222222222222222222222", chain_id: 43113, release_key: `0x${"1".repeat(64)}` };
    const state = { release: release("EP", {}, "PUBLISHED"), binding, tracks: 7, edition: { id: "edition-1", release_id: "ep-1", title: "Old", status: "DRAFT", application_metadata: {}, owner_wallet: owner } };
    const grandfathered = service(state, { metadataStorage: { write: vi.fn() } });
    await expect(grandfathered.instance.createEdition({ request, releaseId: "ep-1", input: newTrack })).rejects.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
    await expect(grandfathered.instance.publishMetadata({ request, releaseId: "ep-1", input: {} })).rejects.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
    await expect(grandfathered.instance.updateEdition({ request, editionId: "edition-1", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "TRACK_REMOVAL_UNAVAILABLE" });
    await expect(grandfathered.instance.updateRelease({ request, releaseId: "ep-1", input: { title: "Retitled" } })).resolves.toBeTruthy();
    // No forced conversion: the type is only ever changed by the artist's own request.
    expect(grandfathered.repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("EP");
    expect(grandfathered.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("refuses to submit an over-limit EP until it is back within five tracks", async () => {
    const metadataStorage = { write: vi.fn() };
    const over = service({ release: release("EP"), tracks: 6 }, { metadataStorage });
    await expect(over.instance.publishMetadata({ request, releaseId: "ep-1", input: {} })).rejects.toMatchObject({ status: 409, code: "EP_TRACK_LIMIT_EXCEEDED" });
    expect(metadataStorage.write).not.toHaveBeenCalled();
    // Five is within the cap: the guard passes and the next unrelated check fires instead.
    const ok = service({ release: release("EP"), tracks: 5 }, { metadataStorage });
    await expect(ok.instance.publishMetadata({ request, releaseId: "ep-1", input: {} })).rejects.not.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
  });

  it("rejects a legacy metadata.tracks list above the cap on create and update, but not a trimmed one", async () => {
    const six = new Array(6).fill({ title: "t" });
    const create = service({});
    await expect(create.instance.createRelease({ request, artistId: "artist-1", input: { title: "EP", releaseType: "EP", metadata: { tracks: six } } })).rejects.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
    await expect(create.instance.createRelease({ request, artistId: "artist-1", input: { title: "EP", releaseType: "EP", metadata: { tracks: six.slice(0, 5) } } })).resolves.toBeTruthy();

    const grow = service({ release: release("EP", { tracks: six.slice(0, 5) }) });
    await expect(grow.instance.updateRelease({ request, releaseId: "ep-1", input: { metadata: { tracks: six } } })).rejects.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
    const trim = service({ release: release("EP", { tracks: new Array(8).fill({}) }) });
    await expect(trim.instance.updateRelease({ request, releaseId: "ep-1", input: { metadata: { tracks: six } } })).resolves.toBeTruthy();
  });
});

describe("switching an unprovisioned draft from EP to Single", () => {
  it("keeps the release id and slug and stores SINGLE", async () => {
    const { instance, repo } = service({ release: release("EP", { artwork: "ipfs://art" }), tracks: 1 });
    await instance.updateRelease({ request, releaseId: "ep-1", input: { releaseType: "SINGLE" } });
    expect(repo.saveRelease).toHaveBeenCalledTimes(1);
    expect(repo.saveRelease.mock.calls[0][0]).toMatchObject({ id: "ep-1", slug: "ep-1", artistId: "artist-1", status: "DRAFT", metadata: { releaseType: "SINGLE", artwork: "ipfs://art" } });
  });

  it("is refused while the draft still has several tracks, with nothing saved", async () => {
    const { instance, repo } = service({ release: release("EP"), tracks: 3 });
    await expect(instance.updateRelease({ request, releaseId: "ep-1", input: { releaseType: "SINGLE" } })).rejects.toMatchObject({ status: 409, code: "SINGLE_REQUIRES_ONE_TRACK" });
    expect(repo.saveRelease).not.toHaveBeenCalled();
    const listed = service({ release: release("EP", { tracks: [{}, {}] }), tracks: 1 });
    await expect(listed.instance.updateRelease({ request, releaseId: "ep-1", input: { releaseType: "SINGLE" } })).rejects.toMatchObject({ code: "SINGLE_REQUIRES_ONE_TRACK" });
  });

  it("leaves an existing Single's own behavior alone", async () => {
    const { instance, repo } = service({ release: release("SINGLE"), tracks: 1 });
    await instance.updateRelease({ request, releaseId: "ep-1", input: { title: "Renamed single" } });
    expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("SINGLE");
  });
});

describe("direct API attempts to bypass the cap", () => {
  const respond = () => ({ status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const call = async (studioService, method, url, body) => {
    const response = respond();
    await createApiHandler({ service: {}, studioService })({ method, url, headers: { "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }, response);
    return { status: response.status, body: JSON.parse(response.body || "{}") };
  };

  it("returns 409 EP_TRACK_LIMIT_EXCEEDED for a sixth track posted straight to the edition route", async () => {
    const { instance, repo } = service({ release: release("EP"), tracks: 5 });
    const result = await call(instance, "POST", "/api/studio/releases/ep-1/editions", newTrack);
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain("EP_TRACK_LIMIT_EXCEEDED");
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });

  it("cannot be bypassed by a client-chosen edition id, a release PATCH or a release POST", async () => {
    const { instance, repo } = service({ release: release("EP"), tracks: 5 });
    const withId = await call(instance, "POST", "/api/studio/releases/ep-1/editions", { ...newTrack, id: "edition-brand-new" });
    expect(withId.status).toBe(409);
    const six = new Array(6).fill({ title: "t" });
    expect((await call(instance, "PATCH", "/api/studio/releases/ep-1", { releaseType: "EP", metadata: { releaseType: "EP", tracks: six } })).status).toBe(409);
    expect((await call(instance, "POST", "/api/studio/artists/artist-1/releases", { title: "New EP", releaseType: "ep", metadata: { tracks: six } })).status).toBe(409);
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveRelease).not.toHaveBeenCalled();
  });

  it("cannot sneak a sixth track in by switching types around the cap", async () => {
    // Single -> EP is not a loophole: the count is by stored edition rows, not by what the client says.
    const { instance } = service({ release: release("SINGLE"), tracks: 5 });
    await instance.updateRelease({ request, releaseId: "ep-1", input: { releaseType: "EP" } });
    const back = service({ release: release("EP"), tracks: 5 });
    await expect(back.instance.createEdition({ request, releaseId: "ep-1", input: newTrack })).rejects.toMatchObject({ code: "EP_TRACK_LIMIT_EXCEEDED" });
  });
});
