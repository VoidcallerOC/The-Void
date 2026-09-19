import { describe, expect, it, vi } from "vitest";
import { canonicalMetadata, PinataMetadataStorage } from "./metadata-storage.js";

const input = {
  artist: { name: "Voidcaller" },
  release: { title: "Summit Demo", description: "A release." },
  edition: { title: "Summit Edition", description: "The collectible.", supply: "10", tier: "standard" },
  includes: ["Full record"],
  experiences: [{ title: "Summit session", description: "A private listening room.", experience_type: "AUDIO" }],
  artwork: "https://cdn.example/summit.png",
  releaseType: "EP",
};

describe("metadata storage", () => {
  it("generates deterministic canonical metadata from domain fields", () => {
    const first = canonicalMetadata(input);
    const second = canonicalMetadata(input);
    expect(first.digest).toBe(second.digest);
    expect(first.metadata).toMatchObject({ name: "Summit Edition", artist: "Voidcaller", image: "https://cdn.example/summit.png", release: { type: "EP" } });
    expect(first.metadata.experiences[0].type).toBe("AUDIO");
  });

  it("rejects incomplete metadata input", () => {
    expect(() => canonicalMetadata({ release: input.release, edition: input.edition })).toThrow(/artist/i);
  });

  it("returns a real IPFS URI from the provider response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ IpfsHash: "bafybeigdyrzt" }) });
    const storage = new PinataMetadataStorage({ config: { endpoint: "https://pin.example/pin", jwt: "secret" }, fetchImpl });
    await expect(storage.write({ metadata: input, name: "summit" })).resolves.toMatchObject({ uri: "ipfs://bafybeigdyrzt", cid: "bafybeigdyrzt" });
    expect(fetchImpl).toHaveBeenCalledWith("https://pin.example/pin", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
  });

  it("fails closed on storage errors and invalid identifiers", async () => {
    const failed = new PinataMetadataStorage({ config: { endpoint: "https://pin.example/pin", jwt: "secret" }, fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) });
    await expect(failed.write({ metadata: input, name: "summit" })).rejects.toMatchObject({ code: "METADATA_STORAGE_UNAVAILABLE" });
    const invalid = new PinataMetadataStorage({ config: { endpoint: "https://pin.example/pin", jwt: "secret" }, fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ IpfsHash: "not-a-cid" }) }) });
    await expect(invalid.write({ metadata: input, name: "summit" })).rejects.toMatchObject({ code: "METADATA_URI_INVALID" });
  });
});
