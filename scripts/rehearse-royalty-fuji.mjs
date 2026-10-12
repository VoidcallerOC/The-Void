import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, ContractFactory, JsonRpcProvider, Wallet, encodeBytes32String, formatEther, getAddress, getCreateAddress, isAddress, keccak256, parseEther, toUtf8Bytes } from "ethers";
import fujiV1 from "../config/fuji-release-per-contract.json" with { type: "json" };
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };
import fujiShared from "../config/fuji-release.json" with { type: "json" };
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { missingAlbumSelectors } from "./deploy-release-per-contract-fuji.mjs";
import { FACTORY_ARTIFACT_PATH, IMPLEMENTATION_ARTIFACT_PATH, MARKETPLACE_ARTIFACT_PATH, missingSelectors } from "./deploy-release-per-contract-mainnet.mjs";

// Fuji-first rehearsal of the royalty-locked mainnet launch candidate (PR #171):
// VoidReleaseFactoryV2Royalty + VoidRelease1155V4Royalty + ReleaseMarketplaceV4, deployed ADDITIVELY
// on Fuji from the deployer's next nonces, then exercised on chain: release, edition at 2.5%, primary
// sale (2.5% credited to the platform recipient), resale (2.5% fee, 2.5% royalty, 95% seller) and
// bypass attempts that must revert. Existing Fuji contracts, manifests (config/) and services are
// never touched; the record is written only to deployments/fuji-royalty-rehearsal-<factory>.json.
// Only the existing deployer key signs. It acts as release artist, seller and buyer; the royalty
// payout is a separate passive wallet granted ARTIST_ROLE, so fee and royalty land on distinct
// addresses. The default path is a read-only plan.
export const FUJI_CHAIN_ID = 43113;
export const FEE_BPS = 250n;
export const PRICE_WEI = parseEther("0.01");
// The platform fee recipient: the same address on Fuji and in the mainnet manifest (the Nano S Plus).
export const FEE_RECIPIENT = getAddress(fujiV2.platformRecipient);
// Passive royalty payout for the rehearsal: the artist wallet. It receives value; it never signs.
export const DEFAULT_ROYALTY_PAYOUT = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIST_ROLE = keccak256(toUtf8Bytes("ARTIST_ROLE"));
const STRANGER = "0x000000000000000000000000000000000000dEaD";

export class RehearsalError extends Error {}

/** Every Fuji contract address already recorded in config/; the rehearsal must never reuse one. */
export function existingFujiAddresses() {
  const values = [
    fujiV1.factoryAddress, fujiV1.implementationAddress, fujiV1.marketplaceAddress,
    fujiV2.factoryAddress, fujiV2.implementationAddress, fujiV2.marketplaceAddress,
    ...(fujiV2.historicalDeployments || []).flatMap((item) => [item.factoryAddress, item.implementationAddress, item.marketplaceAddress]),
    fujiShared.contractAddress, fujiShared.primarySaleAddress, fujiShared.legacyV1?.contractAddress, fujiShared.provenance?.anchorAddress,
  ];
  return new Set(values.filter((value) => isAddress(value)).map((value) => getAddress(value)));
}

function text(value) {
  return String(value ?? "").trim();
}

function address(value, name) {
  if (!isAddress(text(value)) || getAddress(text(value)) === "0x0000000000000000000000000000000000000000") throw new RehearsalError(`${name} must be a non-zero EVM address.`);
  return getAddress(text(value));
}

