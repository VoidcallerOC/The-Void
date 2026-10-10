import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { canonicalProvenanceManifest } from "./provenance-manifest.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService, RELEASE_PROVENANCE_ABI } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const stranger = "0x2222222222222222222222222222222222222222";
const releaseContract = "0x4444444444444444444444444444444444444444";
const v2Anchor = "0x3333333333333333333333333333333333333333";
const releaseKey = `0x${"5a".repeat(32)}`;
const metadataUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const request = { requestId: "request-1", headers: {} };
const tx = `0x${"ab".repeat(32)}`;
const editionId = ethers.encodeBytes32String("chapter-i");
const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId])));
const manifest = canonicalProvenanceManifest({ releaseId: "release-1", editionId: "edition-1", creator: { artistId: "artist-1", wallet: owner }, metadataDigest: "a".repeat(64), createdAt: "2026-09-25T20:00:00.000Z", artwork: "11".repeat(32) });
const root = `0x${manifest.root}`;
const editionIface = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
const provenanceIface = new ethers.Interface(RELEASE_PROVENANCE_ABI);

function editionLog() {
  const encoded = editionIface.encodeEventLog("EditionCreated", [tokenId, releaseKey, editionId, owner, 10n, metadataUri]);
  return { address: releaseContract, topics: encoded.topics, data: encoded.data };
}

function anchoredLog({ provenanceRoot = root, artist = owner, address = releaseContract, loggedRelease = releaseContract } = {}) {
  const encoded = provenanceIface.encodeEventLog("ProvenanceAnchored", [provenanceRoot, releaseKey, editionId, tokenId, artist, loggedRelease]);
  return { address, topics: encoded.topics, data: encoded.data };
}

function binding(version) {
  return { release_contract_id: "contract-release", release_contract_address: releaseContract, provenance_anchor_address: version >= 3 ? releaseContract : v2Anchor, primary_sale_address: "0x5555555555555555555555555555555555555555", factory_address: "0x6666666666666666666666666666666666666666", chain_id: "43113", release_key: releaseKey, implementation_version: version };
}

function harness({ version = 3, logs = [editionLog(), anchoredLog()], anchored = true, storedRoot = root, editionStatus = "DRAFT" } = {}) {
  const release = { id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "DRAFT", release_metadata: { publicationArchitecture: "release-per-contract" }, published_at: null, display_name: "Voidcaller" };
  const document = { _void: { version: 1, digest: "a".repeat(64) }, provenance: manifest.record };
  const edition = { id: "edition-1", release_id: "release-1", contract_id: "contract-release", title: "Chapter I", description: null, tier: null, supply: "10", status: editionStatus, application_metadata: {}, metadata_uri: metadataUri, metadata: document, metadata_version: document._void.digest, token_id: tokenId.toString() };
  const chain = {
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 90, logs }),
    edition: vi.fn().mockResolvedValue([releaseKey, editionId, owner, 10n, 0n, metadataUri, true]),
    getBlock: vi.fn().mockResolvedValue({ timestamp: 1_758_835_200 }),
    isAnchored: vi.fn().mockResolvedValue(anchored),
    provenanceRootOf: vi.fn().mockResolvedValue(storedRoot),
  };
  const db = { query: vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes("FROM experiences") || text.includes("FROM media_assets")) return { rows: [] };
    if (text.includes("AS release_contract_address")) return { rows: [binding(version)] };
    if (text.includes("FROM editions e")) return { rows: [edition] };
    return { rows: [release] };
  }) };
  const repo = { saveRelease: vi.fn(async (input) => input), saveEdition: vi.fn(async (input) => input), saveToken: vi.fn(async (input) => input), saveExperience: vi.fn(async (input) => input), appendAuditEvent: vi.fn(async () => ({})) };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  const instance = new ArtistStudioService({
    db: verifiedArtistDb(db),
    repository: repo,
    metadataStorage: { write: vi.fn().mockResolvedValue({ uri: metadataUri }) },
    publicationChain: chain,
    authenticator: vi.fn().mockResolvedValue({ wallet: owner }),
    logger: { error: vi.fn(), info: vi.fn() },
  });
  return { instance, repo, chain };
}

const confirm = (instance) => instance.confirmPublication({ request, releaseId: "release-1", input: { transactionHash: tx } });

