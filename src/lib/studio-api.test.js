import { describe, expect, it, vi } from "vitest";
import { studioFetch, uploadStudioArtwork, uploadStudioFullTrack, uploadStudioPreview } from "./studio-api.js";

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
    await expect(uploadStudioPreview({ artistId: "artist-a", file: new File(["x"], "x.png", { type: "image/png" }), fetchImpl })).rejects.toThrow(/MP3, WAV/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads the full track privately and returns only an asset id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: "asset-9", mediaType: "AUDIO" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = new File([new Uint8Array([0x49, 0x44, 0x33])], "song.mp3", { type: "audio/mpeg" });
    await expect(uploadStudioFullTrack({ artistId: "artist-a", file, fetchImpl })).resolves.toEqual({ assetId: "asset-9", filename: "song.mp3", contentType: "audio/mpeg" });
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("/api/studio/artists/artist-a/media");
    expect(JSON.parse(options.body)).toEqual({ mediaType: "AUDIO", filename: "song.mp3", contentType: "audio/mpeg", data: "SUQz" });
  });

  it("explains an upload rejected for size before it reaches the API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Request Entity Too Large", { status: 413 }));
    await expect(studioFetch("/studio/artists/a/audio-preview", { method: "POST", payload: {}, fetchImpl })).rejects.toMatchObject({ status: 413, message: "The file is too large for the upload route. Try a smaller file." });
  });
});
