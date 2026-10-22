import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const releaseContract = "0x4444444444444444444444444444444444444444";
const releaseKey = `0x${"5a".repeat(32)}`;
const draftUri = "ipfs://QmDraftIntended";
const chainUri = "ipfs://QmAlreadyOnChain";
const request = { requestId: "request-1", headers: {} };
const tx = `0x${"ab".repeat(32)}`;
const editionId = ethers.encodeBytes32String("forgive-forget");
// The deployed clone derives token IDs as keccak256(abi.encode("the-void:release-edition:v1", editionId)); these never change.
const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId])));
const staleTokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", ethers.encodeBytes32String("forgive-and-forget")])));
const manifestFor = (createdAt) => canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt, artwork: "11".repeat(32) });
const draftManifest = manifestFor("2026-10-22T10:42:45.600Z");
const chainManifest = manifestFor("2026-10-22T10:34:02.595Z");
const docFor = (manifest, digest = "a".repeat(64)) => ({ _void: { version: 1, digest }, provenance: manifest.record });
const editionIface = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);

const royaltyIface = new ethers.Interface(["event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps)"]);
function royaltyLog() {
  const encoded = royaltyIface.encodeEventLog("RoyaltyConfigured", [tokenId, owner, 250n]);
  return { address: releaseContract, topics: encoded.topics, data: encoded.data };
}

function editionLog(uri) {
  const encoded = editionIface.encodeEventLog("EditionCreated", [tokenId, releaseKey, editionId, owner, 0n, uri]);
  return { address: releaseContract, topics: encoded.topics, data: encoded.data };
}

const binding = { release_contract_id: "contract-release", release_contract_address: releaseContract, provenance_anchor_address: "0x3333333333333333333333333333333333333333", primary_sale_address: "0x5555555555555555555555555555555555555555", factory_address: "0x6666666666666666666666666666666666666666", chain_id: "43114", release_key: releaseKey, implementation_version: 2, deployment_block_number: "100" };

function harness({ chainUriOnChain = chainUri, rowUri = draftUri, extraRows = [], fetched = docFor(chainManifest), editionStatus = "DRAFT", releaseStatus = "DRAFT", exists = true, found = [{ transactionHash: tx }] } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "the-record", title: "Forgive & Forget", description: null, status: releaseStatus, release_metadata: { publicationArchitecture: "release-per-contract" }, published_at: null, display_name: "Voidcaller" };
  const doc = docFor(draftManifest);
  const row = { id: "edition-1", release_id: "release-1", contract_id: "contract-release", title: "Forgive & Forget", description: null, tier: null, supply: "0", status: editionStatus, application_metadata: {}, metadata_uri: rowUri, metadata: doc, metadata_version: doc._void.digest, token_id: tokenId.toString() };
  const stale = { ...row, metadata_uri: null, metadata: null, metadata_version: null, token_id: staleTokenId.toString() };
  const chain = {
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 90, logs: [editionLog(chainUriOnChain), royaltyLog()] }),
    edition: vi.fn().mockResolvedValue([releaseKey, editionId, owner, 0n, 0n, chainUriOnChain, exists]),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
    getBlockNumber: vi.fn().mockResolvedValue(4500),
    getLogs: vi.fn().mockImplementation(async ({ fromBlock }) => (fromBlock === 4100 ? found : [])),
  };
  const queries = [];
  const db = { query: vi.fn(async (sql, params) => {
    const text = String(sql);
    queries.push({ text, params });
    if (text.includes("FROM experiences") || text.includes("FROM media_assets")) return { rows: [] };
    if (text.includes("AS release_contract_address")) return { rows: [binding] };
    if (text.includes("FROM editions e")) return { rows: [...extraRows.map((r) => r === "stale" ? stale : r), row] };
    if (text.startsWith("DELETE")) return { rows: [] };
    return { rows: [release] };
  }) };
  const repo = { saveRelease: vi.fn(async (input) => input), saveEdition: vi.fn(async (input) => input), saveToken: vi.fn(async (input) => input), saveExperience: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})) };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  const metadataFetcher = vi.fn(async () => Buffer.from(JSON.stringify(fetched)));
  const instance = new ArtistStudioService({
    db: verifiedArtistDb(db),
    repository: repo,
    metadataStorage: { write: vi.fn().mockResolvedValue({ uri: draftUri }) },
    publicationChain: chain,
    metadataFetcher,
    authenticator: vi.fn().mockResolvedValue({ wallet: owner }),
    logger: { error: vi.fn(), info: vi.fn() },
  });
  return { instance, repo, chain, queries, metadataFetcher };
}

const confirm = (instance, input = { transactionHash: tx }) => instance.confirmPublication({ request, releaseId: "release-1", input });

