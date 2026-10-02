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
const CID = "bafybeiprivatemastercid";

function setup({ wallet = owner, file = null, previewHashes = [], existingKeys = [], maxBytes = 500 * 1024 * 1024 } = {}) {
  const db = { query: vi.fn(async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("FROM audit_events")) return { rows: previewHashes.includes(params[1]) ? [{ id: "audit-1" }] : [] };
    if (text.includes("FROM media_assets WHERE artist_id=$1 AND storage_key=$2")) return { rows: existingKeys.includes(params[1]) ? [{ id: "asset-existing", media_type: "AUDIO" }] : [] };
    if (text.includes("FROM artists a JOIN artist_owners")) return { rows: params[1] === owner ? [artistRow] : [] };
    return { rows: [] };
  }) };
  const repository = { appendAuditEvent: vi.fn(async () => ({})), saveMediaAsset: vi.fn(async (input) => ({ id: input.id, media_type: input.mediaType, created_at: "2026-10-02T00:00:00.000Z" })) };
  const direct = { maxBytes, sign: vi.fn(async () => "https://uploads.pinata.cloud/v3/files/signed-xyz"), find: vi.fn(async () => file) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository, directMediaUploads: direct, authenticator: vi.fn().mockResolvedValue({ wallet }), logger: { info: vi.fn() } });
  return { instance, repository, direct };
}

const stored = (overrides = {}) => ({ cid: CID, size: 180 * 1024 * 1024, mimeType: "audio/wav", network: "private", keyvalues: { voidArtistId: "artist-1", voidUploadId: UPLOAD_ID, voidMediaType: "AUDIO" }, ...overrides });

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
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { mediaType: "STEMS", contentType: "audio/wav", byteSize: 10 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(direct.sign).not.toHaveBeenCalled();
  });

  it("is unavailable (so the client can fall back) when storage has no direct upload", async () => {
    const { instance } = setup();
    instance.directMediaUploads = null;
    await expect(instance.createMediaUploadUrl({ request, artistId: "artist-1", input: { contentType: "audio/wav", byteSize: 10 } })).rejects.toMatchObject({ status: 503, code: "MEDIA_DIRECT_UPLOAD_UNAVAILABLE" });
  });
});

describe("registering a direct upload", () => {
  it("records the private file found under this artist's upload id and returns only an asset id", async () => {
    const { instance, repository, direct } = setup({ file: stored() });
    const result = await instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA } });
    expect(direct.find).toHaveBeenCalledWith({ keyvalues: { voidArtistId: "artist-1", voidUploadId: UPLOAD_ID } });
    expect(repository.saveMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", storageKey: CID, mediaType: "AUDIO", contentSha256: SHA, byteSize: 180 * 1024 * 1024 }));
    expect(result.id).toMatch(/^asset-/);
    expect(JSON.stringify(result)).not.toContain(CID);
  });

  it("says to retry while the file has not reached storage", async () => {
    const { instance, repository } = setup({ file: null });
    await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA } })).rejects.toMatchObject({ status: 409, code: "MEDIA_UPLOAD_NOT_FOUND" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("never records a public file or one stamped for another artist", async () => {
    for (const file of [stored({ network: "public" }), stored({ keyvalues: { voidArtistId: "artist-2", voidUploadId: UPLOAD_ID } })]) {
      const { instance, repository } = setup({ file });
      await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA } })).rejects.toMatchObject({ code: "MEDIA_UPLOAD_MISMATCH" });
      expect(repository.saveMediaAsset).not.toHaveBeenCalled();
    }
  });

  it("refuses a full track that is already public as the preview", async () => {
    const { instance, repository } = setup({ file: stored(), previewHashes: [SHA] });
    await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA } })).rejects.toMatchObject({ code: "PRIVATE_TRACK_MATCHES_PUBLIC_PREVIEW" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("is idempotent when the same upload is registered twice", async () => {
    const { instance, repository } = setup({ file: stored(), existingKeys: [CID] });
    await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: SHA } })).resolves.toMatchObject({ id: "asset-existing" });
    expect(repository.saveMediaAsset).not.toHaveBeenCalled();
  });

  it("rejects malformed upload ids and hashes before touching storage", async () => {
    const { instance, direct } = setup({ file: stored() });
    await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: "../x", contentSha256: SHA } })).rejects.toMatchObject({ status: 400 });
    await expect(instance.registerMediaUpload({ request, artistId: "artist-1", input: { uploadId: UPLOAD_ID, contentSha256: "nope" } })).rejects.toMatchObject({ status: 400 });
    expect(direct.find).not.toHaveBeenCalled();
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

  it("looks the file up in private storage by keyvalues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { files: [{ cid: "bafyx", size: 42, mime_type: "audio/wav", keyvalues: { voidUploadId: "u" } }] } }), { status: 200 }));
    await expect(storage.findSignedUpload({ keyvalues: { voidArtistId: "a", voidUploadId: "u" }, fetchImpl })).resolves.toEqual({ cid: "bafyx", size: 42, mimeType: "audio/wav", keyvalues: { voidUploadId: "u" }, network: "private" });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.pinata.cloud/v3/files/private");
    expect(url.searchParams.get("keyvalues[voidArtistId]")).toBe("a");
    expect(url.searchParams.get("keyvalues[voidUploadId]")).toBe("u");
  });
});
