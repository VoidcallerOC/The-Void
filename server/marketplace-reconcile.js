import { retry } from "./indexer-utils.js";
import { MarketplaceEventError, decodeMarketplaceListingResult } from "./marketplace-events.js";

export async function reconcileMarketplaceListing({ rpc, store, chainId, marketplaceAddress, listingId, blockTag = "finalized", retryOptions = {} } = {}) {
  if (!rpc?.getMarketplaceListing || !store?.reconcileMarketplaceListing) throw new TypeError("Marketplace reconciliation requires RPC listing reads and a reconciliation store.");
  const snapshot = await retry(async () => {
    const result = await rpc.getMarketplaceListing({ chainId, marketplaceAddress, listingId, blockTag });
    return typeof result === "string" ? decodeMarketplaceListingResult(result) : result;
  }, retryOptions);
  const context = { chainId: Number(chainId), marketplaceAddress: String(marketplaceAddress).toLowerCase(), listingId: String(listingId), blockTag };
  if (!snapshot) return store.reconcileMarketplaceListing({ ...context, snapshot: null });
  if (snapshot.currency !== "native") throw new MarketplaceEventError("Only native-currency marketplace listings are supported.");
  return store.reconcileMarketplaceListing({ ...context, snapshot });
}

export async function reconcileMarketplaceTransaction({ rpc, store, chainId, transactionHash, confirmations = 12, retryOptions = {} } = {}) {
  if (!rpc?.getTransactionReceipt || !rpc?.getBlockNumber || !store?.reconcileMarketplaceTransaction) throw new TypeError("Marketplace transaction reconciliation requires transaction RPC reads and a reconciliation store.");
  const receipt = await retry(() => rpc.getTransactionReceipt({ chainId, transactionHash }), retryOptions);
  const context = { chainId: Number(chainId), transactionHash: String(transactionHash).toLowerCase() };
  if (!receipt) return store.reconcileMarketplaceTransaction({ ...context, state: "PENDING", receipt: null });
  if (String(receipt.status).toLowerCase() === "0x0") return store.reconcileMarketplaceTransaction({ ...context, state: "FAILED", receipt });
  const latestBlock = Number(await retry(() => rpc.getBlockNumber(chainId), retryOptions));
  const receiptBlock = Number(receipt.blockNumber);
  const state = latestBlock - receiptBlock >= Number(confirmations) ? "FINALIZED" : "CONFIRMED";
  return store.reconcileMarketplaceTransaction({ ...context, state, receipt });
}
