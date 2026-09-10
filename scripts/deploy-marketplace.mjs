import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const { stdout } = await exec("forge", ["create", "contracts/MusicMarketplace.sol:MusicMarketplace", "--rpc-url", rpcUrl, "--private-key", privateKey, "--constructor-args", feeRecipient, feeBps, "--broadcast", "--json"], { maxBuffer: 10 * 1024 * 1024 });
let result;
try { result = JSON.parse(stdout); } catch { throw new Error(`Forge did not return JSON. Output: ${stdout}`); }
const address = result.deployedTo || result.contractAddress;
const transactionHash = result.transactionHash || result.txHash;
if (!address || !transactionHash) throw new Error("Deployment output did not include contract address and transaction hash.");
const bytecodePath = process.env.MARKETPLACE_BYTECODE_PATH || "out/MusicMarketplace.sol/MusicMarketplace.json";
let bytecodeHash = null;
try { const artifact = JSON.parse(await readFile(bytecodePath, "utf8")); bytecodeHash = `0x${createHash("sha256").update(Buffer.from(artifact.bytecode.object.replace(/^0x/, ""), "hex")).digest("hex")}`; } catch { /* deployment still records an explicit unknown hash */ }
const record = { network, chainId: target.chainId, contractAddress: address.toLowerCase(), deploymentTransaction: transactionHash.toLowerCase(), deploymentBlock: result.blockNumber ?? null, bytecodeHash, sourceVerificationStatus: result.verificationStatus || "NOT_REQUESTED", feeRecipient: feeRecipient.toLowerCase(), feeBasisPoints: Number(feeBps), supportedTokenContracts: [], recordedAt: new Date().toISOString() };
await mkdir("deployments", { recursive: true });
await writeFile(`deployments/marketplace-${network}.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
