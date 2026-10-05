import { randomBytes } from "node:crypto";
import process from "node:process";
import { ethers } from "ethers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiService } from "./api-service.js";
import { assertArtistMayPublish } from "./artist-authorization.js";
import { loadServerConfig } from "./config.js";
import { createIndexerStore } from "./indexer-store.js";
import { ProtectedMediaGateway } from "./media-gateway.js";
import { migrate } from "./migrate.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { createPersistenceRepository } from "./repositories.js";
import { ArtistStudioService } from "./studio-service.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };

// Pre-deployment readiness for the publication gate, on the production data shape:
// - canonical artist `voidcaller` (migration 019) owned by 0x284c…, with contract-owner proof;
// - a Studio-created VOIDCALLER alias (like production voidcaller-7) owned by the Fuji
//   E2E/admin wallet 0xabd3…, unverified, holding the PUBLISHED certified Fuji release.

const CANONICAL_OWNER = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const FUJI_E2E_WALLET = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const HOLDER = "0x1111111111111111111111111111111111111111";
const CERTIFIED = fujiRelease.contractAddress.toLowerCase();
const CHAIN_ID = fujiRelease.chainId;
const CERTIFIED_TOKEN_ID = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const ALIAS_ID = "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724";
const ALIAS_RELEASE = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const ALIAS_EDITION = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const MARKETPLACE = "0x982b28352fd612fe934c5e1ad8fea399689190d2";
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };
const editionCreated = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);

