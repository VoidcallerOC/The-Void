import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, id, isAddress } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

// VoidReleaseFactoryV3 + its ReleaseMarketplaceV3. Each V3 clone (VoidRelease1155V5) records the
// edition's provenance root in the edition-creating transaction. This script never touches Factory V2,
// its clones or its marketplaces, and never edits config/: activating V3 is a separate, owner-authorized
// manifest change printed in the record below. The default path is a dry run.
export const NETWORKS = Object.freeze({
  fuji: Object.freeze({ chainId: 43113, rpcEnv: "AVALANCHE_FUJI_RPC_URL", confirmEnv: "CONFIRM_FUJI_DEPLOY" }),
  mainnet: Object.freeze({ chainId: 43114, rpcEnv: "AVALANCHE_MAINNET_RPC_URL", confirmEnv: "CONFIRM_MAINNET_DEPLOY" }),
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FACTORY_ARTIFACT_PATH = "out/VoidReleaseFactoryV3.sol/VoidReleaseFactoryV3.json";
export const MARKETPLACE_ARTIFACT_PATH = "out/ReleaseMarketplaceV3.sol/ReleaseMarketplaceV3.json";
export const IMPLEMENTATION_ARTIFACT_PATH = "out/VoidRelease1155V5.sol/VoidRelease1155V5.json";
export const EXPECTED_RELEASE_VERSION = 3;
export const EXPECTED_IMPLEMENTATION_VERSION = 5;
export const PLATFORM_FEE_BPS = 250;

// The clone implementation must take the provenance root on every edition-creating path and keep
// Album Contract semantics. Checked on the compiled artifact and again on the mined implementation.
export const V5_SIGNATURES = Object.freeze([
  "createEdition(bytes32,bytes32,uint256,string,address,uint96,bytes32)",
  "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64,bytes32)",
  "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64,bytes32)",
  "isAnchored(bytes32,bytes32,bytes32)",
  "provenanceRootOf(uint256)",
  "createAlbum(bytes32)",
  "closeAlbum(bytes32)",
  "albumCreated()",
  "approveExpandedRelease(bytes32,uint256,uint256)",
]);

/** V5 selectors missing from runtime bytecode (Solidity dispatch uses PUSH4 = 0x63). */
export function missingV5Selectors(runtimeBytecode) {
  const code = String(runtimeBytecode || "").toLowerCase();
  return V5_SIGNATURES.filter((signature) => !code.includes(`63${id(signature).slice(2, 10)}`));
}

export function deploymentRecordPath(network, factoryAddress) {
  return `deployments/release-factory-v3-${network}-${getAddress(factoryAddress)}.json`;
}

export class DeploymentError extends Error {}

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new DeploymentError(`${name} is required.`);
  return text;
}

function address(value, name) {
  const text = required(value, name);
  if (!isAddress(text) || getAddress(text) === "0x0000000000000000000000000000000000000000") throw new DeploymentError(`${name} must be a non-zero EVM address.`);
  return getAddress(text);
}

export function validateDeploymentEnv(env = process.env) {
  const network = String(env.DEPLOY_NETWORK || "").trim().toLowerCase();
  const target = NETWORKS[network];
  if (!target) throw new DeploymentError('DEPLOY_NETWORK must be exactly "fuji" or "mainnet".');
  const rpcUrl = required(env[target.rpcEnv], target.rpcEnv);
  if (!/^https?:\/\//i.test(rpcUrl) || /@/.test(rpcUrl)) throw new DeploymentError(`${target.rpcEnv} must be an HTTP(S) URL without embedded credentials.`);
  const deployerPrivateKey = required(env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) throw new DeploymentError("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key.");
  // Fuji keeps the read-verified existing treasury. Mainnet has no default: the owner names it.
  const platformRecipient = address(network === "fuji" ? (env.RELEASE_PLATFORM_RECIPIENT || fujiV2.platformRecipient) : env.RELEASE_PLATFORM_RECIPIENT, "RELEASE_PLATFORM_RECIPIENT");
  const marketplaceFeeRecipient = address(network === "fuji" ? (env.RELEASE_MARKETPLACE_FEE_RECIPIENT || fujiV2.marketplaceFeeRecipient) : env.RELEASE_MARKETPLACE_FEE_RECIPIENT, "RELEASE_MARKETPLACE_FEE_RECIPIENT");
  if (network === "fuji" && (platformRecipient !== getAddress(fujiV2.platformRecipient) || marketplaceFeeRecipient !== getAddress(fujiV2.marketplaceFeeRecipient))) throw new DeploymentError("Fuji fees must continue going to the read-verified existing permanent treasury address.");
  const feeText = String(env.RELEASE_PLATFORM_FEE_BPS ?? PLATFORM_FEE_BPS).trim();
  if (feeText !== String(PLATFORM_FEE_BPS)) throw new DeploymentError("RELEASE_PLATFORM_FEE_BPS must be exactly 250 (2.5%): Factory V3 seals the primary fee at 250 bps in bytecode.");
  const broadcast = String(env.BROADCAST_DEPLOYMENT || "").trim().toLowerCase() === "yes";
  const confirmed = String(env[target.confirmEnv] || "").trim() === "yes";
  if (broadcast && !confirmed) throw new DeploymentError(`Broadcast requires ${target.confirmEnv}=yes.`);
  const deployerAddress = new Wallet(deployerPrivateKey).address;
  const expectedText = String(env.EXPECTED_DEPLOYER_ADDRESS || "").trim();
  if (broadcast && !expectedText) throw new DeploymentError("Broadcast requires EXPECTED_DEPLOYER_ADDRESS, the deployer address the owner reviewed.");
  if (expectedText && address(expectedText, "EXPECTED_DEPLOYER_ADDRESS") !== deployerAddress) throw new DeploymentError("DEPLOYER_PRIVATE_KEY does not belong to EXPECTED_DEPLOYER_ADDRESS.");
  return Object.freeze({ network, chainId: target.chainId, rpcUrl, deployerPrivateKey, deployerAddress, platformRecipient, marketplaceFeeRecipient, platformFeeBps: PLATFORM_FEE_BPS, broadcast });
}

export function buildDryRunPlan(config) {
  return Object.freeze({
    network: config.network,
    chainId: config.chainId,
    deployer: config.deployerAddress,
    factory: {
      artifact: FACTORY_ARTIFACT_PATH,
      constructor: { platformRecipient: config.platformRecipient },
      note: "VoidReleaseFactoryV3 deploys the VoidRelease1155V5 implementation in its constructor. Each release gets a V5 clone (its own provenance anchor) and a VoidPrimarySale with the fee sealed at 250 bps. No owner, operator or platform signer.",
    },
    marketplace: {
      artifact: MARKETPLACE_ARTIFACT_PATH,
      constructor: { feeRecipient: config.marketplaceFeeRecipient, platformFeeBps: config.platformFeeBps, releaseFactory: "<factory address produced by the preceding broadcast>" },
    },
    untouched: "Factory V2 deployments, their clones, sales, anchors and marketplaces are not called or redeployed.",
    postDeployment: {
      record: `deployments/release-factory-v3-${config.network}-<factory address>.json (existing records are never overwritten)`,
      activation: "Not performed here. Switching Studio to Factory V3 is a separate config change that needs explicit owner authorization.",
    },
  });
}

async function loadArtifact(relativePath) {
  const artifact = JSON.parse(await readFile(resolve(ROOT, relativePath), "utf8"));
  if (!artifact.abi || !artifact.bytecode?.object || artifact.bytecode.object === "0x") throw new DeploymentError(`Artifact is missing ABI or bytecode: ${relativePath}`);
  return artifact;
}

export async function assertV5Artifact(load = loadArtifact) {
  const implementation = await load(IMPLEMENTATION_ARTIFACT_PATH);
  const missing = missingV5Selectors(implementation.deployedBytecode?.object);
  if (missing.length) throw new DeploymentError(`Refusing to deploy: compiled VoidRelease1155V5 lacks ${missing.join(", ")}.`);
}

async function deployContract(artifact, args, wallet) {
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, wallet).deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, receipt, address: getAddress(await contract.getAddress()) };
}

