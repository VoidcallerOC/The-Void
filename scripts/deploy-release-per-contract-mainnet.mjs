import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, ContractFactory, Interface, JsonRpcProvider, formatEther, getAddress, getCreateAddress, id, isAddress, keccak256 } from "ethers";
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { missingAlbumSelectors } from "./deploy-release-per-contract-fuji.mjs";
import { assertDefinedDeployer, assertNoPrivateKeyInEnv, creationRequest, runtimeMatchesArtifact, verifyCreationTransaction } from "./mainnet-signing-requests.mjs";

// C-Chain deployment of the release-per-contract architecture validated on Fuji, with the artist
// royalty enforced on chain: VoidReleaseFactoryV2Royalty (VoidReleaseFactoryV2 whose constructor
// creates the VoidRelease1155V4Royalty clone implementation: every edition pays exactly 2.5% to an
// artist wallet of its release, never to the fee recipient) followed by ReleaseMarketplaceV4 (V3 that
// independently enforces the same royalty at listing and settlement). Both are ownerless and their fee recipients
// and fee rates are immutable, so the recipient must be the owner's physically verified address.
// This script never signs and never reads a private key. It builds the key-less plan, including the
// exact unsigned creation transactions, and verifies mined transactions against that plan. The owner
// signs those transactions in Rabby with the defined deployer (scripts/mainnet-owner-signing.mjs,
// deploy/mainnet/OWNER-SIGNING.md); the deployer creates contracts only, never releases.
export const MAINNET_CHAIN_ID = 43114;
export const FEE_BPS = 250;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FACTORY_ARTIFACT_PATH = "out/VoidReleaseFactoryV2Royalty.sol/VoidReleaseFactoryV2Royalty.json";
export const MARKETPLACE_ARTIFACT_PATH = "out/ReleaseMarketplaceV4.sol/ReleaseMarketplaceV4.json";
export const IMPLEMENTATION_ARTIFACT_PATH = "out/VoidRelease1155V4Royalty.sol/VoidRelease1155V4Royalty.json";
export const ROYALTY_BPS = 250;
// Runtime-bytecode markers of the royalty lock (Solidity dispatch PUSH4 of each selector).
const IMPLEMENTATION_ROYALTY_SIGNATURES = Object.freeze(["REQUIRED_ROYALTY_BPS()", "platformFeeRecipient()"]);
const MARKETPLACE_ROYALTY_SIGNATURES = Object.freeze(["REQUIRED_ROYALTY_BPS()", "REQUIRED_PLATFORM_FEE_BPS()"]);
export function missingSelectors(runtimeBytecode, signatures) {
  const code = String(runtimeBytecode || "").toLowerCase();
  return signatures.filter((signature) => !code.includes(`63${id(signature).slice(2, 10)}`));
}
const ROYALTY_VIEWS = new Interface(["function REQUIRED_ROYALTY_BPS() view returns (uint96)", "function platformFeeRecipient() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
// The single passive platform fee recipient (the owner's Nano S Plus) is recorded in the mainnet
// manifest; both fees must go to exactly that address. Other roles never double as the recipient.
export const FEE_RECIPIENT = getAddress(mainnetManifest.platformRecipient);
if (getAddress(mainnetManifest.marketplaceFeeRecipient) !== FEE_RECIPIENT) throw new Error("The mainnet manifest must name one platform fee recipient for both fees.");
export const REFUSED_RECIPIENTS = Object.freeze({
  "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a": "the artist wallet; artist and platform fee recipient are separate roles",
  "0xD1B4367dd9f235f9ee61878019d66E31511E98eE": "the Genesis collection contract",
});
// Gas headroom required over the estimate before signing (percent).
const FUNDING_HEADROOM_PERCENT = 150n;

export class DeploymentError extends Error {}

function text(value) {
  return String(value ?? "").trim();
}

function address(value, name) {
  const raw = text(value);
  if (!raw) throw new DeploymentError(`${name} is required.`);
  if (!isAddress(raw) || getAddress(raw) === ZERO) throw new DeploymentError(`${name} must be a non-zero EVM address.`);
  return getAddress(raw);
}

function optionalAddress(value, name) {
  return text(value) ? address(value, name) : null;
}

function feeBps(value, name) {
  const raw = text(value) || String(FEE_BPS);
  if (!/^\d+$/.test(raw) || Number(raw) !== FEE_BPS) throw new DeploymentError(`${name} must be exactly ${FEE_BPS} (2.5%), the locked release economics.`);
  return FEE_BPS;
}

/** Validates the environment. Recipients may be absent in a dry run; the plan then reports them BLOCKED. */
export function validateDeploymentEnv(env = process.env) {
  if (text(env.DEPLOY_NETWORK).toLowerCase() !== "mainnet") throw new DeploymentError('DEPLOY_NETWORK must be exactly "mainnet".');
  try {
    assertNoPrivateKeyInEnv(env, "The mainnet deployment plan");
  } catch (error) {
    throw new DeploymentError(error.message);
  }
  if (text(env.BROADCAST_DEPLOYMENT).toLowerCase() === "yes") {
    throw new DeploymentError("This script never signs or broadcasts. The owner signs the planned transactions in Rabby: npm run sign:mainnet (deploy/mainnet/OWNER-SIGNING.md).");
  }
  const rpcUrl = text(env.AVALANCHE_MAINNET_RPC_URL) || mainnetManifest.rpcUrl;
  // HTTPS, or a node on this machine (a local C-Chain node or fork rehearsal). Never embedded credentials.
  if (!(/^https:\/\//i.test(rpcUrl) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(rpcUrl)) || /@/.test(rpcUrl)) {
    throw new DeploymentError("AVALANCHE_MAINNET_RPC_URL must be an HTTPS URL (or a local node) without embedded credentials.");
  }
  let deployerAddress;
  try {
    deployerAddress = assertDefinedDeployer(env.EXPECTED_DEPLOYER_ADDRESS);
  } catch (error) {
    throw new DeploymentError(error.message);
  }

  const platformRecipient = optionalAddress(env.RELEASE_PLATFORM_RECIPIENT, "RELEASE_PLATFORM_RECIPIENT");
  const marketplaceInput = optionalAddress(env.RELEASE_MARKETPLACE_FEE_RECIPIENT, "RELEASE_MARKETPLACE_FEE_RECIPIENT");
  if (marketplaceInput && platformRecipient && marketplaceInput !== platformRecipient) {
    throw new DeploymentError("The validated Fuji economics send primary and marketplace fees to one recipient. A split recipient needs a separate owner decision.");
  }
  const marketplaceFeeRecipient = marketplaceInput || platformRecipient;
  for (const [name, value] of [["RELEASE_PLATFORM_RECIPIENT", platformRecipient], ["RELEASE_MARKETPLACE_FEE_RECIPIENT", marketplaceFeeRecipient]]) {
    if (!value) continue;
    if (REFUSED_RECIPIENTS[value]) throw new DeploymentError(`${name} is ${REFUSED_RECIPIENTS[value]}.`);
    if (value === deployerAddress) throw new DeploymentError(`${name} must not be the deployer.`);
    if (value !== FEE_RECIPIENT) throw new DeploymentError(`${name} must be the owner's Nano S Plus recorded in config/mainnet-release-per-contract.json (${FEE_RECIPIENT}).`);
  }
  const platformFeeBps = feeBps(env.RELEASE_PLATFORM_FEE_BPS, "RELEASE_PLATFORM_FEE_BPS");
  const marketplaceFeeBps = feeBps(env.RELEASE_MARKETPLACE_FEE_BPS, "RELEASE_MARKETPLACE_FEE_BPS");

  const nonceText = text(env.EXPECTED_DEPLOYER_NONCE);
  if (nonceText && !/^\d+$/.test(nonceText)) throw new DeploymentError("EXPECTED_DEPLOYER_NONCE must be a non-negative integer.");
  return Object.freeze({
    network: "mainnet", rpcUrl, deployerAddress,
    expectedNonce: nonceText ? Number(nonceText) : null, platformRecipient, marketplaceFeeRecipient,
    platformFeeBps, marketplaceFeeBps,
  });
}

/** The non-secret inputs that reproduce a plan, recorded in it so the signing tool can re-plan. */
export function planInputs(config) {
  return {
    DEPLOY_NETWORK: "mainnet",
    EXPECTED_DEPLOYER_ADDRESS: config.deployerAddress,
    EXPECTED_DEPLOYER_NONCE: config.expectedNonce === null ? "" : String(config.expectedNonce),
    RELEASE_PLATFORM_RECIPIENT: config.platformRecipient || "",
    RELEASE_MARKETPLACE_FEE_RECIPIENT: config.marketplaceFeeRecipient || "",
    RELEASE_PLATFORM_FEE_BPS: String(config.platformFeeBps),
    RELEASE_MARKETPLACE_FEE_BPS: String(config.marketplaceFeeBps),
  };
}

async function loadArtifact(relativePath) {
  const artifact = JSON.parse(await readFile(resolve(ROOT, relativePath), "utf8"));
  if (!artifact.abi || !artifact.bytecode?.object || artifact.bytecode.object === "0x") throw new DeploymentError(`Artifact is missing ABI or bytecode: ${relativePath}`);
  return artifact;
}

const PENDING = "<physically verified Nano S Plus address>";

/** Read-only plan: chain, deployer state, constructor arguments, predicted addresses, gas and funding. */
export async function buildDryRunPlan(config, provider, { load = loadArtifact } = {}) {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(MAINNET_CHAIN_ID)) throw new DeploymentError(`Refusing chain ${network.chainId}. Expected Avalanche C-Chain ${MAINNET_CHAIN_ID}.`);
  const [factoryArtifact, marketplaceArtifact, implementationArtifact] = await Promise.all([load(FACTORY_ARTIFACT_PATH), load(MARKETPLACE_ARTIFACT_PATH), load(IMPLEMENTATION_ARTIFACT_PATH)]);
  const missingAlbum = missingAlbumSelectors(implementationArtifact.deployedBytecode?.object);
  const missingRoyaltyLock = [
    ...missingSelectors(implementationArtifact.deployedBytecode?.object, IMPLEMENTATION_ROYALTY_SIGNATURES).map((signature) => `implementation ${signature}`),
    ...missingSelectors(marketplaceArtifact.deployedBytecode?.object, MARKETPLACE_ROYALTY_SIGNATURES).map((signature) => `marketplace ${signature}`),
  ];
  const deployer = config.deployerAddress;
  const [nonce, pendingNonce, balance, deployerCode, feeData] = await Promise.all([
    provider.getTransactionCount(deployer, "latest"), provider.getTransactionCount(deployer, "pending"),
    provider.getBalance(deployer), provider.getCode(deployer), provider.getFeeData(),
  ]);
  const factoryAddress = getCreateAddress({ from: deployer, nonce });
  // The factory's constructor creates the implementation as its own first CREATE (contract nonce 1).
  const implementationAddress = getCreateAddress({ from: factoryAddress, nonce: 1 });
  const marketplaceAddress = getCreateAddress({ from: deployer, nonce: nonce + 1 });
  const [factoryCode, implementationCode, marketplaceCode] = await Promise.all([factoryAddress, implementationAddress, marketplaceAddress].map((target) => provider.getCode(target)));

  const coder = AbiCoder.defaultAbiCoder();
  const recipientForGas = config.platformRecipient || deployer;
  const factoryArgs = [recipientForGas];
  const marketplaceArgs = [config.marketplaceFeeRecipient || deployer, config.marketplaceFeeBps, factoryAddress];
  const factoryData = new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object).interface.encodeDeploy(factoryArgs);
  const marketplaceData = new ContractFactory(marketplaceArtifact.abi, marketplaceArtifact.bytecode.object).interface.encodeDeploy(marketplaceArgs);
  const factoryCreation = factoryArtifact.bytecode.object + factoryData.slice(2);
  const marketplaceCreation = marketplaceArtifact.bytecode.object + marketplaceData.slice(2);
  const [factoryGas, marketplaceGas] = await Promise.all([
    provider.estimateGas({ from: deployer, data: factoryCreation }),
    provider.estimateGas({ from: deployer, data: marketplaceCreation }),
  ]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const estimatedCost = (factoryGas + marketplaceGas) * gasPrice;
  const requiredBalance = (estimatedCost * FUNDING_HEADROOM_PERCENT) / 100n;

  const recipientChecks = [];
  for (const [name, value] of [["platformRecipient", config.platformRecipient], ["marketplaceFeeRecipient", config.marketplaceFeeRecipient]]) {
    if (!value) { recipientChecks.push({ name, status: "BLOCKED", reason: "Not provided: awaiting the physically verified Nano S Plus address." }); continue; }
    const code = await provider.getCode(value);
    recipientChecks.push(code === "0x"
      ? { name, address: value, status: "UNVERIFIED", reason: "Externally owned account on C-Chain; receives fees passively and never signs a deployment. The owner confirms it on the device screen (view only; the device signs nothing) before signing the deployment." }
      : { name, address: value, status: "BLOCKED", reason: "Has contract code on C-Chain; a hardware-wallet recipient must be an EOA." });
  }

  const checks = [
    { check: "chainId", status: "PASS", value: Number(network.chainId) },
    { check: "deployer is the defined mainnet deployer", status: deployer === getAddress(mainnetManifest.deployerAddress) ? "PASS" : "FAIL", value: deployer },
    { check: "deployer is an EOA", status: deployerCode === "0x" ? "PASS" : "FAIL" },
    { check: "no pending deployer transactions", status: pendingNonce === nonce ? "PASS" : "FAIL", value: { nonce, pendingNonce } },
    { check: "nonce matches EXPECTED_DEPLOYER_NONCE", status: config.expectedNonce === null ? "NOT PROVIDED" : config.expectedNonce === nonce ? "PASS" : "FAIL", value: config.expectedNonce },
    { check: "predicted addresses are empty", status: [factoryCode, implementationCode, marketplaceCode].every((code) => code === "0x") ? "PASS" : "FAIL" },
    { check: "implementation artifact is album-capable", status: missingAlbum.length ? "FAIL" : "PASS", value: missingAlbum },
    { check: "artifacts enforce the 2.5% artist royalty on chain", status: missingRoyaltyLock.length ? "FAIL" : "PASS", value: missingRoyaltyLock },
    { check: "deployer funded with 50% headroom", status: balance >= requiredBalance ? "PASS" : "FAIL", value: { balanceAvax: formatEther(balance), requiredAvax: formatEther(requiredBalance) } },
    ...recipientChecks.map((item) => ({ check: `${item.name} verified`, status: item.status, value: item.address || null, reason: item.reason })),
  ];

  return {
    mode: "DRY_RUN",
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    deployer: { address: deployer, nonce, pendingNonce, balanceWei: balance.toString(), balanceAvax: formatEther(balance) },
    artifacts: {
      factory: { path: FACTORY_ARTIFACT_PATH, initCodeHash: keccak256(factoryArtifact.bytecode.object) },
      implementation: { path: IMPLEMENTATION_ARTIFACT_PATH, runtimeCodeHash: keccak256(implementationArtifact.deployedBytecode.object), albumCapable: missingAlbum.length === 0 },
      marketplace: { path: MARKETPLACE_ARTIFACT_PATH, initCodeHash: keccak256(marketplaceArtifact.bytecode.object) },
    },
    transactions: [
      { step: 1, nonce, contract: "VoidReleaseFactoryV2Royalty", constructor: { platformRecipient: config.platformRecipient || PENDING }, sealedInBytecode: { PLATFORM_FEE_BPS: FEE_BPS, RELEASE_VERSION: 2, REQUIRED_ROYALTY_BPS: ROYALTY_BPS }, implementation: "VoidRelease1155V4Royalty (royalty locked to 250 bps to an artist wallet of the release; platformFeeRecipient forbidden)", predictedAddress: factoryAddress, predictedImplementation: implementationAddress, estimatedGas: factoryGas.toString() },
      { step: 2, nonce: nonce + 1, contract: "ReleaseMarketplaceV4", sealedInBytecode: { REQUIRED_PLATFORM_FEE_BPS: FEE_BPS, REQUIRED_ROYALTY_BPS: ROYALTY_BPS }, constructor: { feeRecipient: config.marketplaceFeeRecipient || PENDING, platformFeeBps: config.marketplaceFeeBps, releaseFactory: factoryAddress }, predictedAddress: marketplaceAddress, estimatedGas: marketplaceGas.toString() },
    ],
    constructorArgsEncoded: config.platformRecipient ? {
      factory: coder.encode(["address"], [config.platformRecipient]),
      marketplace: coder.encode(["address", "uint256", "address"], [config.marketplaceFeeRecipient, config.marketplaceFeeBps, factoryAddress]),
    } : null,
    gas: { maxFeePerGasWei: gasPrice.toString(), estimatedCostAvax: formatEther(estimatedCost), requiredWithHeadroomAvax: formatEther(requiredBalance), note: config.platformRecipient ? null : "Estimated with the deployer standing in for the pending recipient; the address does not change the gas cost." },
    checks,
    // The exact unsigned transactions the owner signs in Rabby, in order. Present only once the
    // recipient is named, because the recipient is part of the creation data.
    signingRequests: config.platformRecipient ? [
      creationRequest({ step: 1, contract: "VoidReleaseFactoryV2Royalty", from: deployer, nonce, data: factoryCreation, estimatedGas: factoryGas, predictedAddress: factoryAddress }),
      creationRequest({ step: 2, contract: "ReleaseMarketplaceV4", from: deployer, nonce: nonce + 1, data: marketplaceCreation, estimatedGas: marketplaceGas, predictedAddress: marketplaceAddress }),
    ] : null,
    planInputs: planInputs(config),
    // "Ready to sign": every check passes (the recipient's device confirmation is taken by the signing tool).
    readyToBroadcast: checks.every((item) => item.status === "PASS" || (item.check.endsWith("verified") && item.status === "UNVERIFIED")) && config.expectedNonce !== null && Boolean(config.platformRecipient),
    broadcasted: false,
  };
}

export function deploymentRecordPath(factoryAddress) {
  return `deployments/release-per-contract-mainnet-${getAddress(factoryAddress)}.json`;
}

/**
 * Verifies one owner-signed step from chain: the creation transaction against its reviewed request,
 * then the mined contract's immutables against the plan. Step 1 is the factory (and the
 * implementation it creates), step 2 the marketplace bound to that factory.
 */
export async function verifyReleaseStep(provider, plan, stepNumber, hash, { load = loadArtifact, timeoutMs } = {}) {
  const request = plan.signingRequests?.find((item) => item.step === stepNumber);
  if (!request) throw new DeploymentError(`The plan has no signing request for step ${stepNumber}.`);
  const mined = await verifyCreationTransaction(provider, request, hash, { timeoutMs });
  const recipient = getAddress(plan.transactions[0].constructor.platformRecipient);
  const marketplaceStep = plan.transactions[1];
  if (stepNumber === 1) {
    const [factoryArtifact, implementationArtifact] = await Promise.all([load(FACTORY_ARTIFACT_PATH), load(IMPLEMENTATION_ARTIFACT_PATH)]);
    const factory = new Contract(mined.address, factoryArtifact.abi, provider);
    const implementationAddress = getAddress(await factory.implementation());
    const [onChainRecipient, onChainFee, onChainVersion, factoryRoyalty] = await Promise.all([factory.platformRecipient(), factory.PLATFORM_FEE_BPS(), factory.RELEASE_VERSION(), factory.REQUIRED_ROYALTY_BPS()]);
    const implementationViews = new Contract(implementationAddress, ROYALTY_VIEWS, provider);
    const [implementationRoyalty, implementationForbidden, implementationCode] = await Promise.all([implementationViews.REQUIRED_ROYALTY_BPS(), implementationViews.platformFeeRecipient(), provider.getCode(implementationAddress)]);
    const problems = [];
    if (implementationAddress !== getAddress(plan.transactions[0].predictedImplementation)) problems.push(`implementation ${implementationAddress}`);
    if (keccak256(implementationArtifact.deployedBytecode.object) !== plan.artifacts.implementation.runtimeCodeHash) problems.push("the local implementation artifact is not the reviewed one");
    if (!runtimeMatchesArtifact(implementationCode, implementationArtifact)) problems.push("implementation runtime code differs from the reviewed artifact");
    if (!runtimeMatchesArtifact(await provider.getCode(mined.address), factoryArtifact)) problems.push("factory runtime code differs from the reviewed artifact");
    if (getAddress(onChainRecipient) !== recipient) problems.push(`platformRecipient ${onChainRecipient}`);
    if (Number(onChainFee) !== FEE_BPS) problems.push(`PLATFORM_FEE_BPS ${onChainFee}`);
    if (Number(onChainVersion) !== 2) problems.push(`RELEASE_VERSION ${onChainVersion}`);
    if (Number(factoryRoyalty) !== ROYALTY_BPS || Number(implementationRoyalty) !== ROYALTY_BPS) problems.push("royalty lock");
    if (getAddress(implementationForbidden) !== recipient) problems.push(`implementation platformFeeRecipient ${implementationForbidden}`);
    const missingOnChain = missingAlbumSelectors(implementationCode);
    if (missingOnChain.length) problems.push(`implementation missing ${missingOnChain.join(", ")}`);
    if (problems.length) throw new DeploymentError(`The mined factory does not match the reviewed configuration: ${problems.join("; ")}. Do not sign the marketplace.`);
    return { ...mined, implementationAddress, platformRecipient: recipient, platformFeeBps: FEE_BPS, releaseVersion: 2, requiredRoyaltyBps: ROYALTY_BPS };
  }
  if (stepNumber === 2) {
    const marketplaceArtifact = await load(MARKETPLACE_ARTIFACT_PATH);
    const marketplace = new Contract(mined.address, marketplaceArtifact.abi, provider);
    const [registry, feeRecipient, platformFeeBps, deploymentChainId, marketplaceRoyalty] = await Promise.all([marketplace.registry(), marketplace.feeRecipient(), marketplace.platformFeeBps(), marketplace.deploymentChainId(), marketplace.REQUIRED_ROYALTY_BPS()]);
    const problems = [];
    if (!runtimeMatchesArtifact(await provider.getCode(mined.address), marketplaceArtifact)) problems.push("marketplace runtime code differs from the reviewed artifact");
    if (getAddress(registry) !== getAddress(marketplaceStep.constructor.releaseFactory)) problems.push(`registry ${registry}`);
    if (getAddress(feeRecipient) !== getAddress(marketplaceStep.constructor.feeRecipient)) problems.push(`feeRecipient ${feeRecipient}`);
    if (Number(platformFeeBps) !== FEE_BPS) problems.push(`platformFeeBps ${platformFeeBps}`);
    if (Number(deploymentChainId) !== MAINNET_CHAIN_ID) problems.push(`deploymentChainId ${deploymentChainId}`);
    if (Number(marketplaceRoyalty) !== ROYALTY_BPS) problems.push(`REQUIRED_ROYALTY_BPS ${marketplaceRoyalty}`);
    if (problems.length) throw new DeploymentError(`The mined marketplace does not match the reviewed configuration: ${problems.join("; ")}.`);
    return { ...mined, factoryAddress: getAddress(registry), feeRecipient: getAddress(feeRecipient), feeBps: FEE_BPS, requiredRoyaltyBps: ROYALTY_BPS };
  }
  throw new DeploymentError(`Unknown step ${stepNumber}.`);
}

/** The committed deployment record, built only from two verified steps. */
export function buildDeploymentRecord(plan, [factory, marketplace], { sourceCommit = null, planDigest = null } = {}) {
  return {
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    architecture: "release-per-contract",
    signedBy: { deployer: plan.deployer.address, method: "owner-signed in Rabby; no private key left the wallet" },
    plan: { sourceCommit, digest: planDigest },
    factory: { address: factory.address, deploymentTransaction: factory.transaction, deploymentBlock: factory.block, implementationAddress: factory.implementationAddress, implementation: "VoidRelease1155V4Royalty", implementationVersion: 2, implementationAlbumCapable: true, requiredRoyaltyBps: ROYALTY_BPS, contract: "VoidReleaseFactoryV2Royalty", sourceCommit, platformRecipient: factory.platformRecipient, platformFeeBps: FEE_BPS },
    marketplace: { address: marketplace.address, deploymentTransaction: marketplace.transaction, deploymentBlock: marketplace.block, chainId: MAINNET_CHAIN_ID, factoryAddress: marketplace.factoryAddress, feeRecipient: marketplace.feeRecipient, feeBps: marketplace.feeBps, requiredRoyaltyBps: ROYALTY_BPS, contract: "ReleaseMarketplaceV4" },
  };
}

export async function writeRecordFile(relativePath, record) {
  const recordPath = resolve(ROOT, relativePath);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateDeploymentEnv(env);
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, MAINNET_CHAIN_ID, { staticNetwork: true });
  const plan = await (dependencies.buildDryRunPlan || buildDryRunPlan)(config, provider);
  console.log(JSON.stringify(plan, null, 2));
  // The plan binding (scripts/deployment-plan-binding.mjs) ties the owner's signing session to this exact plan.
  if (text(env.PLAN_OUTPUT_PATH)) await writeFile(resolve(text(env.PLAN_OUTPUT_PATH)), `${JSON.stringify(plan, null, 2)}\n`);
  console.log("No transaction was signed or broadcast. The owner signs the planned transactions in Rabby: npm run sign:mainnet.");
  return plan;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Mainnet deployment preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
