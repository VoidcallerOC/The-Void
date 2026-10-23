import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";
import { anchorsProvenanceAtCreation, sequentialEditionId, usesSequentialTokenIds } from "../config/release-network.js";

// A Factory V4 release (ReleaseCreated version 4) clones VoidRelease1155V6Sequential: token IDs are 1, 2, 3, ...
// per release contract and an edition's on-chain edition ID is bytes32(tokenId). The title never feeds the ID.
const owner = "0x1111111111111111111111111111111111111111";
const releaseContract = "0x4444444444444444444444444444444444444444";
const releaseKey = `0x${"5a".repeat(32)}`;
const metadataUri = "ipfs://QmSequentialForgiveForget";
const request = { requestId: "request-1", headers: {} };
const tx = `0x${"ab".repeat(32)}`;
const hashTokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", ethers.encodeBytes32String("forgive-forget")])));
const manifest = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt: "2026-10-23T19:00:00.000Z", artwork: "11".repeat(32) });
const doc = { name: "Forgive & Forget", _void: { version: 1, digest: "a".repeat(64) }, provenance: manifest.record };
const editionIface = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
const royaltyIface = new ethers.Interface(["event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps)"]);
const binding = { release_contract_id: "contract-release", release_contract_address: releaseContract, provenance_anchor_address: "0x3333333333333333333333333333333333333333", primary_sale_address: "0x5555555555555555555555555555555555555555", factory_address: "0x6666666666666666666666666666666666666666", chain_id: "43114", release_key: releaseKey, implementation_version: 4 };

function creationLogs({ tokenId = 1n, editionId = sequentialEditionId(1n), uri = metadataUri } = {}) {
  const created = editionIface.encodeEventLog("EditionCreated", [tokenId, releaseKey, editionId, owner, 0n, uri]);
  const royalty = royaltyIface.encodeEventLog("RoyaltyConfigured", [tokenId, owner, 250n]);
  return [{ address: releaseContract, topics: created.topics, data: created.data }, { address: releaseContract, topics: royalty.topics, data: royalty.data }];
}

function harness({ reserved = "1", maxOnContract = "0", nextTokenId = 1n, onChainExists = false, logs = creationLogs(), attempt = null, rowUri = metadataUri } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "forgive-forget-7", title: "Forgive & Forget", description: null, status: "DRAFT", release_metadata: { publicationArchitecture: "release-per-contract" }, published_at: null, display_name: "Voidcaller" };
  const row = { id: "edition-1", release_id: "release-1", contract_id: "contract-release", title: "Forgive & Forget", description: null, tier: null, supply: "0", status: "DRAFT", application_metadata: attempt ? { publicationAttempt: attempt } : {}, metadata_uri: rowUri, metadata: doc, metadata_version: doc._void.digest, token_id: reserved };
  const chain = {
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 90, logs }),
    edition: vi.fn().mockResolvedValue([releaseKey, sequentialEditionId(1n), owner, 0n, 0n, onChainExists ? metadataUri : "", onChainExists]),
    nextTokenId: vi.fn().mockResolvedValue(nextTokenId),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_792_000_000 }),
  };
  const queries = [];
  const db = { query: vi.fn(async (sql, params) => {
    const text = String(sql);
    queries.push({ text, params });
    if (text.includes("FROM experiences") || text.includes("FROM media_assets")) return { rows: [] };
    if (text.includes("AS release_contract_address")) return { rows: [binding] };
    if (text.includes("SELECT token_id::text AS token_id FROM tokens WHERE edition_id=$1")) return { rows: reserved == null ? [] : [{ token_id: reserved }] };
    if (text.includes("COALESCE(MAX(token_id), 0)")) return { rows: [{ last_token_id: maxOnContract }] };
    if (text.includes("FROM tokens t JOIN contracts c")) return { rows: [] };
    if (text.includes("FROM editions e")) return { rows: [row] };
    if (text.startsWith("DELETE")) return { rows: [] };
    return { rows: [release] };
  }) };
  const repo = { saveRelease: vi.fn(async (input) => input), saveEdition: vi.fn(async (input) => input), saveToken: vi.fn(async (input) => input), saveContract: vi.fn(async () => ({ id: "contract-release" })), saveExperience: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})) };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  const metadataStorage = { write: vi.fn().mockResolvedValue({ uri: metadataUri }) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, metadataStorage, publicationChain: chain, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { error: vi.fn(), info: vi.fn() } });
  return { instance, repo, chain, queries, metadataStorage };
}

const attemptFor = (overrides = {}) => ({ transactionHash: tx, metadataUri, tokenId: "1", submittedAt: "2026-10-23T19:00:00.000Z", ...overrides });
const publish = (instance) => instance.publishMetadata({ request, releaseId: "release-1", input: {} });
const confirm = (instance, input = {}) => instance.confirmPublication({ request, releaseId: "release-1", input });

