import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AbiCoder, Contract, ContractFactory, Interface, JsonRpcProvider, Wallet, formatEther, getAddress, getCreateAddress, id, isAddress, keccak256 } from "ethers";
import mainnetManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { missingAlbumSelectors } from "./deploy-release-per-contract-fuji.mjs";

// C-Chain deployment of the release-per-contract architecture validated on Fuji, with the artist
// royalty enforced on chain: VoidReleaseFactoryV2Royalty (VoidReleaseFactoryV2 whose constructor
// creates the VoidRelease1155V4Royalty clone implementation: every edition pays exactly 2.5% to an
// artist wallet of its release, never to the fee recipient) followed by ReleaseMarketplaceV4 (V3 that
// independently enforces the same royalty at listing and settlement). Both are ownerless and their fee recipients
// and fee rates are immutable, so the recipient must be the owner's physically verified address.
// The default path is a read-only dry run; nothing is signed or sent without every broadcast gate.
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
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
// The single passive platform fee recipient (the owner's Nano S Plus) is recorded in the mainnet
// manifest; both fees must go to exactly that address. Other roles never double as the recipient.
export const FEE_RECIPIENT = getAddress(mainnetManifest.platformRecipient);
if (getAddress(mainnetManifest.marketplaceFeeRecipient) !== FEE_RECIPIENT) throw new Error("The mainnet manifest must name one platform fee recipient for both fees.");
export const REFUSED_RECIPIENTS = Object.freeze({
  "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a": "the artist wallet; artist and platform fee recipient are separate roles",
  "0xD1B4367dd9f235f9ee61878019d66E31511E98eE": "the Genesis collection contract",
});
// Gas headroom required over the estimate before a broadcast (percent).
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
  const rpcUrl = text(env.AVALANCHE_MAINNET_RPC_URL) || mainnetManifest.rpcUrl;
  if (!/^https:\/\//i.test(rpcUrl) || /@/.test(rpcUrl)) throw new DeploymentError("AVALANCHE_MAINNET_RPC_URL must be an HTTPS URL without embedded credentials.");
  const keyText = text(env.DEPLOYER_PRIVATE_KEY);
  if (keyText && !PRIVATE_KEY_PATTERN.test(keyText)) throw new DeploymentError("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key.");
  const keyAddress = keyText ? new Wallet(keyText).address : null;
  const expectedDeployer = optionalAddress(env.EXPECTED_DEPLOYER_ADDRESS, "EXPECTED_DEPLOYER_ADDRESS");
  if (keyAddress && expectedDeployer && keyAddress !== expectedDeployer) throw new DeploymentError("DEPLOYER_PRIVATE_KEY does not belong to EXPECTED_DEPLOYER_ADDRESS.");
  const deployerAddress = keyAddress || expectedDeployer;
  if (!deployerAddress) throw new DeploymentError("EXPECTED_DEPLOYER_ADDRESS (or DEPLOYER_PRIVATE_KEY) is required to plan the deployment.");

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

  const broadcast = text(env.BROADCAST_DEPLOYMENT).toLowerCase() === "yes";
  const nonceText = text(env.EXPECTED_DEPLOYER_NONCE);
  if (nonceText && !/^\d+$/.test(nonceText)) throw new DeploymentError("EXPECTED_DEPLOYER_NONCE must be a non-negative integer.");
  if (broadcast) {
    if (text(env.CONFIRM_MAINNET_DEPLOY) !== "yes") throw new DeploymentError("Broadcast requires CONFIRM_MAINNET_DEPLOY=yes.");
    if (!keyText) throw new DeploymentError("Broadcast requires DEPLOYER_PRIVATE_KEY.");
    if (!expectedDeployer) throw new DeploymentError("Broadcast requires EXPECTED_DEPLOYER_ADDRESS, the deployer address the owner reviewed.");
    if (!nonceText) throw new DeploymentError("Broadcast requires EXPECTED_DEPLOYER_NONCE, so the reviewed predicted addresses hold.");
    if (!platformRecipient) throw new DeploymentError("Broadcast requires RELEASE_PLATFORM_RECIPIENT, the physically verified Nano S Plus address.");
    // The owner re-types the address read from the device screen; any difference refuses the broadcast.
    if (optionalAddress(env.RECIPIENT_VERIFIED_ON_DEVICE, "RECIPIENT_VERIFIED_ON_DEVICE") !== platformRecipient) {
      throw new DeploymentError("Broadcast requires RECIPIENT_VERIFIED_ON_DEVICE to equal RELEASE_PLATFORM_RECIPIENT exactly, as read from the hardware wallet screen.");
    }
  }
  return Object.freeze({
    network: "mainnet", rpcUrl, deployerPrivateKey: keyText || null, deployerAddress, expectedDeployer,
    expectedNonce: nonceText ? Number(nonceText) : null, platformRecipient, marketplaceFeeRecipient,
    platformFeeBps, marketplaceFeeBps, broadcast,
  });
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
  const [factoryGas, marketplaceGas] = await Promise.all([
    provider.estimateGas({ from: deployer, data: factoryArtifact.bytecode.object + factoryData.slice(2) }),
    provider.estimateGas({ from: deployer, data: marketplaceArtifact.bytecode.object + marketplaceData.slice(2) }),
  ]);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const estimatedCost = (factoryGas + marketplaceGas) * gasPrice;
  const requiredBalance = (estimatedCost * FUNDING_HEADROOM_PERCENT) / 100n;

  const recipientChecks = [];
  for (const [name, value] of [["platformRecipient", config.platformRecipient], ["marketplaceFeeRecipient", config.marketplaceFeeRecipient]]) {
    if (!value) { recipientChecks.push({ name, status: "BLOCKED", reason: "Not provided: awaiting the physically verified Nano S Plus address." }); continue; }
    const code = await provider.getCode(value);
    recipientChecks.push(code === "0x"
      ? { name, address: value, status: "UNVERIFIED", reason: "Externally owned account on C-Chain; receives fees passively and never signs a deployment. Physical device verification is still required before broadcast." }
      : { name, address: value, status: "BLOCKED", reason: "Has contract code on C-Chain; a hardware-wallet recipient must be an EOA." });
  }

  const checks = [
    { check: "chainId", status: "PASS", value: Number(network.chainId) },
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
    readyToBroadcast: checks.every((item) => item.status === "PASS" || (item.check.endsWith("verified") && item.status === "UNVERIFIED")) && config.expectedNonce !== null,
    broadcasted: false,
  };
}

