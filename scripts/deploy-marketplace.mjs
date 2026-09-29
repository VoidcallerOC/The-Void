import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonRpcProvider } from "ethers";
import { extractForgeJson } from "./deploy-marketplace-output.mjs";

const execFileAsync = promisify(execFile);
const networks = Object.freeze({
  fuji: { chainId: 43113, rpcEnv: "AVALANCHE_FUJI_RPC_URL" },
  mainnet: { chainId: 43114, rpcEnv: "AVALANCHE_CCHAIN_RPC_URL" },
});
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const BYTECODE_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;

export class DeploymentError extends Error {}

export function resolveMarketplaceConfig(env = process.env) {
  const network = env.DEPLOY_NETWORK || "fuji";
  const target = networks[network];
  if (!target) throw new DeploymentError("Unsupported deployment network. Use fuji or mainnet.");

  const rpcUrl = env[target.rpcEnv];
  const keystorePath = env.DEPLOYER_KEYSTORE_PATH;
  const passwordFilePath = env.DEPLOYER_KEYSTORE_PASSWORD_FILE;
  const feeRecipient = env.MARKETPLACE_FEE_RECIPIENT;
  const feeBpsText = env.MARKETPLACE_FEE_BPS;
  const feeBps = Number(feeBpsText);

  if (
    typeof rpcUrl !== "string" || rpcUrl.length === 0 ||
    typeof keystorePath !== "string" || !isAbsolute(keystorePath) ||
    typeof passwordFilePath !== "string" || !isAbsolute(passwordFilePath) ||
    !ADDRESS_PATTERN.test(feeRecipient || "") ||
    !/^\d+$/.test(feeBpsText || "") || !Number.isSafeInteger(feeBps) || feeBps > 10000
  ) {
    throw new DeploymentError(
      `Missing or invalid deployment configuration. Required: ${target.rpcEnv}, DEPLOYER_KEYSTORE_PATH, DEPLOYER_KEYSTORE_PASSWORD_FILE, MARKETPLACE_FEE_RECIPIENT, MARKETPLACE_FEE_BPS (0-10000).`,
    );
  }

  if (network === "mainnet" && env.CONFIRM_MAINNET_DEPLOY !== "yes") {
    throw new DeploymentError("Mainnet deployment requires CONFIRM_MAINNET_DEPLOY=yes.");
  }

  return {
    network,
    chainId: target.chainId,
    rpcUrl,
    keystorePath,
    passwordFilePath,
    feeRecipient,
    feeBps,
    feeBpsText,
    bytecodePath: env.MARKETPLACE_BYTECODE_PATH || "out/MusicMarketplace.sol/MusicMarketplace.json",
  };
}

export function buildForgeCreateArgs(config) {
  return [
    "create",
    "contracts/MusicMarketplace.sol:MusicMarketplace",
    "--chain",
    String(config.chainId),
    "--keystore",
    config.keystorePath,
    "--password-file",
    config.passwordFilePath,
    "--constructor-args",
    config.feeRecipient,
    config.feeBpsText,
    "--broadcast",
    "--json",
  ];
}

export function buildForgeEnvironment(env, rpcUrl) {
  const forgeEnv = { ...env, ETH_RPC_URL: rpcUrl };
  // Never forward raw or inline signer passwords to the Forge child process.
  for (const key of ["DEPLOYER_PRIVATE_KEY", "ETH_PASSWORD", "DEPLOYER_KEYSTORE_PASSWORD"]) {
    delete forgeEnv[key];
  }
  return forgeEnv;
}

