import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import fujiV2 from "../config/fuji-release-per-contract-v2.json" with { type: "json" };

export const FUJI_CHAIN_ID = 43113;
export const DEPLOYMENT_RECORD_PATH = "deployments/release-per-contract-fuji.json";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY_ARTIFACT_PATH = "out/VoidReleaseFactoryV2.sol/VoidReleaseFactoryV2.json";
const MARKETPLACE_ARTIFACT_PATH = "out/ReleaseMarketplaceV3.sol/ReleaseMarketplaceV3.json";
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export class DeploymentError extends Error {}

function required(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new DeploymentError(`${name} is required.`);
  return text;
}

function address(value, name) {
  const text = required(value, name);
  if (!isAddress(text) || getAddress(text) === "0x0000000000000000000000000000000000000000") {
    throw new DeploymentError(`${name} must be a non-zero EVM address.`);
  }
  return getAddress(text);
}

function feeBps(value) {
  const text = required(value ?? fujiV2.marketplaceFeeBps, "RELEASE_PLATFORM_FEE_BPS");
  if (!/^\d+$/.test(text)) throw new DeploymentError("RELEASE_PLATFORM_FEE_BPS must be an integer from 0 to 10000.");
  const parsed = Number(text);
  if (parsed !== 250) throw new DeploymentError("RELEASE_PLATFORM_FEE_BPS must be exactly 250 (2.5%) for the locked release economics.");
  return parsed;
}

function privateKey(value) {
  const text = required(value, "DEPLOYER_PRIVATE_KEY");
  if (!PRIVATE_KEY_PATTERN.test(text)) throw new DeploymentError("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key.");
  return text;
}

export function validateDeploymentEnv(env = process.env) {
  const network = String(env.DEPLOY_NETWORK || "").trim().toLowerCase();
  if (network !== "fuji") throw new DeploymentError('DEPLOY_NETWORK must be exactly "fuji". C-Chain and all other networks are refused.');
  const rpcUrl = required(env.AVALANCHE_FUJI_RPC_URL, "AVALANCHE_FUJI_RPC_URL");
  if (!/^https?:\/\//i.test(rpcUrl) || /@/.test(rpcUrl)) throw new DeploymentError("AVALANCHE_FUJI_RPC_URL must be an HTTP(S) URL without embedded credentials.");
  const deployerPrivateKey = privateKey(env.DEPLOYER_PRIVATE_KEY);
  const platformRecipient = address(env.RELEASE_PLATFORM_RECIPIENT || fujiV2.platformRecipient, "RELEASE_PLATFORM_RECIPIENT");
  const marketplaceFeeRecipient = address(env.RELEASE_MARKETPLACE_FEE_RECIPIENT || fujiV2.marketplaceFeeRecipient, "RELEASE_MARKETPLACE_FEE_RECIPIENT");
  if (platformRecipient !== getAddress(fujiV2.platformRecipient) || marketplaceFeeRecipient !== getAddress(fujiV2.marketplaceFeeRecipient)) throw new DeploymentError("Fuji fees must continue going to the read-verified existing permanent treasury address.");
  const platformFeeBps = feeBps(env.RELEASE_PLATFORM_FEE_BPS);
  const confirmFuji = String(env.CONFIRM_FUJI_DEPLOY || "").trim();
  const broadcast = String(env.BROADCAST_DEPLOYMENT || "").trim().toLowerCase() === "yes";
  if (broadcast && confirmFuji !== "yes") throw new DeploymentError("Broadcast requires CONFIRM_FUJI_DEPLOY=yes.");
  return Object.freeze({ network, rpcUrl, deployerPrivateKey, platformRecipient, marketplaceFeeRecipient, platformFeeBps, confirmFuji, broadcast });
}

export function buildDryRunPlan(config) {
  return Object.freeze({
    network: "fuji",
    chainId: FUJI_CHAIN_ID,
    factory: {
      artifact: FACTORY_ARTIFACT_PATH,
      constructor: {
        platformRecipient: config.platformRecipient,
      },
      note: "VoidReleaseFactoryV2 internally deploys VoidRelease1155V4; artists call it directly and pay gas. Primary sale commission is locked to 250 bps in bytecode. No separate V4 deployment is planned.",
    },
    marketplace: {
      artifact: MARKETPLACE_ARTIFACT_PATH,
      constructor: {
        feeRecipient: config.marketplaceFeeRecipient,
        platformFeeBps: config.platformFeeBps,
        releaseFactory: "<factory address produced by the preceding broadcast>",
      },
    },
    postDeployment: {
      record: DEPLOYMENT_RECORD_PATH,
      indexer: "Configure RELEASE_FACTORY and MARKETPLACE entries only with actual mined addresses and deployment blocks.",
      database: "Apply migrations 001-035 to the disposable/staging database before E2E; this workflow does not provision or modify a database.",
    },
  });
}

async function loadArtifact(relativePath) {
  const artifact = JSON.parse(await readFile(resolve(ROOT, relativePath), "utf8"));
  if (!artifact.abi || !artifact.bytecode?.object || artifact.bytecode.object === "0x") throw new DeploymentError(`Artifact is missing ABI or bytecode: ${relativePath}`);
  return artifact;
}

function printPlan(plan) {
  console.log(JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2));
  console.log("No transaction was broadcast. Set BROADCAST_DEPLOYMENT=yes and CONFIRM_FUJI_DEPLOY=yes for a future controlled broadcast.");
}

