import { ethers } from "ethers";
import deployment from "../../config/fuji-release.json";
import { waitForReceipt } from "./web3.js";

export const FUJI_RELEASE_CONFIG = Object.freeze({ ...deployment, network: deployment.networkName });
export const FUJI_RELEASE_ABI = Object.freeze(deployment.abi);

export const FUJI_ROLES = Object.freeze({
  DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
  ARTIST_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ARTIST_ROLE")),
  ISSUER_ROLE: ethers.keccak256(ethers.toUtf8Bytes("ISSUER_ROLE")),
});

export function fujiSlug(value, name = "id") {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(name.toLowerCase().includes("release") ? "Enter a release title before publishing." : "A name is required before publishing.");
  if (slug.length > 31) throw new Error(`${name} must be at most 31 characters for the certified Fuji path.`);
  return slug;
}

export function isCertifiedFujiEdition(edition) {
  return Boolean(edition)
    && String(edition.contractAddress || "").toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()
    && Number(edition.chainId) === FUJI_RELEASE_CONFIG.chainId;
}

const iface = new ethers.Interface(FUJI_RELEASE_ABI);
const editionIface = new ethers.Interface([
  "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))",
  "error EditionNotFound(uint256 tokenId)",
  "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
]);
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

export function assertFujiTransactionTarget(address) {
  if (!ethers.isAddress(address)) throw new Error("Only the certified Fuji release or its primary sale contract is allowed for this path.");
  const target = ethers.getAddress(address);
  if (target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) return ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress);
  const sale = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "");
  if (ethers.isAddress(sale) && ethers.getAddress(sale) !== ethers.ZeroAddress && target.toLowerCase() === sale.toLowerCase()) return ethers.getAddress(sale);
  throw new Error("Only the certified Fuji release or its primary sale contract is allowed for this path.");
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

const v2CreateIface = new ethers.Interface([
  "function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps) returns (uint256 tokenId)",
]);

export function encodeCreateFujiEdition({ releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps }) {
  if (!metadataUri || !String(metadataUri).trim()) throw new Error("Metadata URI is required.");
  if (BigInt(maxSupply) <= 0n) throw new Error("Edition supply must be greater than zero.");
  const ids = fujiIds(releaseId, editionId);
  const tokenId = fujiTokenId(releaseId, editionId);
  if (payout === undefined && royaltyBps === undefined) {
    return { tokenId, data: iface.encodeFunctionData("createEdition(bytes32,bytes32,uint256,string)", [ids.releaseId, ids.editionId, BigInt(maxSupply), metadataUri]) };
  }
  if (!ethers.isAddress(payout) || ethers.getAddress(payout) === ethers.ZeroAddress) throw new Error("Edition payout must be a wallet address.");
  const bps = BigInt(royaltyBps ?? 0);
  if (bps > 1000n) throw new Error("Royalty must be between 0 and 1000 basis points (10%).");
  return { tokenId, data: v2CreateIface.encodeFunctionData("createEdition", [ids.releaseId, ids.editionId, BigInt(maxSupply), metadataUri, ethers.getAddress(payout), bps]) };
}

export function encodeFujiMint({ to, tokenId, amount = 1 }) {
  if (!ethers.isAddress(to) || ethers.getAddress(to) === ethers.ZeroAddress) throw new Error("A valid recipient wallet is required.");
  if (BigInt(amount) <= 0n) throw new Error("Mint amount must be greater than zero.");
  return iface.encodeFunctionData("mint", [to, BigInt(tokenId), BigInt(amount), "0x"]);
}

export function isFujiEditionNotFoundError(error) {
  const revertData = error?.data || error?.originalError?.data || error?.cause?.data;
  if (revertData) {
    try {
      if (editionIface.parseError(revertData)?.name === "EditionNotFound") return true;
    } catch { /* Fall through to the provider's generic revert message. */ }
  }
  return /execution reverted/i.test(String(error?.message || error));
}

export function encodeFujiApproval(operator, approved = true) { return iface.encodeFunctionData("setApprovalForAll", [operator, approved]); }
export function encodeFujiTransfer(from, to, tokenId, amount = 1) { return iface.encodeFunctionData("safeTransferFrom", [from, to, BigInt(tokenId), BigInt(amount), "0x"]); }

export function assertProvenanceAnchorTarget(address) {
  if (!ethers.isAddress(address)) throw new Error("The provenance anchor contract address is invalid.");
  const target = ethers.getAddress(address);
  if (target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()) throw new Error("The provenance anchor cannot be the release contract.");
  const sale = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "");
  if (ethers.isAddress(sale) && ethers.getAddress(sale) !== ethers.ZeroAddress && target.toLowerCase() === sale.toLowerCase()) throw new Error("The provenance anchor cannot be the sale contract.");
  return target;
}