describe.skipIf(!testDatabaseUrl)("publication gate readiness on the production data shape", () => {
  let adminPool;
  let pool;
  let dbName;
  let repository;
  let chainEditions;
  const asWallet = (wallet) => ({ requestId: `req-${wallet.slice(2, 8)}`, headers: { "x-test-wallet": wallet } });

  // V2-shaped publication chain: receipts and edition() reads for the certified contract.
  function studio() {
    return new ArtistStudioService({
      db: pool,
      repository,
      metadataStorage: { write: async ({ name }) => ({ uri: `ipfs://readiness-${name}` }) },
      publicationChain: {
        getTransactionReceipt: async (hash) => chainEditions.get(hash)?.receipt || null,
        edition: async (tokenId) => [...chainEditions.values()].find((item) => item.tokenId === tokenId)?.edition,
      },
      authenticator: async (request) => ({ wallet: request.headers["x-test-wallet"] }),
      logger: quiet,
    });
  }

  async function legacyRelease(service, wallet, artistId, title) {
    const release = await service.createRelease({ request: asWallet(wallet), artistId, input: { title } });
    await pool.query("UPDATE releases SET release_metadata='{}'::jsonb WHERE id=$1", [release.id]);
    return { ...release, release_metadata: {} };
  }

  // What the certified contract would hold after `creator` calls createEdition.
  function mineEdition({ creator, releaseSlug, editionSlug, metadataUri }) {
    const releaseId = ethers.encodeBytes32String(releaseSlug);
    const editionId = ethers.encodeBytes32String(editionSlug);
    const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", releaseId, editionId])));
    const log = editionCreated.encodeEventLog("EditionCreated", [tokenId, releaseId, editionId, creator, 25n, metadataUri]);
    const hash = `0x${randomBytes(32).toString("hex")}`;
    chainEditions.set(hash, { tokenId, receipt: { status: 1, blockNumber: 1, logs: [{ address: CERTIFIED, topics: log.topics, data: log.data }] }, edition: [releaseId, editionId, creator, 25n, 0n, metadataUri, true] });
    return hash;
  }

  beforeAll(async () => {
    chainEditions = new Map();
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_gate_readiness_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    repository = createPersistenceRepository(pool);

    // Canonical VOIDCALLER contract-owner proof, as production holds it.
    await pool.query("INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message) VALUES ('vc-claim','voidcaller',$1,'0xd1b4367dd9f235f9ee61878019d66e31511e98ee',43114,'0xsig','claim')", [CANONICAL_OWNER]);

    // The production alias: Studio-created "Voidcaller" owned by the Fuji E2E wallet, unverified,
    // holding the PUBLISHED certified release, edition and token.
    await repository.saveArtist({ id: ALIAS_ID, slug: "voidcaller-7", displayName: "Voidcaller", metadata: {} });
    await repository.assignArtistOwner({ artistId: ALIAS_ID, wallet: FUJI_E2E_WALLET, role: "OWNER" });
    const contract = await repository.saveContract({ chainId: CHAIN_ID, chainKey: "fuji", address: CERTIFIED, contractType: "ERC1155", name: "VoidRelease1155V2", metadata: {} });
    await repository.saveRelease({ id: ALIAS_RELEASE, artistId: ALIAS_ID, slug: "voidcaller", title: "VOIDCALLER", description: "The first call.", status: "PUBLISHED", metadata: {}, publishedAt: new Date() });
    await repository.saveEdition({ id: ALIAS_EDITION, releaseId: ALIAS_RELEASE, contractId: contract.id, title: "VOIDCALLER", tier: null, description: null, supply: "25", status: "PUBLISHED", metadata: {} });
    await repository.saveToken({ editionId: ALIAS_EDITION, contractId: contract.id, tokenId: CERTIFIED_TOKEN_ID, metadataUri: "ipfs://certified" });
    const requirement = [{ type: "erc1155-balance", chainId: CHAIN_ID, contract: CERTIFIED, tokenIds: [CERTIFIED_TOKEN_ID], minAmount: "1" }];
    await repository.saveMediaAsset({ id: "asset-alias-ep", artistId: ALIAS_ID, storageKey: "fuji/voidcaller-ep", mediaType: "AUDIO" });
    await repository.saveExperience({ id: "experience-alias-ep", artistId: ALIAS_ID, releaseId: ALIAS_RELEASE, editionId: ALIAS_EDITION, title: "Full EP", experienceType: "AUDIO", requirements: requirement, mediaConfig: { protected: true, protectedMedia: [{ assetId: "asset-alias-ep", mediaType: "AUDIO" }] }, status: "PUBLISHED" });

    // Indexed holder and an active listing of the certified token sold by the alias wallet.
    await pool.query("INSERT INTO indexer_checkpoints (chain_id, contract_address, contract_type, next_block, last_processed_block, latest_known_block, status, last_successful_run_at) VALUES ($1,$2,'ERC1155',101,100,100,'IDLE',now())", [CHAIN_ID, CERTIFIED]);
    await pool.query("INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,1,100,'0xabc','FINALIZED'), ($1,$2,$3,$5,1,100,'0xabc','FINALIZED')", [CHAIN_ID, CERTIFIED, CERTIFIED_TOKEN_ID, HOLDER, FUJI_E2E_WALLET]);
    await repository.saveContract({ chainId: CHAIN_ID, chainKey: "fuji", address: MARKETPLACE, contractType: "MARKETPLACE", name: "MusicMarketplace", metadata: {} });
    await createIndexerStore(pool).applyMarketplaceEvent({
      chainId: CHAIN_ID, marketplaceAddress: MARKETPLACE, transactionHash: `0x${"1".repeat(64)}`, logIndex: 0, blockNumber: 100, blockHash: `0x${"2".repeat(64)}`, blockTimestamp: new Date(),
      eventType: "ListingCreated", listingId: "1", sellerWallet: FUJI_E2E_WALLET, tokenContractAddress: CERTIFIED, tokenId: CERTIFIED_TOKEN_ID, amount: "1", remainingAmount: "1", priceWei: "10000000000000000", currency: "native", expiresAt: null, status: "ACTIVE",
    });
  });

  afterAll(async () => {
    if (adminPool) await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("lets the canonical owner create, publish and confirm a VOIDCALLER release", async () => {
    const service = studio();
    await expect(assertArtistMayPublish(pool, { artistId: "voidcaller", wallet: CANONICAL_OWNER })).resolves.toMatchObject({ artistId: "voidcaller" });
    const release = await legacyRelease(service, CANONICAL_OWNER, "voidcaller", "Next Record");
    expect(release).toMatchObject({ artist_id: "voidcaller", slug: "next-record", status: "DRAFT" });
    await expect(service.updateRelease({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { description: "Configured." } })).resolves.toMatchObject({ description: "Configured." });
    const edition = await service.createEdition({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { trackTitle: "Next Record", quantity: "25" } });
    expect(edition).toMatchObject({ release_id: release.id, status: "DRAFT" });
    const metadata = await service.publishMetadata({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { releaseType: "EP" } });
    expect(metadata).toMatchObject({ releaseSlug: "next-record", editionSlug: "next-record" });
    const hash = mineEdition({ creator: CANONICAL_OWNER, releaseSlug: "next-record", editionSlug: "next-record", metadataUri: metadata.metadataUri });
    const confirmed = await service.confirmPublication({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { transactionHash: hash } });
    expect(confirmed).toMatchObject({ status: "PUBLISHED", tokenId: metadata.tokenId });
  });

  it("rejects the Fuji E2E wallet for canonical voidcaller at every publication step", async () => {
    const service = studio();
    const e2e = asWallet(FUJI_E2E_WALLET);
    await expect(assertArtistMayPublish(pool, { artistId: "voidcaller", wallet: FUJI_E2E_WALLET })).rejects.toMatchObject({ code: "ARTIST_WALLET_NOT_AUTHORIZED" });
    await expect(service.createRelease({ request: e2e, artistId: "voidcaller", input: { title: "Hijack" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    const release = await legacyRelease(service, CANONICAL_OWNER, "voidcaller", "Owner Draft");
    await expect(service.updateRelease({ request: e2e, releaseId: release.id, input: { title: "x" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await expect(service.createEdition({ request: e2e, releaseId: release.id, input: { trackTitle: "x" } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    await service.createEdition({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { trackTitle: "Owner Draft", quantity: "1" } });
    await expect(service.publishMetadata({ request: e2e, releaseId: release.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    const metadata = await service.publishMetadata({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: {} });
    const hash = mineEdition({ creator: FUJI_E2E_WALLET, releaseSlug: metadata.releaseSlug, editionSlug: metadata.editionSlug, metadataUri: metadata.metadataUri });
    await expect(service.confirmPublication({ request: e2e, releaseId: release.id, input: { transactionHash: hash } })).rejects.toMatchObject({ code: "ARTIST_ACCESS_DENIED" });
    // Even the canonical owner cannot confirm an edition the Fuji E2E wallet created on-chain.
    await expect(service.confirmPublication({ request: asWallet(CANONICAL_OWNER), releaseId: release.id, input: { transactionHash: hash } })).rejects.toMatchObject({ code: "EDITION_CREATED_BY_ANOTHER_ARTIST" });
    // Its own unverified alias cannot publish new content either.
    const aliasDraft = await legacyRelease(service, FUJI_E2E_WALLET, ALIAS_ID, "Alias Draft");
    await service.createEdition({ request: e2e, releaseId: aliasDraft.id, input: { trackTitle: "Alias Draft", quantity: "1" } });
    await expect(service.publishMetadata({ request: e2e, releaseId: aliasDraft.id, input: {} })).rejects.toMatchObject({ code: "ARTIST_NOT_VERIFIED" });
  });

  it("keeps the existing published certified release fully served without re-gating", async () => {
    const api = new ApiService({ db: pool, repository, logger: quiet });
    // Catalog.
    await expect(api.getRelease({ idOrSlug: ALIAS_RELEASE })).resolves.toMatchObject({ id: ALIAS_RELEASE, status: "PUBLISHED", artist_id: ALIAS_ID });
    await expect(api.getEdition({ id: ALIAS_EDITION })).resolves.toMatchObject({ id: ALIAS_EDITION, token_id: CERTIFIED_TOKEN_ID, contract_address: CERTIFIED });
    expect((await api.listEditions({ releaseId: ALIAS_RELEASE })).map((row) => row.id)).toEqual([ALIAS_EDITION]);
    // Marketplace.
    const listings = await api.listListings({ chainId: CHAIN_ID, tokenContractAddress: CERTIFIED, tokenId: CERTIFIED_TOKEN_ID });
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ seller_wallet: FUJI_E2E_WALLET, token_id: CERTIFIED_TOKEN_ID });
    // Ownership.
    const config = { authAllowedChainIds: [CHAIN_ID], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 };
    const requirement = [{ type: "erc1155-balance", chainId: CHAIN_ID, contract: CERTIFIED, tokenIds: [CERTIFIED_TOKEN_ID], minAmount: 1 }];
    const verifier = new IndexedOwnershipVerifier({ db: pool, config, denyUnauthorizedWith401: false });
    await expect(verifier.verify({ wallet: HOLDER, requirements: requirement })).resolves.toMatchObject({ owns: true });
    // Media gating: a holder gets a protected grant for the alias artist's experience.
    const storage = { open: async () => ({ type: "redirect", url: "https://media.example/ep" }) };
    const gateway = new ProtectedMediaGateway({
      db: pool,
      repository,
      authenticator: async () => ({ wallet: HOLDER }),
      ownershipVerifier: (input) => new IndexedOwnershipVerifier({ db: pool, config }).verify(input),
      storage,
      mediaConfig: { driver: "filesystem", privateRoot: "/private-media", grantTtlSeconds: 300, signedUrlTtlSeconds: 60, maxBytes: 1024 * 1024, auditHashSecret: "readiness" },
    });
    const grant = await gateway.issueGrant({ request: {}, input: { wallet: HOLDER, experienceId: "experience-alias-ep", mediaType: "AUDIO" } });
    await expect(gateway.openMedia({ request: { headers: {} }, grantId: grant.grantId })).resolves.toEqual({ type: "redirect", url: "https://media.example/ep" });
    // None of the above consulted verification: the alias owner still has none.
    await expect(assertArtistMayPublish(pool, { artistId: ALIAS_ID, wallet: FUJI_E2E_WALLET })).rejects.toMatchObject({ code: "ARTIST_NOT_VERIFIED" });
    // Re-saving the certified token for its own edition is still allowed; no other edition can take it.
    const contractId = (await pool.query("SELECT id FROM contracts WHERE address=$1 AND contract_type='ERC1155'", [CERTIFIED])).rows[0].id;
    await expect(repository.saveToken({ editionId: ALIAS_EDITION, contractId, tokenId: CERTIFIED_TOKEN_ID, metadataUri: "ipfs://certified" })).resolves.toMatchObject({ edition_id: ALIAS_EDITION });
  });
});
