import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, assertFujiProvider, fujiExplorerUrl, sendFujiTransaction } from "./fuji-release.js";

const configuredSaleAbi = Array.isArray(FUJI_RELEASE_CONFIG.primarySaleAbi) ? FUJI_RELEASE_CONFIG.primarySaleAbi : [];
export const PRIMARY_SALE_ABI = Object.freeze(configuredSaleAbi.length ? configuredSaleAbi : [
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
]);

const saleIface = new ethers.Interface(PRIMARY_SALE_ABI);

export function fujiPrimarySaleAddress() {
  const value = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "").trim();
  if (!ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) return "";
  return ethers.getAddress(value);
}

export function fujiReleaseIsV2() {
  return FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155V2";
}

export function encodeConfigureSale({ tokenId, priceWei, maxSupply, perWalletLimit, startTime = 0, endTime = 0, paused = false }) {
  const price = BigInt(priceWei);
  const supply = BigInt(maxSupply);
  const limit = BigInt(perWalletLimit);
  const start = BigInt(startTime || 0);
  const end = BigInt(endTime || 0);
  if (price <= 0n) throw new Error("Sale price must be greater than zero.");
  if (supply <= 0n) throw new Error("Sale supply must be greater than zero.");
  if (limit <= 0n || limit > supply) throw new Error("Per-wallet limit must be between 1 and the sale supply.");
  if (end !== 0n && start !== 0n && end < start) throw new Error("Sale end must be after the start.");
  return saleIface.encodeFunctionData("configureSale", [BigInt(tokenId), price, supply, limit, start, end, Boolean(paused)]);
}

export function encodePurchase(tokenId, qty = 1) {
  const quantity = BigInt(qty);
  if (quantity <= 0n) throw new Error("Collect quantity must be greater than zero.");
  return saleIface.encodeFunctionData("purchase", [BigInt(tokenId), quantity]);
}

export function purchaseCost(priceWei, qty = 1) {
  return BigInt(priceWei) * BigInt(qty);
}

export function formatAvax(wei) {
  return `${ethers.formatEther(BigInt(wei))} AVAX`;
}

function revertData(error) {
  const candidates = [error?.data, error?.error?.data, error?.info?.error?.data, error?.cause?.data, error?.data?.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) return candidate;
  }
  const match = String(error?.message || "").match(/0x[0-9a-fA-F]{8,}/);
  return match ? match[0] : null;
}

export function explainCollectError(error) {
  const code = error?.code ?? error?.info?.error?.code ?? error?.cause?.code;
  const message = String(error?.shortMessage || error?.message || error || "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(message)) {
    return { state: "rejected", message: "Transaction rejected in the wallet. Nothing was collected." };
  }
  if (/switch your wallet|wrong network|chain 43113|avalanche fuji/i.test(message)) {
    return { state: "wrong-network", message: "Switch your wallet to Avalanche Fuji (chain 43113) before collecting." };
  }
  const data = revertData(error);
  if (data) {
    try {
      const parsed = saleIface.parseError(data);
      if (parsed?.name === "SoldOut") return { state: "sold-out", message: "This release is sold out." };
      if (parsed?.name === "WalletLimitExceeded") return { state: "wallet-limit", message: "This wallet has reached the collector limit for this release." };
      if (parsed?.name === "WrongPayment") return { state: "wrong-payment", message: "The payment did not match the on-chain price. Nothing was collected." };
      if (parsed?.name === "SalePaused") return { state: "paused", message: "This sale is paused." };
      if (parsed?.name === "SaleNotStarted" || parsed?.name === "SaleEnded") return { state: "closed", message: "This sale is not open right now." };
      if (parsed?.name === "SaleNotConfigured") return { state: "unconfigured", message: "This release does not have a primary sale yet." };
    } catch { /* Unknown revert data falls through. */ }
  }
  if (/sold out/i.test(message)) return { state: "sold-out", message: "This release is sold out." };
  return { state: "unavailable", message: "Collection is temporarily unavailable. Please try again later." };
}

export function decodeSale(result) {
  const decoded = saleIface.decodeFunctionResult("sales", result);
  return {
    priceWei: BigInt(decoded[0]),
    maxSupply: BigInt(decoded[1]),
    sold: BigInt(decoded[2]),
    perWalletLimit: BigInt(decoded[3]),
    startTime: BigInt(decoded[4]),
    endTime: BigInt(decoded[5]),
    paused: Boolean(decoded[6]),
    configured: Boolean(decoded[7]),
  };
}

export async function readPrimarySale(provider, tokenId, account) {
  const sale = fujiPrimarySaleAddress();
  if (!sale) return null;
  await assertFujiProvider(provider);
  const saleData = saleIface.encodeFunctionData("sales", [BigInt(tokenId)]);
  const saleResult = await provider.request({ method: "eth_call", params: [{ to: sale, data: saleData }, "latest"] });
  const decoded = decodeSale(saleResult);
  let purchased = 0n;
  if (account && ethers.isAddress(account)) {
    const walletData = saleIface.encodeFunctionData("walletPurchased", [BigInt(tokenId), account]);
    const walletResult = await provider.request({ method: "eth_call", params: [{ to: sale, data: walletData }, "latest"] });
    purchased = BigInt(saleIface.decodeFunctionResult("walletPurchased", walletResult)[0]);
  }
  const remaining = decoded.maxSupply > decoded.sold ? decoded.maxSupply - decoded.sold : 0n;
  return { ...decoded, purchased, remaining, address: sale };
}

export async function ensureFujiNetwork(provider) {
  try {
    await assertFujiProvider(provider);
    return;
  } catch (error) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: FUJI_RELEASE_CONFIG.chainHexId }] });
      await assertFujiProvider(provider);
    } catch (switchError) {
      if (switchError?.code === 4001) throw switchError;
      throw error;
    }
  }
}

export async function collectEdition({ provider, from, tokenId, qty, priceWei }) {
  const sale = fujiPrimarySaleAddress();
  if (!sale) throw new Error("Primary sale is not configured on Fuji yet.");
  await ensureFujiNetwork(provider);
  const quantity = BigInt(qty);
  const value = purchaseCost(priceWei, quantity);
  const data = encodePurchase(tokenId, quantity);
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: sale, data, value: ethers.toQuantity(value) }, "latest"] });
  } catch (error) {
    const explained = explainCollectError(error);
    if (explained.state !== "unavailable") throw Object.assign(new Error(explained.message), { state: explained.state, cause: error });
    throw error;
  }
  return sendFujiTransaction({ provider, from, data, to: sale, value });
}

export { fujiExplorerUrl };
