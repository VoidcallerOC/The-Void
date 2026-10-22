import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const releaseContract = "0x4444444444444444444444444444444444444444";
const releaseKey = `0x${"5a".repeat(32)}`;
const frozenUri = "ipfs://QmFrozenAtSubmission";
const republishedUri = "ipfs://QmRepublishedLater";
const request = { requestId: "request-1", headers: {} };
const tx = `0x${"ab".repeat(32)}`;
const otherTx = `0x${"cd".repeat(32)}`;
const editionId = ethers.encodeBytes32String("forgive-forget");
// The deployed clone derives token IDs as keccak256(abi.encode("the-void:release-edition:v1", editionId)); unchanged here.
const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId])));
const staleTokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", ethers.encodeBytes32String("forgive-and-forget")])));
const manifest = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt: "2026-10-22T10:42:45.600Z", artwork: "11".repeat(32) });
const doc = { _void: { version: 1, digest: "a".repeat(64) }, provenance: manifest.record };
const editionIface = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
const royaltyIface = new ethers.Interface(["event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps)"]);
const binding = { release_contract_id: "contract-release", release_contract_address: releaseContract, provenance_anchor_address: "0x3333333333333333333333333333333333333333", primary_sale_address: "0x5555555555555555555555555555555555555555", factory_address: "0x6666666666666666666666666666666666666666", chain_id: "43114", release_key: releaseKey, implementation_version: 2 };

function logs(uri) {
  const created = editionIface.encodeEventLog("EditionCreated", [tokenId, releaseKey, editionId, owner, 0n, uri]);
  const royalty = royaltyIface.encodeEventLog("RoyaltyConfigured", [tokenId, owner, 250n]);
  return [{ address: releaseContract, topics: created.topics, data: created.data }, { address: releaseContract, topics: royalty.topics, data: royalty.data }];
}

function harness({ attempt = null, rowUri = frozenUri, onChainUri = frozenUri, onChainExists = true, extraStale = false, editionStatus = "DRAFT", releaseStatus = "DRAFT" } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "the-record", title: "Forgive & Forget", description: null, status: releaseStatus, release_metadata: { publicationArchitecture: "release-per-contract" }, published_at: null, display_name: "Voidcaller" };
  const row = { id: "edition-1", release_id: "release-1", contract_id: "contract-release", title: "Forgive & Forget", description: null, tier: null, supply: "0", status: editionStatus, application_metadata: attempt ? { publicationAttempt: attempt } : {}, metadata_uri: rowUri, metadata: doc, metadata_version: doc._void.digest, token_id: tokenId.toString() };
  const stale = { ...row, metadata_uri: null, metadata: null, token_id: staleTokenId.toString() };
  const chain = {
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 90, logs: logs(onChainUri) }),
    edition: vi.fn().mockResolvedValue([releaseKey, editionId, owner, 0n, 0n, onChainUri, onChainExists]),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
  };
  const queries = [];
  const db = { query: vi.fn(async (sql, params) => {
    const text = String(sql);
    queries.push({ text, params });
    if (text.includes("FROM experiences") || text.includes("FROM media_assets")) return { rows: [] };
    if (text.includes("AS release_contract_address")) return { rows: [binding] };
    if (text.includes("FROM editions e")) return { rows: extraStale ? [stale, row] : [row] };
    if (text.startsWith("DELETE")) return { rows: [] };
    return { rows: [release] };
  }) };
  const repo = { saveRelease: vi.fn(async (input) => input), saveEdition: vi.fn(async (input) => input), saveToken: vi.fn(async (input) => input), saveExperience: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})) };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  const metadataStorage = { write: vi.fn().mockResolvedValue({ uri: republishedUri }) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, metadataStorage, publicationChain: chain, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { error: vi.fn(), info: vi.fn() } });
  return { instance, repo, chain, queries, metadataStorage };
}

const attemptFor = (overrides = {}) => ({ transactionHash: tx, metadataUri: frozenUri, tokenId: tokenId.toString(), submittedAt: "2026-10-22T10:34:06.000Z", ...overrides });
const submit = (instance, hash = tx) => instance.recordPublicationSubmission({ request, releaseId: "release-1", input: { transactionHash: hash } });
const confirm = (instance, input = {}) => instance.confirmPublication({ request, releaseId: "release-1", input });

