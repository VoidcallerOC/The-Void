import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { ProvenanceAnchorService } from "./provenance-anchor.js";
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

function studio({ rows = [], chain = null, records = null, metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://metadata" }) } } = {}) {
  const repo = repository();
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  const instance = new ArtistStudioService({
    db,
    repository: repo,
    metadataStorage,
    provenanceRecords: records,
    publicationChain: chain,
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
});

describe("provenance anchor inside publication", () => {
  const manifest = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt: "2026-09-25T20:00:00.000Z", artwork: "b".repeat(64) });
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
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ release_id: "release-1", release_slug: "the-record", release_status: "PUBLISHED", artist_id: "artist-1", edition_id: "edition-1", title: "Chapter I", token_id: null, metadata: { provenance: manifest.record }, metadata_version: manifest.metadataDigest }] }) };
    return { service: new ProvenanceAnchorService({ db, records, authenticator: async () => ({ wallet: owner }), config, reader }), records };
  }

  it("reports provenance failure and verification failure without a verified publication", async () => {
    const reverted = anchorService({ getNetwork: async () => ({ chainId: 43113 }), getTransaction: async () => ({ to: anchorAddress, from: owner, data: "0x" }), getTransactionReceipt: async () => ({ status: 0, logs: [] }), getBlock: async () => ({ timestamp: 1 }), isAnchored: async () => false }, { id: "proof-1", anchor_status: "PENDING", verification_status: "UNVERIFIED" });
    const { encodeAnchorCall } = await import("./provenance-anchor.js");
    const call = encodeAnchorCall({ releaseSlug: "the-record", editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });
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
    const call = encodeAnchorCall({ releaseSlug: "the-record", editionTitleSlug: "chapter-i", provenanceRoot: manifest.root });
    const encoded = new ethers.Interface(ANCHOR_ABI).encodeEventLog("ProvenanceAnchored", [call.provenanceRoot, call.releaseId, call.editionId, call.tokenId, owner, fujiRelease.contractAddress]);
    const reader = { getNetwork: async () => ({ chainId: 43113 }), getTransaction: async () => ({ to: anchorAddress, from: owner, data: call.data }), getTransactionReceipt: async () => ({ status: 1, blockNumber: 90, logs: [{ address: anchorAddress, topics: encoded.topics, data: encoded.data }] }), getBlock: async () => ({ timestamp: 1_758_835_200 }), isAnchored: async () => true };
    const failed = anchorService(reader, { id: "proof-1", anchor_status: "FAILED", verification_status: "UNVERIFIED", attempt_count: 1 });
    const verified = await failed.service.confirm({ request, releaseId: "release-1", input: { transactionHash: tx } });
    expect(failed.records.retryProof).toHaveBeenCalled();
    expect(verified).toMatchObject({ provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true, verificationStatus: "VERIFIED", status: "PUBLISHED" });
  });
});
