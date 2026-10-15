import { marketplaceInterface } from "./marketplace-events.js";

function hex(value) { return `0x${BigInt(value).toString(16)}`; }

/** Structured RPC transport failure so retries can honor status + Retry-After. */
export class RpcHttpError extends Error {
  constructor(status, { retryAfterMs = null } = {}) {
    super(`RPC HTTP ${status}`);
    this.name = "RpcHttpError";
    this.status = Number(status);
    this.retryAfterMs = retryAfterMs == null ? null : Number(retryAfterMs);
    this.retryable = this.status === 429 || this.status >= 500;
  }
}

/** Parse Retry-After as delta-seconds or HTTP-date into milliseconds. */
export function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue == null || headerValue === "") return null;
  const text = String(headerValue).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  const when = Date.parse(text);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - Number(now));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
}

function markRetryable(error, { retryable = true } = {}) {
  if (error && typeof error === "object") error.retryable = retryable;
  return error;
}

export function createJsonRpcClient({ url, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!url) throw new TypeError("RPC URL is required.");
  let requestId = 0;
  async function call(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: controller.signal });
      } catch (error) {
        if (error?.name === "AbortError") throw markRetryable(error);
        const wrapped = markRetryable(new Error(error?.message || "RPC network error"));
        wrapped.name = "RpcNetworkError";
        wrapped.cause = error;
        throw wrapped;
      }
      if (!response.ok) {
        throw new RpcHttpError(response.status, {
          retryAfterMs: parseRetryAfterMs(headerValue(response.headers, "retry-after")),
        });
      }
      const body = await response.json();
      if (body.error) throw markRetryable(new Error(body.error.message || `RPC ${method} failed`), { retryable: true });
      return body.result;
    } finally { clearTimeout(timer); }
  }
  return {
    async getBlockNumber() { return Number(BigInt(await call("eth_blockNumber", []))); },
    async getLogs({ address, fromBlock, toBlock, topics = undefined }) { return (await call("eth_getLogs", [{ address, fromBlock: hex(fromBlock), toBlock: hex(toBlock), ...(topics ? { topics } : {}) }])).map((log) => ({ ...log, blockNumber: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)) })); },
    async getBlock(_chainId, blockNumber) { const block = await call("eth_getBlockByNumber", [hex(blockNumber), false]); if (!block) throw new Error(`Block ${blockNumber} was not found.`); return { number: Number(BigInt(block.number)), hash: block.hash, parentHash: block.parentHash, timestamp: Number(BigInt(block.timestamp)) }; },
    async getTransactionReceipt({ transactionHash }) { return call("eth_getTransactionReceipt", [transactionHash]); },
    async getMarketplaceListing({ marketplaceAddress, listingId, blockTag = "finalized" }) { return call("eth_call", [{ to: marketplaceAddress, data: marketplaceInterface.encodeFunctionData("getListing", [listingId]) }, blockTag]); },
    async getBalanceOf({ address, contractAddress, tokenId, blockTag = "latest" }) { const data = `0x00fdd58e${address.slice(2).padStart(64, "0")}${BigInt(tokenId).toString(16).padStart(64, "0")}`; return BigInt(await call("eth_call", [{ to: contractAddress, data }, blockTag])); },
  };
}
