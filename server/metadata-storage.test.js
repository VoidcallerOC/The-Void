import { describe, expect, it, vi } from "vitest";
import { canonicalMetadata, PinataMetadataStorage, resolveTrackDescription } from "./metadata-storage.js";

const input = {
  artist: { name: "Voidcaller" },
  release: { title: "Summit Demo", description: "A release." },
  edition: { title: "Summit Edition", description: "The collectible.", supply: "10", tier: "standard" },
  includes: ["Full record"],
  experiences: [{ title: "Summit session", description: "A private listening room.", experience_type: "AUDIO" }],
  artwork: "https://cdn.example/summit.png",
  releaseType: "EP",
};

describe("track description fallback", () => {
  it("uses the release description when the track description is blank", () => {
    expect(resolveTrackDescription("", "The space between Silence and Sound")).toBe("The space between Silence and Sound");
  });

  it("lets a non-empty track description win", () => {
    expect(resolveTrackDescription("A different description for this song", "The space between Silence and Sound")).toBe("A different description for this song");
  });

  it("returns null when both descriptions are empty", () => {
    expect(resolveTrackDescription("", "")).toBeNull();
  });

  it("resumes the release fallback after a custom track description is cleared", () => {
    expect(resolveTrackDescription("   ", "The space between Silence and Sound")).toBe("The space between Silence and Sound");
  });

  it("uses the current release description when a track has no custom description", () => {
    expect(resolveTrackDescription(null, "An updated release description")).toBe("An updated release description");
  });

  it("does not mutate the release description while building track metadata", () => {
    const release = { title: "The Record", description: "The space between Silence and Sound" };
    const edition = { title: "Track One", description: "   ", supply: "10" };
    const originalRelease = structuredClone(release);
    const generated = canonicalMetadata({ release, edition, artist: { name: "Voidcaller" } });
    expect(generated.metadata.description).toBe("The space between Silence and Sound");
    expect(release).toEqual(originalRelease);
    expect(release.description).toBe("The space between Silence and Sound");
  });
});

describe("metadata storage", () => {
  it("generates deterministic canonical metadata from domain fields", () => {
    const first = canonicalMetadata(input);
    const second = canonicalMetadata(input);
    expect(first.digest).toBe(second.digest);
    expect(first.metadata).toMatchObject({ name: "Summit Edition", artist: "Voidcaller", image: "https://cdn.example/summit.png", release: { type: "EP" } });
    expect(first.metadata.experiences[0].type).toBe("AUDIO");
  });

  it("sets animation_url only from the vetted public preview and leaves preview-less metadata unchanged", () => {
    const withPreview = canonicalMetadata({ ...input, previewAudio: "ipfs://bafypreview" });
    expect(withPreview.metadata.animation_url).toBe("ipfs://bafypreview");
    const ignoresOtherAudio = canonicalMetadata({ ...input, audio: "ipfs://bafyfulltrack", edition: { ...input.edition, application_metadata: { audio: "ipfs://bafyfulltrack" } } });
    expect(ignoresOtherAudio.metadata).not.toHaveProperty("animation_url");
    expect(ignoresOtherAudio.digest).toBe(canonicalMetadata(input).digest);
    expect(withPreview.digest).not.toBe(canonicalMetadata(input).digest);
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
    const failed = new PinataMetadataStorage({ config: { endpoint: "https://pin.example/pin", jwt: "secret" }, fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ error: { reason: "Invalid JWT" } }) }) });
    await expect(failed.write({ metadata: input, name: "summit" })).rejects.toMatchObject({ code: "METADATA_STORAGE_UNAVAILABLE", status: 503, details: { provider: "pinata", status: 401, reason: "Invalid JWT", authorization: true }, message: /HTTP 401.*Invalid JWT.*Nothing was written on-chain/ });
    const invalid = new PinataMetadataStorage({ config: { endpoint: "https://pin.example/pin", jwt: "secret" }, fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ IpfsHash: "not-a-cid" }) }) });
    await expect(invalid.write({ metadata: input, name: "summit" })).rejects.toMatchObject({ code: "METADATA_URI_INVALID" });
  });

  it("surfaces an actionable, JWT-safe message when the key lacks the pinJSONToIPFS scope", async () => {
    const jwt = "eyJ-super-secret-production-pinata-jwt-value-do-not-leak-abcdef0123456789";
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => JSON.stringify({ error: { reason: "NO_SCOPES_FOUND", details: "This key does not have the required scopes associated with it." } }) });
    const storage = new PinataMetadataStorage({ config: { endpoint: "https://api.pinata.cloud/pinning/pinJSONToIPFS", jwt }, fetchImpl });
    const error = await storage.write({ metadata: input, name: "summit" }).then(() => null, (err) => err);
    expect(error).toMatchObject({ code: "METADATA_STORAGE_UNAVAILABLE", status: 503, details: { provider: "pinata", status: 403, reason: "NO_SCOPES_FOUND", code: "NO_SCOPES_FOUND", authorization: true } });
    // Operator-facing guidance points at the credential, not the release, and stays fail-closed.
    expect(error.message).toMatch(/Metadata storage authorization failed\. Check the configured Pinata API key permissions\./);
    expect(error.message).toMatch(/HTTP 403.*NO_SCOPES_FOUND.*Nothing was written on-chain/);
    // The JWT must never appear in the surfaced message or diagnostic details.
    expect(error.message).not.toContain(jwt);
    expect(JSON.stringify(error.details)).not.toContain(jwt);
  });
});