async function broadcastDeployment(config, provider) {
  const wallet = new Wallet(config.deployerPrivateKey, provider);
  const factoryArtifact = await loadArtifact(FACTORY_ARTIFACT_PATH);
  const marketplaceArtifact = await loadArtifact(MARKETPLACE_ARTIFACT_PATH);
  const factory = await new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object, wallet).deploy(config.platformRecipient);
  const factoryReceipt = await factory.deploymentTransaction().wait();
  const factoryAddress = getAddress(await factory.getAddress());
  const implementationAddress = getAddress(await factory.implementation());
  const marketplace = await new ContractFactory(marketplaceArtifact.abi, marketplaceArtifact.bytecode.object, wallet).deploy(config.marketplaceFeeRecipient, config.platformFeeBps, factoryAddress);
  const marketplaceReceipt = await marketplace.deploymentTransaction().wait();
  const marketplaceAddress = getAddress(await marketplace.getAddress());
  const registryAddress = getAddress(await marketplace.registry());
  if (registryAddress !== factoryAddress) throw new DeploymentError("ReleaseMarketplaceV3 registry does not match the deployed factory.");
  const record = {
    network: "fuji",
    chainId: FUJI_CHAIN_ID,
    architecture: "release-per-contract",
    factory: {
      address: factoryAddress,
      deploymentTransaction: factoryReceipt.hash,
      deploymentBlock: factoryReceipt.blockNumber,
      implementationAddress,
      implementationVersion: 2,
      platformRecipient: config.platformRecipient,
      platformFeeBps: config.platformFeeBps,
    },
    marketplace: {
      address: marketplaceAddress,
      deploymentTransaction: marketplaceReceipt.hash,
      deploymentBlock: marketplaceReceipt.blockNumber,
      chainId: FUJI_CHAIN_ID,
      factoryAddress,
      feeRecipient: config.marketplaceFeeRecipient,
      feeBps: config.platformFeeBps,
    },
  };
  const recordPath = resolve(ROOT, DEPLOYMENT_RECORD_PATH);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return record;
}

export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const config = validateDeploymentEnv(env);
  const provider = dependencies.provider || new JsonRpcProvider(config.rpcUrl, FUJI_CHAIN_ID, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(FUJI_CHAIN_ID)) throw new DeploymentError(`Refusing non-Fuji chain: ${network.chainId}. Expected ${FUJI_CHAIN_ID}.`);
  const plan = buildDryRunPlan(config);
  if (!config.broadcast) {
    printPlan(plan);
    return { mode: "DRY_RUN", plan };
  }
  if (argv.includes("--dry-run")) throw new DeploymentError("--dry-run cannot be combined with BROADCAST_DEPLOYMENT=yes.");
  const record = await (dependencies.broadcastDeployment || broadcastDeployment)(config, provider);
  console.log(JSON.stringify({ mode: "BROADCAST_COMPLETE", record }, null, 2));
  return { mode: "BROADCAST_COMPLETE", record };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(`Deployment preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