describe("release version routing", () => {
  it("version 4 is sequential and keeps the separate provenance anchor; only version 3 anchors at creation", () => {
    expect(usesSequentialTokenIds(4)).toBe(true);
    expect([2, 3, 5].map(usesSequentialTokenIds)).toEqual([false, false, false]);
    expect([2, 3, 4, 5].map(anchorsProvenanceAtCreation)).toEqual([false, true, false, false]);
    expect(sequentialEditionId(1n)).toBe(`0x${"0".repeat(63)}1`);
    expect(() => sequentialEditionId(0n)).toThrow();
  });
});

describe("a sequential release: token 1 is the reserved number, never the title hash", () => {
  it("publishes metadata for the reserved token 1 and returns the bytes32(1) edition ID to sign", async () => {
    const { instance, repo, chain } = harness();
    const published = await publish(instance);
    expect(published).toMatchObject({ tokenId: "1", tokenIdScheme: "sequential", onChainEditionId: sequentialEditionId(1n), releaseKey });
    expect(chain.nextTokenId).toHaveBeenCalled();
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ editionId: "edition-1", tokenId: 1n, metadataUri }));
    expect(published.tokenId).not.toBe(hashTokenId.toString());
  });

  it("refuses to publish a track whose number is not the contract's next token ID", async () => {
    const { instance, metadataStorage } = harness({ reserved: "2", nextTokenId: 1n });
    await expect(publish(instance)).rejects.toMatchObject({ status: 409, code: "SEQUENTIAL_TOKEN_ID_NOT_NEXT", details: { tokenId: "2", nextTokenId: "1" } });
    expect(metadataStorage.write).not.toHaveBeenCalled();
  });

  it("refuses a track that has no reserved number", async () => {
    const { instance } = harness({ reserved: null });
    await expect(publish(instance)).rejects.toMatchObject({ status: 409, code: "EDITION_TOKEN_REQUIRED" });
  });

  it("freezes token 1 when the creation transaction is submitted", async () => {
    const { instance, repo } = harness();
    await expect(instance.recordPublicationSubmission({ request, releaseId: "release-1", input: { transactionHash: tx } })).resolves.toMatchObject({ transactionHash: tx, tokenId: "1" });
    expect(repo.saveEdition).toHaveBeenCalledWith(expect.objectContaining({ metadata: { publicationAttempt: expect.objectContaining({ tokenId: "1" }) } }));
  });

  it("confirms EditionCreated(tokenId 1, releaseKey, bytes32(1)) and persists token 1", async () => {
    const { instance, repo, chain } = harness({ attempt: attemptFor(), onChainExists: true });
    await expect(confirm(instance)).resolves.toMatchObject({ status: "PUBLISHED", tokenId: "1", transactionHash: tx });
    expect(chain.edition).toHaveBeenCalledWith(1n);
    const saved = repo.saveEdition.mock.calls.at(-1)[0];
    expect(saved.metadata.publicationAttempt).toMatchObject({ tokenId: "1", emittedTokenId: "1", confirmedBlock: 90 });
  });

  it("does not confirm a creation event that names another token or the title-slug edition ID", async () => {
    for (const logs of [creationLogs({ tokenId: 2n, editionId: sequentialEditionId(2n) }), creationLogs({ tokenId: 1n, editionId: ethers.encodeBytes32String("forgive-forget") })]) {
      const { instance, repo } = harness({ attempt: attemptFor(), onChainExists: true, logs });
      await expect(confirm(instance)).rejects.toMatchObject({ code: "PUBLICATION_NOT_CONFIRMED" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    }
  });
});

describe("saving a track on a sequential release reserves its number", () => {
  const save = (instance, input = {}) => instance.createEdition({ request, releaseId: "release-1", input: { trackTitle: "Forgive & Forget", quantity: "0", ...input } });

  it("the first track of a fresh release contract is token 1", async () => {
    const { instance, repo, queries } = harness({ reserved: null, maxOnContract: "0" });
    await save(instance);
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ contractId: "contract-release", tokenId: 1n, metadataUri: null }));
    expect(queries.some(({ text }) => text.includes("FROM releases WHERE id=$1 FOR UPDATE"))).toBe(true);
  });

  it("a new track with a duplicate title takes the next number after every existing token row", async () => {
    const { instance, repo } = harness({ reserved: null, maxOnContract: "2" });
    await save(instance);
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 3n }));
  });

  it("re-saving a track keeps the number it already holds", async () => {
    const { instance, repo } = harness({ reserved: "1", maxOnContract: "4" });
    await save(instance);
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ tokenId: 1n }));
  });
});
