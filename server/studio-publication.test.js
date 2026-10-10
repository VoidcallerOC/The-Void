import { ethers } from "ethers";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };
import { ApiError } from "./api-errors.js";
import { canonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { ProvenanceAnchorService } from "./provenance-anchor.js";
import { ProvenanceRecords } from "./provenance-records.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";
import { assertProvenanceConsistency, provenancePublicationStatus, publicationView } from "./studio-publication.js";

const owner = "0x1111111111111111111111111111111111111111";
const request = { requestId: "request-1", headers: {} };
const tx = `0x${"ab".repeat(32)}`;
const anchorAddress = "0x3333333333333333333333333333333333333333";

function ids(releaseSlug, editionSlug) {
  const releaseId = ethers.encodeBytes32String(releaseSlug);
  const editionId = ethers.encodeBytes32String(editionSlug);
  const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", releaseId, editionId])));
  return { releaseId, editionId, tokenId: tokenId === 0n ? 1n : tokenId };
}

function metadataFor(root = "b".repeat(64)) {
  return {
    _void: { version: 1, digest: "a".repeat(64) },
    provenance: { schemaVersion: 1, releaseId: "release-1", editionId: "edition-1", metadataDigest: "a".repeat(64), root, createdAt: "2026-09-25T20:00:00.000Z", creator: { artistId: "artist-1", wallet: owner }, assets: [] },
  };
}

function releaseRow(status = "DRAFT") {
  return { id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status, release_metadata: {}, published_at: null, display_name: "Voidcaller" };
}

function editionRow(metadata = metadataFor()) {
  return { id: "edition-1", release_id: "release-1", contract_id: "contract-1", title: "Chapter I", description: null, tier: null, supply: "10", application_metadata: {}, metadata_uri: "ipfs://metadata", metadata, metadata_version: metadata._void.digest, token_id: ids("the-record", "chapter-i").tokenId.toString() };
}

function repository() {
  const repo = { saveRelease: vi.fn(async (input) => input), saveEdition: vi.fn(async (input) => input), saveToken: vi.fn(async (input) => input), saveExperience: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})) };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}

function editionCreatedReceipt(uri = "ipfs://metadata") {
  const identity = ids("the-record", "chapter-i");
  const event = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
  const encoded = event.encodeEventLog("EditionCreated", [identity.tokenId, identity.releaseId, identity.editionId, owner, 10n, uri]);
  return { status: 1, logs: [{ address: fujiRelease.contractAddress, topics: encoded.topics, data: encoded.data }] };
}

function studio({ authorization = {}, rows = [], chain = null, records = null, metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://metadata" }) }, metadataFetcher = null } = {}) {
  const repo = repository();
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  const instance = new ArtistStudioService({
    db: verifiedArtistDb(db, authorization),
    repository: repo,
    metadataStorage,
    provenanceRecords: records,
    publicationChain: chain,
    metadataFetcher,
    authenticator: vi.fn().mockResolvedValue({ wallet: owner }),
    logger: { error: vi.fn(), info: vi.fn() },
  });
  return { instance, repo, db, chain };
}

describe("publication provenance states", () => {
  it("never treats a submitted or failed proof as verified", () => {
    expect(provenancePublicationStatus(null)).toBe("PROVENANCE_PENDING");
    expect(provenancePublicationStatus({ anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" })).toBe("PROVENANCE_PENDING");
    expect(provenancePublicationStatus({ anchor_status: "FAILED", verification_status: "UNVERIFIED" })).toBe("PROVENANCE_FAILED");
    expect(provenancePublicationStatus({ anchor_status: "ANCHORED", verification_status: "VERIFIED" })).toBe("PROVENANCE_VERIFIED");
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: { anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" } }).fullyPublished).toBe(false);
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: { anchor_status: "ANCHORED", verification_status: "VERIFIED" } }).fullyPublished).toBe(true);
  });

  it("marks fullyPublished only when the catalog is PUBLISHED and the proof is both ANCHORED and VERIFIED", () => {
    const verified = { anchor_status: "ANCHORED", verification_status: "VERIFIED" };
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: verified })).toEqual({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true });
    expect(publicationView({ releaseStatus: "DRAFT", proof: verified }).fullyPublished).toBe(false);
    expect(publicationView({ releaseStatus: "REVIEW", proof: verified }).fullyPublished).toBe(false);
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: { anchor_status: "SUBMITTED", verification_status: "VERIFIED" } }).fullyPublished).toBe(false);
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: { anchor_status: "ANCHORED", verification_status: "UNVERIFIED" } }).fullyPublished).toBe(false);
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: { anchor_status: "FAILED", verification_status: "UNVERIFIED" } })).toMatchObject({ provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false });
    expect(publicationView({ releaseStatus: "PUBLISHED", proof: null })).toMatchObject({ provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false });
    expect(() => assertProvenanceConsistency({ releaseId: "release-1", editionId: "edition-1", metadata: metadataFor("c".repeat(64)), provenanceRoot: "b".repeat(64) })).toThrow(/same release edition/);
  });
});

