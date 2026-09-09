import { marketplaceInterface } from "./marketplace-events.js";

function hex(value) { return `0x${BigInt(value).toString(16)}`; }

export function createJsonRpcClient({ url, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!url) throw new TypeError("RPC URL is required.");
  let requestId = 0;
  async function call(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || `RPC ${method} failed`);
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
