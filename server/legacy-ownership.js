import { ApiError } from "./api-errors.js";
import { LEGACY_CHAIN_ID, LEGACY_CONTRACT, isLegacyMainnetRequirement } from "../src/lib/legacy-genesis.js";
import { walletAddress } from "./validation.js";

const BALANCE_OF_SELECTOR = "00fdd58e";
const DEFAULT_CACHE_TTL_MS = 15_000;

function padAddr(addr) {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function padUint(num) {
  return BigInt(num).toString(16).padStart(64, "0");
}

function decodeUint(hex) {
  const body = String(hex || "").replace(/^0x/, "");
  if (!body || body.length > 64) throw new Error("invalid balance encoding");
  return BigInt(`0x${body || "0"}`);
}

export function assertLegacyChainId(chainId) {
  if (Number(chainId) !== LEGACY_CHAIN_ID) {
    throw new ApiError(403, "LEGACY_WRONG_CHAIN", "Legacy collection ownership is only readable on Avalanche C-Chain mainnet (43114).");
  }
}

export class MainnetBalanceClient {
  constructor({ rpcUrl, fetchImpl = fetch, timeoutMs = 8_000, cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
    this.rpcUrl = String(rpcUrl || "").trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
  }

  cacheKey({ wallet, tokenId }) {
    return `${LEGACY_CHAIN_ID}:${LEGACY_CONTRACT}:${wallet}:${tokenId}`;
  }

  async ethCall(data) {
    if (!this.rpcUrl) throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "MAINNET_RPC_URL is not configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: LEGACY_CONTRACT, data }, "latest"] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`rpc http ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "rpc error");
      return body.result;
    } catch (error) {
      throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "Mainnet ownership lookup failed closed.", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async balanceOf({ wallet, tokenId }) {
    const account = walletAddress(wallet);
    const key = this.cacheKey({ wallet: account, tokenId: String(tokenId) });
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheTtlMs) return hit.value;
    const data = `0x${BALANCE_OF_SELECTOR}${padAddr(account)}${padUint(tokenId)}`;
    const result = await this.ethCall(data);
    let amount;
    try {
      amount = decodeUint(result);
    } catch {
      throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "Mainnet ownership lookup failed closed.");
    }
    this.cache.set(key, { at: this.now(), value: amount });
    return amount;
  }
}

export async function verifyLegacyMainnetOwnership({ requirement, wallet, client, experienceId = null }) {
  if (!isLegacyMainnetRequirement(requirement)) {
    throw new ApiError(403, "LEGACY_WRONG_CHAIN", "Requirement is not the mainnet legacy collection.");
  }
  assertLegacyChainId(requirement.chainId);
  const tokenIds = (requirement.tokenIds || []).map(String);
  if (!tokenIds.length) return { owns: false, state: "CONFIRMED", chainId: LEGACY_CHAIN_ID, watermark: null, experienceId };
  try {
    for (const tokenId of tokenIds) {
      const amount = await client.balanceOf({ wallet, tokenId });
      if (amount >= BigInt(requirement.minAmount || 1)) {
        return { owns: true, state: "CONFIRMED", chainId: LEGACY_CHAIN_ID, watermark: `43114:${tokenId}:live`, experienceId, source: "mainnet-rpc" };
      }
    }
    return { owns: false, state: "UNAUTHORIZED", chainId: LEGACY_CHAIN_ID, watermark: null, experienceId, source: "mainnet-rpc" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "MAINNET_RPC_UNAVAILABLE", "Mainnet ownership lookup failed closed.", { cause: error });
  }
}

export function createMainnetBalanceClient(options) {
  return new MainnetBalanceClient(options);
}
