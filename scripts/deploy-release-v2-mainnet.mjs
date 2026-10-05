// Mainnet-only deploy for VoidRelease1155V2, VoidPrimarySale, and VoidProvenanceAnchor.
// This script never deploys the legacy C-Chain collection or the marketplace.
// It refuses to broadcast until all production gates and Safe handoff support pass.
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";

const CHAIN_ID = 43114n;
const CONFIG_PATH = "config/mainnet-release.json";
const rpcUrl = String(process.env.AVALANCHE_MAINNET_RPC_URL || process.env.AVALANCHE_CCHAIN_RPC_URL || "").trim();
const privateKey = String(process.env.DEPLOYER_PRIVATE_KEY || "").trim();
const adminSafe = String(process.env.ADMIN_SAFE_ADDRESS || "").trim();
const admin = String(process.env.RELEASE_ADMIN_ADDRESS || "").trim();
const platformRecipient = String(process.env.PLATFORM_FEE_RECIPIENT || "").trim();
const feeBps = Number(process.env.PLATFORM_FEE_BPS);

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function address(value, name) {
  required(value, name);
  if (!ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address.`);
  return ethers.getAddress(value);
}
function receiptOf(tx, label) {
  return tx.wait().then((receipt) => {
    if (!receipt || receipt.status !== 1) throw new Error(`${label} did not receive a successful receipt.`);
    return receipt;
  });
}
function artifactMethod(artifact, signature, label) {
  const normalized = signature.replace(/\s+/g, "");
  const found = (artifact.abi || []).some((entry) => typeof entry === "object" && entry.type === "function" && `${entry.name}(${(entry.inputs || []).map((input) => input.type).join(",")})` === normalized);
  if (!found) throw new Error(`${label} does not contain the reviewed method ${signature}; refusing broadcast.`);
}

if (process.env.CONFIRM_MAINNET_DEPLOY !== "yes") throw new Error("Refusing C-Chain broadcast. Set CONFIRM_MAINNET_DEPLOY=yes.");
if (process.env.DEPLOY_NETWORK !== "mainnet") throw new Error("DEPLOY_NETWORK must be exactly mainnet.");
const safe = address(adminSafe, "ADMIN_SAFE_ADDRESS");
const deployerAdmin = address(admin, "RELEASE_ADMIN_ADDRESS");
const recipient = address(platformRecipient, "PLATFORM_FEE_RECIPIENT");
if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
if (!rpcUrl) throw new Error("AVALANCHE_MAINNET_RPC_URL or AVALANCHE_CCHAIN_RPC_URL is required.");
if (safe.toLowerCase() === deployerAdmin.toLowerCase()) throw new Error("ADMIN_SAFE_ADDRESS must differ from the deployer/admin EOA.");
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error("PLATFORM_FEE_BPS must be an integer from 0 to 10000.");

const provider = new ethers.JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== CHAIN_ID) throw new Error(`Refusing non-C-Chain network: ${network.chainId}.`);
const deployer = new ethers.Wallet(privateKey, provider);
if (deployer.address.toLowerCase() !== deployerAdmin.toLowerCase()) throw new Error("DEPLOYER_PRIVATE_KEY must control RELEASE_ADMIN_ADDRESS.");
const balance = await provider.getBalance(deployer.address);
if (balance <= 0n) throw new Error("Deployer has no C-Chain AVAX funding.");

const build = spawnSync("forge", ["build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("forge build failed. Nothing was deployed.");
async function loadArtifact(path) {
  await access(path);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  if (!artifact.bytecode?.object || artifact.bytecode.object === "0x") throw new Error(`Missing bytecode in ${path}.`);
  return artifact;
}
const releaseArtifact = await loadArtifact("out/VoidRelease1155V2.sol/VoidRelease1155V2.json");
const saleArtifact = await loadArtifact("out/VoidPrimarySale.sol/VoidPrimarySale.json");
const anchorArtifact = await loadArtifact("out/VoidProvenanceAnchor.sol/VoidProvenanceAnchor.json");
artifactMethod(releaseArtifact, "grantRole(bytes32,address)", "VoidRelease1155V2 artifact");
artifactMethod(releaseArtifact, "renounceRole(bytes32)", "VoidRelease1155V2 artifact");
artifactMethod(releaseArtifact, "hasRole(bytes32,address)", "VoidRelease1155V2 artifact");
artifactMethod(saleArtifact, "owner()", "VoidPrimarySale artifact");
artifactMethod(saleArtifact, "transferOwnership(address)", "VoidPrimarySale artifact");
artifactMethod(anchorArtifact, "releaseContract()", "VoidProvenanceAnchor artifact");

const release = await new ethers.ContractFactory(releaseArtifact.abi, releaseArtifact.bytecode.object, deployer).deploy(deployerAdmin);
const releaseDeployTx = release.deploymentTransaction();
const releaseDeployReceipt = await receiptOf(releaseDeployTx, "VoidRelease1155V2 deployment");
const releaseAddress = ethers.getAddress(await release.getAddress());
const sale = await new ethers.ContractFactory(saleArtifact.abi, saleArtifact.bytecode.object, deployer).deploy(releaseAddress, recipient, feeBps);
const saleDeployTx = sale.deploymentTransaction();
const saleDeployReceipt = await receiptOf(saleDeployTx, "VoidPrimarySale deployment");
const saleAddress = ethers.getAddress(await sale.getAddress());
const anchor = await new ethers.ContractFactory(anchorArtifact.abi, anchorArtifact.bytecode.object, deployer).deploy(releaseAddress);
const anchorDeployTx = anchor.deploymentTransaction();
const anchorDeployReceipt = await receiptOf(anchorDeployTx, "VoidProvenanceAnchor deployment");
const anchorAddress = ethers.getAddress(await anchor.getAddress());

const issuerRole = ethers.id("ISSUER_ROLE");
const defaultAdminRole = ethers.ZeroHash;
const grantIssuerTx = await release.grantRole(issuerRole, saleAddress);
const grantIssuerReceipt = await receiptOf(grantIssuerTx, "ISSUER_ROLE grant");
if ((await sale.owner()).toLowerCase() !== deployerAdmin.toLowerCase()) throw new Error("Primary-sale owner is not the expected deployer before Safe handoff.");
const transferSaleTx = await sale.transferOwnership(safe);
const transferSaleReceipt = await receiptOf(transferSaleTx, "primary-sale Safe ownership handoff");
const grantAdminTx = await release.grantRole(defaultAdminRole, safe);
const grantAdminReceipt = await receiptOf(grantAdminTx, "DEFAULT_ADMIN Safe grant");
const renounceAdminTx = await release.renounceRole(defaultAdminRole);
const renounceAdminReceipt = await receiptOf(renounceAdminTx, "deployer DEFAULT_ADMIN renouncement");
const renounceArtistTx = await release.renounceRole(ethers.id("ARTIST_ROLE"));
const renounceArtistReceipt = await receiptOf(renounceArtistTx, "deployer ARTIST_ROLE renouncement");
const renounceIssuerTx = await release.renounceRole(issuerRole);
const renounceIssuerReceipt = await receiptOf(renounceIssuerTx, "deployer ISSUER_ROLE renouncement");

if (!(await release.hasRole(defaultAdminRole, safe))) throw new Error("Safe does not hold DEFAULT_ADMIN_ROLE after handoff.");
if (await release.hasRole(defaultAdminRole, deployer.address)) throw new Error("Deployer still holds DEFAULT_ADMIN_ROLE.");
if (await release.hasRole(ethers.id("ARTIST_ROLE"), deployer.address)) throw new Error("Deployer still holds ARTIST_ROLE.");
if (await release.hasRole(issuerRole, deployer.address)) throw new Error("Deployer still holds ISSUER_ROLE.");
if ((await sale.owner()).toLowerCase() !== safe.toLowerCase()) throw new Error("Primary-sale owner is not the Safe after handoff.");
if ((await sale.releases()).toLowerCase() !== releaseAddress.toLowerCase()) throw new Error("Primary-sale release address mismatch.");
if ((await anchor.releaseContract()).toLowerCase() !== releaseAddress.toLowerCase()) throw new Error("Provenance anchor release address mismatch.");

const current = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const next = {
  ...current,
  network: "mainnet",
  networkName: "Avalanche C-Chain",
  chainId: 43114,
  chainHexId: "0xa86a",
  deployed: true,
  contractName: "VoidRelease1155V2",
  contractType: "ERC1155",
  contractAddress: releaseAddress,
  deploymentTransaction: releaseDeployTx.hash,
  deploymentBlock: releaseDeployReceipt.blockNumber,
  primarySaleName: "VoidPrimarySale",
  primarySaleAddress: saleAddress,
  primarySaleTransaction: saleDeployTx.hash,
  primarySaleBlock: saleDeployReceipt.blockNumber,
  primarySaleIssuerGrantTransaction: grantIssuerTx.hash,
  adminSafe: safe,
  adminHandoffTransactions: [grantAdminTx.hash, renounceAdminTx.hash, renounceArtistTx.hash, renounceIssuerTx.hash, transferSaleTx.hash],
  provenance: { anchorAddress, anchorDeploymentTransaction: anchorDeployTx.hash, anchorDeploymentBlock: anchorDeployReceipt.blockNumber, rpcUrl },
  rpcUrl,
  abi: current.abi,
  primarySaleAbi: current.primarySaleAbi,
  deploymentVerification: {
    releaseReceiptStatus: releaseDeployReceipt.status,
    saleReceiptStatus: saleDeployReceipt.status,
    anchorReceiptStatus: anchorDeployReceipt.status,
    issuerGrantBlock: grantIssuerReceipt.blockNumber,
    saleOwnerHandoffBlock: transferSaleReceipt.blockNumber,
    safeGrantBlock: grantAdminReceipt.blockNumber,
    deployerRenouncementBlocks: [renounceAdminReceipt.blockNumber, renounceArtistReceipt.blockNumber, renounceIssuerReceipt.blockNumber],
  },
};
const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
await rename(temp, CONFIG_PATH);
console.log(JSON.stringify({ network: "mainnet", chainId: 43114, releaseAddress, saleAddress, anchorAddress, adminSafe: safe, configPath: CONFIG_PATH }, null, 2));
