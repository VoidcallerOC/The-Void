import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService, DIRECT_AUDIO_MIME_TYPES } from "./studio-service.js";
import { PrivateMediaStorage } from "./media-storage.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";

// Lossless masters (WAV) are too big for an API request body, so the browser
// uploads them straight to PRIVATE storage through a link the API signs, and
// the API then records the file it finds under that link's keyvalues.

const owner = "0x1111111111111111111111111111111111111111";
const artistRow = { id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" };
const request = { requestId: "request-1", headers: {} };
const UPLOAD_ID = "upload-00000000-0000-4000-8000-000000000000";
const SHA = "b".repeat(64);
const CID = "bafybeiprivatemastercid0000000000000000000000000000";

function setup({ wallet = owner, file = null, previewHashes = [], existingKeys = [], issued = [UPLOAD_ID], storedSha = SHA, existingSha = SHA, existingArtist = "artist-1", ownedArtists = ["artist-1"], assetInUse = false, reassigned = [], storedBytes = null, maxBytes = 500 * 1024 * 1024 } = {}) {
  const db = { query: vi.fn(async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("STUDIO_MEDIA_UPLOAD_ISSUED")) return { rows: issued.includes(params[1]) ? [{ id: "audit-issued" }] : [] };
    if (text.includes("FROM audit_events")) return { rows: previewHashes.includes(params[1]) ? [{ id: "audit-1" }] : [] };
    if (text.includes("FROM media_assets WHERE storage_key=$1")) return { rows: existingKeys.includes(params[0]) ? [{ id: "asset-existing", artist_id: existingArtist, media_type: "AUDIO", content_sha256: existingSha }] : [] };
    if (text.includes("FROM artist_owners WHERE artist_id=$1 AND owner_wallet=$2")) return { rows: ownedArtists.includes(params[0]) && params[1] === wallet ? [{ "?column?": 1 }] : [] };
    if (text.includes("FROM experiences WHERE media_config")) return { rows: assetInUse ? [{ "?column?": 1 }] : [] };
    if (text.startsWith("UPDATE media_assets SET artist_id")) { reassigned.push(params); return { rows: [] }; }
    if (text.includes("FROM artists a JOIN artist_owners")) return { rows: params[1] === owner ? [artistRow] : [] };
    return { rows: [] };
  }) };
  const repository = { appendAuditEvent: vi.fn(async () => ({})), saveMediaAsset: vi.fn(async (input) => ({ id: input.id, media_type: input.mediaType, created_at: "2026-10-02T00:00:00.000Z" })) };
  const upstream = { endpoint: "GET /v3/files/private/{id}", status: file ? 200 : 404, count: file ? 1 : 0, files: [] };
  const direct = { maxBytes, sign: vi.fn(async () => "https://uploads.pinata.cloud/v3/files/signed-xyz"), get: vi.fn(async () => ({ file, upstream })), sha256: vi.fn(async () => ({ sha256: storedSha, bytes: storedBytes ?? file?.size, download: { status: 200 } })) };
  const logger = { info: vi.fn(), error: vi.fn() };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository, directMediaUploads: direct, authenticator: vi.fn().mockResolvedValue({ wallet }), logger });
  return { instance, repository, direct, logger, reassigned };
}

const FILE_ID = "0198f2a4-1111-7222-8333-944455556666";
const IDENTITY = { pinataFileId: FILE_ID };
const stored = (overrides = {}) => ({ id: FILE_ID, cid: CID, size: 180 * 1024 * 1024, mimeType: "audio/wav", network: "private", keyvalues: { voidArtistId: "artist-1", voidUploadId: UPLOAD_ID, voidMediaType: "AUDIO" }, ...overrides });

