import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonRpcProvider } from "ethers";
import { extractForgeJson } from "./deploy-marketplace-output.mjs";

const MAX_FORGE_OUTPUT_BYTES = 10 * 1024 * 1024;
const networks = Object.freeze({
  fuji: { chainId: 43113, rpcEnv: "AVALANCHE_FUJI_RPC_URL", canonicalTokenEnv: "FUJI_CANONICAL_TOKEN", canonicalToken: "0x82b26Da27136935454Bdf1e40801190B521b82e5" },
  mainnet: { chainId: 43114, rpcEnv: "AVALANCHE_CCHAIN_RPC_URL", canonicalTokenEnv: "CCHAIN_CANONICAL_TOKEN" },
});
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const BYTECODE_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;

export class DeploymentError extends Error {}

export function resolveMarketplaceConfig(env = process.env) {
  const network = env.DEPLOY_NETWORK || "fuji";
  const target = networks[network];
  if (!target) throw new DeploymentError("Unsupported deployment network. Use fuji or mainnet.");

  const rpcUrl = env[target.rpcEnv];
  const feeRecipient = env.MARKETPLACE_FEE_RECIPIENT;
  const feeBpsText = env.MARKETPLACE_FEE_BPS;
  const canonicalToken = env[target.canonicalTokenEnv];
  const feeBps = Number(feeBpsText);

  if (
    typeof rpcUrl !== "string" || rpcUrl.length === 0 ||
    !ADDRESS_PATTERN.test(feeRecipient || "") ||
    !ADDRESS_PATTERN.test(canonicalToken || "") ||
    canonicalToken.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
    !/^\d+$/.test(feeBpsText || "") || !Number.isSafeInteger(feeBps) || feeBps > 10000
  ) {
    throw new DeploymentError(
      `Missing or invalid deployment configuration. Required: ${target.rpcEnv}, ${target.canonicalTokenEnv}, MARKETPLACE_FEE_RECIPIENT, MARKETPLACE_FEE_BPS (0-10000).`,
    );
  }

  if (target.canonicalToken && canonicalToken.toLowerCase() !== target.canonicalToken.toLowerCase()) {
    throw new DeploymentError(`Fuji canonical token must be ${target.canonicalToken}.`);
  }

  if (network === "mainnet" && env.CONFIRM_MAINNET_DEPLOY !== "yes") {
    throw new DeploymentError("Mainnet deployment requires CONFIRM_MAINNET_DEPLOY=yes.");
  }

  return {
    network,
    chainId: target.chainId,
    rpcUrl,
    feeRecipient,
    feeBps,
    feeBpsText,
    canonicalToken,
    bytecodePath: env.MARKETPLACE_BYTECODE_PATH || "out/MusicMarketplace.sol/MusicMarketplace.json",
  };
}

function privateKeyInputFromEnvironment(value) {
  if (typeof value !== "string") {
    throw new DeploymentError("A valid DEPLOYER_PRIVATE_KEY environment credential is required.");
  }
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!PRIVATE_KEY_PATTERN.test(normalized)) {
    throw new DeploymentError("A valid DEPLOYER_PRIVATE_KEY environment credential is required.");
  }
  return Buffer.from(`${normalized}\n`, "utf8");
}

export function buildForgeCreateArgs(config) {
  return [
    "create",
    "contracts/MusicMarketplace.sol:MusicMarketplace",
    "--chain",
    String(config.chainId),
    "--interactive",
    "--broadcast",
    "--json",
    "--constructor-args",
    config.feeRecipient,
    config.feeBpsText,
    config.canonicalToken,
  ];
}

export function buildForgeEnvironment(env, rpcUrl) {
  const forgeEnv = { ...env, ETH_RPC_URL: rpcUrl };
  // Forge receives the key only through its hidden PTY prompt, never via argv or environment.
  for (const key of [
    "DEPLOYER_PRIVATE_KEY",
    "ETH_PRIVATE_KEY",
    "ETH_PASSWORD",
    "ETH_KEYSTORE",
    "ETH_KEYSTORE_ACCOUNT",
    "DEPLOYER_KEYSTORE_PATH",
    "DEPLOYER_KEYSTORE_PASSWORD_FILE",
    "DEPLOYER_KEYSTORE_PASSWORD",
  ]) {
    delete forgeEnv[key];
  }
  return forgeEnv;
}

function quoteShellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function executeForgeWithPty(args, { env, input, cwd, maxBuffer = MAX_FORGE_OUTPUT_BYTES }) {
  const command = ["forge", ...args].map(quoteShellArgument).join(" ");
  const stdout = execFileSync(
    "script",
    ["--quiet", "--return", "--command", command, "/dev/null"],
    { cwd, env, input, encoding: "utf8", maxBuffer },
  );
  return { stdout, stderr: "" };
}

export async function runForgeCreate(
  execute = executeForgeWithPty,
  config,
  env = process.env,
  privateKeyInput,
  cwd = process.cwd(),
) {
  if (!Buffer.isBuffer(privateKeyInput) || privateKeyInput.length === 0) {
    throw new DeploymentError("A deployer wallet credential is required.");
  }

  let stdout;
  try {
    const args = buildForgeCreateArgs(config);
    const childEnv = buildForgeEnvironment(env, config.rpcUrl);
    ({ stdout } = await execute(args, {
      env: childEnv,
      input: privateKeyInput,
      cwd,
      maxBuffer: MAX_FORGE_OUTPUT_BYTES,
    }));
  } catch {
    throw new DeploymentError("Forge create failed; sensitive process output was suppressed.");
  } finally {
    privateKeyInput.fill(0);
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

export async function runMarketplaceDeployment({
  env = process.env,
  cwd = process.cwd(),
  execute = executeForgeWithPty,
  Provider = JsonRpcProvider,
} = {}) {
  const runtimeEnv = { ...env };
  let rawPrivateKey = runtimeEnv.DEPLOYER_PRIVATE_KEY;
  if (env === process.env) delete process.env.DEPLOYER_PRIVATE_KEY;
  delete runtimeEnv.DEPLOYER_PRIVATE_KEY;

  let privateKeyInput;
  try {
    const config = resolveMarketplaceConfig(runtimeEnv);
    privateKeyInput = privateKeyInputFromEnvironment(rawPrivateKey);
    rawPrivateKey = "";

    const forgeResult = await runForgeCreate(execute, config, runtimeEnv, privateKeyInput, cwd);
    privateKeyInput = undefined;
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
      supportedTokenContracts: [config.canonicalToken.toLowerCase()],
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
  } finally {
    rawPrivateKey = "";
    privateKeyInput?.fill(0);
  }
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
