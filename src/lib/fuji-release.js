import { ethers } from "ethers";
import { waitForReceipt } from "./web3.js";

export const FUJI_RELEASE_CONFIG = Object.freeze({
  network: "Avalanche Fuji",
  chainId: 43113,
  chainHexId: "0xa869",
  contractAddress: "0x262B774cf9a1949170B58E2d57F6189980FE757b",
  deploymentBlock: 58428586,
  deploymentTransaction: "0x69eb5de1a6db53578d3995b5af34c0a78f47b27dee1c1a2b7aed6522b14f33f9",
  explorer: "https://testnet.snowtrace.io",
});

export const FUJI_RELEASE_ABI = Object.freeze([
  "function tokenIdFor(bytes32 releaseId, bytes32 editionId) view returns (uint256)",
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri) returns (uint256 tokenId)",
  "function mint(address to, uint256 tokenId, uint256 amount, bytes data)",
  "function uri(uint256 tokenId) view returns (string)",
  "function balanceOf(address account, uint256 tokenId) view returns (uint256)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function paused() view returns (bool)",
]);

export const FUJI_ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ARTIST_ROLE")),
  ISSUER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE")),
});

const iface = new ethers.Interface(FUJI_RELEASE_ABI);
const bytes32 = (value, name) => {
  const text = String(value || "").trim();
  if (!text || text.length > 31) throw new Error(`${name} must be non-empty and at most 31 bytes.`);
  return ethers.encodeBytes32String(text);
};

export function fujiIds(releaseId, editionId) {
  return { releaseId: bytes32(releaseId, "releaseId"), editionId: bytes32(editionId, "editionId") };
}

export function fujiTokenId(releaseId, editionId) {
  const ids = fujiIds(releaseId, editionId);
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", ids.releaseId, ids.editionId]));
  const tokenId = BigInt(digest);
  return tokenId === 0n ? 1n : tokenId;
}

export function assertFujiAddress(address) {
  if (!ethers.isAddress(address) || address.toLowerCase() !== FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) throw new Error("Only the certified Fuji VoidRelease1155 contract is allowed for this path.");
  return FUJI_RELEASE_CONFIG.contractAddress;
}

export async function assertFujiProvider(provider) {
  if (!provider?.request) throw new Error("Connect a wallet before using the Fuji release.");
  const chain = await provider.request({ method: "eth_chainId" });
  const chainId = Number.parseInt(chain, 16);
  if (chainId !== FUJI_RELEASE_CONFIG.chainId) throw new Error(`Switch your wallet to ${FUJI_RELEASE_CONFIG.network} (chain ${FUJI_RELEASE_CONFIG.chainId}).`);
  return chainId;
}

export function encodeCreateFujiEdition({ releaseId, editionId, maxSupply, metadataUri }) {
  if (!metadataUri || !String(metadataUri).trim()) throw new Error("Metadata URI is required.");
  if (BigInt(maxSupply) <= 0n) throw new Error("Edition supply must be greater than zero.");
  const ids = fujiIds(releaseId, editionId);
  return { tokenId: fujiTokenId(releaseId, editionId), data: iface.encodeFunctionData("createEdition", [ids.releaseId, ids.editionId, BigInt(maxSupply), metadataUri]) };
}

export function encodeFujiMint({ to, tokenId, amount = 1 }) {
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error("A valid recipient wallet is required.");
  if (BigInt(amount) <= 0n) throw new Error("Mint amount must be greater than zero.");
  return iface.encodeFunctionData("mint", [to, BigInt(tokenId), BigInt(amount), "0x"]);
}

export function encodeFujiApproval(operator, approved = true) { return iface.encodeFunctionData("setApprovalForAll", [operator, approved]); }
export function encodeFujiTransfer(from, to, tokenId, amount = 1) { return iface.encodeFunctionData("safeTransferFrom", [from, to, BigInt(tokenId), BigInt(amount), "0x"]); }

export async function sendFujiTransaction({ provider, from, data }) {
  await assertFujiProvider(provider);
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to: FUJI_RELEASE_CONFIG.contractAddress, data }] });
  const receipt = await waitForReceipt(provider, hash);
  if (!receipt || receipt.status !== "0x1") throw new Error("Fuji transaction reverted or did not receive a successful receipt.");
  return { hash, receipt };
}

export async function readFujiBalance(provider, account, tokenId) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("balanceOf", [account, BigInt(tokenId)]);
  const result = await provider.request({ method: "eth_call", params: [{ to: FUJI_RELEASE_CONFIG.contractAddress, data }, "latest"] });
  return BigInt(iface.decodeFunctionResult("balanceOf", result)[0]);
}

export async function readFujiRole(provider, role, account) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("hasRole", [role, account]);
  const result = await provider.request({ method: "eth_call", params: [{ to: FUJI_RELEASE_CONFIG.contractAddress, data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("hasRole", result)[0]);
}

export async function readFujiPaused(provider) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("paused", []);
  const result = await provider.request({ method: "eth_call", params: [{ to: FUJI_RELEASE_CONFIG.contractAddress, data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("paused", result)[0]);
}

export function fujiExplorerUrl(kind, value) { return `${FUJI_RELEASE_CONFIG.explorer}/${kind}/${value}`; }