export function validateRehearsalEnv(env = process.env) {
  if (text(env.DEPLOY_NETWORK).toLowerCase() !== "fuji") throw new RehearsalError('DEPLOY_NETWORK must be exactly "fuji".');
  if (FEE_RECIPIENT !== getAddress(mainnetManifest.platformRecipient)) throw new RehearsalError("The Fuji and mainnet platform fee recipients differ; the rehearsal would not match the launch economics.");
  const rpcUrl = text(env.AVALANCHE_FUJI_RPC_URL) || fujiV2.rpcUrl;
  if (!/^https?:\/\//i.test(rpcUrl) || /@/.test(rpcUrl)) throw new RehearsalError("AVALANCHE_FUJI_RPC_URL must be an HTTP(S) URL without embedded credentials.");
  const expectedDeployer = address(env.EXPECTED_DEPLOYER_ADDRESS, "EXPECTED_DEPLOYER_ADDRESS");
  const key = text(env.DEPLOYER_PRIVATE_KEY);
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new RehearsalError("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key.");
  if (key && new Wallet(key).address !== expectedDeployer) throw new RehearsalError("DEPLOYER_PRIVATE_KEY does not belong to EXPECTED_DEPLOYER_ADDRESS.");
  const royaltyPayout = address(text(env.REHEARSAL_ROYALTY_PAYOUT) || DEFAULT_ROYALTY_PAYOUT, "REHEARSAL_ROYALTY_PAYOUT");
  if (royaltyPayout === FEE_RECIPIENT || royaltyPayout === expectedDeployer) throw new RehearsalError("The rehearsal royalty payout must differ from the fee recipient and the deployer.");
  const broadcast = text(env.BROADCAST_REHEARSAL).toLowerCase() === "yes";
  const nonceText = text(env.EXPECTED_DEPLOYER_NONCE);
  if (nonceText && !/^\d+$/.test(nonceText)) throw new RehearsalError("EXPECTED_DEPLOYER_NONCE must be a non-negative integer.");
  if (broadcast) {
    if (text(env.CONFIRM_FUJI_REHEARSAL) !== "yes") throw new RehearsalError("Broadcast requires CONFIRM_FUJI_REHEARSAL=yes.");
    if (!key) throw new RehearsalError("Broadcast requires DEPLOYER_PRIVATE_KEY.");
    if (!nonceText) throw new RehearsalError("Broadcast requires EXPECTED_DEPLOYER_NONCE from the reviewed plan.");
  }
  return Object.freeze({ rpcUrl, deployer: expectedDeployer, deployerPrivateKey: key || null, royaltyPayout, broadcast, expectedNonce: nonceText ? Number(nonceText) : null });
}

async function loadArtifact(relativePath) {
  const artifact = JSON.parse(await readFile(resolve(ROOT, relativePath), "utf8"));
  if (!artifact.abi || !artifact.bytecode?.object || artifact.bytecode.object === "0x") throw new RehearsalError(`Artifact is missing ABI or bytecode: ${relativePath}; run forge build.`);
  return artifact;
}

/** Read-only plan: chain, deployer, predicted additive addresses, isolation from existing Fuji contracts, funding. */
export async function buildRehearsalPlan(config, provider, { load = loadArtifact } = {}) {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(FUJI_CHAIN_ID)) throw new RehearsalError(`Refusing chain ${network.chainId}. The rehearsal runs only on Fuji (${FUJI_CHAIN_ID}).`);
  const [factoryArtifact, marketplaceArtifact, implementationArtifact] = await Promise.all([load(FACTORY_ARTIFACT_PATH), load(MARKETPLACE_ARTIFACT_PATH), load(IMPLEMENTATION_ARTIFACT_PATH)]);
  const [nonce, pendingNonce, balance] = await Promise.all([provider.getTransactionCount(config.deployer, "latest"), provider.getTransactionCount(config.deployer, "pending"), provider.getBalance(config.deployer)]);
  const factory = getCreateAddress({ from: config.deployer, nonce });
  const implementation = getCreateAddress({ from: factory, nonce: 1 });
  const marketplace = getCreateAddress({ from: config.deployer, nonce: nonce + 1 });
  const existing = existingFujiAddresses();
  const collisions = [factory, implementation, marketplace].filter((value) => existing.has(value));
  const codes = await Promise.all([factory, implementation, marketplace].map((value) => provider.getCode(value)));
  const missingLock = [
    ...missingSelectors(implementationArtifact.deployedBytecode?.object, ["REQUIRED_ROYALTY_BPS()", "platformFeeRecipient()"]),
    ...missingSelectors(marketplaceArtifact.deployedBytecode?.object, ["REQUIRED_ROYALTY_BPS()", "REQUIRED_PLATFORM_FEE_BPS()"]),
    ...missingAlbumSelectors(implementationArtifact.deployedBytecode?.object),
  ];
  // Two deployments plus about fourteen rehearsal transactions, and the two 0.01 AVAX purchases.
  const required = parseEther("0.05");
  const checks = [
    { check: "chainId is Fuji", status: "PASS", value: FUJI_CHAIN_ID },
    { check: "no pending deployer transactions", status: pendingNonce === nonce ? "PASS" : "FAIL", value: { nonce, pendingNonce } },
    { check: "nonce matches EXPECTED_DEPLOYER_NONCE", status: config.expectedNonce === null ? "NOT PROVIDED" : config.expectedNonce === nonce ? "PASS" : "FAIL" },
    { check: "new addresses differ from every recorded Fuji contract", status: collisions.length ? "FAIL" : "PASS", value: collisions },
    { check: "new addresses have no code (additive)", status: codes.every((code) => code === "0x") ? "PASS" : "FAIL" },
    { check: "artifacts are the royalty-locked, album-capable launch candidate", status: missingLock.length ? "FAIL" : "PASS", value: missingLock },
    { check: "deployer funded for the rehearsal", status: balance >= required ? "PASS" : "FAIL", value: { balanceAvax: formatEther(balance), requiredAvax: formatEther(required) } },
  ];
  return {
    mode: "PLAN",
    chainId: FUJI_CHAIN_ID,
    deployer: config.deployer,
    deployerNonce: nonce,
    feeRecipient: FEE_RECIPIENT,
    royaltyPayout: config.royaltyPayout,
    predicted: { factory, implementation, marketplace },
    artifacts: { factory: { path: FACTORY_ARTIFACT_PATH, initCodeHash: keccak256(factoryArtifact.bytecode.object) }, marketplace: { path: MARKETPLACE_ARTIFACT_PATH, initCodeHash: keccak256(marketplaceArtifact.bytecode.object) }, implementation: { path: IMPLEMENTATION_ARTIFACT_PATH, runtimeCodeHash: keccak256(implementationArtifact.deployedBytecode.object) } },
    untouched: [...existing],
    checks,
    ready: checks.every((item) => item.status === "PASS"),
    broadcasted: false,
  };
}

