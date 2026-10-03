import { describe, expect, it, vi } from "vitest";
import { CHUNKED_UPLOAD_THRESHOLD, MAX_FULL_TRACK_BYTES, audioContentType, studioFetch, uploadStudioArtwork, uploadStudioFullTrack, uploadStudioPreview } from "./studio-api.js";

describe("Studio API contract", () => {
  it("calls the canonical metadata publication endpoint with POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { metadataUri: "ipfs://cid" } }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(studioFetch("/studio/releases/release-a/metadata", { method: "POST", payload: { releaseType: "EP" }, headers: { authorization: "Bearer test" }, fetchImpl })).resolves.toEqual({ metadataUri: "ipfs://cid" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/studio/releases/release-a/metadata", expect.objectContaining({ method: "POST", body: JSON.stringify({ releaseType: "EP" }) }));
  });

  it("exposes a safe method and path when the deployed API returns a 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Route not found." } }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(studioFetch("/studio/releases/release-a/obsolete", { method: "POST", fetchImpl })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, endpoint: "/api/studio/releases/release-a/obsolete", message: "Route not found." });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/studio/releases/release-a/obsolete");
  });

  it("uploads artwork as base64 to the artist's artwork endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { uri: "ipfs://bafyart" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "cover.png", { type: "image/png" });
    await expect(uploadStudioArtwork({ artistId: "artist-a", file, headers: { authorization: "Bearer test" }, fetchImpl })).resolves.toEqual({ uri: "ipfs://bafyart" });
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("/api/studio/artists/artist-a/artwork");
    expect(JSON.parse(options.body)).toEqual({ data: "iVBORw==", filename: "cover.png" });
  });

  it("rejects non-image and oversized artwork before any request", async () => {
    const fetchImpl = vi.fn();
    await expect(uploadStudioArtwork({ artistId: "artist-a", file: new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }), fetchImpl })).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
    await expect(uploadStudioArtwork({ artistId: "artist-a", file: new File([new Uint8Array(3 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }), fetchImpl })).rejects.toThrow(/3 MB/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads a short public preview to the audio-preview endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { uri: "ipfs://bafypreview" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], "preview.mp3", { type: "audio/mpeg" });
    await expect(uploadStudioPreview({ artistId: "artist-a", file, fetchImpl, durationOf: async () => 30 })).resolves.toEqual({ uri: "ipfs://bafypreview" });
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("/api/studio/artists/artist-a/audio-preview");
    expect(JSON.parse(options.body)).toEqual({ data: "SUQz", filename: "preview.mp3" });
  });

  it("refuses a full-length file as the public preview before any request", async () => {
    const fetchImpl = vi.fn();
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], "whole-song.mp3", { type: "audio/mpeg" });
    await expect(uploadStudioPreview({ artistId: "artist-a", file, fetchImpl, durationOf: async () => 241 })).rejects.toThrow(/30-second clip/);
    await expect(uploadStudioPreview({ artistId: "artist-a", file: new File([new Uint8Array(5 * 1000 * 1000 + 1)], "big.mp3", { type: "audio/mpeg" }), fetchImpl, durationOf: async () => null })).rejects.toThrow(/5 MB/);
    await expect(uploadStudioPreview({ artistId: "artist-a", file: new File(["x"], "x.png", { type: "image/png" }), fetchImpl })).rejects.toThrow(/WAV, AIFF, FLAC, MP3/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const json = (data, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { "content-type": "application/json" } });
  const signed = { uploadId: "upload-00000000-0000-4000-8000-000000000000", url: "https://uploads.pinata.cloud/v3/files/signed-abc", maxBytes: MAX_FULL_TRACK_BYTES };
  const sha = "a".repeat(64);
  const FILE_ID = "0198f2a4-1111-7222-8333-944455556666";
  const CID = "bafybeiprivatemastercid0000000000000000000000000000";
  // What Pinata returns for a multipart private upload (Pinata SDK UploadResponse).
  const pinataRecord = { id: FILE_ID, name: "master.wav", cid: CID, size: 4, number_of_files: 1, mime_type: "audio/wav", group_id: null, keyvalues: { voidUploadId: "upload-00000000-0000-4000-8000-000000000000" }, created_at: "2026-10-03T00:00:00Z", network: "private" };
  const pinataOk = { ok: true, status: 200, header: () => null, text: JSON.stringify({ data: pinataRecord }) };

  it("sends a WAV master straight to private storage, then registers the exact object Pinata returned", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(signed))
      .mockResolvedValueOnce(json({ id: "asset-9", mediaType: "AUDIO", byteSize: 4 }));
    const send = vi.fn().mockResolvedValue(pinataOk);
    const progress = vi.fn();
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "master.wav", { type: "audio/wav" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha, onProgress: progress })).resolves.toEqual({ assetId: "asset-9", filename: "master.wav", contentType: "audio/wav", mediaType: "AUDIO", byteSize: 4 });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/studio/artists/artist-a/media/upload-url");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ mediaType: "AUDIO", filename: "master.wav", contentType: "audio/wav", byteSize: 4 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ method: "POST", url: signed.url });
    expect(send.mock.calls[0][0].body.get("network")).toBe("private");
    expect(JSON.parse(send.mock.calls[0][0].body.get("keyvalues"))).toEqual({ voidArtistId: "artist-a", voidUploadId: signed.uploadId, voidMediaType: "AUDIO" });
    expect(fetchImpl.mock.calls[1][0]).toBe("/api/studio/artists/artist-a/media/register");
    const registration = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(registration).toMatchObject({ uploadId: signed.uploadId, contentSha256: sha, pinataFileId: FILE_ID, cid: CID });
    expect(registration.uploadReceipt).toMatchObject({ protocol: "multipart", status: 200, network: "private", name: "master.wav", keys: Object.keys(pinataRecord).sort() });
    expect(JSON.stringify(registration.uploadReceipt)).not.toContain(CID);
    // The file bytes never go through the API.
    for (const [, options] of fetchImpl.mock.calls) expect(options.body).not.toContain("UklGRg");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "uploading", total: 4 }));
  });

  it("uses resumable chunks for masters over the single-request limit", async () => {
    const size = CHUNKED_UPLOAD_THRESHOLD + 10;
    const file = { name: "master.wav", type: "", size, slice: (start, end) => ({ size: Math.min(end, size) - start }) };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(signed)).mockResolvedValueOnce(json({ id: "asset-10", byteSize: size }));
    const send = vi.fn(async ({ method }) => method === "POST"
      ? { ok: true, status: 201, header: (name) => (name === "Location" ? "/v3/files/tus/abc" : null) }
      : { ok: true, status: 204, header: (name) => (name === "Upload-CID" ? CID : null) });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha })).resolves.toMatchObject({ assetId: "asset-10", contentType: "audio/wav", byteSize: size });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({ pinataFileId: null, cid: CID, uploadReceipt: { protocol: "tus", status: 204 } });
    const [create, ...patches] = send.mock.calls.map(([call]) => call);
    expect(create.headers["Upload-Length"]).toBe(String(size));
    expect(atob(create.headers["Upload-Metadata"].split(",").find((entry) => entry.startsWith("network ")).split(" ")[1])).toBe("private");
    expect(JSON.parse(atob(create.headers["Upload-Metadata"].split(",").find((entry) => entry.startsWith("keyvalues ")).split(" ")[1]))).toEqual({ voidArtistId: "artist-a", voidUploadId: signed.uploadId, voidMediaType: "AUDIO" });
    expect(patches.map((call) => call.url)).toEqual(Array(patches.length).fill("https://uploads.pinata.cloud/v3/files/tus/abc"));
    expect(patches.map((call) => Number(call.headers["Upload-Offset"]))).toEqual([0, 50 * 1024 * 1024]);
  });

  it("registers once and reports the exact upstream status when the object is not found", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(signed))
      .mockResolvedValueOnce(json({ code: "MEDIA_OBJECT_NOT_FOUND", message: "Private storage has no object for this upload.", details: { upstream: { endpoint: "GET /v3/files/private/{id}", status: 404, count: 0 } } }, 404));
    const send = vi.fn().mockResolvedValue(pinataOk);
    const file = new File([new Uint8Array([1, 2])], "song.flac", { type: "audio/flac" });
    const error = await uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "MEDIA_OBJECT_NOT_FOUND", phase: "private-storage" });
    expect(error.message).toContain("GET /v3/files/private/{id} → HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails at the upload step when Pinata returns no file id or CID", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(signed));
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200, header: () => null, text: "{}" });
    const file = new File([new Uint8Array([1, 2])], "song.flac", { type: "audio/flac" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha })).rejects.toMatchObject({ phase: "upload", message: expect.stringContaining("no file id or CID") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the API route only for small files when direct upload is unavailable", async () => {
    const unavailable = () => json({ code: "MEDIA_DIRECT_UPLOAD_UNAVAILABLE", message: "no" }, 503);
    const fetchImpl = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(json({ id: "asset-9" }));
    const small = new File([new Uint8Array([0x49, 0x44, 0x33])], "song.mp3", { type: "audio/mpeg" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file: small, fetchImpl, send: vi.fn() })).resolves.toMatchObject({ assetId: "asset-9" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ mediaType: "AUDIO", filename: "song.mp3", contentType: "audio/mpeg", data: "SUQz" });
    const big = { name: "master.wav", type: "audio/wav", size: 16 * 1000 * 1000 };
    const again = vi.fn().mockResolvedValueOnce(unavailable());
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file: big, fetchImpl: again, send: vi.fn() })).rejects.toThrow(/15 MB/);
  });

  it("rejects non-audio and over-limit files before any request", async () => {
    const fetchImpl = vi.fn();
    await expect(uploadStudioFullTrack({ artistId: "a", file: new File(["x"], "x.png", { type: "image/png" }), fetchImpl })).rejects.toThrow(/WAV, AIFF/);
    await expect(uploadStudioFullTrack({ artistId: "a", file: { name: "huge.wav", type: "audio/wav", size: MAX_FULL_TRACK_BYTES + 1 }, fetchImpl })).rejects.toThrow(/500 MB/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("labels a WAV the browser left untyped by its extension", () => {
    expect(audioContentType({ name: "Master Final.WAV", type: "" })).toBe("audio/wav");
    expect(audioContentType({ name: "mix.aiff", type: "application/octet-stream" })).toBe("audio/aiff");
    expect(audioContentType({ name: "notes.txt", type: "" })).toBeNull();
  });

  it("explains an upload rejected for size before it reaches the API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Request Entity Too Large", { status: 413 }));
    await expect(studioFetch("/studio/artists/a/audio-preview", { method: "POST", payload: {}, fetchImpl })).rejects.toMatchObject({ status: 413, message: "The file is too large for the upload route. Try a smaller file." });
  });
});

