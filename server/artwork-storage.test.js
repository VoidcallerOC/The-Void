import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { MAX_ARTWORK_BYTES, MAX_AUDIO_BYTES, createPinataArtworkUploader, sniffArtwork, sniffAudio } from "./artwork-storage.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from("GIF89a\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("public artwork storage", () => {
  it("identifies images from their bytes, never the declared type", () => {
    expect(sniffArtwork(PNG)).toEqual({ contentType: "image/png", extension: ".png" });
    expect(sniffArtwork(JPEG)).toEqual({ contentType: "image/jpeg", extension: ".jpg" });
    expect(sniffArtwork(GIF)).toEqual({ contentType: "image/gif", extension: ".gif" });
    expect(sniffArtwork(WEBP)).toEqual({ contentType: "image/webp", extension: ".webp" });
    expect(sniffArtwork(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffArtwork(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffArtwork(Buffer.alloc(0))).toBeNull();
  });

  it("caps uploads at 3 MB so the base64 body fits the /api rewrite", () => {
    expect(MAX_ARTWORK_BYTES).toBe(3 * 1024 * 1024);
  });

  it("pins artwork publicly on IPFS and returns an ipfs:// URI", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { cid: CID } }), { status: 200 }));
    const upload = createPinataArtworkUploader({ jwt: "test-jwt", fetchImpl });
    await expect(upload({ body: PNG, filename: "artwork.png", contentType: "image/png" })).resolves.toEqual({ uri: `ipfs://${CID}` });
    const [endpoint, options] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("https://uploads.pinata.cloud/v3/files");
    expect(options.headers.authorization).toBe("Bearer test-jwt");
    expect(options.body.get("network")).toBe("public");
    expect(options.body.get("file").type).toBe("image/png");
  });

  it("explains a Pinata key without file-upload permission", async () => {
    const upload = createPinataArtworkUploader({ jwt: "test-jwt", fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 403 })) });
    await expect(upload({ body: PNG, filename: "artwork.png", contentType: "image/png" })).rejects.toMatchObject({ code: "ARTWORK_UPLOAD_UNAUTHORIZED", message: expect.stringMatching(/file-upload permission/) });
  });

  it("rejects a response without a valid CID", async () => {
    const upload = createPinataArtworkUploader({ jwt: "test-jwt", fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { cid: "../../etc" } }), { status: 200 })) });
    await expect(upload({ body: PNG, filename: "artwork.png", contentType: "image/png" })).rejects.toMatchObject({ code: "ARTWORK_UPLOAD_FAILED" });
  });

  it("identifies track audio from its bytes and rejects everything else", () => {
    expect(sniffAudio(Buffer.from("ID3\x04\x00", "latin1"))).toEqual({ contentType: "audio/mpeg", extension: ".mp3" });
    expect(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toEqual({ contentType: "audio/mpeg", extension: ".mp3" });
    expect(sniffAudio(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]))).toEqual({ contentType: "audio/wav", extension: ".wav" });
    expect(sniffAudio(Buffer.from("fLaC\x00", "latin1"))).toEqual({ contentType: "audio/flac", extension: ".flac" });
    expect(sniffAudio(Buffer.from("OggS\x00", "latin1"))).toEqual({ contentType: "audio/ogg", extension: ".ogg" });
    expect(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]))).toEqual({ contentType: "audio/mp4", extension: ".m4a" });
    expect(sniffAudio(PNG)).toBeNull();
    expect(sniffAudio(WEBP)).toBeNull();
    expect(sniffAudio(Buffer.from("<html>"))).toBeNull();
    expect(MAX_AUDIO_BYTES).toBe(15 * 1000 * 1000);
  });
});