describe("Factory V3 publication records the provenance root in the edition transaction", () => {
  it("publishes only when the same transaction anchored the canonical root on the release contract", async () => {
    const { instance, repo, chain } = harness();
    await expect(confirm(instance)).resolves.toMatchObject({
      status: "PUBLISHED",
      provenanceAtCreation: true,
      separateAnchorAvailable: false,
      onChainProvenance: { event: "ProvenanceAnchored", contract: releaseContract, provenanceRoot: root, artist: owner, tokenId: tokenId.toString() },
    });
    expect(chain.isAnchored).toHaveBeenCalledWith({ releaseId: releaseKey, editionId, provenanceRoot: root });
    expect(chain.provenanceRootOf).toHaveBeenCalledWith(tokenId);
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED" }));
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_PUBLICATION_CONFIRMED", payload: expect.objectContaining({ provenanceAnchoredAtCreation: true }) }));
  });

  it("refuses success when the transaction recorded no root", async () => {
    const { instance, repo } = harness({ logs: [editionLog()] });
    await expect(confirm(instance)).rejects.toMatchObject({ status: 409, code: "PROVENANCE_ROOT_NOT_ANCHORED" });
    expect(repo.saveRelease).not.toHaveBeenCalled();
    expect(repo.saveEdition).not.toHaveBeenCalled();
  });

  it("ignores a look-alike ProvenanceAnchored log from any other contract", async () => {
    const { instance, repo } = harness({ logs: [editionLog(), anchoredLog({ address: stranger, loggedRelease: releaseContract })] });
    await expect(confirm(instance)).rejects.toMatchObject({ code: "PROVENANCE_ROOT_NOT_ANCHORED" });
    expect(repo.saveRelease).not.toHaveBeenCalled();
  });

  it("refuses success on a different root, attester, or logged release contract", async () => {
    for (const log of [anchoredLog({ provenanceRoot: `0x${"cd".repeat(32)}` }), anchoredLog({ artist: stranger }), anchoredLog({ loggedRelease: stranger })]) {
      const { instance, repo } = harness({ logs: [editionLog(), log] });
      await expect(confirm(instance)).rejects.toMatchObject({ code: "PROVENANCE_ROOT_MISMATCH" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    }
  });

  it("refuses success when the contract state does not record the root", async () => {
    for (const state of [{ anchored: false }, { storedRoot: `0x${"00".repeat(32)}` }]) {
      const { instance, repo } = harness(state);
      await expect(confirm(instance)).rejects.toMatchObject({ code: "PROVENANCE_ROOT_MISMATCH" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    }
  });

  it("keeps the release unpublished and retryable when the provenance state cannot be read", async () => {
    const { instance, repo, chain } = harness();
    chain.isAnchored.mockRejectedValueOnce(new Error("rpc down"));
    await expect(confirm(instance)).rejects.toMatchObject({ status: 503, code: "PROVENANCE_STATE_UNAVAILABLE" });
    expect(repo.saveRelease).not.toHaveBeenCalled();
  });

  it("leaves Factory V2 releases on the separate-anchor path", async () => {
    const { instance, chain } = harness({ version: 2, logs: [editionLog()] });
    await expect(confirm(instance)).resolves.toMatchObject({ status: "PUBLISHED", provenanceAtCreation: false, onChainProvenance: null, separateAnchorAvailable: true });
    expect(chain.isAnchored).not.toHaveBeenCalled();
  });

  it("hands Studio the bytes32 root to pass into the creation call for V3 releases only", async () => {
    const v3 = await harness({ version: 3 }).instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "EP" } });
    expect(v3).toMatchObject({ provenanceAtCreation: true, implementationVersion: 3, provenanceAnchorAddress: releaseContract });
    expect(v3.provenanceRootBytes32).toBe(`0x${v3.provenanceRoot}`);
    const v2 = await harness({ version: 2 }).instance.publishMetadata({ request, releaseId: "release-1", input: { releaseType: "EP" } });
    expect(v2).toMatchObject({ provenanceAtCreation: false, implementationVersion: 2, provenanceAnchorAddress: v2Anchor });
    expect(v2.provenanceRootBytes32).toBeUndefined();
  });
});