describe("a clean new release: submission is recorded, then confirmed from the record", () => {
  it("freezes the metadata URI and the contract-derived token ID when the transaction is submitted", async () => {
    const { instance, repo } = harness();
    const recorded = await submit(instance);
    expect(recorded).toMatchObject({ transactionHash: tx, metadataUri: frozenUri, tokenId: tokenId.toString() });
    expect(tokenId.toString()).toBe("25679935302133066722236771263728427871936411831072189551573738559199048803312");
    expect(repo.saveEdition).toHaveBeenCalledWith(expect.objectContaining({ id: "edition-1", status: "DRAFT", metadata: { publicationAttempt: expect.objectContaining({ transactionHash: tx, metadataUri: frozenUri }) } }));
  });

  it("confirms from the recorded transaction without being handed a hash, and persists the emitted token ID", async () => {
    const { instance, repo } = harness({ attempt: attemptFor() });
    const confirmed = await confirm(instance);
    expect(confirmed).toMatchObject({ status: "PUBLISHED", transactionHash: tx, tokenId: tokenId.toString() });
    const saved = repo.saveEdition.mock.calls[0][0];
    expect(saved).toMatchObject({ status: "PUBLISHED" });
    expect(saved.metadata.publicationAttempt).toMatchObject({ transactionHash: tx, metadataUri: frozenUri, emittedTokenId: tokenId.toString(), tokenId: tokenId.toString() });
    expect(saved.metadata.publicationAttempt.confirmedAt).toBeTruthy();
  });

  it("publishes metadata exactly once for a fresh edition that is not yet on-chain", async () => {
    const { instance, metadataStorage } = harness({ onChainExists: false, onChainUri: "" });
    const published = await instance.publishMetadata({ request, releaseId: "release-1", input: {} });
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    expect(published).toMatchObject({ tokenId: tokenId.toString(), metadataUri: expect.any(String), releaseKey });
  });

  it("recording the same transaction twice is idempotent and a different one is refused", async () => {
    const { instance, repo } = harness({ attempt: attemptFor() });
    await expect(submit(instance)).resolves.toMatchObject({ alreadyRecorded: true, transactionHash: tx });
    await expect(submit(instance, otherTx)).rejects.toMatchObject({ code: "PUBLICATION_ATTEMPT_EXISTS" });
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });
});

describe("the original URI-mismatch failure cannot recur", () => {
  it("refuses to republish metadata once a creation transaction is recorded", async () => {
    const { instance, repo, metadataStorage } = harness({ attempt: attemptFor() });
    await expect(instance.publishMetadata({ request, releaseId: "release-1", input: {} })).rejects.toMatchObject({ status: 409, code: "PUBLICATION_ATTEMPT_RECORDED", details: { transactionHash: tx, metadataUri: frozenUri } });
    expect(metadataStorage.write).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
  });

  it("refuses to publish metadata for an edition identity that already exists on-chain, without adopting it", async () => {
    const { instance, repo, metadataStorage } = harness({ onChainExists: true, onChainUri: "ipfs://QmAlreadyThere" });
    await expect(instance.publishMetadata({ request, releaseId: "release-1", input: {} })).rejects.toMatchObject({ status: 409, code: "EDITION_ALREADY_ON_CHAIN" });
    expect(metadataStorage.write).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
  });

  it("never adopts a different on-chain URI: a stored URI that drifted from the frozen one fails closed", async () => {
    const { instance, repo } = harness({ attempt: attemptFor(), rowUri: republishedUri });
    await expect(confirm(instance)).rejects.toMatchObject({ code: "PUBLICATION_METADATA_DIVERGED", details: { frozenMetadataUri: frozenUri } });
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveRelease).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
  });

  it("fails closed when the chain's URI differs from the frozen one", async () => {
    const { instance, repo } = harness({ attempt: attemptFor(), onChainUri: republishedUri });
    await expect(confirm(instance)).rejects.toMatchObject({ code: "PUBLICATION_NOT_CONFIRMED" });
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });

  it("refuses a supplied transaction that differs from the recorded one", async () => {
    const { instance, repo } = harness({ attempt: attemptFor() });
    await expect(confirm(instance, { transactionHash: otherTx })).rejects.toMatchObject({ code: "PUBLICATION_TRANSACTION_MISMATCH" });
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });

  it("needs a transaction hash when none was ever recorded", async () => {
    const { instance } = harness();
    await expect(confirm(instance)).rejects.toMatchObject({ code: "TRANSACTION_REQUIRED" });
  });
});

describe("confirmation is idempotent and leaves one canonical token row", () => {
  it("repeating a confirmed attempt returns the stored outcome and writes nothing", async () => {
    const confirmedAttempt = attemptFor({ confirmedAt: "2026-10-22T10:35:00.000Z", emittedTokenId: tokenId.toString() });
    const { instance, repo, chain } = harness({ attempt: confirmedAttempt, editionStatus: "PUBLISHED", releaseStatus: "PUBLISHED" });
    const again = await confirm(instance);
    expect(again).toMatchObject({ alreadyConfirmed: true, tokenId: tokenId.toString(), transactionHash: tx });
    expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
  });

  it("picks the token row of the contract-derived ID over a stale duplicate and drops only the metadata-less stale row", async () => {
    const { instance, queries, repo } = harness({ attempt: attemptFor(), extraStale: true });
    await expect(confirm(instance)).resolves.toMatchObject({ status: "PUBLISHED", tokenId: tokenId.toString() });
    const cleanup = queries.find((q) => q.text.startsWith("DELETE"));
    expect(cleanup.params).toEqual(["edition-1", "contract-release", tokenId.toString()]);
    expect(cleanup.text).toContain("metadata_uri IS NULL");
    expect(repo.saveToken).not.toHaveBeenCalled();
  });
});