export async function sendFujiTransaction({ provider, from, data, to, value, anchorAddress = null }) {
  await assertFujiProvider(provider);
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  const target = anchorAddress ? assertProvenanceAnchorTarget(anchorAddress) : assertFujiTransactionTarget(to || FUJI_RELEASE_CONFIG.contractAddress);
  if (anchorAddress && to && ethers.getAddress(to) !== target) throw new Error("The provenance transaction target does not match the configured anchor.");
  const tx = { from, to: target, data };
  if (value !== undefined && value !== null && BigInt(value) > 0n) tx.value = ethers.toQuantity(BigInt(value));
  const hash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
  const receipt = await waitForReceipt(provider, hash);
  if (!receipt || receipt.status !== "0x1") throw new Error("Fuji transaction reverted or did not receive a successful receipt.");
  return { hash, receipt, blockNumber: receipt.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : null };
}

export async function readFujiBalance(provider, account, tokenId) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("balanceOf", [account, BigInt(tokenId)]);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return BigInt(iface.decodeFunctionResult("balanceOf", result)[0]);
}

export async function readFujiRole(provider, role, account) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("hasRole", [role, account]);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("hasRole", result)[0]);
}

export async function readFujiPaused(provider) {
  await assertFujiProvider(provider);
  const data = iface.encodeFunctionData("paused", []);
  const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
  return Boolean(iface.decodeFunctionResult("paused", result)[0]);
}

export async function readFujiEdition(provider, tokenId) {
  await assertFujiProvider(provider);
  const data = editionIface.encodeFunctionData("edition", [BigInt(tokenId)]);
  try {
    const result = await provider.request({ method: "eth_call", params: [{ to: assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress), data }, "latest"] });
    const [edition] = editionIface.decodeFunctionResult("edition", result);
    return { releaseId: edition.releaseId, editionId: edition.editionId, artist: edition.artist, maxSupply: edition.maxSupply, mintedSupply: edition.mintedSupply, metadataUri: edition.metadataUri, exists: Boolean(edition.exists) };
  } catch (error) {
    const revertData = error?.data || error?.originalError?.data || error?.cause?.data;
    if (revertData) {
      try {
        const parsed = editionIface.parseError(revertData);
        if (parsed?.name === "EditionNotFound") return null;
      } catch { /* Preserve the provider error for unknown failures. */ }
    }
    throw error;
  }
}

export async function assertFujiGas(provider, { from, data }) {
  await assertFujiProvider(provider);
  const to = assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress);
  const [gasHex, gasPriceHex, balanceHex] = await Promise.all([
    provider.request({ method: "eth_estimateGas", params: [{ from, to, data }] }),
    provider.request({ method: "eth_gasPrice" }),
    provider.request({ method: "eth_getBalance", params: [from, "latest"] }),
  ]);
  const gas = BigInt(gasHex);
  const gasPrice = BigInt(gasPriceHex);
  const balance = BigInt(balanceHex);
  const required = gas * gasPrice;
  if (balance < required) {
    throw new Error(`Insufficient Fuji AVAX for gas. Estimated requirement is ${ethers.formatEther(required)} AVAX; wallet balance is ${ethers.formatEther(balance)} AVAX.`);
  }
  return { gas, gasPrice, balance, required };
}

export async function verifyFujiEditionCreation(provider, { transactionHash, releaseId, editionId, tokenId }) {
  await assertFujiProvider(provider);
  const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [transactionHash] });
  if (!receipt || receipt.status !== "0x1") throw new Error("Create Edition did not receive a successful Fuji receipt.");
  const expectedTokenId = BigInt(tokenId).toString();
  const expectedReleaseId = fujiIds(releaseId, editionId).releaseId;
  const expectedEditionId = fujiIds(releaseId, editionId).editionId;
  const event = (receipt.logs || []).filter((log) => log.address?.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()).map((log) => {
    try { return editionIface.parseLog(log); } catch { return null; }
  }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId.toString() === expectedTokenId && parsed.args.releaseId === expectedReleaseId && parsed.args.editionId === expectedEditionId);
  if (!event) throw new Error("Create Edition receipt succeeded, but the expected EditionCreated event was not found.");
  const edition = await readFujiEdition(provider, tokenId);
  if (!edition?.exists) throw new Error("EditionCreated was emitted, but edition(tokenId) is not available on Fuji.");
  return { receipt, event, edition };
}

export function fujiExplorerUrl(kind, value) { return `${FUJI_RELEASE_CONFIG.explorer}/${kind}/${value}`; }