async function writeRecordFile(relativePath, record) {
  const recordPath = resolve(ROOT, relativePath);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

/** The manifest entry an owner-authorized activation would add. Printed only; never written. */
export function proposedManifestEntry(record) {
  return {
    factoryAddress: record.factory.address,
    implementationAddress: record.factory.implementationAddress,
    marketplaceAddress: record.marketplace.address,
    factoryDeploymentBlock: record.factory.deploymentBlock,
    marketplaceDeploymentBlock: record.marketplace.deploymentBlock,
    source: "VoidReleaseFactoryV3",
    releaseVersion: record.factory.releaseVersion,
    albumCapable: true,
    provenanceAtCreation: true,
    record: record.recordPath,
  };
}

export async function broadcastDeployment(config, provider, {
  load = loadArtifact,
  deploy = deployContract,
  writeRecord = writeRecordFile,
  log = (value) => console.log(JSON.stringify(value)),
  wallet = new Wallet(config.deployerPrivateKey, provider),
} = {}) {
  await assertV5Artifact(load);
  const factoryArtifact = await load(FACTORY_ARTIFACT_PATH);
  const marketplaceArtifact = await load(MARKETPLACE_ARTIFACT_PATH);
  // Each mined step is logged immediately: a later failure must not lose a deployed address.
  const factory = await deploy(factoryArtifact, [config.platformRecipient], wallet);
  const factoryAddress = getAddress(factory.address);
  const implementationAddress = getAddress(await factory.contract.implementation());
  log({ step: "FACTORY_MINED", factoryAddress, implementationAddress, transaction: factory.receipt.hash, block: factory.receipt.blockNumber });
  const missingOnChain = missingV5Selectors(await provider.getCode(implementationAddress));
  const releaseVersion = Number(await factory.contract.RELEASE_VERSION());
  const feeBps = Number(await factory.contract.PLATFORM_FEE_BPS());
  if (missingOnChain.length || releaseVersion !== EXPECTED_RELEASE_VERSION || feeBps !== PLATFORM_FEE_BPS) {
    log({ step: "FACTORY_NOT_V3", factoryAddress, implementationAddress, missing: missingOnChain, releaseVersion, feeBps });
    throw new DeploymentError(`Deployed factory ${factoryAddress} is not the reviewed Factory V3; the marketplace was not deployed.`);
  }
  const marketplace = await deploy(marketplaceArtifact, [config.marketplaceFeeRecipient, config.platformFeeBps, factoryAddress], wallet);
  const marketplaceAddress = getAddress(marketplace.address);
  log({ step: "MARKETPLACE_MINED", marketplaceAddress, transaction: marketplace.receipt.hash, block: marketplace.receipt.blockNumber });
  if (getAddress(await marketplace.contract.registry()) !== factoryAddress) throw new DeploymentError("ReleaseMarketplaceV3 registry does not match the deployed Factory V3.");
  const recordPath = deploymentRecordPath(config.network, factoryAddress);
  const record = {
    network: config.network,
    chainId: config.chainId,
    architecture: "release-per-contract",
    provenanceAtCreation: true,
    recordPath,
    factory: {
      name: "VoidReleaseFactoryV3",
      address: factoryAddress,
      deploymentTransaction: factory.receipt.hash,
      deploymentBlock: factory.receipt.blockNumber,
      implementationName: "VoidRelease1155V5",
      implementationAddress,
      implementationVersion: EXPECTED_IMPLEMENTATION_VERSION,
      releaseVersion,
      sourceCommit: process.env.GITHUB_SHA || null,
      platformRecipient: config.platformRecipient,
      platformFeeBps: config.platformFeeBps,
    },
    marketplace: {
      address: marketplaceAddress,
      deploymentTransaction: marketplace.receipt.hash,
      deploymentBlock: marketplace.receipt.blockNumber,
      factoryAddress,
      feeRecipient: config.marketplaceFeeRecipient,
      feeBps: config.platformFeeBps,
    },
  };
  log({ step: "RECORD", path: recordPath, record });
  log({ step: "ACTIVATION_NOT_PERFORMED", proposedManifestEntry: proposedManifestEntry(record) });
  try {
    await writeRecord(recordPath, record);
  } catch (error) {
    // The contracts are already mined and the record is in the log above; never fail the run here.
    log({ step: "RECORD_WRITE_FAILED", path: recordPath, error: error.message });
  }
  return record;
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateDeploymentEnv(env);
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) throw new DeploymentError(`Refusing chain ${network.chainId}: DEPLOY_NETWORK=${config.network} expects ${config.chainId}.`);
  await (dependencies.assertV5 || assertV5Artifact)();
  const plan = buildDryRunPlan(config);
  if (!config.broadcast) {
    console.log(JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2));
    console.log("No transaction was broadcast.");
    return { mode: "DRY_RUN", plan };
  }
  if (argv.includes("--dry-run")) throw new DeploymentError("--dry-run cannot be combined with BROADCAST_DEPLOYMENT=yes.");
  const record = await (dependencies.broadcastDeployment || broadcastDeployment)(config, provider);
  console.log(JSON.stringify({ mode: "BROADCAST_COMPLETE", record }, null, 2));
  return { mode: "BROADCAST_COMPLETE", record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Factory V3 deployment preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
