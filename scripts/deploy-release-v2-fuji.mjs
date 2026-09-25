// Fuji-only deploy for VoidRelease1155V2 and VoidPrimarySale.
// Does not deploy MusicMarketplace and refuses Avalanche mainnet (43114).
//
// Exact steps, run by an operator. Do not commit the private key.
//
// 1. Install Foundry v1.3.1 (`foundryup -i v1.3.1`) and put `forge` on PATH.
// 2. Export only these variables:
//      DEPLOY_NETWORK=fuji
//      AVALANCHE_FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
//      DEPLOYER_PRIVATE_KEY=0x...          # must equal RELEASE_ADMIN_ADDRESS
//      RELEASE_ADMIN_ADDRESS=0x...
//      PLATFORM_FEE_RECIPIENT=0x...
//      PLATFORM_FEE_BPS=250                # integer 0-10000; this value is the fee cap
// 3. From the repository root:
//      npm run deploy:release-v2
//    The script compiles with `forge build`, deploys V2, deploys VoidPrimarySale,
//    grants ISSUER_ROLE on V2 to the sale, and atomically rewrites
//    config/fuji-release.json. The collectible stays ERC-1155. Fans pay native AVAX.
// 4. Check both addresses and the grant transaction on https://testnet.snowtrace.io.
// 5. Update the certified address pins that still expect VoidRelease1155 at
//    0x262B774cf9a1949170B58E2d57F6189980FE757b:
//      src/lib/fuji-release.test.js
//      src/lib/marketplace-surface.js (certifiedFujiReleaseUnchanged)
//      test/runtime-config-packaging.test.mjs
//      README.md blockchain table
//    Then set INDEXER_CONTRACTS_JSON to the V2 address as ERC1155 and the sale
//    address as PRIMARY_SALE with tokenAddress set to the V2 address.
// 6. Do not point this config at mainnet. Do not run scripts/deploy-marketplace.
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";

const configPath = "config/fuji-release.json";
const releaseAbi = [
  "function tokenIdFor(bytes32 releaseId, bytes32 editionId) view returns (uint256)",
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri) returns (uint256 tokenId)",
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps) returns (uint256 tokenId)",
  "function mint(address to, uint256 tokenId, uint256 amount, bytes data)",
  "function uri(uint256 tokenId) view returns (string)",
  "function balanceOf(address account, uint256 tokenId) view returns (uint256)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function paused() view returns (bool)",
  "function payoutOf(uint256 tokenId) view returns (address)",
  "function artistOf(uint256 tokenId) view returns (address)",
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)",
];
const primarySaleAbi = [
  "function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)",
  "function walletPurchased(uint256,address) view returns (uint256)",
  "function purchase(uint256 tokenId, uint256 qty) payable",
  "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
  "error SoldOut(uint256 tokenId, uint256 remaining, uint256 requested)",
  "error WrongPayment(uint256 expected, uint256 actual)",
  "error WalletLimitExceeded(uint256 tokenId, uint256 limit, uint256 already, uint256 requested)",
  "error SalePaused(uint256 tokenId)",
  "error SaleNotStarted(uint256 tokenId)",
  "error SaleEnded(uint256 tokenId)",
  "error SaleNotConfigured(uint256 tokenId)",
  "error ZeroQuantity()",
];