const FACTORY_ABI = ["function createRelease(bytes32,bytes32,string,string,string) returns (address,address,address)", "function implementation() view returns (address)", "function platformRecipient() view returns (address)", "function PLATFORM_FEE_BPS() view returns (uint256)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)", "function RELEASE_VERSION() view returns (uint16)", "event ReleaseCreated(address indexed releaseContract,bytes32 indexed releaseKey,address indexed artist,address primarySale,address provenanceAnchor,address implementation,uint256 index,uint16 version)"];
const RELEASE_ABI = ["function grantRole(bytes32,address)", "function createEdition(bytes32,bytes32,uint256,string,address,uint96) returns (uint256)", "function tokenIdFor(bytes32,bytes32) view returns (uint256)", "function setApprovalForAll(address,bool)", "function balanceOf(address,uint256) view returns (uint256)", "function royaltyInfo(uint256,uint256) view returns (address,uint256)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)", "function platformFeeRecipient() view returns (address)", "error RoyaltyPolicyViolation(uint96 royaltyBps, uint96 requiredBps)", "error UnauthorizedRoyaltyRecipient(address payout)"];
const SALE_ABI = ["function configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)", "function purchase(uint256,uint256) payable", "function balances(address) view returns (uint256)"];
const MARKET_ABI = ["function createListing(address,address,uint256,uint256,uint256,uint64) returns (uint256)", "function buy(uint256,uint256) payable", "function listingStatus(uint256) view returns (uint8)", "function registry() view returns (address)", "function feeRecipient() view returns (address)", "function platformFeeBps() view returns (uint256)", "function REQUIRED_ROYALTY_BPS() view returns (uint96)", "error UnsupportedRelease()", "error RoyaltyPolicyViolation()", "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty)"];

async function mined(txPromise, label, log) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new RehearsalError(`${label} failed.`);
  log({ step: label, transaction: receipt.hash, block: receipt.blockNumber });
  return receipt;
}

