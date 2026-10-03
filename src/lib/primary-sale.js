import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, assertFujiProvider, fujiExplorerUrl, sendFujiTransaction } from "./fuji-release.js";
import { normalizeSaleTimeToUnixSeconds } from "./sale-time.js";

export const FUJI_RPC_TIMEOUT_MS = 10_000;

export class FujiRpcTimeoutError extends Error {
  constructor(method, timeoutMs = FUJI_RPC_TIMEOUT_MS) {
    super(`The Fuji public RPC timed out while handling ${method}. Please try again.`);
    this.name = "FujiRpcTimeoutError";
    this.code = "FUJI_RPC_TIMEOUT";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class FujiRpcUnavailableError extends Error {
  constructor(method, cause) {
    super(`The Fuji public RPC is unavailable while handling ${method}. Please try again later.`);
    this.name = "FujiRpcUnavailableError";
    this.code = "FUJI_RPC_UNAVAILABLE";
    this.method = method;
    this.cause = cause;
  }
}

export function createFujiPublicProvider({ fetchImpl = globalThis.fetch, rpcUrl = FUJI_RELEASE_CONFIG.rpcUrl, timeoutMs = FUJI_RPC_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("The browser does not provide fetch for the Fuji public RPC.");
  return {
    async request({ method, params = [] } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let raceTimer;
      try {
        const operation = (async () => {
          let response;
          try {
            response = await fetchImpl(rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
              signal: controller.signal,
            });
          } catch (error) {
            if (error?.name === "AbortError") throw new FujiRpcTimeoutError(method, timeoutMs);
            throw new FujiRpcUnavailableError(method, error);
          }
          let json;
          try { json = await response.json(); } catch (error) { throw new FujiRpcUnavailableError(method, error); }
          if (!response.ok || json?.error) {
            const error = new Error(json?.error?.message || `HTTP ${response.status}`);
            error.data = json?.error?.data;
            error.rpcCode = json?.error?.code;
            throw error;
          }
          return json?.result;
        })();
        return await Promise.race([operation, new Promise((_, reject) => { raceTimer = setTimeout(() => reject(new FujiRpcTimeoutError(method, timeoutMs)), timeoutMs); })]);
      } finally {
        clearTimeout(timer);
        clearTimeout(raceTimer);
      }
    },
  };
}

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
// purchase() mints through the release contract, so its reverts can carry the
// release contract's errors instead of the sale's.
const releaseErrorIface = new ethers.Interface([
  "error AccessDenied(bytes32 role, address account)",
  "error ContractPaused()",
  "error EditionNotFound(uint256 tokenId)",
  "error InactiveEdition(uint256 tokenId)",
  "error ExceedsSupply(uint256 tokenId, uint256 available, uint256 requested)",
]);

export function fujiPrimarySaleAddress() {
  const value = String(FUJI_RELEASE_CONFIG.primarySaleAddress || "").trim();
  if (!ethers.isAddress(value) || ethers.getAddress(value) === ethers.ZeroAddress) return "";
  return ethers.getAddress(value);
}

export function fujiReleaseIsV2() {
  return FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155V2";
}

function wholeSupply(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0n;
  return BigInt(value);
}

export function encodeConfigureSale({ tokenId, priceWei, maxSupply, perWalletLimit, startTime = 0, endTime = 0, paused = false, openEdition = false }) {
  const price = BigInt(priceWei);
  const supply = wholeSupply(maxSupply);
  const limit = wholeSupply(perWalletLimit);
  const start = BigInt(normalizeSaleTimeToUnixSeconds(startTime));
  const end = BigInt(normalizeSaleTimeToUnixSeconds(endTime));
  if (price <= 0n) throw new Error("Sale price must be greater than zero.");
  if (supply < 0n || limit < 0n) throw new Error("Sale supply and per-wallet limit must be whole numbers.");
  if (openEdition) {
    // The sale end time is the close. An unlimited edition cannot omit it.
    if (end === 0n) throw new Error("An unlimited edition must have a sale end time. That end time closes the edition.");
    // Supply 0 means the sale itself does not cap copies. Limit 0 means no per-wallet cap.
    if (supply !== 0n && limit !== 0n && limit > supply) throw new Error("Per-wallet limit must be between 1 and the sale supply.");
  } else {
    if (supply <= 0n) throw new Error("Sale supply must be greater than zero.");
    if (limit <= 0n || limit > supply) throw new Error("Per-wallet limit must be between 1 and the sale supply.");
  }
  if (end !== 0n && start !== 0n && end < start) throw new Error("Sale end must be after the start.");
  return saleIface.encodeFunctionData("configureSale", [BigInt(tokenId), price, supply, limit, start, end, Boolean(paused)]);
}

export function validateSaleSupply(requestedSaleSupply, editionSupply) {
  const requested = wholeSupply(requestedSaleSupply);
  const maximum = wholeSupply(editionSupply);
  if (requested < 0n) throw new Error("Sale supply must be a whole number.");
  // Edition supply 0 is unlimited. The sale may also be uncapped (0) or set its own cap.
  if (maximum === 0n) return requested;
  if (requested <= 0n) throw new Error("Sale supply must be greater than zero.");
  if (requested > maximum) throw new Error(`Sale supply exceeds edition supply. This edition contains ${maximum.toString()} copies. Set the sale supply to ${maximum.toString()} or fewer.`);
  return requested;
}

export function saleIsSoldOut(sale) {
  return Boolean(sale && sale.maxSupply !== 0n && sale.remaining === 0n);
}

export function walletLimitReached(sale) {
  return Boolean(sale && sale.perWalletLimit !== 0n && sale.purchased >= sale.perWalletLimit);
}

export async function simulateConfigureSale(provider, { from, data, value = 0 } = {}) {
  await assertFujiProvider(provider);
  if (!ethers.isAddress(from)) throw new Error("A connected wallet is required.");
  const sale = fujiPrimarySaleAddress();
  if (!sale) throw new Error("Primary sale is not configured on Fuji yet.");
  try {
    return await provider.request({ method: "eth_call", params: [{ from, to: sale, data, value: ethers.toQuantity(BigInt(value)), gas: SIMULATION_GAS }, "latest"] });
  } catch (error) {
    if (error?.code === "FUJI_RPC_TIMEOUT" || error?.code === "FUJI_RPC_UNAVAILABLE") throw error;
    throw Object.assign(new Error(`Sale configuration simulation reverted on Fuji: ${error?.shortMessage || error?.message || "execution reverted"}`), {
      code: "CONFIGURE_SALE_SIMULATION_REVERTED",
      cause: error,
    });
  }
}

export function explainConfigureSaleError(error) {
  if (error?.code === "FUJI_RPC_TIMEOUT") return { code: error.code, message: error.message };
  if (error?.code === "FUJI_RPC_UNAVAILABLE") return { code: error.code, message: error.message };
  if (error?.code === "CONFIGURE_SALE_SIMULATION_REVERTED") return { code: error.code, message: error.message };
  if (error?.code === "CHAIN_MISMATCH") return { code: error.code, message: error.message };
  if (error?.code === "WALLET_PROVIDER_UNAVAILABLE") return { code: error.code, message: error.message };
  if (error?.code === 4001 || error?.code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(String(error?.message || ""))) {
    return { code: "TRANSACTION_REJECTED", message: "Transaction rejected in the wallet. No sale was configured." };
  }
  if (error?.code === "TRANSACTION_SUBMISSION_FAILED") return { code: error.code, message: error.message };
  return { code: error?.code || "CONFIGURE_SALE_FAILED", message: error?.message || "Sale configuration failed. No transaction was submitted." };
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

export function avaxToWei(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Enter a price in AVAX.");
  let wei;
  try {
    wei = ethers.parseEther(text);
  } catch {
    throw new Error("Enter a price in AVAX, like 0.01.");
  }
  if (wei <= 0n) throw new Error("Price must be more than 0 AVAX.");
  return wei.toString();
}

export function weiToAvax(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return text;
  return ethers.formatEther(BigInt(text));
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
    } catch { /* Not a sale error; try the release contract's errors. */ }
    try {
      const parsed = releaseErrorIface.parseError(data);
      if (parsed?.name === "AccessDenied") return { state: "unauthorized-sale", message: "The sale contract is not authorized to mint this release on Fuji (missing ISSUER_ROLE). Nothing was collected." };
      if (parsed?.name === "ContractPaused") return { state: "paused", message: "The certified Fuji release is paused. Nothing was collected." };
      if (parsed?.name === "EditionNotFound") return { state: "not-created", message: "This release hasn't been published on-chain yet." };
      if (parsed?.name === "InactiveEdition") return { state: "closed", message: "This edition is not active on-chain. Nothing was collected." };
      if (parsed?.name === "ExceedsSupply") return { state: "sold-out", message: "This release is sold out." };
    } catch { /* Unknown revert data falls through. */ }
  }
  if (/sold out/i.test(message)) return { state: "sold-out", message: "This release is sold out." };
  if (/insufficient funds/i.test(message)) return { state: "insufficient-funds", message: "This wallet does not have enough Fuji AVAX for the price plus gas. Nothing was collected." };
  if (/revert/i.test(message)) return { state: "reverted", message: `The collect transaction would revert on Fuji: ${message.slice(0, 240)}` };
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
  const unlimited = decoded.maxSupply === 0n;
  const remaining = unlimited ? null : (decoded.maxSupply > decoded.sold ? decoded.maxSupply - decoded.sold : 0n);
  return { ...decoded, purchased, remaining, unlimited, address: sale };
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

// Explicit gas for dry runs: without one, a node can assume its full gas cap
// and require cap x gasPrice + value, reporting "insufficient funds" for a
// wallet that can easily afford the real purchase.
export const SIMULATION_GAS = ethers.toQuantity(500_000n);

export async function collectEdition({ provider, from, tokenId, qty, priceWei }) {
  const sale = fujiPrimarySaleAddress();
  if (!sale) throw new Error("Primary sale is not configured on Fuji yet.");
  await ensureFujiNetwork(provider);
  const quantity = BigInt(qty);
  const value = purchaseCost(priceWei, quantity);
  const data = encodePurchase(tokenId, quantity);
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: sale, data, value: ethers.toQuantity(value), gas: SIMULATION_GAS }, "latest"] });
  } catch (error) {
    const explained = explainCollectError(error);
    if (explained.state !== "unavailable") throw Object.assign(new Error(explained.message), { state: explained.state, cause: error });
    throw error;
  }
  return sendFujiTransaction({ provider, from, data, to: sale, value });
}

export { fujiExplorerUrl };
