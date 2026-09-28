import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcProvider } from "ethers";
import { extractForgeJson } from "./deploy-marketplace-output.mjs";

const exec = promisify(execFile);
const network = process.env.DEPLOY_NETWORK || "fuji";
const networks = { fuji: { chainId: 43113, rpcEnv: "AVALANCHE_FUJI_RPC_URL" }, mainnet: { chainId: 43114, rpcEnv: "AVALANCHE_CCHAIN_RPC_URL" } };
const target = networks[network];
if (!target) throw new Error(`Unsupported DEPLOY_NETWORK: ${network}. Use fuji or mainnet.`);
const rpcUrl = process.env[target.rpcEnv];
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const feeRecipient = process.env.MARKETPLACE_FEE_RECIPIENT;
const feeBps = process.env.MARKETPLACE_FEE_BPS;
if (!rpcUrl || !privateKey || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient || "") || !/^\d+$/.test(feeBps || "") || Number(feeBps) > 10000) throw new Error(`Missing or invalid deployment configuration. Required: ${target.rpcEnv}, DEPLOYER_PRIVATE_KEY, MARKETPLACE_FEE_RECIPIENT, MARKETPLACE_FEE_BPS (0-10000).`);
if (network === "mainnet" && process.env.CONFIRM_MAINNET_DEPLOY !== "yes") throw new Error("Mainnet deployment requires CONFIRM_MAINNET_DEPLOY=yes.");

let stdout;
try {
  ({ stdout } = await exec("forge", ["create", "contracts/MusicMarketplace.sol:MusicMarketplace", "--rpc-url", rpcUrl, "--private-key", privateKey, "--constructor-args", feeRecipient, feeBps, "--broadcast", "--json"], { maxBuffer: 10 * 1024 * 1024 }));
} catch (error) {
  throw new Error(`Forge create failed with exit code ${error?.code ?? "unknown"}.`);
}
const result = extractForgeJson(stdout);
const transactionHash = result.transactionHash || result.txHash;
if (!transactionHash) throw new Error("Deployment output did not include a transaction hash.");
const provider = new JsonRpcProvider(rpcUrl, target.chainId, { staticNetwork: true });
const receipt = await provider.waitForTransaction(transactionHash, 1, 60_000);
if (!receipt) throw new Error("Deployment transaction receipt was not available; refusing to record incomplete deployment metadata.");
const address = result.deployedTo || result.contractAddress || receipt.contractAddress;
if (!address) throw new Error("Deployment output did not include a contract address.");
const bytecodePath = process.env.MARKETPLACE_BYTECODE_PATH || "out/MusicMarketplace.sol/MusicMarketplace.json";
let artifact;
try { artifact = JSON.parse(await readFile(bytecodePath, "utf8")); } catch { throw new Error(`Deployment bytecode artifact was not available at ${bytecodePath}.`); }
const bytecode = artifact?.bytecode?.object;
if (typeof bytecode !== "string" || !/^(0x)?[0-9a-fA-F]+$/.test(bytecode)) throw new Error("Deployment bytecode artifact did not contain valid bytecode.");
const bytecodeHash = `0x${createHash("sha256").update(Buffer.from(bytecode.replace(/^0x/, ""), "hex")).digest("hex")}`;
const record = { network, chainId: target.chainId, contractAddress: address.toLowerCase(), deploymentTransaction: transactionHash.toLowerCase(), deploymentBlock: receipt.blockNumber ?? result.blockNumber ?? null, bytecodeHash, sourceVerificationStatus: result.verificationStatus || "NOT_REQUESTED", feeRecipient: feeRecipient.toLowerCase(), feeBasisPoints: Number(feeBps), supportedTokenContracts: [], recordedAt: new Date().toISOString() };
await mkdir("deployments", { recursive: true });
await writeFile(`deployments/marketplace-${network}.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
