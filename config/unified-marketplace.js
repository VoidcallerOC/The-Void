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

/** True only for the manifest's active marketplace: the one every new listing is created on. */
export function isActiveUnifiedMarketplace(address, config = UNIFIED_MARKETPLACE) {
  return unifiedMarketplaceActive(config) && same(config.marketplaceAddress, address);
}

// An earlier VoidUnifiedMarketplace stays recorded under `retainedMarketplaces` after the manifest moves new listings to a
// new instance (for example when a new factory needs its own marketplace). Its existing listings stay readable, buyable,
// cancellable and indexed; no new listing is ever created on it. Each entry carries its own deployment block and its own
// two factories (its immutables); the chain, fee recipient, fee policy and Genesis collection are the manifest's.
function validRetainedEntry(entry, config) {
  return ADDRESS.test(String(entry?.marketplaceAddress || ""))
    && !same(entry.marketplaceAddress, config.marketplaceAddress)
    && ADDRESS.test(String(entry.releaseFactoryAddress || ""))
    && (entry.legacyReleaseFactoryAddress == null || entry.legacyReleaseFactoryAddress === "" || ADDRESS.test(String(entry.legacyReleaseFactoryAddress)))
    && Number.isSafeInteger(entry.deploymentBlock) && entry.deploymentBlock >= 0;
}

/** Every retained marketplace as a manifest of its own (same shape as the active one), or [] when there are none. */
export function retainedUnifiedMarketplaces(config = UNIFIED_MARKETPLACE) {
  if (!unifiedMarketplaceActive(config) || !Array.isArray(config.retainedMarketplaces)) return [];
  return config.retainedMarketplaces.filter((entry) => validRetainedEntry(entry, config)).map((entry) => {
    const shared = { ...config };
    delete shared.retainedMarketplaces;
    return Object.freeze({
      ...shared,
      marketplaceAddress: entry.marketplaceAddress,
      deploymentBlock: entry.deploymentBlock,
      releaseFactoryAddress: entry.releaseFactoryAddress,
      legacyReleaseFactoryAddress: entry.legacyReleaseFactoryAddress || "",
      retained: true,
    });
  });
}

/** The manifest view (factories, block) of one unified marketplace, active or retained; null for any other address. */
export function unifiedMarketplaceFor(address, config = UNIFIED_MARKETPLACE) {
  if (isActiveUnifiedMarketplace(address, config)) return config;
  return retainedUnifiedMarketplaces(config).find((entry) => same(entry.marketplaceAddress, address)) || null;
}

/** True for the active unified marketplace or a retained one. New listings must still use `isActiveUnifiedMarketplace`. */
export function isUnifiedMarketplace(address, config = UNIFIED_MARKETPLACE) {
  return Boolean(unifiedMarketplaceFor(address, config));
}

/** The retained marketplaces that accept this asset under their own factories: where its existing listings may be. */
export function retainedUnifiedMarketplacesFor({ chainId, contractAddress, tokenId, factoryAddress }, config = UNIFIED_MARKETPLACE) {
  return retainedUnifiedMarketplaces(config).filter((entry) => unifiedAssetClass({ chainId, contractAddress, tokenId, factoryAddress }, entry));
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