function requireAddress(value, name) {
  if (!ethers.isAddress(value || "") || ethers.getAddress(value) === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address.`);
  return ethers.getAddress(value);
}

if ((process.env.DEPLOY_NETWORK || "fuji") !== "fuji") throw new Error("This script only deploys to Avalanche Fuji (43113).");
const rpcUrl = String(process.env.AVALANCHE_FUJI_RPC_URL || "");
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!rpcUrl || !privateKey || !process.env.RELEASE_ADMIN_ADDRESS || !process.env.PLATFORM_FEE_RECIPIENT || process.env.PLATFORM_FEE_BPS === undefined) {
  throw new Error("Required: AVALANCHE_FUJI_RPC_URL, DEPLOYER_PRIVATE_KEY, RELEASE_ADMIN_ADDRESS, PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS.");
}
if (/api\.avax\.network/i.test(rpcUrl) && !/avax-test/i.test(rpcUrl)) throw new Error("Refusing Avalanche mainnet RPC.");
if (/(^|[^0-9])43114([^0-9]|$)/.test(rpcUrl)) throw new Error("Refusing mainnet chain id 43114.");
const admin = requireAddress(process.env.RELEASE_ADMIN_ADDRESS, "RELEASE_ADMIN_ADDRESS");
const platformRecipient = requireAddress(process.env.PLATFORM_FEE_RECIPIENT, "PLATFORM_FEE_RECIPIENT");
const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS);
if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) throw new Error("PLATFORM_FEE_BPS must be an integer from 0 to 10000.");

const provider = new ethers.JsonRpcProvider(rpcUrl, 43113, { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== 43113n) throw new Error(`Refusing non-Fuji chain: ${network.chainId}`);
const deployer = new ethers.Wallet(privateKey, provider);
if (deployer.address.toLowerCase() !== admin.toLowerCase()) throw new Error("DEPLOYER_PRIVATE_KEY must control RELEASE_ADMIN_ADDRESS so ISSUER_ROLE can be granted to the sale.");

const build = spawnSync("forge", ["build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("forge build failed. Nothing was deployed.");

async function artifact(relativePath) {
  await access(relativePath);
  return JSON.parse(await readFile(relativePath, "utf8"));
}

async function waitDeployment(contract) {
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("Deployment transaction was not created.");
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Deployment transaction did not receive a successful receipt.");
  return { transaction, receipt, address: ethers.getAddress(await contract.getAddress()) };
}

const releaseArtifact = await artifact("out/VoidRelease1155V2.sol/VoidRelease1155V2.json");
const saleArtifact = await artifact("out/VoidPrimarySale.sol/VoidPrimarySale.json");
const release = await new ethers.ContractFactory(releaseArtifact.abi, releaseArtifact.bytecode.object, deployer).deploy(admin);
const releaseDeployment = await waitDeployment(release);
const sale = await new ethers.ContractFactory(saleArtifact.abi, saleArtifact.bytecode.object, deployer).deploy(releaseDeployment.address, platformRecipient, platformFeeBps);
const saleDeployment = await waitDeployment(sale);
const grant = await release.grantRole(ethers.id("ISSUER_ROLE"), saleDeployment.address);
const grantReceipt = await grant.wait();
if (!grantReceipt || grantReceipt.status !== 1) throw new Error("ISSUER_ROLE grant did not receive a successful receipt.");

const current = JSON.parse(await readFile(configPath, "utf8"));
const next = {
  ...current,
  network: "fuji",
  networkName: current.networkName || "Avalanche Fuji",
  chainId: 43113,
  chainHexId: current.chainHexId || "0xa869",
  contractName: "VoidRelease1155V2",
  contractType: "ERC1155",
  contractAddress: releaseDeployment.address,
  deploymentTransaction: releaseDeployment.transaction.hash,
  deploymentBlock: releaseDeployment.receipt.blockNumber,
  primarySaleName: "VoidPrimarySale",
  primarySaleAddress: saleDeployment.address,
  primarySaleTransaction: saleDeployment.transaction.hash,
  primarySaleBlock: saleDeployment.receipt.blockNumber,
  primarySaleIssuerGrantTransaction: grant.hash,
  platformFeeRecipient: platformRecipient,
  platformFeeBps,
  rpcUrl: current.rpcUrl,
  explorer: current.explorer,
  abi: releaseAbi,
  primarySaleAbi,
};
const temporaryPath = `${configPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
await rename(temporaryPath, configPath);
console.log(JSON.stringify({
  network: "fuji",
  chainId: 43113,
  contractName: "VoidRelease1155V2",
  contractType: "ERC1155",
  contractAddress: releaseDeployment.address,
  deploymentTransaction: releaseDeployment.transaction.hash,
  deploymentBlock: releaseDeployment.receipt.blockNumber,
  primarySaleName: "VoidPrimarySale",
  primarySaleAddress: saleDeployment.address,
  primarySaleTransaction: saleDeployment.transaction.hash,
  primarySaleBlock: saleDeployment.receipt.blockNumber,
  primarySaleIssuerGrantTransaction: grant.hash,
  platformFeeRecipient: platformRecipient,
  platformFeeBps,
  configPath,
}, null, 2));
