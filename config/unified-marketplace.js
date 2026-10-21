import manifest from "./unified-marketplace.json" with { type: "json" };

// VoidUnifiedMarketplace is the single resale marketplace for Genesis and factory releases (corrected factory and the
// production factory 0x262B…757b). This manifest is the one source of truth for its address. It stays `deployed: false`
// until a deployment is verified and recorded, which keeps every consumer (routing, listing UI, indexer) inert until then.
export const UNIFIED_MARKETPLACE = Object.freeze(manifest);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function unifiedMarketplaceActive(config = UNIFIED_MARKETPLACE) {
  return config?.deployed === true
    && ADDRESS.test(String(config.marketplaceAddress || ""))
    && ADDRESS.test(String(config.releaseFactoryAddress || ""))
    && Number.isSafeInteger(config.deploymentBlock) && config.deploymentBlock >= 0
    && ADDRESS.test(String(config.genesis?.address || ""));
}

export function isUnifiedMarketplace(address, config = UNIFIED_MARKETPLACE) {
  return unifiedMarketplaceActive(config) && same(config.marketplaceAddress, address);
}

/** True when `tokenId` of `contractAddress` is the approved Genesis collection range. Does not depend on deployment. */
export function isGenesisAsset(contractAddress, tokenId, config = UNIFIED_MARKETPLACE) {
  if (!same(config?.genesis?.address, contractAddress) || !/^\d+$/.test(String(tokenId ?? ""))) return false;
  const id = BigInt(tokenId);
  return id >= BigInt(config.genesis.minTokenId) && id <= BigInt(config.genesis.maxTokenId);
}

/** "GENESIS", "FACTORY_RELEASE" or null, mirroring VoidUnifiedMarketplace.assetClassOf (the contract stays authoritative). */
export function unifiedAssetClass({ chainId, contractAddress, tokenId, factoryAddress }, config = UNIFIED_MARKETPLACE) {
  if (!unifiedMarketplaceActive(config) || Number(chainId) !== Number(config.chainId)) return null;
  if (same(config.genesis.address, contractAddress)) return isGenesisAsset(contractAddress, tokenId, config) ? "GENESIS" : null;
  if (same(config.releaseFactoryAddress, factoryAddress) || same(config.legacyReleaseFactoryAddress, factoryAddress)) return "FACTORY_RELEASE";
  return null;
}

/** Expected platform fee for a sale on the unified marketplace: 0 bps for Genesis, 250 bps for factory releases. */
export function unifiedPlatformFeeBps(tokenContract, config = UNIFIED_MARKETPLACE) {
  return same(config?.genesis?.address, tokenContract) ? Number(config.genesis.platformFeeBps) : Number(config.factoryPlatformFeeBps);
}
