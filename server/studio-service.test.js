import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService } from "./studio-service.js";

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
function service({ rows = [], authenticated = true } = {}) {
  const repo = repository();
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  return { instance: new ArtistStudioService({ db, repository: repo, authenticator: authenticated ? vi.fn().mockResolvedValue({ wallet: owner }) : vi.fn().mockResolvedValue(null), logger: { info: vi.fn() } }), repo, db };
}
const request = { requestId: "request-1", headers: {} };

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

  it("creates a release, validates lifecycle publishing, and prevents regression", async () => {
    const { instance, repo } = service({ rows: [{ id: "artist-1", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }] });
    await expect(instance.createRelease({ request, artistId: "artist-1", input: { id: "release-1", title: "The Record", slug: "the-record" } })).resolves.toMatchObject({ id: "release-1", status: "DRAFT" });
    expect(repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-1", status: "DRAFT" }));

    const published = service({ rows: [{ id: "release-1", artist_id: "artist-1", slug: "the-record", title: "The Record", description: null, status: "REVIEW", release_metadata: {}, published_at: null }] });
    await expect(published.instance.updateRelease({ request, releaseId: "release-1", input: { status: "PUBLISHED" } })).resolves.toMatchObject({ status: "PUBLISHED" });
    expect(published.repo.saveRelease).toHaveBeenCalledWith(expect.objectContaining({ status: "PUBLISHED", publishedAt: expect.any(Date) }));

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
    const experience = await experienceService.instance.createExperience({ request, editionId: "edition-1", input: { id: "experience-1", title: "Full Record", type: "AUDIO", requirements: [{ type: "erc1155-balance", contract, tokenIds: ["7"] }], mediaConfig: { protected: true, protectedMedia: [{ mediaType: "AUDIO", storageKey: "records/full-record.mp3" }] } } });
    expect(experience).toMatchObject({ id: "experience-1", edition_id: "edition-1", status: "DRAFT" });
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
});
