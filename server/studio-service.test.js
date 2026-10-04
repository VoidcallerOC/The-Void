import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG } from "../src/lib/fuji-release.js";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService, EDITION_ABI } from "./studio-service.js";

const certifiedFujiRelease = FUJI_RELEASE_CONFIG.contractAddress.toLowerCase();

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
function service({ rows = [], authenticated = true, authenticatedWallet = owner, metadataStorage = null, authorization = {} } = {}) {
  const repo = repository();
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  return { instance: new ArtistStudioService({ db: verifiedArtistDb(db, authorization), repository: repo, metadataStorage, authenticator: authenticated ? vi.fn().mockResolvedValue({ wallet: authenticatedWallet }) : vi.fn().mockResolvedValue(null), logger: { info: vi.fn() } }), repo, db };
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
    await expect(regression.instance.updateRelease({ request, releaseId: "release-1", input: { status: "DRAFT" } })).rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_INVALID" });
    expect(regression.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("archives a published release and its editions and experiences without touching the token", async () => {
    const publishedAt = new Date("2026-09-01T00:00:00.000Z");
    const harness = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] });
    await expect(harness.instance.updateRelease({ request, releaseId: "release-1", input: { status: "archived" } })).resolves.toMatchObject({ status: "ARCHIVED" });
    expect(harness.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ id: "release-1", status: "ARCHIVED", publishedAt }));
    const updates = harness.db.query.mock.calls.map(([sql]) => String(sql));
    expect(updates.some((sql) => /UPDATE editions SET status = 'ARCHIVED'/i.test(sql))).toBe(true);
    expect(updates.some((sql) => /UPDATE experiences SET status = 'ARCHIVED'/i.test(sql))).toBe(true);
    expect(updates.join("\n")).not.toMatch(/UPDATE tokens|DELETE FROM tokens|UPDATE listings|UPDATE purchases/i);

    const draft = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "DRAFT", release_metadata: {}, published_at: null }] });
    await expect(draft.instance.updateRelease({ request, releaseId: "release-1", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_INVALID" });
    expect(draft.repo.saveRelease).not.toHaveBeenCalled();
  });

  it("refuses to archive a published mintable release and still archives one that is not mintable yet", async () => {
    const publishedAt = new Date("2026-10-01T00:00:00.000Z");
    const legacy = { id: "voidcaller-legacy-genesis", artist_id: "artist-1", slug: "voidcaller-legacy-genesis", title: "VOIDCALLER", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt };
    const bySlug = service({ rows: [legacy] });
    await expect(bySlug.instance.updateRelease({ request, releaseId: legacy.id, input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "LEGACY_CATALOG_LOCKED" });
    expect(bySlug.repo.saveRelease).not.toHaveBeenCalled();
    expect(bySlug.db.query.mock.calls.map(([sql]) => String(sql)).some((sql) => /UPDATE editions SET status = 'ARCHIVED'/i.test(sql))).toBe(false);

    const byContract = service({ rows: [{ ...legacy, id: "release-copy", slug: "not-the-legacy-slug", title: "VOIDCALLER" }] });
    byContract.db.query.mockImplementation(async (sql) => {
      if (/FROM editions/i.test(sql)) return { rows: [{ release_id: "release-copy", status: "PUBLISHED", chain_id: 43114, contract_address: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", token_id: "1" }] };
      return { rows: [{ ...legacy, id: "release-copy", slug: "not-the-legacy-slug", title: "VOIDCALLER" }] };
    });
    await expect(byContract.instance.updateRelease({ request, releaseId: "release-copy", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "LEGACY_CATALOG_LOCKED" });
    expect(byContract.repo.saveRelease).not.toHaveBeenCalled();

    const fuji = service({ rows: [{ id: "fuji-voidcaller", artist_id: "artist-1", slug: "voidcaller", title: "VOIDCALLER", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] });
    fuji.db.query.mockImplementation(async (sql) => {
      if (/FROM editions/i.test(sql)) return { rows: [{ release_id: "fuji-voidcaller", status: "PUBLISHED", chain_id: 43113, contract_address: certifiedFujiRelease, token_id: "9", buyable_sale: false }] };
      return { rows: [{ id: "fuji-voidcaller", artist_id: "artist-1", slug: "voidcaller", title: "VOIDCALLER", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] };
    });
    await expect(fuji.instance.updateRelease({ request, releaseId: "fuji-voidcaller", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "MINTABLE_RELEASE_LOCKED" });
    expect(fuji.repo.saveRelease).not.toHaveBeenCalled();

    const saleOnly = service({ rows: [{ id: "fuji-sale", artist_id: "artist-1", slug: "open-sale", title: "Open sale", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] });
    saleOnly.db.query.mockImplementation(async (sql) => {
      if (/FROM editions/i.test(sql)) return { rows: [{ release_id: "fuji-sale", status: "DRAFT", chain_id: 43113, contract_address: certifiedFujiRelease, token_id: null, buyable_sale: true }] };
      return { rows: [{ id: "fuji-sale", artist_id: "artist-1", slug: "open-sale", title: "Open sale", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] };
    });
    await expect(saleOnly.instance.updateRelease({ request, releaseId: "fuji-sale", input: { status: "ARCHIVED" } })).rejects.toMatchObject({ code: "MINTABLE_RELEASE_LOCKED" });

    const pending = service({ rows: [{ id: "fuji-pending", artist_id: "artist-1", slug: "not-out-yet", title: "Not out yet", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] });
    pending.db.query.mockImplementation(async (sql) => {
      if (/FROM editions/i.test(sql)) return { rows: [{ release_id: "fuji-pending", status: "DRAFT", chain_id: 43113, contract_address: certifiedFujiRelease, token_id: "9", buyable_sale: false }] };
      return { rows: [{ id: "fuji-pending", artist_id: "artist-1", slug: "not-out-yet", title: "Not out yet", description: null, status: "PUBLISHED", release_metadata: {}, published_at: publishedAt }] };
    });
    await expect(pending.instance.updateRelease({ request, releaseId: "fuji-pending", input: { status: "ARCHIVED" } })).resolves.toMatchObject({ status: "ARCHIVED" });
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
    expect(repo.saveContract).toHaveBeenCalledWith(expect.objectContaining({ address: certifiedFujiRelease, contractType: "ERC1155", chainId: 43113 }));
    expect(certifiedFujiRelease).toBe("0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6");
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
    expect(repo.saveContract).toHaveBeenCalledWith(expect.objectContaining({ chainId: 43113, address: certifiedFujiRelease }));
    expect(repo.saveToken).toHaveBeenCalledWith(expect.objectContaining({ tokenId: expect.any(BigInt), metadataUri: null }));

    const unauthorized = service({ rows: [] });
    await expect(unauthorized.instance.createEdition({ request, releaseId: "release-1", input: { name: "Denied", chainId: 43113, contractAddress: contract, tokenId: "1", quantity: "1", priceWei: "1" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
  });

  it("gates a private full track sent without requirements to holders of the edition's own token", async () => {
    const edition = { id: "edition-1", release_id: "release-1", artist_id: "artist-1" };
    const harness = service({ rows: [edition] });
    harness.db.query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes("media_assets")) return { rows: [{ id: "asset-1", artist_id: "artist-1", storage_key: "bafyprivatefulltrack", media_type: "AUDIO" }] };
      if (text.includes("FROM tokens")) return { rows: [{ token_id: "7", contract_address: contract, chain_id: 43113 }] };
      return { rows: [edition] };
    });
    await harness.instance.createExperience({ request, editionId: "edition-1", input: { title: "Full track", type: "AUDIO", requirements: [], mediaConfig: { protected: true, protectedMedia: [{ assetId: "asset-1", mediaType: "AUDIO", contentType: "audio/mpeg" }] } } });
    const saved = harness.repo.saveExperience.mock.calls[0][0];
    expect(saved.requirements).toEqual([{ type: "erc1155-balance", contract, chainId: 43113, tokenIds: ["7"], minAmount: "1" }]);
    expect(saved.mediaConfig).toMatchObject({ protected: true, protectedMedia: [{ assetId: "asset-1", mediaType: "AUDIO" }] });
    expect(JSON.stringify(saved.mediaConfig)).not.toContain("bafyprivatefulltrack");
  });

  it("rejects protected media for an edition without tokens, a foreign token, or a foreign storage key", async () => {
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
    await expect(experienceService({ tokens: [] }).instance.createExperience({ request, editionId: "edition-1", input: { title: "Full Record", type: "AUDIO", requirements: [], mediaConfig } })).rejects.toMatchObject({ code: "PROTECTED_MEDIA_REQUIREMENTS_REQUIRED" });
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
    const { instance, repo, db } = service({ rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] });
    db.query.mockImplementation(async (sql) => (String(sql).includes("FROM audit_events") ? { rows: [] } : { rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] }));
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

  describe("artwork upload", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const artistRow = { id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" };

    it("pins a sniffed image for the owning artist and returns only the public URI", async () => {
      const { instance } = service({ rows: [artistRow] });
      instance.artworkUploader = vi.fn(async () => ({ uri: "ipfs://bafyartwork" }));
      const result = await instance.uploadArtwork({ request, artistId: "artist-1", input: { data: png.toString("base64"), filename: "cover.png" } });
      expect(result).toEqual({ uri: "ipfs://bafyartwork", contentType: "image/png", byteSize: png.length });
      expect(instance.artworkUploader).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", contentType: "image/png", filename: expect.stringMatching(/^artwork-[0-9a-f]{16}\.png$/) }));
    });

    it("rejects files that are not PNG, JPEG, GIF or WebP, whatever they claim to be", async () => {
      const { instance } = service({ rows: [artistRow] });
      instance.artworkUploader = vi.fn();
      const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
      await expect(instance.uploadArtwork({ request, artistId: "artist-1", input: { data: svg.toString("base64"), filename: "cover.png", contentType: "image/png" } })).rejects.toMatchObject({ code: "ARTWORK_TYPE_UNSUPPORTED" });
      expect(instance.artworkUploader).not.toHaveBeenCalled();
    });

    it("rejects artwork over 3 MB before uploading", async () => {
      const { instance } = service({ rows: [artistRow] });
      instance.artworkUploader = vi.fn();
      const large = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
      await expect(instance.uploadArtwork({ request, artistId: "artist-1", input: { data: large.toString("base64") } })).rejects.toMatchObject({ status: 413, code: "ARTWORK_TOO_LARGE" });
      expect(instance.artworkUploader).not.toHaveBeenCalled();
    });

    it("reports a clear error when artwork storage is not configured", async () => {
      const { instance } = service({ rows: [artistRow] });
      await expect(instance.uploadArtwork({ request, artistId: "artist-1", input: { data: png.toString("base64") } })).rejects.toMatchObject({ status: 503, code: "ARTWORK_UPLOAD_UNAVAILABLE" });
    });

    it("pins a short public preview, registers it, and returns its ipfs URI", async () => {
      const { instance, repo, db } = service({ rows: [artistRow] });
      db.query.mockImplementation(async (sql) => (String(sql).includes("media_assets WHERE artist_id=$1 AND metadata") ? { rows: [] } : { rows: [artistRow] }));
      instance.artworkUploader = vi.fn(async () => ({ uri: "ipfs://bafypreview" }));
      const mp3 = Buffer.from("ID3\x04\x00\x00", "latin1");
      await expect(instance.uploadTrackPreview({ request, artistId: "artist-1", input: { data: mp3.toString("base64") } })).resolves.toEqual({ uri: "ipfs://bafypreview", contentType: "audio/mpeg", byteSize: mp3.length });
      expect(instance.artworkUploader).toHaveBeenCalledWith(expect.objectContaining({ contentType: "audio/mpeg", filename: expect.stringMatching(/^preview-[0-9a-f]{16}\.mp3$/) }));
      expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_AUDIO_PREVIEW_UPLOADED", subjectType: "artist", subjectId: "artist-1", payload: expect.objectContaining({ uri: "ipfs://bafypreview", contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }) }));
    });

    it("rejects non-audio previews, previews over 5 MB, and previews identical to a private track", async () => {
      const { instance, db } = service({ rows: [artistRow] });
      instance.artworkUploader = vi.fn();
      await expect(instance.uploadTrackPreview({ request, artistId: "artist-1", input: { data: png.toString("base64") } })).rejects.toMatchObject({ code: "AUDIO_TYPE_UNSUPPORTED" });
      const large = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(5 * 1000 * 1000)]);
      await expect(instance.uploadTrackPreview({ request, artistId: "artist-1", input: { data: large.toString("base64") } })).rejects.toMatchObject({ status: 413, code: "PREVIEW_TOO_LARGE" });
      db.query.mockImplementation(async (sql) => (String(sql).includes("media_assets WHERE artist_id=$1 AND metadata") ? { rows: [{ id: "asset-full" }] } : { rows: [artistRow] }));
      await expect(instance.uploadTrackPreview({ request, artistId: "artist-1", input: { data: Buffer.from("ID3\x04", "latin1").toString("base64") } })).rejects.toMatchObject({ status: 409, code: "PREVIEW_MATCHES_PRIVATE_TRACK" });
      expect(instance.artworkUploader).not.toHaveBeenCalled();
    });

    it("refuses to store a private full track that is already public as a preview", async () => {
      const { instance, repo, db } = service({ rows: [artistRow] });
      instance.mediaUploader = vi.fn();
      repo.saveMediaAsset = vi.fn();
      db.query.mockImplementation(async (sql) => (String(sql).includes("FROM audit_events") ? { rows: [{ id: "audit-1" }] } : { rows: [artistRow] }));
      await expect(instance.uploadProtectedMedia({ request, artistId: "artist-1", input: { mediaType: "AUDIO", data: "SUQz" } })).rejects.toMatchObject({ status: 409, code: "PRIVATE_TRACK_MATCHES_PUBLIC_PREVIEW" });
      expect(instance.mediaUploader).not.toHaveBeenCalled();
      expect(repo.saveMediaAsset).not.toHaveBeenCalled();
    });

    it("refuses wallets that do not own the artist", async () => {
      const { instance, db } = service({ rows: [], authenticatedWallet: "0x2222222222222222222222222222222222222222" });
      instance.artworkUploader = vi.fn();
      await expect(instance.uploadArtwork({ request, artistId: "artist-1", input: { data: png.toString("base64") } })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ao.owner_wallet=$2"), ["artist-1", "0x2222222222222222222222222222222222222222"]);
      expect(instance.artworkUploader).not.toHaveBeenCalled();
    });
  });
});
