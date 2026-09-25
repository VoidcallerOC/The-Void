import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { canonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest, sha256Bytes } from "./provenance-manifest.js";
import { assertAssetHash, createIpfsMetadataFetcher, derivePublicationProvenance, metadataBytes, readCidDocument, verifyEditionPublication } from "./publication-anchor.js";
import { LEGACY_IPFS_MEDIA, legacyReleaseEvidence } from "../src/lib/legacy-genesis.js";

const owner = "0x1111111111111111111111111111111111111111";
const uri = "ipfs://bafybeigexamplecidexamplecidexamplecidexamplecid";
const tx = `0x${"ab".repeat(32)}`;

function published() {
  const generated = canonicalMetadata({
    release: { title: "The Record", description: "The record." },
    edition: { title: "Chapter I", description: "The record.", supply: "10" },
    artist: { name: "Voidcaller" },
    artwork: "b".repeat(64),
    releaseType: "EP",
  });
  const provenance = canonicalProvenanceManifest({
    releaseId: "release-1",
    editionId: "edition-1",
    creator: { artistId: "artist-1", wallet: owner },
    metadataDigest: generated.digest,
    createdAt: "2026-09-25T20:00:00.000Z",
    artwork: "11".repeat(32),
    audio: "22".repeat(32),
  });
  const document = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
  return { generated, provenance, document, bytes: Buffer.from(JSON.stringify(document), "utf8") };
}

function evidence(overrides = {}) {
  const { document, bytes } = published();
  return {
    metadataUri: uri,
    bytes,
    receipt: { status: 1, blockNumber: 90, transactionHash: tx },
    event: { name: "EditionCreated", args: { metadataUri: uri, artist: owner } },
    onChainUri: uri,
    blockTimestamp: "2026-09-25T21:00:00.000Z",
    releaseId: "release-1",
    editionId: "edition-1",
    document,
    ...overrides,
  };
}

describe("edition metadata CID provenance anchor", () => {
  it("derives one root from the canonical metadata digest and exact asset hashes", () => {
    const { generated, provenance, document } = published();
    const derived = derivePublicationProvenance(document);
    expect(derived.metadataDigest).toBe(generated.digest);
    expect(derived.provenanceRoot).toBe(provenance.root);
    expect(derived.operationalCreatedAt).toBe("2026-09-25T20:00:00.000Z");
    expect(derived.creatorWallet).toBe(owner);
    expect(derived.copyrightOwnership).toBe(false);
    expect(derived.artistVerification).toBe("NOT_ASSERTED");
    expect(metadataBytes(document).sha256).toBe(sha256Bytes(Buffer.from(JSON.stringify(document), "utf8")));
  });

  it("does not let the provenance root change the canonical metadata digest", () => {
    const { generated, document } = published();
    const rewritten = { ...document, provenance: { ...document.provenance, root: "ff".repeat(32) } };
    expect(derivePublicationProvenance({ ...document })).toMatchObject({ metadataDigest: generated.digest });
    expect(() => derivePublicationProvenance(rewritten)).toThrow(/provenance root/i);
    const circularDigest = createHash("sha256").update(JSON.stringify(document)).digest("hex");
    expect(circularDigest).not.toBe(generated.digest);
    expect(() => derivePublicationProvenance({ ...document, _void: { digest: circularDigest }, provenance: { ...document.provenance, metadataDigest: circularDigest } })).toThrow(/metadata digest/i);
  });

  it("rejects a mismatched asset hash and a metadata CID that is not the committed document", () => {
    const { document, bytes } = published();
    expect(assertAssetHash(document, { role: "audio", sha256: "22".repeat(32) }).sha256).toBe("22".repeat(32));
    expect(() => assertAssetHash(document, { role: "audio", sha256: "33".repeat(32) })).toThrow(/exact file bytes/i);
    const loaded = readCidDocument(uri, bytes);
    expect(loaded.metadataByteSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const mutated = Buffer.from(bytes);
    mutated[20] = mutated[20] === 97 ? 98 : 97;
    expect(sha256Bytes(mutated)).not.toBe(loaded.metadataByteSha256);
  });

  it("verifies the edition transaction, event, CID, and block timestamp together", () => {
    const verified = verifyEditionPublication(evidence());
    expect(verified).toMatchObject({
      mechanism: "edition-metadata-cid",
      anchorEvent: "EditionCreated",
      transactionHash: tx,
      blockNumber: 90,
      anchorBlockTimestamp: "2026-09-25T21:00:00.000Z",
      copyrightOwnership: false,
    });
    expect(verified.anchorBlockTimestamp).not.toBe(verified.operationalCreatedAt);
  });

  it("rejects a missing, failed, stale, or timestamp-less publication", () => {
    expect(() => verifyEditionPublication(evidence({ receipt: null }))).toThrow(/not found/i);
    expect(() => verifyEditionPublication(evidence({ receipt: { status: 0, blockNumber: 90, transactionHash: tx } }))).toThrow(/failed/i);
    expect(() => verifyEditionPublication(evidence({ onChainUri: "ipfs://bafybeigothercidothercidothercidothercidother" }))).toThrow(/metadata CID/i);
    expect(() => verifyEditionPublication(evidence({ blockTimestamp: null }))).toThrow(/server timestamp/i);
    expect(() => verifyEditionPublication(evidence({ event: { name: "TransferSingle", args: { metadataUri: uri } } }))).toThrow(/edition event/i);
  });

  it("fetches only the CID path and does not treat a gateway miss as verification", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const fetcher = createIpfsMetadataFetcher({ gateway: "https://gateway.pinata.cloud/ipfs", fetchImpl });
    await expect(fetcher(uri)).rejects.toMatchObject({ code: "METADATA_CID_UNAVAILABLE" });
    expect(fetchImpl).toHaveBeenCalledWith(`https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`);
  });
});

describe("legacy Voidcaller backfill evidence", () => {
  it("does not invent provenance for the four existing tokens", () => {
    const evidence = legacyReleaseEvidence();
    expect(evidence.sufficientForVerifiedProvenance).toBe(false);
    expect(evidence.tokens).toHaveLength(4);
    expect(evidence.tokens.map((token) => token.tokenId)).toEqual([0, 1, 2, 3]);
    expect(evidence.tokens[0].audioContentType).toBe("audio/wav");
    expect(evidence.tokens[0].animationUrl).toBe(LEGACY_IPFS_MEDIA[0].animationUrl);
    expect(evidence.copyrightOwnership).toBe(false);
    expect(JSON.stringify(evidence)).not.toMatch(/provenanceRoot":"[0-9a-f]{64}/);
  });
});
