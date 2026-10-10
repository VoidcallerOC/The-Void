import process from "node:process";
import { Interface, getAddress, isAddress } from "ethers";
import { primarySaleAvailability } from "../src/lib/primary-sale-availability.js";

// Live sale state for release-per-contract editions. The indexer projects only
// Purchased events, so price, cap, window and pause come from the sale's
// sales(tokenId) view. Reads are cached briefly; a failed read returns null and
// the edition is served without sale state (the storefront then reads it).
const SALE_ABI = ["function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)"];
const saleIface = new Interface(SALE_ABI);

export function createPrimarySaleStateReader({ url, chainId, fetchImpl = fetch, timeoutMs = 5_000, ttlMs = 30_000, now = Date.now } = {}) {
  if (!url || !Number(chainId)) return null;
  const cache = new Map();
  let requestId = 0;
  async function call(to, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "eth_call", params: [{ to, data }, "latest"] }), signal: controller.signal });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "eth_call failed");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    chainId: Number(chainId),
    async readSale({ chainId: rowChainId, saleAddress, tokenId }) {
      if (Number(rowChainId) !== Number(chainId) || !isAddress(String(saleAddress || "")) || !/^\d+$/.test(String(tokenId ?? ""))) return null;
      const to = getAddress(String(saleAddress));
      const key = `${to.toLowerCase()}:${tokenId}`;
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return cached.value;
      const decoded = saleIface.decodeFunctionResult("sales", await call(to, saleIface.encodeFunctionData("sales", [BigInt(tokenId)])));
      const value = {
        priceWei: decoded[0].toString(),
        maxSupply: decoded[1].toString(),
        sold: decoded[2].toString(),
        perWalletLimit: decoded[3].toString(),
        startTime: decoded[4].toString(),
        endTime: decoded[5].toString(),
        paused: Boolean(decoded[6]),
        configured: Boolean(decoded[7]),
      };
      cache.set(key, { value, expires: now() + ttlMs });
      return value;
    },
  };
}

export function primarySaleStateReaderFromEnv({ env = process.env, indexerConfig = null, fetchImpl = fetch } = {}) {
  const url = indexerConfig?.rpcUrl || String(env.INDEXER_RPC_URL || "").trim();
  const chainId = indexerConfig?.chainId || Number(env.INDEXER_CHAIN_ID || 0);
  return createPrimarySaleStateReader({ url, chainId, fetchImpl });
}

/** Public edition fields: the raw sale tuple and its availability state. */
export function publicSaleFields(sale, { editionSupply = null, now = Date.now() } = {}) {
  if (!sale) return {};
  const availability = primarySaleAvailability(sale, { editionSupply, now });
  return {
    primary_sale: {
      configured: sale.configured,
      paused: sale.paused,
      price_wei: sale.priceWei,
      max_supply: sale.maxSupply,
      sold: sale.sold,
      per_wallet_limit: sale.perWalletLimit,
      start_time: sale.startTime,
      end_time: sale.endTime,
    },
    primary_availability: availability.state,
    open_edition: availability.openEdition,
  };
}