describe("Artist Studio publication pipeline", () => {
  it("publishes metadata and records a pending proof without calling it verified", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue(null), createProof: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const harness = studio({ records });
    harness.db.query
      .mockResolvedValueOnce({ rows: [releaseRow()] })
      .mockResolvedValueOnce({ rows: [{ ...editionRow(), metadata_uri: null, metadata: null, metadata_version: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const published = await harness.instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "EP" } });
    expect(published).toMatchObject({ provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false });
    expect(published.provenanceRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(records.createProof).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-1", editionId: "edition-1", manifestSha256: published.provenanceRoot, metadataSha256: published.digest }));
    expect(harness.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("publishes the stored, validated release type rather than the request's releaseType", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue(null), createProof: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://metadata" }) };
    const harness = studio({ records, metadataStorage });
    harness.db.query
      .mockResolvedValueOnce({ rows: [{ ...releaseRow(), release_metadata: { releaseType: "ALBUM" } }] })
      .mockResolvedValueOnce({ rows: [{ ...editionRow(), metadata_uri: null, metadata: null, metadata_version: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await harness.instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "<script>MIXTAPE" } });
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    expect(JSON.stringify(metadataStorage.write.mock.calls[0][0].metadata)).toContain('"ALBUM"');
    expect(JSON.stringify(metadataStorage.write.mock.calls[0][0].metadata)).not.toContain("MIXTAPE");
  });

  it("does not record provenance when metadata publication fails", async () => {
    const records = { findOwnedByRoot: vi.fn(), createProof: vi.fn() };
    const harness = studio({ records, metadataStorage: { write: vi.fn().mockRejectedValue(new Error("pinata down")) } });
    harness.db.query
      .mockResolvedValueOnce({ rows: [releaseRow()] })
      .mockResolvedValueOnce({ rows: [{ ...editionRow(), metadata_uri: null, metadata: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(harness.instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "EP" } })).rejects.toThrow(/pinata down/);
    expect(records.createProof).not.toHaveBeenCalled();
    expect(harness.repo.saveToken).not.toHaveBeenCalled();
  });

  it("rejects an already published release before writing new metadata", async () => {
    const harness = studio();
    harness.db.query.mockResolvedValueOnce({ rows: [releaseRow("PUBLISHED")] });
    await expect(harness.instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "EP" } })).rejects.toMatchObject({ code: "RELEASE_ALREADY_PUBLISHED" });
    expect(harness.repo.saveToken).not.toHaveBeenCalled();
  });

  it("publishes metadata for a new draft edition (track) on an already published release", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue(null), createProof: vi.fn().mockResolvedValue({ id: "proof-2", anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://metadata-2" }) };
    const harness = studio({ records, metadataStorage });
    harness.db.query
      .mockResolvedValueOnce({ rows: [releaseRow("PUBLISHED")] })
      .mockResolvedValueOnce({ rows: [{ ...editionRow(), id: "edition-2", title: "Chapter II", status: "DRAFT", metadata_uri: null, metadata: null, metadata_version: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const published = await harness.instance.publishMetadata({ request, releaseId: "release-1", input: {} });
    expect(published).toMatchObject({ provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false });
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    expect(records.createProof).toHaveBeenCalledWith(expect.objectContaining({ releaseId: "release-1", editionId: "edition-2" }));
    // Only an open (DRAFT/REVIEW) edition may receive metadata; a published edition is never selected for rewrite.
    const editionQuery = harness.db.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("FROM editions e"));
    expect(editionQuery).toContain("e.status IN ('DRAFT','REVIEW')");
    expect(harness.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("confirms a new draft edition on a published release and marks only that edition published", async () => {
    const identity = ids("the-record", "chapter-i");
    const secondTrack = metadataFor();
    secondTrack.provenance.editionId = "edition-2";
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ id: "proof-2", anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const chain = { getTransactionReceipt: vi.fn().mockResolvedValue(editionCreatedReceipt()), edition: vi.fn().mockResolvedValue([identity.releaseId, identity.editionId, owner, 10n, 0n, "ipfs://metadata", true]) };
    const harness = studio({ records, chain });
    harness.db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM experiences")) return { rows: [] };
      if (String(sql).includes("FROM editions")) return { rows: [{ ...editionRow(secondTrack), id: "edition-2", status: "DRAFT" }] };
      return { rows: [{ ...releaseRow("PUBLISHED"), published_at: "2026-10-01T00:00:00.000Z" }] };
    });
    const confirmed = await harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } });
    expect(confirmed).toMatchObject({ editionId: "edition-2", status: "PUBLISHED", provenanceStatus: "PROVENANCE_PENDING" });
    expect(harness.repo.saveEdition).toHaveBeenCalledWith(expect.objectContaining({ id: "edition-2", status: "PUBLISHED" }));
    expect(harness.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED", publishedAt: "2026-10-01T00:00:00.000Z" }));
    const editionQuery = harness.db.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("FROM editions e"));
    expect(editionQuery).toContain("ORDER BY CASE WHEN e.status IN ('DRAFT','REVIEW') THEN 0 ELSE 1 END");
  });

  it("still refuses to re-confirm a published edition whose provenance is verified", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ anchor_status: "ANCHORED", verification_status: "VERIFIED" }) };
    const harness = studio({ records, chain: { getTransactionReceipt: vi.fn() } });
    harness.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [{ ...editionRow(), status: "PUBLISHED" }] } : { rows: [releaseRow("PUBLISHED")] });
    await expect(harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "RELEASE_ALREADY_PUBLISHED" });
    expect(harness.chain.getTransactionReceipt).not.toHaveBeenCalled();
    expect(harness.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("keeps catalog publication unverified for provenance until the anchor is confirmed", async () => {
    const identity = ids("the-record", "chapter-i");
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const chain = { getTransactionReceipt: vi.fn().mockResolvedValue(editionCreatedReceipt()), edition: vi.fn().mockResolvedValue([identity.releaseId, identity.editionId, owner, 10n, 0n, "ipfs://metadata", true]) };
    const harness = studio({ records, chain, rows: [] });
    harness.db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM experiences")) return { rows: [] };
      if (String(sql).includes("FROM editions")) return { rows: [editionRow()] };
      return { rows: [releaseRow()] };
    });
    const confirmed = await harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } });
    expect(confirmed).toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false });
    expect(harness.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED" }));
  });

  it("retries a failed blockchain confirmation without fabricating provenance", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const chain = { getTransactionReceipt: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(editionCreatedReceipt()), edition: vi.fn().mockResolvedValue([ids("the-record", "chapter-i").releaseId, ids("the-record", "chapter-i").editionId, owner, 10n, 0n, "ipfs://metadata", true]) };
    const harness = studio({ records, chain, rows: [] });
    harness.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow()] } : String(sql).includes("FROM experiences") ? { rows: [] } : { rows: [releaseRow()] });
    await expect(harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "PUBLICATION_NOT_CONFIRMED" });
    expect(harness.repo.saveRelease).not.toHaveBeenCalled();
    const retried = await harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } });
    expect(retried).toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false });
  });

  it("refuses to confirm an edition created on-chain by another artist's wallet", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const onChain = [ids("the-record", "chapter-i").releaseId, ids("the-record", "chapter-i").editionId, owner, 10n, 0n, "ipfs://metadata", true];
    const chain = { getTransactionReceipt: vi.fn().mockResolvedValue(editionCreatedReceipt()), edition: vi.fn().mockResolvedValue(onChain) };
    const harness = studio({ records, chain, authorization: { creatorOwns: false } });
    harness.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow()] } : { rows: [releaseRow()] });
    await expect(harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "EDITION_CREATED_BY_ANOTHER_ARTIST" });
    expect(harness.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("ignores a look-alike EditionCreated log emitted by any contract other than the certified release", async () => {
    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ anchor_status: "PENDING", verification_status: "UNVERIFIED" }) };
    const receipt = editionCreatedReceipt();
    receipt.logs = receipt.logs.map((log) => ({ ...log, address: "0x000000000000000000000000000000000000dead" }));
    const chain = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt), edition: vi.fn().mockResolvedValue([ids("the-record", "chapter-i").releaseId, ids("the-record", "chapter-i").editionId, owner, 10n, 0n, "ipfs://metadata", true]) };
    const harness = studio({ records, chain });
    harness.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow()] } : { rows: [releaseRow()] });
    await expect(harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "PUBLICATION_NOT_CONFIRMED" });
    expect(harness.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("refuses publication by an unverified or revoked artist before any chain or storage call", async () => {
    for (const [authorization, code] of [[{ verified: false }, "ARTIST_NOT_VERIFIED"], [{ revoked: true }, "ARTIST_VERIFICATION_REVOKED"]]) {
      const chain = { getTransactionReceipt: vi.fn(), edition: vi.fn() };
      const harness = studio({ chain, authorization });
      harness.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow()] } : { rows: [releaseRow()] });
      await expect(harness.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code });
      await expect(harness.instance.publishMetadata({ request, releaseId: "release-1", input: {} })).rejects.toMatchObject({ code });
      expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
      expect(harness.repo.saveToken).not.toHaveBeenCalled();
    }
  });

  it("fails closed on inconsistent provenance and on a duplicate verified publication", async () => {
    const broken = metadataFor();
    broken._void.digest = "c".repeat(64);
    const inconsistent = studio({ chain: { getTransactionReceipt: vi.fn(), edition: vi.fn() } });
    inconsistent.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow(broken)] } : { rows: [releaseRow()] });
    await expect(inconsistent.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "PROVENANCE_INCONSISTENT" });
    expect(inconsistent.repo.saveRelease).not.toHaveBeenCalled();
    expect(inconsistent.chain.getTransactionReceipt).not.toHaveBeenCalled();

    const records = { findOwnedByRoot: vi.fn().mockResolvedValue({ anchor_status: "ANCHORED", verification_status: "VERIFIED" }) };
    const duplicate = studio({ records, chain: { getTransactionReceipt: vi.fn() } });
    duplicate.db.query.mockImplementation(async (sql) => String(sql).includes("FROM editions") ? { rows: [editionRow()] } : { rows: [releaseRow("PUBLISHED")] });
    await expect(duplicate.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "RELEASE_ALREADY_PUBLISHED" });
    expect(duplicate.chain.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("verifies provenance from the edition metadata CID and does not verify a mismatched CID", async () => {
    const generated = canonicalMetadata({ release: releaseRow(), edition: { title: "Chapter I", description: null, supply: "10" }, artist: { name: "Voidcaller" }, releaseType: "EP" });
    const provenance = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: generated.digest, createdAt: "2026-09-25T20:00:00.000Z", artwork: "11".repeat(32) });
    const document = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const identity = ids("the-record", "chapter-i");
    const chain = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ ...editionCreatedReceipt(), blockNumber: 90 }),
      edition: vi.fn().mockResolvedValue([identity.releaseId, identity.editionId, owner, 10n, 0n, "ipfs://metadata", true]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
    };
    const records = {
      findOwnedByRoot: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" }),
      recordVerifiedAnchor: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "ANCHORED", verification_status: "VERIFIED" }),
      recordAnchorFailure: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "FAILED", verification_status: "UNVERIFIED" }),
    };
    const verified = studio({ records, chain, metadataFetcher: async () => Buffer.from(JSON.stringify(document)) });
    verified.db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM experiences")) return { rows: [] };
      if (String(sql).includes("FROM editions")) return { rows: [editionRow(document)] };
      return { rows: [releaseRow()] };
    });
    await expect(verified.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true, copyrightOwnership: false });
    expect(records.recordVerifiedAnchor).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: tx,
      blockNumber: 90,
      blockTimestamp: "2025-09-25T21:20:00.000Z",
      anchorEvent: "EditionCreated",
      mechanism: "edition-metadata-cid",
      metadataCid: "metadata",
      anchorContract: fujiRelease.contractAddress.toLowerCase(),
      chainId: 43113,
      chainKey: "fuji",
    }));

    const mismatched = studio({ records, chain, metadataFetcher: async () => Buffer.from(JSON.stringify({ ...document, description: "not the pinned bytes" })) });
    mismatched.db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM experiences")) return { rows: [] };
      if (String(sql).includes("FROM editions")) return { rows: [editionRow(document)] };
      return { rows: [releaseRow()] };
    });
    await expect(mismatched.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false });
    expect(records.recordAnchorFailure).toHaveBeenCalled();
  });

  it("records a failed anchor, not a pending or verified one, when the record layer rejects the publication anchor", async () => {
    const generated = canonicalMetadata({ release: releaseRow(), edition: { title: "Chapter I", description: null, supply: "10" }, artist: { name: "Voidcaller" }, releaseType: "EP" });
    const provenance = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: generated.digest, createdAt: "2026-09-25T20:00:00.000Z", artwork: "11".repeat(32) });
    const document = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const identity = ids("the-record", "chapter-i");
    const chain = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ ...editionCreatedReceipt(), blockNumber: 90 }),
      edition: vi.fn().mockResolvedValue([identity.releaseId, identity.editionId, owner, 10n, 0n, "ipfs://metadata", true]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
    };
    const records = {
      findOwnedByRoot: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" }),
      recordVerifiedAnchor: vi.fn().mockRejectedValue(new ApiError(400, "PROVENANCE_RECORD_INVALID", "anchorEvent must be one of EditionCreated, ProvenanceAnchored.")),
      recordAnchorFailure: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "FAILED", verification_status: "UNVERIFIED", failure_code: "PROVENANCE_RECORD_INVALID" }),
    };
    const rejected = studio({ records, chain, metadataFetcher: async () => Buffer.from(JSON.stringify(document)) });
    rejected.db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM experiences")) return { rows: [] };
      if (String(sql).includes("FROM editions")) return { rows: [editionRow(document)] };
      return { rows: [releaseRow()] };
    });
    await expect(rejected.instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false });
    expect(records.recordAnchorFailure).toHaveBeenCalledWith(expect.objectContaining({ id: "proof-1", failureCode: "PROVENANCE_RECORD_INVALID" }));
    expect(records.recordAnchorFailure.mock.calls[0][0].failureDetail).not.toMatch(/ipfs:\/\//);
  });
});