async function reverts(call) {
  try { await call(); return { reverted: false }; } catch (error) { return { reverted: true, reason: error?.revert?.name || error?.shortMessage || "reverted" }; }
}

const gasCost = (receipt) => receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);

/** Broadcasts the additive deployment and the on-chain acceptance journey; every mined step is logged. */
export async function broadcastRehearsal(config, provider, plan, { load = loadArtifact, signer = new Wallet(config.deployerPrivateKey, provider), log = (value) => console.log(JSON.stringify(value)), writeRecord = writeRecordFile } = {}) {
  if (!plan.ready) throw new RehearsalError("The plan is not ready. Nothing was sent.");
  const bal = async (who) => BigInt(await provider.send("eth_getBalance", [who, "latest"]));
  const factoryArtifact = await load(FACTORY_ARTIFACT_PATH);
  const marketplaceArtifact = await load(MARKETPLACE_ARTIFACT_PATH);
  const evidence = { deployments: {}, journey: {}, bypass: {}, checks: [] };
  const check = (name, pass, value) => { evidence.checks.push({ check: name, status: pass ? "PASS" : "FAIL", value }); if (!pass) throw new RehearsalError(`Rehearsal check failed: ${name} (${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}).`); };

  const factoryDeploy = await new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object, signer).deploy(FEE_RECIPIENT);
  const factoryReceipt = await mined(Promise.resolve(factoryDeploy.deploymentTransaction()), "FACTORY_DEPLOYED", log);
  const factory = new Contract(getAddress(await factoryDeploy.getAddress()), FACTORY_ABI, signer);
  check("factory at the planned address", factory.target === plan.predicted.factory, factory.target);
  const implementation = new Contract(getAddress(await factory.implementation()), RELEASE_ABI, provider);
  check("factory immutables: recipient, 250 bps fee, 250 bps royalty, version 2", getAddress(await factory.platformRecipient()) === FEE_RECIPIENT && (await factory.PLATFORM_FEE_BPS()) === FEE_BPS && BigInt(await factory.REQUIRED_ROYALTY_BPS()) === FEE_BPS && Number(await factory.RELEASE_VERSION()) === 2, factory.target);
  check("implementation is royalty-locked to the same recipient", BigInt(await implementation.REQUIRED_ROYALTY_BPS()) === FEE_BPS && getAddress(await implementation.platformFeeRecipient()) === FEE_RECIPIENT, implementation.target);
  const marketplaceDeploy = await new ContractFactory(marketplaceArtifact.abi, marketplaceArtifact.bytecode.object, signer).deploy(FEE_RECIPIENT, FEE_BPS, factory.target);
  const marketplaceReceipt = await mined(Promise.resolve(marketplaceDeploy.deploymentTransaction()), "MARKETPLACE_DEPLOYED", log);
  const market = new Contract(getAddress(await marketplaceDeploy.getAddress()), MARKET_ABI, signer);
  check("marketplace at the planned address", market.target === plan.predicted.marketplace, market.target);
  check("marketplace registry, recipient, 250 bps fee and royalty", getAddress(await market.registry()) === factory.target && getAddress(await market.feeRecipient()) === FEE_RECIPIENT && (await market.platformFeeBps()) === FEE_BPS && BigInt(await market.REQUIRED_ROYALTY_BPS()) === FEE_BPS, market.target);
  evidence.deployments = {
    factory: { address: factory.target, transaction: factoryReceipt.hash, block: factoryReceipt.blockNumber, implementation: implementation.target },
    marketplace: { address: market.target, transaction: marketplaceReceipt.hash, block: marketplaceReceipt.blockNumber },
  };
  log({ step: "DEPLOYMENTS", ...evidence.deployments });

  // Release and edition (deployer acts as the release artist on Fuji only).
  const appId = keccak256(toUtf8Bytes(`the-void:fuji-royalty-rehearsal:${factory.target}`));
  const releaseKey = keccak256(AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "bytes32", "address"], ["the-void:studio-release:v2", BigInt(FUJI_CHAIN_ID), factory.target, appId, config.deployer]));
  const created = await mined(factory.createRelease(appId, releaseKey, "Void Royalty Rehearsal", "VRR", "ipfs://the-void-fuji-royalty-rehearsal"), "RELEASE_CREATED", log);
  const event = created.logs.map((item) => { try { return factory.interface.parseLog(item); } catch { return null; } }).find((parsed) => parsed?.name === "ReleaseCreated");
  const release = new Contract(getAddress(event.args.releaseContract), RELEASE_ABI, signer);
  const sale = new Contract(getAddress(event.args.primarySale), SALE_ABI, signer);
  await mined(release.grantRole(ARTIST_ROLE, config.royaltyPayout), "PAYOUT_AUTHORIZED", log);

  // Bypass attempts, simulated against the live deployed clone: each must revert.
  const editionId = encodeBytes32String("rehearsal-edition");
  evidence.bypass = {
    royalty500Bps: await reverts(() => release.createEdition.staticCall(releaseKey, encodeBytes32String("bypass-500"), 10, "ipfs://x", config.royaltyPayout, 500)),
    royalty0Bps: await reverts(() => release.createEdition.staticCall(releaseKey, encodeBytes32String("bypass-0"), 10, "ipfs://x", config.royaltyPayout, 0)),
    platformPayout: await reverts(() => release.createEdition.staticCall(releaseKey, encodeBytes32String("bypass-fee"), 10, "ipfs://x", FEE_RECIPIENT, 250)),
    unauthorizedPayout: await reverts(() => release.createEdition.staticCall(releaseKey, encodeBytes32String("bypass-stranger"), 10, "ipfs://x", STRANGER, 250)),
    existingFujiReleaseListing: await reverts(async () => {
      const legacyFactory = new Contract(fujiV2.factoryAddress, ["function releaseAt(uint256) view returns (address)"], provider);
      return market.createListing.staticCall(await legacyFactory.releaseAt(0), config.deployer, 1, 1, PRICE_WEI, 0);
    }),
  };
  const expected = { royalty500Bps: "RoyaltyPolicyViolation", royalty0Bps: "RoyaltyPolicyViolation", platformPayout: "UnauthorizedRoyaltyRecipient", unauthorizedPayout: "UnauthorizedRoyaltyRecipient", existingFujiReleaseListing: "UnsupportedRelease" };
  check("every bypass attempt reverts with the enforcing error", Object.entries(expected).every(([name, reason]) => evidence.bypass[name].reverted && evidence.bypass[name].reason === reason), evidence.bypass);

  await mined(release.createEdition(releaseKey, editionId, 10, "ipfs://the-void-fuji-royalty-rehearsal/edition", config.royaltyPayout, 250), "EDITION_CREATED", log);
  const tokenId = await release.tokenIdFor(releaseKey, editionId);
  const [royaltyReceiver, royaltyAmount] = await release.royaltyInfo(tokenId, PRICE_WEI);
  check("edition royalty is 2.5% to the authorized artist payout", getAddress(royaltyReceiver) === config.royaltyPayout && royaltyAmount === (PRICE_WEI * FEE_BPS) / 10_000n, { royaltyReceiver, royaltyAmount });

  // Primary sale: 2.5% credited to the platform recipient, 97.5% to the edition payout.
  await mined(sale.configureSale(tokenId, PRICE_WEI, 10, 5, 0, 0, false), "SALE_CONFIGURED", log);
  const [feeCreditBefore, payoutCreditBefore] = await Promise.all([sale.balances(FEE_RECIPIENT), sale.balances(config.royaltyPayout)]);
  const purchase = await mined(sale.purchase(tokenId, 1, { value: PRICE_WEI }), "PRIMARY_PURCHASE", log);
  const [feeCredit, payoutCredit] = await Promise.all([sale.balances(FEE_RECIPIENT), sale.balances(config.royaltyPayout)]);
  check("primary sale credits 2.5% / 97.5%", feeCredit - feeCreditBefore === (PRICE_WEI * FEE_BPS) / 10_000n && payoutCredit - payoutCreditBefore === PRICE_WEI - (PRICE_WEI * FEE_BPS) / 10_000n, { feeCredit: feeCredit - feeCreditBefore, payoutCredit: payoutCredit - payoutCreditBefore });
  check("buyer owns the purchased token", (await release.balanceOf(config.deployer, tokenId)) === 1n, tokenId);

  // Resale on ReleaseMarketplaceV4 (the deployer lists and buys its own listing: one signing key).
  await mined(release.setApprovalForAll(market.target, true), "MARKETPLACE_APPROVED", log);
  const listingId = await market.createListing.staticCall(release.target, config.deployer, tokenId, 1, PRICE_WEI, 0);
  await mined(market.createListing(release.target, config.deployer, tokenId, 1, PRICE_WEI, 0), "LISTED", log);
  const [feeBefore, payoutBefore, deployerBefore] = await Promise.all([bal(FEE_RECIPIENT), bal(config.royaltyPayout), bal(config.deployer)]);
  const resale = await mined(market.buy(listingId, 1, { value: PRICE_WEI }), "RESOLD", log);
  const [feeAfter, payoutAfter, deployerAfter] = await Promise.all([bal(FEE_RECIPIENT), bal(config.royaltyPayout), bal(config.deployer)]);
  const sold = resale.logs.map((item) => { try { return market.interface.parseLog(item); } catch { return null; } }).find((parsed) => parsed?.name === "ListingSold");
  const fee = (PRICE_WEI * FEE_BPS) / 10_000n;
  check("ListingSold records 2.5% fee and 2.5% royalty", sold && sold.args.platformFee === fee && sold.args.royalty === fee, { platformFee: sold?.args.platformFee, royalty: sold?.args.royalty });
  check("platform recipient received exactly 2.5%", feeAfter - feeBefore === fee, feeAfter - feeBefore);
  check("artist payout received exactly 2.5%", payoutAfter - payoutBefore === fee, payoutAfter - payoutBefore);
  check("seller received 95% (buyer = seller: net -5% minus gas)", deployerBefore - deployerAfter - gasCost(resale) === 2n * fee, deployerBefore - deployerAfter - gasCost(resale));
  check("listing settled", Number(await market.listingStatus(listingId)) === 1, listingId);

  evidence.journey = {
    release: release.target, primarySale: sale.target, tokenId: tokenId.toString(), listingId: listingId.toString(), priceWei: PRICE_WEI.toString(),
    primaryPurchase: purchase.hash, resale: resale.hash, platformFeeWei: fee.toString(), royaltyWei: fee.toString(), sellerProceedsWei: (PRICE_WEI - 2n * fee).toString(),
  };
  const record = { network: "fuji", chainId: FUJI_CHAIN_ID, purpose: "Fuji-first rehearsal of the PR #171 royalty-locked launch candidate (additive; not an app deployment)", sourceCommit: process.env.GITHUB_SHA || null, feeRecipient: FEE_RECIPIENT, royaltyPayout: config.royaltyPayout, ...evidence };
  const recordPath = `deployments/fuji-royalty-rehearsal-${factory.target}.json`;
  log({ step: "RECORD", path: recordPath });
  try { await writeRecord(recordPath, record); } catch (error) { log({ step: "RECORD_WRITE_FAILED", path: recordPath, error: error.message }); }
  return record;
}

async function writeRecordFile(relativePath, record) {
  const recordPath = resolve(ROOT, relativePath);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`, { flag: "wx" });
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateRehearsalEnv(env);
  if (config.broadcast && argv.includes("--dry-run")) throw new RehearsalError("--dry-run cannot be combined with BROADCAST_REHEARSAL=yes.");
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, FUJI_CHAIN_ID, { staticNetwork: true });
  const plan = await (dependencies.buildRehearsalPlan || buildRehearsalPlan)(config, provider);
  console.log(JSON.stringify(plan, null, 2));
  if (!config.broadcast) {
    console.log("Plan only. No transaction was signed or broadcast.");
    return plan;
  }
  const record = await (dependencies.broadcastRehearsal || broadcastRehearsal)(config, provider, plan);
  console.log(JSON.stringify({ mode: "REHEARSAL_COMPLETE", record }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return { mode: "REHEARSAL_COMPLETE", record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Fuji royalty rehearsal failed: ${error.message}`);
    process.exitCode = 1;
  });
}