describe("tagging private masters so each upload is distinct", async () => {
  const { tagPrivateMaster } = await import("./studio-api.js");
  const riff = (payload) => {
    const body = new Uint8Array([...new TextEncoder().encode("WAVEfmt "), ...payload]);
    const out = new Uint8Array(8 + body.length);
    out.set(new TextEncoder().encode("RIFF"), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };

  it("appends one chunk to a WAV, keeps every original byte after the header, and fixes the RIFF size", async () => {
    const original = riff([1, 2, 3, 4]);
    const tagged = await tagPrivateMaster(new File([original], "master.wav", { type: "audio/wav" }), "void:artist-a:upload-1");
    const bytes = new Uint8Array(await tagged.arrayBuffer());
    expect(tagged.name).toBe("master.wav");
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(bytes.length - 8);
    expect(Array.from(bytes.slice(8, original.length))).toEqual(Array.from(original.slice(8)));
    const chunk = bytes.slice(original.length);
    expect(new TextDecoder().decode(chunk.slice(0, 4))).toBe("void");
    const length = new DataView(chunk.buffer).getUint32(4, true);
    expect(new TextDecoder().decode(chunk.slice(8, 8 + length))).toBe("void:artist-a:upload-1");
    expect(chunk.length % 2).toBe(0);
  });

  it("gives two uploads of the same WAV different bytes", async () => {
    const original = riff([9, 9]);
    const a = new Uint8Array(await (await tagPrivateMaster(new File([original], "m.wav"), "void:x:upload-1")).arrayBuffer());
    const b = new Uint8Array(await (await tagPrivateMaster(new File([original], "m.wav"), "void:x:upload-2")).arrayBuffer());
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("leaves non-RIFF/AIFF files and malformed headers untouched", async () => {
    const flac = new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 1])], "m.flac");
    expect(await tagPrivateMaster(flac, "t")).toBe(flac);
    const broken = riff([1, 2]);
    new DataView(broken.buffer).setUint32(4, 999, true);
    const bad = new File([broken], "bad.wav");
    expect(await tagPrivateMaster(bad, "t")).toBe(bad);
  });

  it("uses a big-endian ANNO chunk for AIFF", async () => {
    const body = new TextEncoder().encode("AIFFCOMM");
    const aiff = new Uint8Array(8 + body.length);
    aiff.set(new TextEncoder().encode("FORM"), 0);
    new DataView(aiff.buffer).setUint32(4, body.length, false);
    aiff.set(body, 8);
    const bytes = new Uint8Array(await (await tagPrivateMaster(new File([aiff], "m.aiff"), "void:a:u")).arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(4, false)).toBe(bytes.length - 8);
    expect(new TextDecoder().decode(bytes.slice(aiff.length, aiff.length + 4))).toBe("ANNO");
  });
});