describe("release-contract publication through the real provenance record layer", () => {
  const releaseContract = "0x4444444444444444444444444444444444444444";
  const releaseKey = `0x${"5a".repeat(32)}`;
  const metadataUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const editionId = ethers.encodeBytes32String("chapter-i");
  const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId])));

  function publication({ recordBinding }) {
    const generated = canonicalMetadata({ release: releaseRow(), edition: { title: "Chapter I", description: null, supply: "10" }, artist: { name: "Voidcaller" }, releaseType: "EP" });
    const provenance = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: generated.digest, createdAt: "2026-09-25T20:00:00.000Z", artwork: "11".repeat(32) });
    const document = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const release = { ...releaseRow(), release_metadata: { publicationArchitecture: "release-per-contract" } };
    const edition = { ...editionRow(document), contract_id: "contract-release", metadata_uri: metadataUri, token_id: tokenId.toString() };
    const studioBinding = { release_contract_id: "contract-release", release_contract_address: releaseContract, chain_id: "43113", release_key: releaseKey };
    const proof = { id: "proof-1", release_id: "release-1", edition_id: "edition-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" };
    const event = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
    const encoded = event.encodeEventLog("EditionCreated", [tokenId, releaseKey, editionId, owner, 10n, metadataUri]);
    const chain = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 90, logs: [{ address: releaseContract, topics: encoded.topics, data: encoded.data }] }),
      edition: vi.fn().mockResolvedValue([releaseKey, editionId, owner, 10n, 0n, metadataUri, true]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
    };
    const db = { query: vi.fn(async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM experiences")) return { rows: [] };
      if (text.includes("JOIN tokens t")) return { rows: [edition] };
      if (text.includes("AS release_contract_address")) return { rows: [studioBinding] };
      if (text.includes("FROM release_contracts rc")) return { rows: recordBinding };
      if (text.includes("anchor_status = 'FAILED'")) return { rows: [{ ...proof, anchor_status: "FAILED", failure_code: params[1] }] };
      if (text.includes("UPDATE provenance_proofs")) return { rows: [{ ...proof, anchor_status: "ANCHORED", verification_status: "VERIFIED", chain_key: params[2], chain_id: params[3], anchor_contract: params[7], anchor_event: params[8] }] };
      if (text.includes("FROM provenance_proofs p")) return { rows: [proof] };
      if (text.includes("FROM editions e")) return { rows: [{ release_id: "release-1", edition_id: "edition-1", artist_id: "artist-1" }] };
      return { rows: [release] };
    }) };
    const scoped = verifiedArtistDb(db);
    const instance = new ArtistStudioService({
      db: scoped,
      repository: repository(),
      metadataStorage: { write: vi.fn() },
      provenanceRecords: new ProvenanceRecords({ db: scoped }),
      publicationChain: chain,
      metadataFetcher: async () => Buffer.from(JSON.stringify(document)),
      authenticator: vi.fn().mockResolvedValue({ wallet: owner }),
      logger: { error: vi.fn(), info: vi.fn() },
    });
    const calls = (pattern) => db.query.mock.calls.filter(([sql]) => pattern.test(String(sql)));
    return { instance, calls };
  }

  it("fully publishes a bound release contract's EditionCreated on its own chain", async () => {
    const { instance, calls } = publication({ recordBinding: [{ address: releaseContract, chain_id: "43113", chain_key: "43113" }] });
    await expect(instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true, releaseContractAddress: releaseContract, chainId: 43113 });
    expect(calls(/FROM release_contracts rc\s+JOIN contracts c/)[0][1]).toEqual(["release-1", releaseContract]);
    const [, params] = calls(/anchor_status = 'ANCHORED'/)[0];
    expect(params.slice(2, 4)).toEqual(["43113", 43113]);
    expect(params.slice(7)).toEqual([releaseContract, "EditionCreated"]);
    expect(calls(/anchor_status = 'FAILED'/)).toHaveLength(0);
  });

  it("does not fully publish when the record layer finds no binding for that contract", async () => {
    const { instance, calls } = publication({ recordBinding: [] });
    await expect(instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ status: "PUBLISHED", provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false });
    expect(calls(/anchor_status = 'ANCHORED'/)).toHaveLength(0);
    expect(calls(/anchor_status = 'FAILED'/)[0][1][1]).toBe("PROVENANCE_RECORD_INVALID");
  });

  it("does not fully publish when the bound release contract's chain differs from the publication chain", async () => {
    const { instance, calls } = publication({ recordBinding: [{ address: releaseContract, chain_id: "43114", chain_key: "43114" }] });
    await expect(instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false });
    expect(calls(/anchor_status = 'ANCHORED'/)).toHaveLength(0);
  });
});

