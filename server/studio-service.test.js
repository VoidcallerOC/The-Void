import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { ArtistStudioService, EDITION_ABI } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function repository() {
  const repo = {
    saveArtist: vi.fn(async (input) => ({ id: input.id, slug: input.slug, display_name: input.displayName, status: input.status })),
    saveArtistProfile: vi.fn(async (input) => input),
    assignArtistOwner: vi.fn(async (input) => input),
    saveRelease: vi.fn(async (input) => ({ id: input.id, artist_id: input.artistId, title: input.title, status: input.status, release_metadata: input.metadata })),
    saveContract: vi.fn(async () => ({ id: "contract-uuid" })),
    saveEdition: vi.fn(async (input) => ({ id: input.id, release_id: input.releaseId, contract_id: input.contractId, title: input.title, status: input.status })),
    saveToken: vi.fn(async (input) => input),
    saveExperience: vi.fn(async (input) => ({ id: input.id, edition_id: input.editionId, title: input.title, status: input.status, requirements: input.requirements, media_config: input.mediaConfig })),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}
function service({ rows = [], authenticated = true, authenticatedWallet = owner, metadataStorage = null } = {}) {
  const repo = repository();
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  return { instance: new ArtistStudioService({ db, repository: repo, metadataStorage, authenticator: authenticated ? vi.fn().mockResolvedValue({ wallet: authenticatedWallet }) : vi.fn().mockResolvedValue(null), logger: { info: vi.fn() } }), repo, db };
}
const request = { requestId: "request-1", headers: {} };

describe("Fuji edition ABI", () => {
  it("decodes the deployed Solidity struct return without shifting the address field", () => {
    const releaseId = ethers.encodeBytes32String("voidcaller");
    const editionId = ethers.encodeBytes32String("the-feet");
    const metadataUri = "ipfs://QmWT4u3APAUHCSDXfQiozcgEJgKQGJmUaTi1cLqaiLiTmt";
    const iface = new ethers.Interface([EDITION_ABI]);
    const tupleType = "tuple(bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists)";
    const raw = ethers.AbiCoder.defaultAbiCoder().encode([tupleType], [[releaseId, editionId, owner, 25n, 0n, metadataUri, true]]);
    const [edition] = iface.decodeFunctionResult("edition", raw);

    expect(edition[0]).toBe(releaseId);
    expect(edition[1]).toBe(editionId);
    expect(edition[2]).toBe(owner);
    expect(edition[3]).toBe(25n);
    expect(edition[5]).toBe(metadataUri);
    expect(edition[6]).toBe(true);
  });
});

describe("Artist Studio", () => {
  it("creates an artist profile only for the verified owner wallet", async () => {
    const { instance, repo } = service();
    const result = await instance.createArtist({ request, input: { id: "artist-1", name: "Voidcaller", slug: "voidcaller", bio: "Music-first." } });
    expect(result).toMatchObject({ id: "artist-1", slug: "voidcaller" });
    expect(repo.assignArtistOwner).toHaveBeenCalledWith({ artistId: "artist-1", wallet: owner, role: "OWNER" });
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_ARTIST_CREATED", actorWallet: owner }));
  });

  it("rejects artist creation without a verified wallet session", async () => {
    const { instance } = service({ authenticated: false });
    await expect(instance.createArtist({ request, input: { id: "artist-1", name: "Voidcaller", slug: "voidcaller" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows an owner to edit an artist but denies an unauthorized wallet", async () => {
    const authorized = service({ rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE", application_metadata: {}, bio: "old" }] });
    await expect(authorized.instance.updateArtist({ request, artistId: "artist-1", input: { name: "Voidcaller Updated", slug: "voidcaller" } })).resolves.toMatchObject({ display_name: "Voidcaller Updated" });
    expect(authorized.repo.saveArtist).toHaveBeenCalledWith(expect.objectContaining({ id: "artist-1", displayName: "Voidcaller Updated" }));

    const denied = service();
    await expect(denied.instance.updateArtist({ request, artistId: "artist-1", input: { name: "Not allowed" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
  });

  it("keeps publish authorization bound to wallet A and rejects wallet B or no session", async () => {
    const release = { id: "release-a", artist_id: "artist-a", slug: "voidcaller-full-ep", title: "Voidcaller Full EP", description: "The record.", status: "DRAFT", release_metadata: {}, published_at: null, display_name: "Voidcaller" };
    const edition = { id: "edition-a", release_id: release.id, contract_id: "contract-a", title: "Voidcaller Full EP", description: "The record.", tier: "standard", supply: "25", application_metadata: {}, metadata_uri: null, metadata_version: null };
    const metadataStorage = { write: vi.fn().mockResolvedValue({ uri: "ipfs://real-metadata-cid" }) };
    const authorized = service({ authenticatedWallet: owner, metadataStorage });
    authorized.db.query
      .mockResolvedValueOnce({ rows: [release] })
      .mockResolvedValueOnce({ rows: [edition] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(authorized.instance.publishMetadata({ request, releaseId: release.id, input: { releaseType: "EP" } })).resolves.toMatchObject({ releaseId: release.id, metadataUri: "ipfs://real-metadata-cid", digest: expect.stringMatching(/^[0-9a-f]{64}$/), provenanceRoot: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(metadataStorage.write).toHaveBeenCalledOnce();
    const published = authorized.repo.saveToken.mock.calls[0][0];
    expect(published.metadataVersion).toBe(published.metadata._void.digest);
    expect(published.metadata.provenance.metadataDigest).toBe(published.metadataVersion);
    expect(published.metadata.provenance.root).not.toBe(published.metadataVersion);
    expect(JSON.stringify(published.metadata.provenance)).not.toMatch(/storageKey|storage_key|ipfs:|https?:|secret|filename/i);

    const walletB = "0x2222222222222222222222222222222222222222";
    const denied = service({ authenticatedWallet: walletB, rows: [] });
    await expect(denied.instance.publishMetadata({ request, releaseId: release.id, input: { releaseType: "EP" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });

    const unauthenticated = service({ authenticated: false, rows: [] });
    await expect(unauthenticated.instance.publishMetadata({ request, releaseId: release.id, input: { releaseType: "EP" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("creates a release, validates lifecycle publishing, and prevents regression", async () => {
    const { instance, repo } = service({ rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] });
    await expect(instance.createRelease({ request, artistId: "artist-1", input: { id: "release-1", title: "The Record", slug: "the-record" } })).resolves.toMatchObject({ id: "release-1", status: "DRAFT" });
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", status: "DRAFT" }));

    const published = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "REVIEW", release_metadata: {}, published_at: null }] });
    await expect(published.instance.updateRelease({ request, releaseId: "release-1", input: { status: "PUBLISHED" } })).rejects.toMatchObject({ code: "PUBLICATION_REQUIRES_CONFIRMATION" });
    expect(published.repo.saveRelease).not.toHaveBeenCalled();

    const review = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "DRAFT", release_metadata: {}, published_at: null }] });
    await expect(review.instance.updateRelease({ request, releaseId: "release-1", input: { status: "REVIEW" } })).resolves.toMatchObject({ status: "REVIEW" });

    const regression = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "PUBLISHED", release_metadata: {}, published_at: new Date() }] });
    await expect(regression.instance.updateRelease({ request, releaseId: "release-1", input: { status: "REVIEW" } })).rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_INVALID" });
  });

  it("derives a title-only release slug and resolves collisions without client input", async () => {
    const first = service({ rows: [{ id: "artist-1", artist_id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] });
    await expect(first.instance.createRelease({ request, artistId: "artist-1", input: { title: "The Void — Summit Demo" } })).resolves.toMatchObject({ status: "DRAFT" });
    expect(first.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ slug: "the-void-summit-demo" }));

    const collision = service({ rows: [{ id: "artist-1", artist_id: "artist-1", slug: "my-new-record", display_name: "Voidcaller", status: "ACTIVE" }] });
    await collision.instance.createRelease({ request, artistId: "artist-1", input: { title: "My New Record!", slug: "" } });
    expect(collision.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ slug: "my-new-record-2" }));
  });

  it("preserves the internal release slug when a legacy client sends an invalid slug", async () => {
    const { instance, repo } = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-void-summit-demo", title: "Summit Demo", description: null, status: "DRAFT", release_metadata: {}, published_at: null }] });
    await instance.updateRelease({ request, releaseId: "release-1", input: { slug: "!!!", title: "Summit Demo Updated" } });
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ slug: "the-void-summit-demo", title: "Summit Demo Updated" }));
  });

  it("creates a contract-agnostic ERC-1155 edition and its experience", async () => {
    const { instance, repo } = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record" }] });
    const edition = await instance.createEdition({ request, releaseId: "release-1", input: { id: "edition-1", name: "Chapter I", chainId: 43113, contractAddress: contract, tokenId: "7", quantity: "100", priceWei: "1000000000000000000" } });
    expect(edition).toMatchObject({ id: "edition-1", status: "DRAFT" });
    expect(repo.saveContract).toHaveBeenCalledWith(expect.objectContaining({ address: "0x262b774cf9a1949170b58e2d57f6189980fe757b", contractType: "ERC1155", chainId: 43113 }));
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ editionId: "edition-1", tokenId: expect.any(BigInt), metadataUri: null }));

    const experienceService = service({ rows: [{ id: "edition-1", release_id: "release-1", artist_id: "artist-1" }] });
    experienceService.db.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("media_assets")) return { rows: [{ id: "asset-1", artist_id: "artist-1", storage_key: "records/full-record.mp3", media_type: "AUDIO" }] };
      if (text.includes("FROM tokens")) return { rows: [{ token_id: "7", contract_address: contract, chain_id: 43113 }] };
      return { rows: [{ id: "edition-1", release_id: "release-1", artist_id: "artist-1" }] };
    });
    const experience = await experienceService.instance.createExperience({ request, editionId: "edition-1", input: { id: "experience-1", title: "Full Record", type: "AUDIO", requirements: [{ type: "erc1155-balance", contract, tokenIds: ["7"] }], mediaConfig: { protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey: "records/full-record.mp3" }] } } });
    expect(experience).toMatchObject({ id: "experience-1", edition_id: "edition-1", status: "DRAFT" });
    expect(experienceService.repo.saveExperience).toHaveBeenCalledWith(expect.objectContaining({ mediaConfig: expect.objectContaining({ protectedMedia: [expect.objectContaining({ assetId: "asset-1" })] }) }));
    expect(JSON.stringify(experienceService.repo.saveExperience.mock.calls[0][0].mediaConfig)).not.toMatch(/storageKey|records\/full-record/);
  });

  it("derives the internal compatibility title from the release without editionName", async () => {
    const { instance, repo } = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "voidcaller-full-ep", title: "Voidcaller Full EP" }] });
    await expect(instance.createEdition({ request, releaseId: "release-1", input: { quantity: "25", priceWei: "1" } })).resolves.toMatchObject({ status: "DRAFT" });
    expect(repo.saveEdition).toHaveBeenCalledWith(expect.objectContaining({ title: "Voidcaller Full EP", supply: "25" }));
  });

  it("ignores artist blockchain fields and derives the certified contract and token", async () => {
    const { instance, repo } = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record" }] });
    await expect(instance.createEdition({ request, releaseId: "release-1", input: { name: "Bad", slug: "bad", chainId: 1, contractAddress: "not-an-address", tokenId: "-1", quantity: "1", priceWei: "1" } })).resolves.toMatchObject({ id: expect.stringMatching(/^edition-/) });
    expect(repo.saveContract).toHaveBeenCalledWith(expect.objectContaining({ chainId: 43113, address: "0x262b774cf9a1949170b58e2d57f6189980fe757b" }));
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ tokenId: expect.any(BigInt), metadataUri: null }));

    const unauthorized = service({ rows: [] });
    await expect(unauthorized.instance.createEdition({ request, releaseId: "release-1", input: { name: "Denied", chainId: 43113, contractAddress: contract, tokenId: "1", quantity: "1", priceWei: "1" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
  });

  it("rejects protected media with empty requirements, a foreign token, or a foreign storage key", async () => {
    const ownedToken = [{ token_id: "7", contract_address: contract, chain_id: 43113 }];
    const ownedAsset = [{ id: "asset-1", artist_id: "artist-1", storage_key: "records/full-record.mp3", media_type: "AUDIO" }];
    const edition = { id: "edition-1", release_id: "release-1", artist_id: "artist-1" };
    function experienceService({ tokens = ownedToken, assets = ownedAsset } = {}) {
      const harness = service({ rows: [edition] });
      harness.db.query.mockImplementation(async (sql) => {
        const text = String(sql);
        if (text.includes("media_assets")) return { rows: assets };
        if (text.includes("FROM tokens")) return { rows: tokens };
        return { rows: [edition] };
      });
      return harness;
    }
    const mediaConfig = { protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey: "records/full-record.mp3" }] };
    const requirement = { type: "erc1155-balance", contract, tokenIds: ["7"] };
    await expect(experienceService().instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [], mediaConfig } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_REQUIREMENTS_REQUIRED" });
    await expect(experienceService().instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [{ type: "erc1155-balance", contract, tokenIds: ["9"] }], mediaConfig } })).rejects.toMatchObject({ code: "REQUIREMENT_TOKEN_NOT_OWNED" });
    await expect(experienceService().instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [{ type: "erc1155-balance", contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tokenIds: ["7"] }], mediaConfig } })).rejects.toMatchObject({ code: "REQUIREMENT_TOKEN_NOT_OWNED" });
    await expect(experienceService({ assets: [] }).instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [requirement], mediaConfig: { protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey: "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234" }] } } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_OWNED" });
    await expect(experienceService().instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [requirement], mediaConfig: { protected: true, protectedMedia: [{ mediaType: "AUDIO", assetId: "asset-foreign", storageKey: "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234" }] } } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_NOT_OWNED" });

    const stored = { id: "experience-1", artist_id: "artist-1", release_id: "release-1", edition_id: "edition-1", title: "Full Record", description: null, experience_type: "AUDIO", requirements: [requirement], media_config: { protected: true, protectedMedia: [{ assetId: "asset-1", mediaType: "AUDIO" }] }, version: 1, status: "DRAFT" };
    const updating = service();
    updating.db.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM experiences")) return { rows: [stored] };
      if (text.includes("media_assets")) return { rows: ownedAsset };
      if (text.includes("FROM tokens")) return { rows: ownedToken };
      return { rows: [] };
    });
    await expect(updating.instance.updateExperience({ request, experienceId: "experience-1", input: { requirements: [] } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_REQUIREMENTS_REQUIRED" });
    await expect(updating.instance.updateExperience({ request, experienceId: "experience-1", input: { status: "PUBLISHED" } })).rejects.toMatchObject({ code: "PUBLICATION_REQUIRES_CONFIRMATION" });
    expect(updating.repo.saveExperience).not.toHaveBeenCalled();
  });

  it("blocks PATCH publication on releases and editions", async () => {
    const release = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "DRAFT", release_metadata: {}, published_at: null }] });
    await expect(release.instance.updateRelease({ request, releaseId: "release-1", input: { status: "published" } })).rejects.toMatchObject({ code: "PUBLICATION_REQUIRES_CONFIRMATION" });
    const edition = service({ rows: [{ id: "edition-1", release_id: "release-1", contract_id: "contract-1", title: "Chapter I", description: null, tier: null, supply: "1", status: "REVIEW", application_metadata: {} }] });
    await expect(edition.instance.updateEdition({ request, editionId: "edition-1", input: { status: "PUBLISHED" } })).rejects.toMatchObject({ code: "PUBLICATION_REQUIRES_CONFIRMATION" });
    expect(edition.repo.saveEdition).not.toHaveBeenCalled();
  });

  it("writes media assets only from the upload path and does not echo the storage key", async () => {
    const { instance, repo } = service({ rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] });
    const storageKey = "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234";
    repo.saveMediaAsset = vi.fn(async (input) => ({ id: input.id, media_type: input.mediaType, created_at: "2026-09-24T00:00:00.000Z" }));
    instance.mediaUploader = vi.fn(async () => ({ storageKey }));
    const result = await instance.uploadProtectedMedia({ request, artistId: "artist-1", input: { mediaType: "AUDIO", filename: "track.mp3", data: "YQ==" } });
    expect(result).toMatchObject({ mediaType: "AUDIO" });
    expect(result.id).toMatch(/^asset-/);
    expect(JSON.stringify(result)).not.toContain(storageKey);
    expect(repo.saveMediaAsset).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", storageKey, mediaType: "AUDIO", contentSha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb", byteSize: 1 }));
    expect(JSON.stringify(result)).not.toContain(storageKey);
    expect(JSON.stringify(result)).not.toContain("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(repo.saveExperience).not.toHaveBeenCalled();
  });
});
