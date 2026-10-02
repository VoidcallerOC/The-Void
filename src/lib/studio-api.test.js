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

  it("sends a WAV master straight to private storage, then registers it by upload id", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(signed))
      .mockResolvedValueOnce(json({ id: "asset-9", mediaType: "AUDIO", byteSize: 4 }));
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200, header: () => null, text: "{}" });
    const progress = vi.fn();
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "master.wav", { type: "audio/wav" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha, onProgress: progress })).resolves.toEqual({ assetId: "asset-9", filename: "master.wav", contentType: "audio/wav", byteSize: 4 });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/studio/artists/artist-a/media/upload-url");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ mediaType: "AUDIO", filename: "master.wav", contentType: "audio/wav", byteSize: 4 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ method: "POST", url: signed.url });
    expect(send.mock.calls[0][0].body.get("network")).toBe("private");
    expect(fetchImpl.mock.calls[1][0]).toBe("/api/studio/artists/artist-a/media/register");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ uploadId: signed.uploadId, contentSha256: sha });
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
      : { ok: true, status: 204, header: () => null });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha })).resolves.toMatchObject({ assetId: "asset-10", contentType: "audio/wav", byteSize: size });
    const [create, ...patches] = send.mock.calls.map(([call]) => call);
    expect(create.headers["Upload-Length"]).toBe(String(size));
    expect(atob(create.headers["Upload-Metadata"].split(",").find((entry) => entry.startsWith("network ")).split(" ")[1])).toBe("private");
    expect(patches.map((call) => call.url)).toEqual(Array(patches.length).fill("https://uploads.pinata.cloud/v3/files/tus/abc"));
    expect(patches.map((call) => Number(call.headers["Upload-Offset"]))).toEqual([0, 50 * 1024 * 1024]);
  });

  it("waits for the stored file to appear before giving up", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(signed))
      .mockResolvedValueOnce(json({ code: "MEDIA_UPLOAD_NOT_FOUND", message: "not yet" }, 409))
      .mockResolvedValueOnce(json({ id: "asset-11" }));
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200, header: () => null });
    const wait = vi.fn().mockResolvedValue();
    const file = new File([new Uint8Array([1, 2])], "song.flac", { type: "audio/flac" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl, send, hash: async () => sha, wait })).resolves.toMatchObject({ assetId: "asset-11" });
    expect(wait).toHaveBeenCalledTimes(1);
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