describe("provenance anchor inside publication", () => {
  const manifest = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt: "2026-09-25T20:00:00.000Z", artwork: "b".repeat(64) });
  const releaseKey = `0x${"99".repeat(32)}`;
  const boundReleaseAddress = "0x4444444444444444444444444444444444444444";
  const config = { enabled: true, chainId: 43113, network: "fuji", releaseContract: fujiRelease.contractAddress.toLowerCase(), contractAddress: anchorAddress, rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", eventName: "ProvenanceAnchored" };

  function anchorService(reader, proof) {
    const records = {
      findOwnedByRoot: vi.fn().mockResolvedValue(proof),
      createProof: vi.fn(),
      retryProof: vi.fn().mockResolvedValue({ ...proof, anchor_status: "PENDING", verification_status: "UNVERIFIED" }),
      recordSubmittedAnchor: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "SUBMITTED", verification_status: "UNVERIFIED" }),
      recordAnchorFailure: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "FAILED", verification_status: "UNVERIFIED" }),
      recordVerifiedAnchor: vi.fn().mockResolvedValue({ id: "proof-1", anchor_status: "ANCHORED", verification_status: "VERIFIED" }),
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ release_id: "release-1", release_slug: "the-record", release_status: "PUBLISHED", artist_id: "artist-1", edition_id: "edition-1", title: "Chapter I", token_id: null, metadata: { provenance: manifest.record }, metadata_version: manifest.metadataDigest, bound_chain_id: 43113, release_key: releaseKey, release_contract_address: boundReleaseAddress, provenance_anchor_address: anchorAddress }] }) };
    return { service: new ProvenanceAnchorService({ db, records, authenticator: async () => ({ wallet: owner }), config, reader }), records };
  }

  it("reports provenance failure and verification failure without a verified publication", async () => {
    const reverted = anchorService({ getNetwork: async () => ({ chainId: 43113 }), getTransaction: async () => ({ to: anchorAddress, from: owner, data: "0x" }), getTransactionReceipt: async () => ({ status: 0, logs: [] }), getBlock: async () => ({ timestamp: 1 }), isAnchored: async () => false }, { id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" });
    const { encodeAnchorCall } = await import("./provenance-anchor.js");
    const call = encodeAnchorCall({ releaseKey, editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });
    reverted.service.reader.getTransaction = async () => ({ to: anchorAddress, from: owner, data: call.data });
    await expect(reverted.service.confirm({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false, verificationStatus: "UNVERIFIED" });
    expect(reverted.records.recordVerifiedAnchor).not.toHaveBeenCalled();

    const mismatch = anchorService({ getNetwork: async () => ({ chainId: 43113 }), getTransaction: async () => ({ to: anchorAddress, from: owner, data: call.data }), getTransactionReceipt: async () => ({ status: 1, blockNumber: 9, logs: [] }), getBlock: async () => ({ timestamp: 1 }), isAnchored: async () => false }, { id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" });
    await expect(mismatch.service.confirm({ request, releaseId: "release-1", input: { transactionHash: tx } })).rejects.toMatchObject({ code: "ANCHOR_EVENT_MISMATCH" });
    expect(mismatch.records.recordVerifiedAnchor).not.toHaveBeenCalled();
    expect(mismatch.records.recordAnchorFailure).toHaveBeenCalled();
  });

  it("marks the release fully published only after an independent anchor verification and can retry", async () => {
    const { encodeAnchorCall, ANCHOR_ABI } = await import("./provenance-anchor.js");
    const call = encodeAnchorCall({ releaseKey, editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });
    const encoded = new ethers.Interface(ANCHOR_ABI).encodeEventLog("ProvenanceAnchored", [call.provenanceRoot, call.releaseId, call.editionId, call.tokenId, owner, boundReleaseAddress]);
    const reader = { getNetwork: async () => ({ chainId: 43113 }), getTransaction: async () => ({ to: anchorAddress, from: owner, data: call.data }), getTransactionReceipt: async () => ({ status: 1, blockNumber: 90, logs: [{ address: anchorAddress, topics: encoded.topics, data: encoded.data }] }), getBlock: async () => ({ timestamp: 1_758_835_200 }), isAnchored: async () => true };
    const failed = anchorService(reader, { id: "proof-1", anchor_status: "FAILED", verification_status: "UNVERIFIED", attempt_count: 1 });
    const verified = await failed.service.confirm({ request, releaseId: "release-1", input: { transactionHash: tx } });
    expect(failed.records.retryProof).toHaveBeenCalled();
    expect(verified).toMatchObject({ provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true, verificationStatus: "VERIFIED", status: "PUBLISHED" });
  });
});
