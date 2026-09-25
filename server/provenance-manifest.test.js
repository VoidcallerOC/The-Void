import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest, protectedMediaCommitments, PROVENANCE_SCHEMA_VERSION, provenanceCommitment, sha256Bytes } from "./provenance-manifest.js";

const artworkHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const audioHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherAudioHash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const protectedHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const otherProtectedHash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const metadataDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const otherMetadataDigest = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const base = {
  releaseId: "release-a",
  editionId: "edition-a",
  creator: { artistId: "artist-a", wallet: "0x1111111111111111111111111111111111111111" },
  metadataDigest,
  createdAt: "2026-09-25T20:00:00.000Z",
  artwork: { sha256: artworkHash, assetType: "IMAGE", version: 1 },
  audio: { sha256: audioHash, assetType: "AUDIO", version: 1 },
  protectedMedia: [{ experienceId: "experience-a", sha256: protectedHash, assetType: "AUDIO", version: 1 }],
};

function manifest(overrides = {}) {
  return canonicalProvenanceManifest({ ...base, ...overrides, creator: { ...base.creator, ...(overrides.creator || {}) } });
}

describe("canonical provenance manifest", () => {
  it("serializes identical input to the same bytes and the same root", () => {
    const first = manifest();
    const second = canonicalProvenanceManifest({
      protectedMedia: base.protectedMedia,
      audio: base.audio,
      createdAt: base.createdAt,
      metadataDigest: base.metadataDigest,
      creator: { wallet: base.creator.wallet, artistId: base.creator.artistId },
      editionId: base.editionId,
      artwork: base.artwork,
      releaseId: base.releaseId,
    });
    expect(first.serialized).toBe(second.serialized);
    expect(first.root).toBe(second.root);
    expect(first.root).toBe(createHash("sha256").update(first.serialized).digest("hex"));
    expect(first.manifest.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION);
    expect(first.metadataDigest).toBe(metadataDigest);
    expect(first.root).not.toBe(metadataDigest);
  });

  it("normalizes timestamp and wallet casing without changing the root", () => {
    const checksummed = manifest({
      creator: { artistId: "artist-a", wallet: "0xABCDef0000000000000000000000000000000001" },
      createdAt: "2026-09-25T20:00:00Z",
    });
    const explicit = canonicalProvenanceManifest({
      ...base,
      creator: { artistId: "artist-a", wallet: "0xabcdef0000000000000000000000000000000001" },
      createdAt: "2026-09-25T20:00:00.000+00:00",
    });
    expect(checksummed.root).toBe(explicit.root);
    expect(checksummed.manifest.createdAt).toBe("2026-09-25T20:00:00.000Z");
    expect(checksummed.manifest.creator.wallet).toBe("0xabcdef0000000000000000000000000000000001");
  });

  it("changes the root when the canonical metadata digest changes and does not replace that digest", () => {
    const changed = manifest({ metadataDigest: otherMetadataDigest });
    expect(changed.root).not.toBe(manifest().root);
    expect(changed.metadataDigest).toBe(otherMetadataDigest);
    const metadataInput = {
      artist: { name: "Voidcaller" },
      release: { title: "Summit Demo", description: "A release." },
      edition: { title: "Summit Edition", description: "The collectible.", supply: "10" },
    };
    const original = canonicalMetadata(metadataInput);
    const rewritten = canonicalMetadata({ ...metadataInput, release: { ...metadataInput.release, description: "A different release." } });
    expect(rewritten.digest).not.toBe(original.digest);
    const rooted = manifest({ metadataDigest: rewritten.digest });
    expect(rooted.metadataDigest).toBe(rewritten.digest);
    expect(rooted.root).not.toBe(manifest({ metadataDigest: original.digest }).root);
    expect(original.digest).toHaveLength(64);
  });

  it("changes the root when the artwork hash changes and rejects mutable artwork references", () => {
    expect(manifest({ artwork: { sha256: otherAudioHash, assetType: "IMAGE", version: 1 } }).root).not.toBe(manifest().root);
    for (const artwork of ["https://cdn.example/summit.png", "ipfs://bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234", "/assets/track-art/ep1-the-hollow.png"]) {
      expect(() => manifest({ artwork })).toThrow(/SHA-256 digest of file bytes/i);
    }
    expect(JSON.stringify(manifest().record)).not.toMatch(/https?:|ipfs:|\/assets\/|storageKey|filename/i);
  });

  it("changes the root when the audio hash changes", () => {
    expect(manifest({ audio: { sha256: otherAudioHash, assetType: "AUDIO", version: 1 } }).root).not.toBe(manifest().root);
    expect(() => manifest({ audio: "https://cdn.example/master.mp3" })).toThrow(/SHA-256/i);
  });

  it("changes the root when a protected experience commitment changes", () => {
    const changedHash = manifest({ protectedMedia: [{ experienceId: "experience-a", sha256: otherProtectedHash, assetType: "AUDIO", version: 1 }] });
    const changedExperience = manifest({ protectedMedia: [{ experienceId: "experience-b", sha256: protectedHash, assetType: "AUDIO", version: 1 }] });
    expect(changedHash.root).not.toBe(manifest().root);
    expect(changedExperience.root).not.toBe(manifest().root);
    expect(changedHash.serialized).not.toMatch(/storageKey|bafy|secret|filename|jwt/i);
  });

  it("changes the root when creator attribution changes", () => {
    const otherWallet = manifest({ creator: { artistId: "artist-a", wallet: "0x2222222222222222222222222222222222222222" } });
    const otherArtist = manifest({ creator: { artistId: "artist-b", wallet: "0x1111111111111111111111111111111111111111" } });
    expect(otherWallet.root).not.toBe(manifest().root);
    expect(otherArtist.root).not.toBe(manifest().root);
    const ignoredName = canonicalProvenanceManifest({ ...base, creator: { ...base.creator, displayName: "Someone Else" } });
    expect(ignoredName.root).toBe(manifest().root);
    expect(ignoredName.serialized).not.toContain("Someone Else");
  });

  it("changes the root when an asset version or the proof timestamp changes", () => {
    expect(manifest({ artwork: { sha256: artworkHash, assetType: "IMAGE", version: 2 } }).root).not.toBe(manifest().root);
    expect(manifest({ protectedMedia: [{ experienceId: "experience-a", sha256: protectedHash, assetType: "AUDIO", version: 4 }] }).root).not.toBe(manifest().root);
    expect(manifest({ createdAt: "2026-09-25T20:00:01.000Z" }).root).not.toBe(manifest().root);
    expect(manifest().manifest.schemaVersion).toBe(1);
  });

  it("rejects malformed input and missing required fields", () => {
    expect(() => canonicalProvenanceManifest(null)).toThrow(/release edition/i);
    expect(() => canonicalProvenanceManifest([])).toThrow(/release edition/i);
    expect(() => manifest({ releaseId: "" })).toThrow(/releaseId/i);
    expect(() => manifest({ editionId: "   " })).toThrow(/editionId/i);
    expect(() => canonicalProvenanceManifest({ ...base, creator: null })).toThrow(/creator/i);
    expect(() => canonicalProvenanceManifest({ ...base, creator: { artistId: "artist-a" } })).toThrow(/wallet/i);
    expect(() => manifest({ metadataDigest: "not-a-hash" })).toThrow(/metadataDigest/i);
    expect(() => manifest({ metadataDigest: "https://cdn.example/meta.json" })).toThrow(/SHA-256 digest of file bytes/i);
    expect(() => manifest({ createdAt: "tomorrow" })).toThrow(/timestamp/i);
    expect(() => canonicalProvenanceManifest({ ...base, createdAt: undefined })).toThrow(/timestamp/i);
    expect(() => manifest({ artwork: { sha256: "abc", assetType: "IMAGE" } })).toThrow(/64-character/i);
    expect(() => manifest({ artwork: { sha256: artworkHash, version: 0 } })).toThrow(/version/i);
    expect(() => manifest({ protectedMedia: "audio" })).toThrow(/protectedMedia/i);
    expect(() => manifest({ protectedMedia: [{ sha256: protectedHash }] })).toThrow(/experienceId/i);
    expect(() => manifest({ protectedMedia: [{ experienceId: "experience-a", sha256: protectedHash, storageKey: "records/secret.mp3" }] })).toThrow(/storageKey/i);
  });

  it("keeps key order and asset order deterministic", () => {
    const reversed = canonicalProvenanceManifest({
      ...base,
      protectedMedia: [
        { experienceId: "experience-b", sha256: otherProtectedHash, assetType: "STEMS", version: 2 },
        { experienceId: "experience-a", sha256: protectedHash, assetType: "AUDIO", version: 1 },
      ],
    });
    const forward = canonicalProvenanceManifest({
      ...base,
      protectedMedia: [
        { version: 1, assetType: "AUDIO", sha256: protectedHash, experienceId: "experience-a" },
        { version: 2, assetType: "STEMS", sha256: otherProtectedHash, experienceId: "experience-b" },
      ],
    });
    expect(reversed.serialized).toBe(forward.serialized);
    expect(reversed.manifest.assets.filter((asset) => asset.role === "protected-media").map((asset) => asset.experienceId)).toEqual(["experience-a", "experience-b"]);
    expect(reversed.serialized).toBe(JSON.stringify(JSON.parse(reversed.serialized)));
    const parsed = JSON.parse(reversed.serialized);
    expect(Object.keys(parsed)).toEqual(["assets", "createdAt", "creator", "editionId", "metadataDigest", "releaseId", "schemaVersion"].sort());
  });

  it("does not treat a protected URI as a file identity", () => {
    const experiences = [{
      id: "experience-a",
      version: 3,
      media_config: {
        protected: true,
        protectedMedia: [
          { mediaType: "AUDIO", uri: "ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn", source: "public-ipfs" },
          { assetId: "asset-1", mediaType: "AUDIO", storageKey: "bafybeigsecret" },
        ],
      },
    }];
    const assets = [{ id: "asset-1", media_type: "AUDIO", metadata: { contentSha256: protectedHash, version: 3 } }];
    const commitments = protectedMediaCommitments(experiences, assets);
    expect(commitments).toEqual([{ experienceId: "experience-a", sha256: protectedHash, assetType: "AUDIO", version: 3 }]);
    expect(JSON.stringify(commitments)).not.toMatch(/ipfs:|storageKey|bafy/i);
    const withCommitment = manifest({ protectedMedia: commitments });
    const without = manifest({ protectedMedia: [] });
    expect(withCommitment.root).not.toBe(without.root);
    expect(provenanceCommitment(withCommitment.record)).not.toBe(provenanceCommitment(without.record));
  });

  it("hashes file bytes without retaining them", () => {
    const bytes = new Uint8Array([0x61]);
    expect(sha256Bytes(bytes)).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(sha256Bytes(new Uint8Array([0x62]))).not.toBe(sha256Bytes(bytes));
  });
});
