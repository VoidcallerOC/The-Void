// Fuji-only deploy for VoidRoleGranter: lets verification reviewers grant
// ARTIST_ROLE + ISSUER_ROLE on the certified VoidRelease1155V2 without holding
// its admin role. Refuses Avalanche mainnet (43114).
//
// Exact steps, run by an operator. Do not commit the private key.
//
// 1. Install Foundry (`forge` on PATH).
// 2. Export only these variables:
//      DEPLOY_NETWORK=fuji
//      AVALANCHE_FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
//      DEPLOYER_PRIVATE_KEY=0x...          # the release contract's DEFAULT_ADMIN wallet
//      ROLE_GRANTER_OWNER=0x...            # manages the reviewer list (need not be admin)
//      ROLE_GRANTER_REVIEWERS=0x...,0x...  # comma-separated reviewer wallets
// 3. From the repository root:
//      npm run deploy:role-granter
//    The script compiles with `forge build`, deploys VoidRoleGranter against
//    config/fuji-release.json's contractAddress, grants it DEFAULT_ADMIN on that
//    release contract (the one-time admin step), and atomically records
//    roleGranterAddress in config/fuji-release.json.
// 4. Check both transactions on https://testnet.snowtrace.io, commit the config,
//    and let Vercel deploy. Reviewers then grant roles from the verification
//    review page with their own wallets.
// To switch the granter off later, the release admin calls
//   revokeRole(0x00…00, <roleGranterAddress>) on the release contract.
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";

const configPath = "config/fuji-release.json";
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

function requireAddress(value, name) {
  if (!ethers.isAddress(value || "") || ethers.getAddress(value) === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address.`);
  return ethers.getAddress(value);
}

if ((process.env.DEPLOY_NETWORK || "fuji") !== "fuji") throw new Error("This script only deploys to Avalanche Fuji (43113).");
const rpcUrl = String(process.env.AVALANCHE_FUJI_RPC_URL || "");
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!rpcUrl || !privateKey || !process.env.ROLE_GRANTER_OWNER || !process.env.ROLE_GRANTER_REVIEWERS) {
  throw new Error("Required: AVALANCHE_FUJI_RPC_URL, DEPLOYER_PRIVATE_KEY, ROLE_GRANTER_OWNER, ROLE_GRANTER_REVIEWERS.");
}
if (/api\.avax\.network/i.test(rpcUrl) && !/avax-test/i.test(rpcUrl)) throw new Error("Refusing Avalanche mainnet RPC.");
if (/(^|[^0-9])43114([^0-9]|$)/.test(rpcUrl)) throw new Error("Refusing mainnet chain id 43114.");
const owner = requireAddress(process.env.ROLE_GRANTER_OWNER, "ROLE_GRANTER_OWNER");
const reviewers = [...new Set(String(process.env.ROLE_GRANTER_REVIEWERS).split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => requireAddress(entry, "ROLE_GRANTER_REVIEWERS entry")))];
if (!reviewers.length) throw new Error("ROLE_GRANTER_REVIEWERS must list at least one reviewer wallet.");

const current = JSON.parse(await readFile(configPath, "utf8"));
if (Number(current.chainId) !== 43113) throw new Error("config/fuji-release.json is not the Fuji config.");
const releaseAddress = requireAddress(current.contractAddress, "config contractAddress");

const provider = new ethers.JsonRpcProvider(rpcUrl, 43113, { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== 43113n) throw new Error(`Refusing non-Fuji chain: ${network.chainId}`);
const deployer = new ethers.Wallet(privateKey, provider);
const release = new ethers.Contract(releaseAddress, ["function hasRole(bytes32,address) view returns (bool)", "function grantRole(bytes32,address)"], deployer);
if (!(await release.hasRole(DEFAULT_ADMIN_ROLE, deployer.address))) throw new Error("DEPLOYER_PRIVATE_KEY must be the release contract's DEFAULT_ADMIN so it can hand the granter its role. Nothing was deployed.");

const build = spawnSync("forge", ["build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("forge build failed. Nothing was deployed.");
const artifactPath = "out/VoidRoleGranter.sol/VoidRoleGranter.json";
await access(artifactPath);
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));

const granter = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, deployer).deploy(releaseAddress, owner, reviewers);
const deployment = granter.deploymentTransaction();
const deployReceipt = await deployment.wait();
if (!deployReceipt || deployReceipt.status !== 1) throw new Error("VoidRoleGranter deployment did not receive a successful receipt.");
const granterAddress = ethers.getAddress(await granter.getAddress());

const grant = await release.grantRole(DEFAULT_ADMIN_ROLE, granterAddress);
const grantReceipt = await grant.wait();
if (!grantReceipt || grantReceipt.status !== 1) throw new Error(`DEFAULT_ADMIN grant to ${granterAddress} failed. The granter is deployed but inactive.`);

const next = {
  ...current,
  roleGranterAddress: granterAddress,
  roleGranterTransaction: deployment.hash,
  roleGranterBlock: deployReceipt.blockNumber,
  roleGranterAdminGrantTransaction: grant.hash,
};
const temporaryPath = `${configPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
await rename(temporaryPath, configPath);
console.log(JSON.stringify({ network: "fuji", chainId: 43113, releaseAddress, roleGranterAddress: granterAddress, owner, reviewers, deploymentTransaction: deployment.hash, adminGrantTransaction: grant.hash, configPath }, null, 2));
