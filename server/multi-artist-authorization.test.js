import { randomBytes } from "node:crypto";
import process from "node:process";
import { ethers } from "ethers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiErrorFrom } from "./api-errors.js";
import { ApiService } from "./api-service.js";
import { artistKeyFor, assertArtistMayPublish, onChainEditionIdentity, releaseAuthorizationFor } from "./artist-authorization.js";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { tokenIdFor as anchorTokenIdFor } from "./provenance-anchor.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { FUJI_RELEASE_CONFIG, fujiTokenId } from "../src/lib/fuji-release.js";

// THE VOID → VERIFIED ARTIST → RELEASE → EDITION → ERC-1155 TOKEN.
// VOIDCALLER is one artist; TEST ARTIST and ARTIST B coexist beside it.

const VOIDCALLER_CERTIFIED_TOKEN_ID = 33778802922810732976408591241428358474475553907731009337085064305512658576739n;
const CONTRACT = FUJI_RELEASE_CONFIG.contractAddress.toLowerCase();
const CHAIN_ID = FUJI_RELEASE_CONFIG.chainId;
const VOIDCALLER_WALLET = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const TEST_WALLET = "0x7e57000000000000000000000000000000007e57";
const B_WALLET = "0xb0b000000000000000000000000000000000b0b0";
const STRANGER = "0x5757000000000000000000000000000000005757";
const HOLDER = "0xfa11000000000000000000000000000000000fa1";
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };

describe("artist identity derivation", () => {
  it("derives the on-chain artist key exactly as VoidRelease1155V3 tests do", () => {
    const key = artistKeyFor("artist-test-artist");
    expect(key).toBe(ethers.solidityPackedKeccak256(["string", "string"], ["the-void:artist:v1:", "artist-test-artist"]));
    expect(artistKeyFor("voidcaller")).not.toBe(key);
    expect(artistKeyFor("artist-b")).not.toBe(key);
  });

  it("keeps the certified VOIDCALLER token identity across every derivation path", () => {
    expect(onChainEditionIdentity("voidcaller", "voidcaller").tokenId).toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    expect(fujiTokenId("voidcaller", "voidcaller")).toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    expect(anchorTokenIdFor("voidcaller", "voidcaller").tokenId).toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
  });

  it("keeps database UUIDs separate from on-chain identifiers", () => {
    const identity = onChainEditionIdentity("test-release", "test-edition");
    expect(identity.releaseId).toBe(ethers.encodeBytes32String("test-release"));
    expect(identity.editionId).toBe(ethers.encodeBytes32String("test-edition"));
    expect(identity.tokenId).not.toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
  });
});

