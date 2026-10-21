import manifest from "./legacy-collection-marketplace.json" with { type: "json" };

// LegacyCollectionMarketplace serves an explicit allowlist of legacy ERC-1155 collections (Genesis) that The Void's
// release factory did not create. The manifest stays `deployed: false` until a deployment is verified and recorded
// here, which keeps every consumer (listing UI, marketplace selection, indexer) inert until then.
// Genesis policy (locked 2026-10-21): 0% platform fee / the collection's full ERC-2981 royalty / the rest to the seller. The
// contract has no fee recipient and a constant `platformFeeBps` of 0; a manifest recording any other fee never activates.
export const LEGACY_COLLECTION_MARKETPLACE = Object.freeze(manifest);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function legacyMarketplaceActive(config = LEGACY_COLLECTION_MARKETPLACE) {
  return config?.deployed === true
    && config.platformFeeBps === 0
    && ADDRESS.test(String(config.marketplaceAddress || ""))
    && Number.isSafeInteger(config.deploymentBlock) && config.deploymentBlock >= 0
    && Array.isArray(config.collections) && config.collections.length > 0;
}

/** The allowlisted collection policy for one asset, or null (also null while the marketplace is not deployed). */
export function legacyCollectionFor({ chainId, contractAddress, tokenId }, config = LEGACY_COLLECTION_MARKETPLACE) {
  if (!legacyMarketplaceActive(config) || Number(chainId) !== Number(config.chainId)) return null;
  if (tokenId === undefined || tokenId === null || !/^\d+$/.test(String(tokenId))) return null;
  const id = BigInt(tokenId);
  return config.collections.find((item) => same(item.address, contractAddress) && id >= BigInt(item.minTokenId) && id <= BigInt(item.maxTokenId)) || null;
}

export function isLegacyMarketplace(address, config = LEGACY_COLLECTION_MARKETPLACE) {
  return legacyMarketplaceActive(config) && same(config.marketplaceAddress, address);
}
