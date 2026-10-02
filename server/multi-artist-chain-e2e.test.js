import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ethers } from "ethers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiService } from "./api-service.js";
import { artistKeyFor, releaseAuthorizationFor } from "./artist-authorization.js";
import { loadServerConfig } from "./config.js";
import { BlockchainIndexer } from "./indexer.js";
import { createJsonRpcClient } from "./indexer-rpc.js";
import { createIndexerStore } from "./indexer-store.js";
import { migrate } from "./migrate.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { createPersistenceRepository } from "./repositories.js";
import { dropScratchDatabase } from "./test-helpers/scratch-database.js";
import { ArtistStudioService } from "./studio-service.js";
import fujiRelease from "../config/fuji-release.json" with { type: "json" };

// Real chain + real Postgres + real indexer. A local anvil chain (chain id 43113)
// runs VoidRelease1155V3 at the certified release address, so the unmodified
// Studio confirm path, indexer, ownership verifier and API run end to end.
// Nothing here touches Fuji: the chain is a throwaway local process.

const CERTIFIED = fujiRelease.contractAddress;
const CHAIN_ID = 43113;
const VOIDCALLER_WALLET = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const VOIDCALLER_CERTIFIED_TOKEN_ID = 33778802922810732976408591241428358474475553907731009337085064305512658576739n;
const root = join(import.meta.dirname, "..");
const artifact = (file, name) => join(root, "out", file, `${name}.json`);
const anvilBinary = [process.env.ANVIL_BIN, "anvil", join(homedir(), ".foundry", "bin", "anvil")].filter(Boolean).find((bin) => spawnSync(bin, ["--version"]).status === 0);
const artifactsReady = existsSync(artifact("VoidRelease1155V3.sol", "VoidRelease1155V3")) && existsSync(artifact("MusicMarketplace.sol", "MusicMarketplace"));
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
const quiet = { info() {}, error() {}, warn() {} };
const ready = Boolean(testDatabaseUrl && anvilBinary && artifactsReady);

function load(file, name) { return JSON.parse(readFileSync(artifact(file, name), "utf8")); }

// CI installs Foundry and runs `forge test` (which writes out/) before `npm test`,
// so there this suite must run rather than skip.
describe.runIf(process.env.CI === "true" && testDatabaseUrl)("chain end-to-end prerequisites in CI", () => {
  it("has anvil and the compiled contracts available", () => {
    expect({ anvil: Boolean(anvilBinary), artifacts: artifactsReady }).toEqual({ anvil: true, artifacts: true });
  });
});