describe("direct private upload link", () => {
  it("issues a private, audio-only, size-capped link stamped with the artist and an upload id", async () => {
    const { instance, direct, repository } = setup();
    const result = await instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "AUDIO", filename: "master.wav", contentType: "audio/wav", byteSize: 180 * 1024 * 1024 } });
    expect(result).toMatchObject({ url: "https://uploads.pinata.cloud/v3/files/signed-xyz", maxBytes: 500 * 1024 * 1024 });
    expect(result.uploadId).toMatch(/^upload-[0-9a-f-]{36}$/);
    const signed = direct.sign.mock.calls[0][0];
    expect(signed).toMatchObject({ filename: "master.wav", maxBytes: 500 * 1024 * 1024, expiresSeconds: 900, keyvalues: { voidArtistId: "artist-1", voidUploadId: result.uploadId, voidMediaType: "AUDIO" } });
    expect(signed.mimeTypes).toContain("audio/wav");
    expect(signed.mimeTypes.every((type) => type.startsWith("audio/"))).toBe(true);
    expect(repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_MEDIA_UPLOAD_ISSUED" }));
  });

  it("refuses wallets that do not own the artist, non-audio files and oversized files", async () => {
    const stranger = setup({ wallet: "0x2222222222222222222222222222222222222222" });
    await expect(stranger.instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { contentType: "audio/wav", byteSize: 10 } })).rejects.toMatchObject({ status: 403 });
    const { instance, direct } = setup({ maxBytes: 100 });
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { contentType: "video/mp4", byteSize: 10 } })).rejects.toMatchObject({ code: "AUDIO_TYPE_UNSUPPORTED" });
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { contentType: "audio/wav", byteSize: 101 } })).rejects.toMatchObject({ status: 413 });
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "VIDEO", contentType: "audio/wav", byteSize: 10 } })).rejects.toMatchObject({ code: "MEDIA_TYPE_UNSUPPORTED" });
    expect(direct.sign).not.toHaveBeenCalled();
  });


  it("issues a video link for a music video and a zip-or-audio link for stems and downloads", async () => {
    const video = setup();
    await video.instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "VIDEO", filename: "clip.mp4", contentType: "video/mp4", byteSize: 10 } });
    expect(video.direct.sign.mock.calls[0][0]).toMatchObject({ keyvalues: expect.objectContaining({ voidMediaType: "VIDEO" }) });
    expect(video.direct.sign.mock.calls[0][0].mimeTypes).toEqual(expect.arrayContaining(["video/mp4"]));
    expect(video.direct.sign.mock.calls[0][0].mimeTypes.every((type) => type.startsWith("video/"))).toBe(true);
    const stems = setup();
    await stems.instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "STEMS", filename: "stems.zip", contentType: "application/zip", byteSize: 10 } });
    expect(stems.direct.sign.mock.calls[0][0].mimeTypes).toEqual(expect.arrayContaining(["application/zip", "audio/wav"]));
    expect(stems.direct.sign.mock.calls[0][0].keyvalues.voidMediaType).toBe("STEMS");
    const download = setup();
    await download.instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "DOWNLOAD", filename: "thanks.mp4", contentType: "video/mp4", byteSize: 10 } });
    expect(download.direct.sign.mock.calls[0][0].keyvalues.voidMediaType).toBe("DOWNLOAD");
    expect(download.direct.sign.mock.calls[0][0].mimeTypes).toEqual(expect.arrayContaining(["video/mp4", "application/zip", "audio/wav"]));
  });

  it("is unavailable (so the client can fall back) when storage has no direct upload", async () => {
    const { instance } = setup();
    instance.directMediaUploads = null;
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { contentType: "audio/wav", byteSize: 10 } })).rejects.toMatchObject({ status: 503, code: "MEDIA_DIRECT_UPLOAD_UNAVAILABLE" });
  });
});

