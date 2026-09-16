import { retry } from "./indexer-utils.js";

export async function reconcileOwnership({ rpc, store, chainId, contractAddress, assets, wallets, blockTag = "finalized", sourceBlock = null, retryOptions = {} } = {}) {
  const results = [];
  for (const wallet of wallets) {
    for (const tokenId of assets) {
      const chainAmount = await retry(() => rpc.getBalanceOf({ address: wallet, contractAddress, tokenId, blockTag }), retryOptions);
      const indexed = await store.getOwnership({ chainId, contractAddress, wallet, tokenId });
      const indexedAmount = BigInt(indexed?.amount || 0);
      const match = indexedAmount === BigInt(chainAmount);
      results.push({ chainId, contractAddress: contractAddress.toLowerCase(), wallet: wallet.toLowerCase(), tokenId: String(tokenId), indexedAmount: indexedAmount.toString(), chainAmount: BigInt(chainAmount).toString(), match, source: blockTag });
      if (!match) {
        await store.recordIndexerError({ chainId, contractAddress, errorType: "OWNERSHIP_MISMATCH", message: "Indexed ownership differs from blockchain balance.", payload: results.at(-1) });
        if (store.reconcileOwnership) await store.reconcileOwnership({ chainId, contractAddress, wallet, tokenId, amount: BigInt(chainAmount).toString(), sourceBlock, watermark: `RECONCILED:${blockTag}` });
      }
    }
  }
  return results;
}