describe.skipIf(!ready)("second artist on a real chain, indexer and database", () => {
  let anvil;
  let provider;
  let adminPool;
  let pool;
  let dbName;
  let studio;
  let repository;
  let release1155;
  let market;
  let accounts;
  const V3 = ready ? load("VoidRelease1155V3.sol", "VoidRelease1155V3") : null;
  const MARKET = ready ? load("MusicMarketplace.sol", "MusicMarketplace") : null;
  const asWallet = (wallet) => ({ requestId: `req-${wallet.slice(2, 8)}`, headers: { "x-test-wallet": wallet.toLowerCase() } });
  const signer = (address) => new ethers.JsonRpcSigner(provider, ethers.getAddress(address));
  const asRelease = (address) => new ethers.Contract(CERTIFIED, V3.abi, signer(address));

  async function expectRevert(promise, errorName) {
    const error = await promise.then(() => null, (caught) => caught);
    expect(error, `expected ${errorName}`).not.toBeNull();
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    expect(release1155.interface.parseError(data)?.name).toBe(errorName);
  }

  async function verify(artistId, wallet) {
    const id = `app-${randomBytes(6).toString("hex")}`;
    await pool.query(
      `INSERT INTO artist_verification_applications (id, public_id, wallet_address, artist_id, slug, artist_name, legal_name, email, location, artist_type, artist_bio, work_description, years_active, verification_evidence, status, submitted_at, reviewed_at)
       VALUES ($1,$1,$2,$3,$3,'n','n','e@x.test','l','solo','b','w','1','evidence','VERIFIED',now(),now())`,
      [id, wallet.toLowerCase(), artistId],
    );
  }

  // Registrar mirrors the verified database artist onto the chain.
  async function registrarOnboard({ artistId, wallet, releaseSlug, editionSlug }) {
    const payload = await releaseAuthorizationFor(pool, { artistId, wallet, releaseSlug, editionSlug });
    if (!(await release1155.isArtistRegistered(payload.artistKey))) await (await release1155.registerArtist(payload.artistKey)).wait();
    if ((await release1155.artistIdOfWallet(payload.wallet)) !== payload.artistKey) await (await release1155.setArtistWallet(payload.artistKey, payload.wallet, true)).wait();
    await (await release1155.bindRelease(payload.releaseId, payload.artistKey)).wait();
    return payload;
  }

  // Studio draft → verified metadata → registrar → artist createEdition → Studio confirm.
  async function publish({ wallet, artistId, releaseTitle, editionTitle, supply = "10" }) {
    const release = await studio.createRelease({ request: asWallet(wallet), artistId, input: { title: releaseTitle } });
    const edition = await studio.createEdition({ request: asWallet(wallet), releaseId: release.id, input: { trackTitle: editionTitle, quantity: supply } });
    const metadata = await studio.publishMetadata({ request: asWallet(wallet), releaseId: release.id, input: { releaseType: "EP" } });
    const payload = await registrarOnboard({ artistId, wallet, releaseSlug: metadata.releaseSlug, editionSlug: metadata.editionSlug });
    const tx = await asRelease(wallet)["createEdition(bytes32,bytes32,uint256,string,address,uint96)"](payload.releaseId, payload.editionId, BigInt(supply), metadata.metadataUri, wallet, 500);
    await tx.wait();
    const confirmed = await studio.confirmPublication({ request: asWallet(wallet), releaseId: release.id, input: { transactionHash: tx.hash } });
    return { release, edition, metadata, payload, confirmed, tokenId: payload.tokenId };
  }

  async function indexAll() {
    const indexer = new BlockchainIndexer({
      rpc: createJsonRpcClient({ url: anvil.url }),
      store: createIndexerStore(pool),
      confirmations: 0,
      logger: quiet,
      configs: [
        { chainId: CHAIN_ID, address: CERTIFIED.toLowerCase(), contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: release1155.interface.getEvent("TransferSingle").topicHash, TransferBatch: release1155.interface.getEvent("TransferBatch").topicHash } },
        { chainId: CHAIN_ID, address: (await market.getAddress()).toLowerCase(), contractType: "MARKETPLACE", startBlock: 0, platformFeeBps: 250 },
      ],
    });
    return indexer.syncAll();
  }

  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(anvilBinary, ["--chain-id", String(CHAIN_ID), "--port", String(port), "--silent"], { stdio: "ignore" });
    anvil = { child, url: `http://127.0.0.1:${port}` };
    provider = new ethers.JsonRpcProvider(anvil.url, CHAIN_ID, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
    for (let attempt = 0; ; attempt += 1) {
      try { await provider.getBlockNumber(); break; } catch (error) { if (attempt > 100) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    accounts = (await provider.send("eth_accounts", [])).map((address) => ethers.getAddress(address));
    const [admin] = accounts;

    // Deploy V3, then place its runtime code at the certified address on this local chain
    // and seed the constructor's admin roles (_roles is storage slot 0).
    const deployed = await new ethers.ContractFactory(V3.abi, V3.bytecode.object, signer(admin)).deploy(admin);
    await deployed.waitForDeployment();
    await provider.send("anvil_setCode", [CERTIFIED, await provider.getCode(await deployed.getAddress())]);
    for (const role of [ethers.ZeroHash, ethers.id("REGISTRAR_ROLE")]) {
      const roleSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [role, 0]));
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [admin, roleSlot]));
      await provider.send("anvil_setStorageAt", [CERTIFIED, slot, ethers.zeroPadValue("0x01", 32)]);
    }
    release1155 = new ethers.Contract(CERTIFIED, V3.abi, signer(admin));
    market = await new ethers.ContractFactory(MARKET.abi, MARKET.bytecode.object, signer(admin)).deploy(admin, 250, CERTIFIED);
    await market.waitForDeployment();
    await provider.send("anvil_impersonateAccount", [VOIDCALLER_WALLET]);
    await provider.send("anvil_setBalance", [VOIDCALLER_WALLET, "0x56BC75E2D63100000"]);

    adminPool = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 2 });
    dbName = `void_chain_e2e_${randomBytes(6).toString("hex")}`;
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
    repository = createPersistenceRepository(pool);
    await repository.saveContract({ chainId: CHAIN_ID, chainKey: "fuji", address: (await market.getAddress()).toLowerCase(), contractType: "MARKETPLACE", name: "Local marketplace", metadata: {} });
    studio = new ArtistStudioService({
      db: pool,
      repository,
      metadataStorage: { write: async ({ name }) => ({ uri: `ipfs://local-${name}` }) },
      publicationChain: {
        getTransactionReceipt: (hash) => provider.getTransactionReceipt(hash),
        edition: (tokenId) => release1155.edition(tokenId),
        getBlock: (number) => provider.getBlock(number),
      },
      authenticator: async (request) => ({ wallet: request.headers["x-test-wallet"] }),
      logger: quiet,
    });
  }, 60_000);

  afterAll(async () => {
    anvil?.child.kill();
    if (adminPool) await dropScratchDatabase(adminPool, dbName, { pool });
    await adminPool?.end();
  });

  it("runs TEST ARTIST from verification to indexed ownership, marketplace and gating, beside VOIDCALLER", async () => {
    const [, testWallet, holder, buyer, bWallet, stranger] = accounts;
    expect(await release1155.hasRole(ethers.ZeroHash, accounts[0])).toBe(true);

    // VOIDCALLER: one artist, verified by contract-owner proof, keeps its certified token.
    await pool.query("INSERT INTO artist_contract_verifications (id, artist_slug, wallet_address, contract_address, chain_id, signature, message) VALUES ('vc-claim','voidcaller',$1,'0xd1b4367dd9f235f9ee61878019d66e31511e98ee',43114,'0xsig','claim')", [VOIDCALLER_WALLET]);
    const voidcaller = await publish({ wallet: VOIDCALLER_WALLET, artistId: "voidcaller", releaseTitle: "VOIDCALLER", editionTitle: "VOIDCALLER", supply: "25" });
    expect(voidcaller.metadata).toMatchObject({ releaseSlug: "voidcaller", editionSlug: "voidcaller" });
    expect(voidcaller.tokenId).toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    expect(voidcaller.confirmed).toMatchObject({ status: "PUBLISHED", tokenId: VOIDCALLER_CERTIFIED_TOKEN_ID.toString() });
    expect(await release1155.artistIdOf(VOIDCALLER_CERTIFIED_TOKEN_ID)).toBe(artistKeyFor("voidcaller"));

    // 1-3: TEST ARTIST created, verified, wallet authorized.
    const artist = await studio.createArtist({ request: asWallet(testWallet), input: { name: "TEST ARTIST" } });
    await verify(artist.id, testWallet);
    // 4-7: release, edition, token derivation, registrar authorization, on-chain publication, Studio confirm.
    const test = await publish({ wallet: testWallet, artistId: artist.id, releaseTitle: "TEST RELEASE", editionTitle: "TEST EDITION" });
    expect(test.metadata).toMatchObject({ releaseSlug: "test-release", editionSlug: "test-edition" });
    expect(test.tokenId).toBe(await release1155.tokenIdFor(ethers.encodeBytes32String("test-release"), ethers.encodeBytes32String("test-edition")));
    expect(test.tokenId).not.toBe(VOIDCALLER_CERTIFIED_TOKEN_ID);
    expect(test.confirmed).toMatchObject({ status: "PUBLISHED", tokenId: test.tokenId.toString() });
    expect(await release1155.artistIdOf(test.tokenId)).toBe(artistKeyFor(artist.id));

    // Cross-artist rejection on the real chain.
    await expectRevert(asRelease(VOIDCALLER_WALLET).mint(stranger, test.tokenId, 1, "0x"), "NotAuthorizedMinter");
    await expectRevert(asRelease(testWallet).mint(stranger, VOIDCALLER_CERTIFIED_TOKEN_ID, 1, "0x"), "NotAuthorizedMinter");
    await expectRevert(asRelease(testWallet)["createEdition(bytes32,bytes32,uint256,string,address,uint96)"](ethers.encodeBytes32String("voidcaller"), ethers.encodeBytes32String("x"), 1n, "ipfs://x", testWallet, 0), "ReleaseOwnedByAnotherArtist");
    await expectRevert(asRelease(stranger).mint(stranger, test.tokenId, 1, "0x"), "NotAuthorizedMinter");
    await expectRevert(asRelease(bWallet)["createEdition(bytes32,bytes32,uint256,string,address,uint96)"](ethers.encodeBytes32String("test-release"), ethers.encodeBytes32String("x"), 1n, "ipfs://x", bWallet, 0), "NotArtistWallet");

    // 8: TEST ARTIST mints its token; 10: holder lists, buyer purchases on the canonical marketplace.
    await (await asRelease(testWallet).mint(holder, test.tokenId, 2, "0x")).wait();
    await (await asRelease(VOIDCALLER_WALLET).mint(holder, VOIDCALLER_CERTIFIED_TOKEN_ID, 1, "0x")).wait();
    await (await asRelease(holder).setApprovalForAll(await market.getAddress(), true)).wait();
    const asHolder = market.connect(signer(holder));
    await (await asHolder.createListing(CERTIFIED, holder, test.tokenId, 1, ethers.parseEther("1"), 0)).wait();
    expect(await release1155.royaltyInfo(test.tokenId, ethers.parseEther("1"))).toEqual([testWallet, ethers.parseEther("0.05")]);
    const payoutBefore = await provider.getBalance(testWallet);
    await (await market.connect(signer(buyer)).buy(1, 1, { value: ethers.parseEther("1") })).wait();
    expect((await provider.getBalance(testWallet)) - payoutBefore).toBe(ethers.parseEther("0.05"));

    // 9: the production indexer projects ownership and the marketplace from the chain.
    await indexAll();
    const snapshots = (await pool.query("SELECT wallet_address, token_id::text AS token_id, amount::text AS amount FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 AND amount > 0 ORDER BY token_id, wallet_address", [CHAIN_ID, CERTIFIED.toLowerCase()])).rows;
    expect(snapshots).toEqual(expect.arrayContaining([
      { wallet_address: holder.toLowerCase(), token_id: test.tokenId.toString(), amount: "1" },
      { wallet_address: buyer.toLowerCase(), token_id: test.tokenId.toString(), amount: "1" },
      { wallet_address: holder.toLowerCase(), token_id: VOIDCALLER_CERTIFIED_TOKEN_ID.toString(), amount: "1" },
    ]));
    expect(snapshots).toHaveLength(3);
    const api = new ApiService({ db: pool, repository, logger: quiet });
    const sold = await api.listListings({ chainId: CHAIN_ID, tokenContractAddress: CERTIFIED.toLowerCase(), tokenId: test.tokenId.toString(), status: "SOLD" });
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatchObject({ token_id: test.tokenId.toString(), seller_wallet: holder.toLowerCase() });
    // Catalog attributes the edition to TEST ARTIST by contract + token.
    await expect(api.getEdition({ id: test.edition.id })).resolves.toMatchObject({ artist_id: artist.id, token_id: test.tokenId.toString(), contract_address: CERTIFIED.toLowerCase() });

    // 11: gating on TEST ARTIST's token, through the indexed ownership.
    const requirement = [{ type: "erc1155-balance", chainId: CHAIN_ID, contract: CERTIFIED.toLowerCase(), tokenIds: [test.tokenId.toString()], minAmount: 1 }];
    const experience = await studio.createExperience({ request: asWallet(testWallet), editionId: test.edition.id, input: { title: "Stems", type: "STEMS", requirements: requirement } });
    const verifier = new IndexedOwnershipVerifier({ db: pool, config: { authAllowedChainIds: [CHAIN_ID], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000 }, denyUnauthorizedWith401: false });
    const stored = (await pool.query("SELECT requirements FROM experiences WHERE id=$1", [experience.id])).rows[0].requirements;
    await expect(verifier.verify({ wallet: buyer, requirements: stored })).resolves.toMatchObject({ owns: true });
    await expect(verifier.verify({ wallet: stranger, requirements: stored })).resolves.toMatchObject({ owns: false });
    // Holding VOIDCALLER's token does not unlock TEST ARTIST's experience, and vice versa.
    await expect(verifier.verify({ wallet: holder, requirements: [{ ...requirement[0], tokenIds: [VOIDCALLER_CERTIFIED_TOKEN_ID.toString()] }] })).resolves.toMatchObject({ owns: true });
    await expect(verifier.verify({ wallet: buyer, requirements: [{ ...requirement[0], tokenIds: [VOIDCALLER_CERTIFIED_TOKEN_ID.toString()] }] })).resolves.toMatchObject({ owns: false });

    // Revocation on chain stops TEST ARTIST without touching VOIDCALLER.
    await (await release1155.setArtistActive(artistKeyFor(artist.id), false)).wait();
    await expectRevert(asRelease(testWallet).mint(holder, test.tokenId, 1, "0x"), "ArtistInactive");
    await (await asRelease(VOIDCALLER_WALLET).mint(holder, VOIDCALLER_CERTIFIED_TOKEN_ID, 1, "0x")).wait();
  }, 120_000);
});