describe("Studio publication recovery on the deployed hash-derived token IDs", () => {
  it("confirms a successful creation and keeps the contract's hash-derived token ID", async () => {
    const { instance, repo, queries } = harness({ rowUri: chainUri });
    const confirmed = await confirm(instance);
    expect(confirmed).toMatchObject({ status: "PUBLISHED", tokenId: tokenId.toString(), transactionHash: tx });
    expect(tokenId.toString()).toBe("25679935302133066722236771263728427871936411831072189551573738559199048803312");
    expect(repo.saveToken).not.toHaveBeenCalled();
    expect(repo.saveEdition).toHaveBeenCalledWith(expect.objectContaining({ id: "edition-1", status: "PUBLISHED" }));
    expect(queries.find((q) => q.text.startsWith("DELETE"))).toMatchObject({ params: ["edition-1", "contract-release", tokenId.toString()] });
  });

  it("picks the token row of the contract-derived ID when a stale duplicate row comes first, then drops only the metadata-less stale row", async () => {
    const { instance, repo, queries } = harness({ rowUri: chainUri, extraRows: ["stale"] });
    await expect(confirm(instance)).resolves.toMatchObject({ status: "PUBLISHED", tokenId: tokenId.toString() });
    const cleanup = queries.find((q) => q.text.startsWith("DELETE"));
    expect(cleanup.text).toContain("metadata_uri IS NULL");
    expect(cleanup.text).toContain("token_id<>$3::numeric");
    expect(repo.saveEdition).toHaveBeenCalledOnce();
  });

  it("recovers a creation that was never confirmed by finding the transaction on-chain", async () => {
    const { instance, chain, repo } = harness({ rowUri: chainUri });
    const confirmed = await confirm(instance, {});
    expect(confirmed).toMatchObject({ status: "PUBLISHED", transactionHash: tx });
    const filter = chain.getLogs.mock.calls.map(([f]) => f).find((f) => f.fromBlock === 4100);
    expect(filter.address).toBe(releaseContract);
    expect(filter.topics[1]).toBe(ethers.zeroPadValue(ethers.toBeHex(tokenId), 32));
    expect(repo.saveEdition).toHaveBeenCalledOnce();
  });

  it("changes nothing when no creation transaction exists", async () => {
    const { instance, repo } = harness({ rowUri: chainUri, found: [] });
    await expect(confirm(instance, {})).rejects.toMatchObject({ code: "EDITION_CREATION_NOT_FOUND" });
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveRelease).not.toHaveBeenCalled();
  });

  it("is idempotent: repeating a confirmation writes the same rows and never inserts a token row", async () => {
    const { instance, repo } = harness({ rowUri: chainUri });
    const first = await confirm(instance);
    const second = await confirm(instance);
    expect(second).toMatchObject({ tokenId: first.tokenId, transactionHash: tx });
    expect(repo.saveToken).not.toHaveBeenCalled();
    expect(repo.saveEdition.mock.calls[0][0]).toEqual(repo.saveEdition.mock.calls[1][0]);
  });

  it("refuses to republish metadata for an edition that already exists on-chain", async () => {
    const { instance, repo } = harness({ rowUri: chainUri });
    await expect(instance.publishMetadata({ request, releaseId: "release-1", input: {} })).rejects.toMatchObject({ status: 409, code: "EDITION_ALREADY_ON_CHAIN", details: { tokenId: tokenId.toString(), onChainMetadataUri: chainUri } });
    expect(repo.saveToken).not.toHaveBeenCalled();
  });

  it("does not adopt a different on-chain URI unless the artist accepts it, and reports both URIs", async () => {
    const { instance, repo } = harness();
    await expect(confirm(instance)).rejects.toMatchObject({ code: "METADATA_URI_MISMATCH", details: { onChainMetadataUri: chainUri, draftMetadataUri: draftUri, tokenId: tokenId.toString() } });
    expect(repo.saveToken).not.toHaveBeenCalled();
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });

  it("adopts the on-chain edition on acceptance and keeps the intended draft URI recorded, never overwritten silently", async () => {
    const { instance, repo, metadataFetcher } = harness();
    const confirmed = await confirm(instance, { transactionHash: tx, acceptOnChainMetadata: true });
    expect(confirmed).toMatchObject({ status: "PUBLISHED", tokenId: tokenId.toString() });
    expect(metadataFetcher).toHaveBeenCalledWith(chainUri);
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ editionId: "edition-1", tokenId, metadataUri: chainUri }));
    const saved = repo.saveEdition.mock.calls[0][0];
    expect(saved.metadata.unattachedDraftMetadata).toMatchObject({ uri: draftUri, reason: "EDITION_ALREADY_ON_CHAIN", transactionHash: tx, provenanceRoot: draftManifest.root });
  });

  it("refuses to adopt on-chain metadata whose content differs from the draft", async () => {
    const { instance, repo } = harness({ fetched: docFor(chainManifest, "f".repeat(64)) });
    await expect(confirm(instance, { transactionHash: tx, acceptOnChainMetadata: true })).rejects.toMatchObject({ code: "ONCHAIN_METADATA_DIVERGED" });
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
  });
});