describe.skipIf(!testDatabaseUrl)("multi-artist authorization (database)", () => {
  let adminPool;
  let pool;
  let dbName;
  let studio;
  let repository;
  const asWallet = (wallet) => ({ requestId: `req-${wallet.slice(2, 8)}`, headers: { "x-test-wallet": wallet } });
  const metadataStorage = { write: vi.fn(async ({ name }) => ({ uri: `ipfs://${name}` })) };

  async function verify(artistId, wallet, status = "VERIFIED") {
    const id = `app-${randomBytes(6).toString("hex")}`;
    await pool.query(
      `INSERT INTO artist_verification_applications (id, public_id, wallet_address, artist_id, slug, artist_name, legal_name, email, location, artist_type, artist_bio, work_description, years_active, verification_evidence, status, submitted_at, reviewed_at)
       VALUES ($1,$1,$2,$3,$3,'n','n','e@x.test','l','solo','b','w','1','evidence',$4,now(),now())`,
      [id, wallet, artistId, status],
    );
    return id;
  }

  async function onboard({ name, wallet, releaseTitle, editionTitle, verified = true }) {
    const artist = await studio.createArtist({ request: asWallet(wallet), input: { name } });
    if (verified) await verify(artist.id, wallet);
    const release = await studio.createRelease({ request: asWallet(wallet), artistId: artist.id, input: { title: releaseTitle } });
    const edition = await studio.createEdition({ request: asWallet(wallet), releaseId: release.id, input: { trackTitle: editionTitle, quantity: "10" } });
    return { artist, release, edition };
  }

  async function tokenRow(editionId) {
    const { rows } = await pool.query("SELECT t.token_id::text AS token_id, t.edition_id, r.artist_id FROM tokens t JOIN editions e ON e.id=t.edition_id JOIN releases r ON r.id=e.release_id WHERE t.edition_id=$1", [editionId]);
    return rows[0];
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_multi_artist_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    repository = createPersistenceRepository(pool);
    studio = new ArtistStudioService({
      db: pool,
      repository,
      metadataStorage,
      authenticator: async (request) => ({ wallet: request.headers["x-test-wallet"] }),
      logger: quiet,
    });
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    if (dbName) await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await adminPool?.end();
  });

  it("runs the complete TEST ARTIST lifecycle on the shared canonical contract", async () => {
    // 1-3: create, verify, and authorize TEST ARTIST's wallet.
    const { artist, release, edition } = await onboard({ name: "TEST ARTIST", wallet: TEST_WALLET, releaseTitle: "TEST RELEASE", editionTitle: "TEST EDITION" });
    expect(artist.slug).toBe("test-artist");
    expect(artist.id).toMatch(/^artist-[0-9a-f-]{36}$/);
    await expect(assertArtistMayPublish(pool, { artistId: artist.id, wallet: TEST_WALLET })).resolves.toMatchObject({ artistId: artist.id });
    // 4-5: release and edition are this artist's records, with database UUIDs.
    expect(release.id).toMatch(/^release-/);
    expect(release.slug).toBe("test-release");
    expect(edition.id).toMatch(/^edition-/);
    // 6: deterministic token identity from the on-chain release/edition ids.
    const expected = onChainEditionIdentity("test-release", "test-edition");
    const token = await tokenRow(edition.id);
    expect(token).toMatchObject({ token_id: expected.tokenId.toString(), artist_id: artist.id });
    expect(BigInt(token.token_id)).not.toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    // 7: publish authorization: metadata publication and the registrar payload.
    const published = await studio.publishMetadata({ request: asWallet(TEST_WALLET), releaseId: release.id, input: { releaseType: "EP" } });
    expect(published).toMatchObject({ releaseSlug: "test-release", editionSlug: "test-edition", tokenId: expected.tokenId.toString() });
    const authorization = await releaseAuthorizationFor(pool, { artistId: artist.id, wallet: TEST_WALLET, releaseSlug: release.slug, editionSlug: published.editionSlug });
    expect(authorization).toMatchObject({ artistKey: artistKeyFor(artist.id), wallet: ethers.getAddress(TEST_WALLET), releaseId: expected.releaseId, editionId: expected.editionId, tokenId: expected.tokenId });
    // 8-9: a mint indexed into ownership snapshots verifies ownership for the holder only.
    await pool.query(
      "INSERT INTO indexer_checkpoints (chain_id, contract_address, contract_type, next_block, last_processed_block, latest_known_block, status, last_successful_run_at) VALUES ($1,$2,'ERC1155',101,100,100,'IDLE',now()) ON CONFLICT (chain_id, contract_address) DO UPDATE SET last_processed_block=100, latest_known_block=100, status='IDLE', last_successful_run_at=now()",
      [CHAIN_ID, CONTRACT],
    );
    await pool.query("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,1,100,'0xabc','FINALIZED')", [CHAIN_ID, CONTRACT, expected.tokenId.toString(), HOLDER]);
    const verifier = new IndexedOwnershipVerifier({ db: pool, config: { authAllowedChainIds: [CHAIN_ID], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 }, denyUnauthorizedWith401: false });
    const requirement = [{ type: "erc1155-balance", chainId: CHAIN_ID, contract: CONTRACT, tokenIds: [expected.tokenId.toString()], minAmount: 1 }];
    await expect(verifier.verify({ wallet: HOLDER, requirements: requirement })).resolves.toMatchObject({ owns: true });
    await expect(verifier.verify({ wallet: STRANGER, requirements: requirement })).resolves.toMatchObject({ owns: false });
    // 10: marketplace/catalog compatibility: the edition is addressed by contract + token, attributed to TEST ARTIST.
    const api = new ApiService({ db: pool, repository, logger: quiet });
    await repository.saveRelease({ id: release.id, artistId: artist.id, slug: release.slug, title: release.title, description: null, status: "PUBLISHED", metadata: {}, publishedAt: new Date() });
    await repository.saveEdition({ id: edition.id, releaseId: release.id, contractId: edition.contract_id, title: edition.title, tier: null, description: null, supply: "10", status: "PUBLISHED", metadata: {} });
    await expect(api.getEdition({ id: edition.id })).resolves.toMatchObject({ artist_id: artist.id, contract_address: CONTRACT, chain_id: String(CHAIN_ID), token_id: expected.tokenId.toString() });
    // 11: gating: TEST ARTIST may gate on its own token.
    await expect(studio.createExperience({ request: asWallet(TEST_WALLET), editionId: edition.id, input: { title: "Stems", type: "STEMS", requirements: requirement } })).resolves.toMatchObject({ requirements: [expect.objectContaining({ tokenIds: [expected.tokenId.toString()] })] });
  });

  it("keeps VOIDCALLER one artist with its certified token, coexisting with other artists", async () => {
    // Contract-owner verification for VOIDCALLER (migration 018 claim shape).
    await pool.query("INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message) VALUES ('vc-claim','voidcaller',$1,'0xd1b4367dd9f235f9ee61878019d66e31511e98ee',43114,'0xsig','claim')", [VOIDCALLER_WALLET]);
    const release = await studio.createRelease({ request: asWallet(VOIDCALLER_WALLET), artistId: "voidcaller", input: { title: "VOIDCALLER" } });
    expect(release.slug).toBe("voidcaller");
    const edition = await studio.createEdition({ request: asWallet(VOIDCALLER_WALLET), releaseId: release.id, input: { trackTitle: "VOIDCALLER", quantity: "25" } });
    const token = await tokenRow(edition.id);
    expect(BigInt(token.token_id)).toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    expect(token.artist_id).toBe("voidcaller");
    await expect(studio.publishMetadata({ request: asWallet(VOIDCALLER_WALLET), releaseId: release.id, input: {} })).resolves.toMatchObject({ tokenId: VOIDCALLER_CERTIFIED_TOKEN_ID.toString() });

    // VOIDCALLER is not a platform identity: it cannot manage or publish for another artist.
    const b = await onboard({ name: "Artist B", wallet: B_WALLET, releaseTitle: "B Debut", editionTitle: "B Edition" });
    await expect(studio.createEdition({ request: asWallet(VOIDCALLER_WALLET), releaseId: b.release.id, input: { trackTitle: "Hijack" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(assertArtistMayPublish(pool, { artistId: b.artist.id, wallet: VOIDCALLER_WALLET })).rejects.toMatchObject({ code: "ARTIST_WALLET_NOT_AUTHORIZED" });
    // Independent identities and token IDs.
    const bToken = await tokenRow(b.edition.id);
    expect(bToken.artist_id).toBe(b.artist.id);
    expect(new Set([token.token_id, bToken.token_id]).size).toBe(2);
    expect(artistKeyFor("voidcaller")).not.toBe(artistKeyFor(b.artist.id));
  });

  it("rejects cross-artist release, edition, token, and gating references", async () => {
    const a = await onboard({ name: "Cross A", wallet: "0xaaaa00000000000000000000000000000000aaaa", releaseTitle: "Cross A Release", editionTitle: "Cross A Edition" });
    const b = await onboard({ name: "Cross B", wallet: "0xbbbb00000000000000000000000000000000bbbb", releaseTitle: "Cross B Release", editionTitle: "Cross B Edition" });
    const aWallet = "0xaaaa00000000000000000000000000000000aaaa";
    // Artist A cannot create, edit, or publish Artist B's edition.
    await expect(studio.createEdition({ request: asWallet(aWallet), releaseId: b.release.id, input: { trackTitle: "x" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(studio.updateEdition({ request: asWallet(aWallet), editionId: b.edition.id, input: { quantity: "1" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(studio.publishMetadata({ request: asWallet(aWallet), releaseId: b.release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    // Artist A cannot gate its experience on Artist B's token.
    const bToken = await tokenRow(b.edition.id);
    await expect(studio.createExperience({ request: asWallet(aWallet), editionId: a.edition.id, input: { title: "x", type: "AUDIO", requirements: [{ type: "erc1155-balance", chainId: CHAIN_ID, contract: CONTRACT, tokenIds: [bToken.token_id] }] } })).rejects.toMatchObject({ code: "REQUIREMENT_TOKEN_NOT_OWNED" });
    // The same release title under two artists gets distinct platform-wide slugs, so distinct token IDs.
    const sameA = await studio.createRelease({ request: asWallet(aWallet), artistId: a.artist.id, input: { title: "Shared Title" } });
    const sameB = await studio.createRelease({ request: asWallet("0xbbbb00000000000000000000000000000000bbbb"), artistId: b.artist.id, input: { title: "Shared Title" } });
    expect(sameA.slug).toBe("shared-title");
    expect(sameB.slug).toBe("shared-title-2");
    const vcTitle = await studio.createRelease({ request: asWallet(aWallet), artistId: a.artist.id, input: { title: "VOIDCALLER" } });
    expect(vcTitle.slug).not.toBe("voidcaller");
  });

  it("refuses to re-point an existing token to another artist when slugs collide", async () => {
    // Legacy rows can still share a release slug across artists (old per-artist uniqueness).
    const intruder = await studio.createArtist({ request: asWallet(STRANGER), input: { name: "Intruder" } });
    await verify(intruder.id, STRANGER);
    await repository.saveRelease({ id: "release-collision", artistId: intruder.id, slug: "voidcaller", title: "VOIDCALLER", description: null, status: "DRAFT", metadata: {} });
    await expect(studio.createEdition({ request: asWallet(STRANGER), releaseId: "release-collision", input: { trackTitle: "VOIDCALLER" } })).rejects.toMatchObject({ code: "TOKEN_OWNED_BY_ANOTHER_ARTIST" });
    const { rows } = await pool.query("SELECT r.artist_id FROM tokens t JOIN editions e ON e.id=t.edition_id JOIN releases r ON r.id=e.release_id WHERE t.token_id=$1", [VOIDCALLER_CERTIFIED_TOKEN_ID.toString()]);
    expect(rows).toEqual([{ artist_id: "voidcaller" }]);
  });

  it("enforces canonical token identity in the repository itself, below the Studio guard", async () => {
    const owner = await onboard({ name: "Token Owner", wallet: "0x1010000000000000000000000000000000001010", releaseTitle: "Owner Release", editionTitle: "Owner Edition" });
    const other = await onboard({ name: "Token Thief", wallet: "0x2020000000000000000000000000000000002020", releaseTitle: "Thief Release", editionTitle: "Thief Edition" });
    const current = await tokenRow(owner.edition.id);
    const contractId = owner.edition.contract_id;
    // Legitimate: re-saving the same identity refreshes metadata, keeps the edition.
    await expect(repository.saveToken({ editionId: owner.edition.id, contractId, tokenId: current.token_id, metadataUri: "ipfs://refreshed", metadata: { v: 2 } })).resolves.toMatchObject({ edition_id: owner.edition.id, metadata_uri: "ipfs://refreshed" });
    // Malicious: another artist's edition (another release) cannot take the token.
    await expect(repository.saveToken({ editionId: other.edition.id, contractId, tokenId: current.token_id, metadataUri: "ipfs://hijack" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Retry flow: an unpublished draft hands its token to another draft of the same release.
    const retry = await repository.saveEdition({ id: "edition-retry", releaseId: owner.release.id, contractId, title: "Owner Edition", tier: null, description: null, supply: "10", status: "DRAFT", metadata: {} });
    await expect(repository.saveToken({ editionId: retry.id, contractId, tokenId: current.token_id })).resolves.toMatchObject({ edition_id: retry.id });
    // Once published, even a same-release edition cannot take it.
    await pool.query("UPDATE editions SET status='PUBLISHED' WHERE id=$1", [retry.id]);
    await expect(repository.saveToken({ editionId: owner.edition.id, contractId, tokenId: current.token_id })).rejects.toMatchObject({ code: "CONFLICT" });
    const after = (await pool.query("SELECT t.edition_id, t.metadata_uri, r.artist_id FROM tokens t JOIN editions e ON e.id=t.edition_id JOIN releases r ON r.id=e.release_id WHERE t.contract_id=$1 AND t.token_id=$2", [contractId, current.token_id])).rows;
    expect(after).toEqual([{ edition_id: retry.id, metadata_uri: null, artist_id: owner.artist.id }]);
    // Through the API layer the conflict is a 409, never a silent success.
    const conflict = await repository.saveToken({ editionId: other.edition.id, contractId, tokenId: current.token_id }).catch((error) => error);
    expect(apiErrorFrom(conflict)).toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("drops authority from a wallet removed from the artist, and verification does not transfer to a new wallet", async () => {
    const ownerWallet = "0x3030000000000000000000000000000000003030";
    const managerWallet = "0x4040000000000000000000000000000000004040";
    const rotated = await onboard({ name: "Rotating Artist", wallet: ownerWallet, releaseTitle: "Rotating Release", editionTitle: "Rotating Edition" });
    await repository.assignArtistOwner({ artistId: rotated.artist.id, wallet: managerWallet, role: "MANAGER" });
    // Both current wallets act while the verified owner remains an owner.
    await expect(assertArtistMayPublish(pool, { artistId: rotated.artist.id, wallet: ownerWallet })).resolves.toBeTruthy();
    await expect(assertArtistMayPublish(pool, { artistId: rotated.artist.id, wallet: managerWallet })).resolves.toBeTruthy();
    // The old wallet is removed: it loses every Studio and publication path at once.
    await pool.query("DELETE FROM artist_owners WHERE artist_id=$1 AND owner_wallet=$2", [rotated.artist.id, ownerWallet]);
    await expect(studio.publishMetadata({ request: asWallet(ownerWallet), releaseId: rotated.release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(studio.createEdition({ request: asWallet(ownerWallet), releaseId: rotated.release.id, input: { trackTitle: "x" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(assertArtistMayPublish(pool, { artistId: rotated.artist.id, wallet: ownerWallet })).rejects.toMatchObject({ code: "ARTIST_WALLET_NOT_AUTHORIZED" });
    // The verification was granted to the removed wallet, so the remaining wallet must be re-verified.
    await expect(assertArtistMayPublish(pool, { artistId: rotated.artist.id, wallet: managerWallet })).rejects.toMatchObject({ code: "ARTIST_NOT_VERIFIED" });
    await verify(rotated.artist.id, managerWallet);
    await expect(studio.publishMetadata({ request: asWallet(managerWallet), releaseId: rotated.release.id, input: {} })).resolves.toMatchObject({ releaseSlug: rotated.release.slug });
  });

  it("lets a verified, authorized artist publish, and only that artist", async () => {
    const wallet = "0x5050000000000000000000000000000000005050";
    const ok = await onboard({ name: "Publishing Artist", wallet, releaseTitle: "Publishing Release", editionTitle: "Publishing Edition" });
    await expect(studio.publishMetadata({ request: asWallet(wallet), releaseId: ok.release.id, input: {} })).resolves.toMatchObject({ releaseSlug: "publishing-release", editionSlug: "publishing-edition" });
  });

  it("blocks unverified, revoked, inactive, and unauthorized publication", async () => {
    // Unverified: may draft, may not publish.
    const unverified = await onboard({ name: "Unverified Artist", wallet: "0xc0c000000000000000000000000000000000c0c0", releaseTitle: "Unverified Release", editionTitle: "Unverified Edition", verified: false });
    await expect(studio.publishMetadata({ request: asWallet("0xc0c000000000000000000000000000000000c0c0"), releaseId: unverified.release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_NOT_VERIFIED" });
    // A verified application owned by a wallet that is not this artist's owner does not count.
    await verify(unverified.artist.id, "0x0dd000000000000000000000000000000000dd00");
    await expect(assertArtistMayPublish(pool, { artistId: unverified.artist.id, wallet: "0xc0c000000000000000000000000000000000c0c0" })).rejects.toMatchObject({ code: "ARTIST_NOT_VERIFIED" });

    // Revoked: verification later revoked blocks publication.
    const revoked = await onboard({ name: "Revoked Artist", wallet: "0xd0d000000000000000000000000000000000d0d0", releaseTitle: "Revoked Release", editionTitle: "Revoked Edition" });
    await expect(assertArtistMayPublish(pool, { artistId: revoked.artist.id, wallet: "0xd0d000000000000000000000000000000000d0d0" })).resolves.toBeTruthy();
    await pool.query("UPDATE artist_verification_applications SET status='REVOKED', reviewed_at=now() + interval '1 second' WHERE artist_id=$1", [revoked.artist.id]);
    await expect(studio.publishMetadata({ request: asWallet("0xd0d000000000000000000000000000000000d0d0"), releaseId: revoked.release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_VERIFICATION_REVOKED" });

    // Inactive artist.
    const inactive = await onboard({ name: "Inactive Artist", wallet: "0xe0e000000000000000000000000000000000e0e0", releaseTitle: "Inactive Release", editionTitle: "Inactive Edition" });
    await pool.query("UPDATE artists SET status='ARCHIVED' WHERE id=$1", [inactive.artist.id]);
    await expect(assertArtistMayPublish(pool, { artistId: inactive.artist.id, wallet: "0xe0e000000000000000000000000000000000e0e0" })).rejects.toMatchObject({ code: "ARTIST_INACTIVE" });

    // Unauthorized wallet for a verified artist.
    const verified = await onboard({ name: "Guarded Artist", wallet: "0xf0f000000000000000000000000000000000f0f0", releaseTitle: "Guarded Release", editionTitle: "Guarded Edition" });
    await expect(studio.publishMetadata({ request: asWallet(STRANGER), releaseId: verified.release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(assertArtistMayPublish(pool, { artistId: verified.artist.id, wallet: STRANGER })).rejects.toMatchObject({ code: "ARTIST_WALLET_NOT_AUTHORIZED" });
    await expect(releaseAuthorizationFor(pool, { artistId: verified.artist.id, wallet: STRANGER, releaseSlug: verified.release.slug, editionSlug: "guarded-edition" })).rejects.toMatchObject({ code: "ARTIST_WALLET_NOT_AUTHORIZED" });
  });
});