export async function runForgeCreate(execute = execFileAsync, config, env = process.env) {
  const args = buildForgeCreateArgs(config);
  const childEnv = buildForgeEnvironment(env, config.rpcUrl);
  let stdout;
  try {
    ({ stdout } = await execute("forge", args, {
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    throw new DeploymentError("Forge create failed; sensitive process output was suppressed.");
  }

  try {
    return extractForgeJson(stdout);
  } catch {
    throw new DeploymentError("Forge did not return a valid deployment result.");
  }
}

export function verifyForgeDeployment(result, receipt) {
  const transactionHash = result?.transactionHash || result?.txHash;
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash || "")) {
    throw new DeploymentError("Deployment output did not include a valid transaction hash.");
  }

  if (
    !receipt || receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0
  ) {
    throw new DeploymentError("A successful mined transaction receipt with a deployment block was not available.");
  }

  if (
    receipt.transactionHash &&
    (!TRANSACTION_HASH_PATTERN.test(receipt.transactionHash) ||
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase())
  ) {
    throw new DeploymentError("The mined receipt did not match the Forge transaction hash.");
  }

  const contractAddress = result?.deployedTo || result?.contractAddress || receipt.contractAddress;
  if (!ADDRESS_PATTERN.test(contractAddress || "")) {
    throw new DeploymentError("Deployment output did not include a valid contract address.");
  }

  return {
    transactionHash: transactionHash.toLowerCase(),
    contractAddress: contractAddress.toLowerCase(),
    deploymentBlock: receipt.blockNumber,
  };
}

export function hashDeploymentBytecode(bytecode) {
  if (typeof bytecode !== "string") {
    throw new DeploymentError("Deployment bytecode artifact did not contain valid bytecode.");
  }
  const normalizedBytecode = bytecode.replace(/^0x/i, "");
  if (!BYTECODE_PATTERN.test(normalizedBytecode)) {
    throw new DeploymentError("Deployment bytecode artifact did not contain valid bytecode.");
  }
  const bytecodeHash = `0x${createHash("sha256").update(Buffer.from(normalizedBytecode, "hex")).digest("hex")}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(bytecodeHash)) {
    throw new DeploymentError("Could not compute a valid deployment bytecode hash.");
  }
  return bytecodeHash;
}

async function assertReadableSignerFiles(config) {
  try {
    await access(config.keystorePath, fsConstants.R_OK);
    await access(config.passwordFilePath, fsConstants.R_OK);
  } catch {
    throw new DeploymentError("The configured signer keystore and password files must be readable.");
  }
}

export async function runMarketplaceDeployment({
  env = process.env,
  cwd = process.cwd(),
  execute = execFileAsync,
  Provider = JsonRpcProvider,
} = {}) {
  const config = resolveMarketplaceConfig(env);
  await assertReadableSignerFiles(config);

  const forgeResult = await runForgeCreate(execute, config, env);
  const rawTransactionHash = forgeResult.transactionHash || forgeResult.txHash;
  if (!TRANSACTION_HASH_PATTERN.test(rawTransactionHash || "")) {
    throw new DeploymentError("Deployment output did not include a valid transaction hash.");
  }

  let receipt;
  try {
    const provider = new Provider(config.rpcUrl, config.chainId, { staticNetwork: true });
    receipt = await provider.waitForTransaction(rawTransactionHash, 1, 60_000);
  } catch {
    throw new DeploymentError("Could not verify a mined deployment receipt.");
  }
  const verified = verifyForgeDeployment(forgeResult, receipt);

  const artifactPath = isAbsolute(config.bytecodePath)
    ? config.bytecodePath
    : resolve(cwd, config.bytecodePath);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch {
    throw new DeploymentError("The deployment bytecode artifact could not be read.");
  }
  const bytecodeHash = hashDeploymentBytecode(artifact?.bytecode?.object);
  const record = {
    network: config.network,
    chainId: config.chainId,
    contractAddress: verified.contractAddress,
    deploymentTransaction: verified.transactionHash,
    deploymentBlock: verified.deploymentBlock,
    bytecodeHash,
    sourceVerificationStatus: "NOT_REQUESTED",
    feeRecipient: config.feeRecipient.toLowerCase(),
    feeBasisPoints: config.feeBps,
    supportedTokenContracts: [],
    recordedAt: new Date().toISOString(),
  };

  try {
    const deploymentDirectory = resolve(cwd, "deployments");
    await mkdir(deploymentDirectory, { recursive: true });
    await writeFile(
      resolve(deploymentDirectory, `marketplace-${config.network}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch {
    throw new DeploymentError("Deployment metadata could not be written.");
  }

  return record;
}

const invokedScriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedScriptPath && pathToFileURL(invokedScriptPath).href === import.meta.url) {
  runMarketplaceDeployment()
    .then((record) => {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    })
    .catch((error) => {
      const message = error instanceof DeploymentError
        ? error.message
        : "Marketplace deployment failed; sensitive details were suppressed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