async function deployContract(artifact, args, signer) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  if (!receipt || receipt.status !== 1) throw new DeploymentError("Deployment transaction did not succeed.");
  return { contract, receipt, address: getAddress(await contract.getAddress()) };
}

export function deploymentRecordPath(factoryAddress) {
  return `deployments/release-per-contract-mainnet-${getAddress(factoryAddress)}.json`;
}

async function writeRecordFile(relativePath, record) {
  const recordPath = resolve(ROOT, relativePath);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

/** Broadcasts both deployments and verifies every immutable against the reviewed plan. */
export async function broadcastDeployment(config, provider, plan, {
  load = loadArtifact,
  deploy = deployContract,
  writeRecord = writeRecordFile,
  log = (value) => console.log(JSON.stringify(value)),
  signer = new Wallet(config.deployerPrivateKey, provider),
} = {}) {
  if (!plan.readyToBroadcast) throw new DeploymentError("The dry-run plan is not ready to broadcast. Nothing was sent.");
  const [factoryStep, marketplaceStep] = plan.transactions;
  const factoryArtifact = await load(FACTORY_ARTIFACT_PATH);
  const marketplaceArtifact = await load(MARKETPLACE_ARTIFACT_PATH);
  const factory = await deploy(factoryArtifact, [config.platformRecipient], signer);
  log({ step: "FACTORY_MINED", factoryAddress: factory.address, transaction: factory.receipt.hash, block: factory.receipt.blockNumber });
  if (factory.address !== factoryStep.predictedAddress) throw new DeploymentError(`Factory mined at ${factory.address}, not the reviewed ${factoryStep.predictedAddress}. The marketplace was not deployed.`);
  const implementationAddress = getAddress(await factory.contract.implementation());
  const [onChainRecipient, onChainFee, onChainVersion] = await Promise.all([factory.contract.platformRecipient(), factory.contract.PLATFORM_FEE_BPS(), factory.contract.RELEASE_VERSION()]);
  const missingOnChain = missingAlbumSelectors(await provider.getCode(implementationAddress));
  const implementationViews = new Contract(implementationAddress, ROYALTY_VIEWS, provider);
  const [factoryRoyalty, implementationRoyalty, implementationForbidden] = await Promise.all([factory.contract.REQUIRED_ROYALTY_BPS(), implementationViews.REQUIRED_ROYALTY_BPS(), implementationViews.platformFeeRecipient()]);
  const royaltyLocked = Number(factoryRoyalty) === ROYALTY_BPS && Number(implementationRoyalty) === ROYALTY_BPS && getAddress(implementationForbidden) === config.platformRecipient;
  if (getAddress(onChainRecipient) !== config.platformRecipient || Number(onChainFee) !== FEE_BPS || Number(onChainVersion) !== 2 || missingOnChain.length || !royaltyLocked) {
    log({ step: "FACTORY_STATE_MISMATCH", implementationAddress, onChainRecipient, onChainFee: String(onChainFee), onChainVersion: String(onChainVersion), missingOnChain, royaltyLocked });
    throw new DeploymentError("The mined factory does not match the reviewed configuration. The marketplace was not deployed.");
  }
  const marketplace = await deploy(marketplaceArtifact, [config.marketplaceFeeRecipient, config.marketplaceFeeBps, factory.address], signer);
  log({ step: "MARKETPLACE_MINED", marketplaceAddress: marketplace.address, transaction: marketplace.receipt.hash, block: marketplace.receipt.blockNumber });
  const [registry, feeRecipient, platformFeeBps, deploymentChainId, marketplaceRoyalty] = await Promise.all([marketplace.contract.registry(), marketplace.contract.feeRecipient(), marketplace.contract.platformFeeBps(), marketplace.contract.deploymentChainId(), marketplace.contract.REQUIRED_ROYALTY_BPS()]);
  if (marketplace.address !== marketplaceStep.predictedAddress || getAddress(registry) !== factory.address || getAddress(feeRecipient) !== config.marketplaceFeeRecipient || Number(platformFeeBps) !== config.marketplaceFeeBps || Number(deploymentChainId) !== MAINNET_CHAIN_ID || Number(marketplaceRoyalty) !== ROYALTY_BPS) {
    throw new DeploymentError("The mined marketplace does not match the reviewed configuration. Record the logged addresses before any further action.");
  }
  const record = {
    network: "mainnet",
    chainId: MAINNET_CHAIN_ID,
    architecture: "release-per-contract",
    factory: { address: factory.address, deploymentTransaction: factory.receipt.hash, deploymentBlock: factory.receipt.blockNumber, implementationAddress, implementation: "VoidRelease1155V4Royalty", implementationVersion: 2, implementationAlbumCapable: true, requiredRoyaltyBps: ROYALTY_BPS, contract: "VoidReleaseFactoryV2Royalty", sourceCommit: process.env.GITHUB_SHA || null, platformRecipient: config.platformRecipient, platformFeeBps: FEE_BPS },
    marketplace: { address: marketplace.address, deploymentTransaction: marketplace.receipt.hash, deploymentBlock: marketplace.receipt.blockNumber, chainId: MAINNET_CHAIN_ID, factoryAddress: factory.address, feeRecipient: config.marketplaceFeeRecipient, feeBps: config.marketplaceFeeBps, requiredRoyaltyBps: ROYALTY_BPS, contract: "ReleaseMarketplaceV4" },
  };
  const recordPath = deploymentRecordPath(factory.address);
  log({ step: "RECORD", path: recordPath, record });
  try {
    await writeRecord(recordPath, record);
  } catch (error) {
    log({ step: "RECORD_WRITE_FAILED", path: recordPath, error: error.message });
  }
  return record;
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateDeploymentEnv(env);
  if (config.broadcast && argv.includes("--dry-run")) throw new DeploymentError("--dry-run cannot be combined with BROADCAST_DEPLOYMENT=yes.");
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, MAINNET_CHAIN_ID, { staticNetwork: true });
  const plan = await (dependencies.buildDryRunPlan || buildDryRunPlan)(config, provider);
  console.log(JSON.stringify(plan, null, 2));
  if (!config.broadcast) {
    console.log("No transaction was signed or broadcast.");
    return plan;
  }
  const record = await (dependencies.broadcastDeployment || broadcastDeployment)(config, provider, plan);
  console.log(JSON.stringify({ mode: "BROADCAST_COMPLETE", record }, null, 2));
  return { mode: "BROADCAST_COMPLETE", record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Mainnet deployment preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