describe("registering a direct upload", () => {
  const register = (instance, input = {}) => instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA, ...IDENTITY, ...input } });

  it("looks up exactly the object Pinata returned, verifies its stored SHA-256, and returns only an asset id", async () => {
    const { instance, repository, direct } = setup({ file: stored() });
    const result = await register(instance);
    expect(direct.get).toHaveBeenCalledWith({ fileId: FILE_ID, cid: null });
    expect(direct.sha256).toHaveBeenCalledWith({ cid: CID });
    expect(repository.saveMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", storageKey: CID, mediaType: "AUDIO", contentSha256: SHA, byteSize: 180 * 1024 * 1024 }));
    expect(result.id).toMatch(/^asset-/);
    expect(JSON.stringify(result)).not.toContain(CID);
  });

  it("accepts the tus Upload-CID as the identity", async () => {
    const { instance, direct } = setup({ file: stored() });
    await register(instance, { pinataFileId: undefined, cid: CID });
    expect(direct.get).toHaveBeenCalledWith({ fileId: null, cid: CID });
  });

  it("requires an object identity instead of searching storage by metadata", async () => {
    const { instance, direct } = setup({ file: stored() });
    await expect(register(instance, { pinataFileId: undefined })).rejects.toMatchObject({ status: 400, code: "UPLOAD_IDENTITY_REQUIRED" });
    expect(direct.get).not.toHaveBeenCalled();
  });

  it("refuses an upload id this server never issued to the artist", async () => {
    const { instance, direct } = setup({ file: stored(), issued: [] });
    await expect(register(instance)).rejects.toMatchObject({ status: 403, code: "UPLOAD_NOT_ISSUED" });
    expect(direct.get).not.toHaveBeenCalled();
  });

  it("reports the exact upstream lookup when the object is missing, and logs the evidence", async () => {
    const { instance, repository, logger } = setup({ file: null });
    const error = await register(instance).catch((caught) => caught);
    expect(error).toMatchObject({ status: 404, code: "MEDIA_OBJECT_NOT_FOUND", details: { upstream: { endpoint: "GET /v3/files/private/{id}", status: 404, count: 0 } } });
    expect(error.message).toContain("HTTP 404");
    expect(logger.error).toHaveBeenCalledWith("MEDIA_UPLOAD_VERIFY", expect.objectContaining({ outcome: "MEDIA_OBJECT_NOT_FOUND", pinataFileId: FILE_ID }));
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("never records a public object, another artist's object, a different CID, or non-audio", async () => {
    const cases = [
      [stored({ network: "public" }), {}, "MEDIA_UPLOAD_NOT_PRIVATE"],
      [stored({ keyvalues: { voidArtistId: "artist-2", voidUploadId: UPLOAD_ID } }), {}, "MEDIA_UPLOAD_MISMATCH"],
      [stored({ keyvalues: {} }), {}, "MEDIA_UPLOAD_MISMATCH"],
      [stored(), { cid: "bafybeiotherobject000000000000000000000000000000" }, "MEDIA_UPLOAD_MISMATCH"],
      [stored({ mimeType: "video/mp4" }), {}, "AUDIO_TYPE_UNSUPPORTED"],
      [stored({ cid: "pending" }), {}, "MEDIA_CID_PENDING"],
    ];
    for (const [file, input, code] of cases) {
      const { instance, repository } = setup({ file });
      await expect(register(instance, input)).rejects.toMatchObject({ code });
      expect(repository.saveMediaAsset).not.toHaveBeenCalled();
    }
  });

  it("accepts a Pinata duplicate stamped by an earlier upload link issued to the same artist", async () => {
    const EARLIER = "upload-11111111-1111-4111-8111-111111111111";
    const { instance, repository } = setup({ file: stored({ keyvalues: { voidArtistId: "artist-1", voidUploadId: EARLIER, voidMediaType: "AUDIO" } }), issued: [UPLOAD_ID, EARLIER] });
    await expect(register(instance)).resolves.toMatchObject({ id: expect.stringMatching(/^asset-/) });
    expect(repository.saveMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ storageKey: CID }));
  });

  it("refuses a duplicate whose stamped upload link was never issued to this artist", async () => {
    const OTHER = "upload-22222222-2222-4222-8222-222222222222";
    const { instance, repository } = setup({ file: stored({ keyvalues: { voidArtistId: "artist-1", voidUploadId: OTHER } }) });
    await expect(register(instance)).rejects.toMatchObject({ code: "MEDIA_UPLOAD_MISMATCH" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("moves an unused asset from a sibling artist profile owned by the same wallet", async () => {
    const EARLIER = "upload-11111111-1111-4111-8111-111111111111";
    const reassigned = [];
    const { instance, repository } = setup({ file: stored({ keyvalues: { voidArtistId: "artist-0", voidUploadId: EARLIER } }), issued: [UPLOAD_ID, EARLIER], existingKeys: [CID], existingArtist: "artist-0", ownedArtists: ["artist-1", "artist-0"], reassigned });
    await expect(register(instance)).resolves.toMatchObject({ id: "asset-existing" });
    expect(reassigned).toEqual([["artist-1", "asset-existing", "artist-0"]]);
    expect(repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_MEDIA_REASSIGNED" }));
  });

  it("never takes an asset from an artist this wallet does not own, or one already used by a release", async () => {
    const EARLIER = "upload-11111111-1111-4111-8111-111111111111";
    const foreign = setup({ file: stored({ keyvalues: { voidArtistId: "artist-9", voidUploadId: EARLIER } }), issued: [UPLOAD_ID, EARLIER], existingKeys: [CID], existingArtist: "artist-9" });
    await expect(register(foreign.instance)).rejects.toMatchObject({ code: "MEDIA_UPLOAD_MISMATCH" });
    const used = setup({ file: stored({ keyvalues: { voidArtistId: "artist-0", voidUploadId: EARLIER } }), issued: [UPLOAD_ID, EARLIER], existingKeys: [CID], existingArtist: "artist-0", ownedArtists: ["artist-1", "artist-0"], assetInUse: true });
    await expect(register(used.instance)).rejects.toMatchObject({ code: "MEDIA_ASSET_IN_USE" });
    expect(used.reassigned).toEqual([]);
  });

  it("treats Pinata's size as the DAG size: verifies the hash against the browser's byte count", async () => {
    const fileBytes = 180 * 1024 * 1024 - 12733; // Pinata size includes UnixFS overhead
    const { instance, repository } = setup({ file: stored(), storedBytes: fileBytes });
    await expect(register(instance, { byteSize: fileBytes })).resolves.toMatchObject({ byteSize: fileBytes });
    expect(repository.saveMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ byteSize: fileBytes }));
    expect(repository.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_MEDIA_UPLOADED", payload: expect.objectContaining({ hashVerified: true }) }));
    const wrongSize = setup({ file: stored(), storedBytes: fileBytes });
    await expect(register(wrongSize.instance, { byteSize: fileBytes - 1 })).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
    const wrongHash = setup({ file: stored(), storedBytes: fileBytes, storedSha: "e".repeat(64) });
    await expect(register(wrongHash.instance, { byteSize: fileBytes })).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
    expect(wrongHash.repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("refuses when the stored bytes do not hash to the declared SHA-256", async () => {
    const { instance, repository } = setup({ file: stored(), storedSha: "c".repeat(64) });
    await expect(register(instance)).rejects.toMatchObject({ status: 409, code: "MEDIA_HASH_MISMATCH" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("refuses a full track that is already public as the preview", async () => {
    const { instance, repository } = setup({ file: stored(), previewHashes: [SHA] });
    await expect(register(instance)).rejects.toMatchObject({ code: "PRIVATE_TRACK_MATCHES_PUBLIC_PREVIEW" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("is idempotent when the same object is registered twice, and logs it", async () => {
    const { instance, repository, logger } = setup({ file: stored(), existingKeys: [CID] });
    await expect(register(instance)).resolves.toMatchObject({ id: "asset-existing" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("MEDIA_UPLOAD_VERIFY", expect.objectContaining({ outcome: "ALREADY_REGISTERED", assetId: "asset-existing" }));
  });

  it("refuses to return an existing asset whose recorded SHA-256 differs", async () => {
    const { instance } = setup({ file: stored(), existingKeys: [CID], existingSha: "d".repeat(64) });
    await expect(register(instance)).rejects.toMatchObject({ code: "MEDIA_HASH_MISMATCH" });
  });

  it("rejects malformed upload ids, hashes and identities before touching storage", async () => {
    const { instance, direct } = setup({ file: stored() });
    await expect(register(instance, { uploadId: "../x" })).rejects.toMatchObject({ status: 400 });
    await expect(register(instance, { contentSha256: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(register(instance, { pinataFileId: "../../files/public" })).rejects.toMatchObject({ code: "INVALID_PINATA_FILE_ID" });
    await expect(register(instance, { pinataFileId: undefined, cid: "not-a-cid" })).rejects.toMatchObject({ code: "INVALID_CID" });
    expect(direct.get).not.toHaveBeenCalled();
  });
});

describe("Pinata signed upload requests", () => {
  const storage = new PrivateMediaStorage({ config: { driver: "pinata", maxBytes: 500, signedUrlTtlSeconds: 60, pinata: { jwt: "jwt-test", gateway: "https://gw.example", endpoint: "https://api.pinata.cloud/v3/files/private/download_link" } }, signer: async () => "" });

  it("signs a private-network upload with the size cap, mime list and keyvalues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: "https://uploads.pinata.cloud/v3/files/signed" }), { status: 200 }));
    await expect(storage.createSignedUpload({ filename: "master.wav", keyvalues: { voidUploadId: "u" }, maxBytes: 500, mimeTypes: DIRECT_AUDIO_MIME_TYPES, fetchImpl })).resolves.toBe("https://uploads.pinata.cloud/v3/files/signed");
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://uploads.pinata.cloud/v3/files/sign");
    expect(options.headers.authorization).toBe("Bearer jwt-test");
    expect(JSON.parse(options.body)).toMatchObject({ network: "private", max_file_size: 500, expires: 900, filename: "master.wav", keyvalues: { voidUploadId: "u" } });
  });

  it("explains a key without upload permission", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(storage.createSignedUpload({ keyvalues: {}, maxBytes: 1, mimeTypes: [], fetchImpl })).rejects.toMatchObject({ code: "MEDIA_UPLOAD_UNAUTHORIZED" });
  });

  it("gets the exact private object by Pinata file id (GET /v3/files/private/{id})", async () => {
    const record = { id: "0198f2a4-1111-7222-8333-944455556666", name: "master.wav", cid: "bafybeiprivatemastercid0000000000000000000000000000", size: 42, number_of_files: 1, mime_type: "audio/wav", keyvalues: { voidUploadId: "u" }, group_id: null, created_at: "2026-10-03T00:00:00Z" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: record }), { status: 200 }));
    const { file, upstream } = await storage.getPrivateUpload({ fileId: record.id, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.pinata.cloud/v3/files/private/${record.id}`);
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer jwt-test");
    expect(file).toMatchObject({ id: record.id, cid: record.cid, size: 42, mimeType: "audio/wav", network: "private", keyvalues: { voidUploadId: "u" } });
    expect(upstream).toMatchObject({ status: 200, count: 1 });
    expect(JSON.stringify(upstream)).not.toContain(record.cid);
  });

  it("gets the object by CID (GET /v3/files/private?cid=) and reports a 404 as missing with evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { files: [{ id: "f1", cid: "bafyx", size: 1, mime_type: "audio/wav", keyvalues: {} }], next_page_token: "" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const byCid = await storage.getPrivateUpload({ cid: "bafyx", fetchImpl });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.pinata.cloud/v3/files/private");
    expect(url.searchParams.get("cid")).toBe("bafyx");
    expect(byCid.file).toMatchObject({ id: "f1", cid: "bafyx" });
    const missing = await storage.getPrivateUpload({ fileId: "0198f2a4-1111-7222-8333-944455556666", fetchImpl });
    expect(missing).toMatchObject({ file: null, upstream: { status: 404, count: 0 } });
  });

  it("surfaces a non-404 upstream failure with its status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{\"error\":\"Unauthorized\"}", { status: 403 }));
    await expect(storage.getPrivateUpload({ fileId: "0198f2a4-1111-7222-8333-944455556666", fetchImpl })).rejects.toMatchObject({ code: "MEDIA_UPLOAD_LOOKUP_FAILED", upstream: { status: 403 } });
  });

  it("refuses a partial download instead of hashing it", async () => {
    const hashing = new PrivateMediaStorage({ config: { driver: "pinata", maxBytes: 500, signedUrlTtlSeconds: 60, pinata: { jwt: "j", gateway: "https://gw.example", endpoint: "x" } }, signer: async (cid) => `https://gw.example/files/${cid}` });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("hel", { status: 206, headers: { "content-range": "bytes 0-2/5" } }));
    await expect(hashing.sha256OfPrivateObject({ cid: "bafyx", fetchImpl })).rejects.toMatchObject({ code: "MEDIA_HASH_UNVERIFIED", upstream: { status: 206 } });
  });

  it("hashes the stored private object through a signed download link", async () => {
    const hashing = new PrivateMediaStorage({ config: { driver: "pinata", maxBytes: 500, signedUrlTtlSeconds: 60, pinata: { jwt: "j", gateway: "https://gw.example", endpoint: "x" } }, signer: async (cid) => `https://gw.example/files/${cid}?sig=1` });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("hello"));
    await expect(hashing.sha256OfPrivateObject({ cid: "bafyx", fetchImpl })).resolves.toMatchObject({ sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", bytes: 5, download: { status: 200 } });
    expect(fetchImpl).toHaveBeenCalledWith("https://gw.example/files/bafyx?sig=1", { headers: { "accept-encoding": "identity" } });
  });
});
