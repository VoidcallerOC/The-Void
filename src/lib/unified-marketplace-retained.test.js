import { describe, expect, it, vi } from "vitest";
import {
  UNIFIED_MARKETPLACE,
  isActiveUnifiedMarketplace,
  isUnifiedMarketplace,
  retainedUnifiedMarketplaces,
  retainedUnifiedMarketplacesFor,
  unifiedAssetClass,
  unifiedMarketplaceFor,
} from "../../config/unified-marketplace.js";
import { marketplaceConfigForEdition } from "./marketplace.js";
import { readUnifiedListingContext } from "./secondary-listing.js";
import { withUnifiedMarketplace } from "../../server/config.js";

// The launch switch: new listings move to the VoidUnifiedMarketplace 0x0F59 (sequential factory + 0x262B), while the
// earlier marketplace 0x75964 (0xE744 + 0x262B) is retained for the listings it already holds. `switched` is a fixture
// of that shape with its own block; the committed manifest is checked separately below.
const OLD_MARKET = "0x75964C44cA586b13e98e7c30E74d2B4114f65b06";
const NEW_MARKET = "0x0F5930113Ec750d867741E05F302053472115eb2";
const SEQUENTIAL_FACTORY = "0xEa0c345cE84025b4e8462d145100dce1848254B4";
const CURRENT_FACTORY = "0xE744D58fA8138042f5f00a28d39f89081539C19B";
const PRODUCTION_FACTORY = "0x262B774cf9a1949170B58E2d57F6189980FE757b";
const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
const CLONE = "0x0000000000000000000000000000000000000123";
const SELLER = "0x00000000000000000000000000000000000b0b01";
const switched = Object.freeze({
  ...UNIFIED_MARKETPLACE,
  marketplaceAddress: NEW_MARKET,
  deploymentBlock: 98400000,
  releaseFactoryAddress: SEQUENTIAL_FACTORY,
  legacyReleaseFactoryAddress: PRODUCTION_FACTORY,
  retainedMarketplaces: [{ marketplaceAddress: OLD_MARKET, deploymentBlock: 98161532, releaseFactoryAddress: CURRENT_FACTORY, legacyReleaseFactoryAddress: PRODUCTION_FACTORY }],
});

describe("retained unified marketplaces", () => {
  it("the committed manifest lists on 0x0F59 and retains exactly 0x75964 for its existing listings", () => {
    expect(retainedUnifiedMarketplaces().map((entry) => entry.marketplaceAddress)).toEqual([OLD_MARKET]);
    expect(isActiveUnifiedMarketplace(NEW_MARKET)).toBe(true);
    expect(isActiveUnifiedMarketplace(OLD_MARKET)).toBe(false);
    expect(isUnifiedMarketplace(OLD_MARKET)).toBe(true);
    expect(unifiedMarketplaceFor(NEW_MARKET)).toBe(UNIFIED_MARKETPLACE);
    expect(unifiedMarketplaceFor(OLD_MARKET)).toMatchObject({ marketplaceAddress: OLD_MARKET, deploymentBlock: 98161532, releaseFactoryAddress: CURRENT_FACTORY, legacyReleaseFactoryAddress: PRODUCTION_FACTORY, retained: true });
    // The live Genesis listing (token 0) on 0x75964 stays reachable; new sequential releases never route there.
    expect(retainedUnifiedMarketplacesFor({ chainId: 43114, contractAddress: GENESIS, tokenId: "0" }).map((entry) => entry.marketplaceAddress)).toEqual([OLD_MARKET]);
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: SEQUENTIAL_FACTORY })).toBe("FACTORY_RELEASE");
    expect(retainedUnifiedMarketplacesFor({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: SEQUENTIAL_FACTORY })).toEqual([]);
  });

  it("recognises a retained marketplace without making it the active one", () => {
    expect(isUnifiedMarketplace(OLD_MARKET, switched)).toBe(true);
    expect(isActiveUnifiedMarketplace(OLD_MARKET, switched)).toBe(false);
    expect(isActiveUnifiedMarketplace(NEW_MARKET, switched)).toBe(true);
    expect(isUnifiedMarketplace("0x0000000000000000000000000000000000000999", switched)).toBe(false);
    expect(unifiedMarketplaceFor(OLD_MARKET, switched)).toMatchObject({ marketplaceAddress: OLD_MARKET, deploymentBlock: 98161532, releaseFactoryAddress: CURRENT_FACTORY, legacyReleaseFactoryAddress: PRODUCTION_FACTORY, retained: true, genesis: UNIFIED_MARKETPLACE.genesis });
  });

  it("classifies a retained marketplace's assets with its own factories, not the active one's", () => {
    const old = unifiedMarketplaceFor(OLD_MARKET, switched);
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: CURRENT_FACTORY }, old)).toBe("FACTORY_RELEASE");
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: SEQUENTIAL_FACTORY }, old)).toBeNull();
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: CURRENT_FACTORY }, switched)).toBeNull();
    expect(retainedUnifiedMarketplacesFor({ chainId: 43114, contractAddress: GENESIS, tokenId: "0" }, switched).map((entry) => entry.marketplaceAddress)).toEqual([OLD_MARKET]);
    expect(retainedUnifiedMarketplacesFor({ chainId: 43114, contractAddress: GENESIS, tokenId: "4" }, switched)).toEqual([]);
    expect(retainedUnifiedMarketplacesFor({ chainId: 43114, contractAddress: CLONE, tokenId: "1", factoryAddress: SEQUENTIAL_FACTORY }, switched)).toEqual([]);
  });

  it("ignores malformed retained entries and one that repeats the active address", () => {
    const messy = { ...switched, retainedMarketplaces: [{ marketplaceAddress: NEW_MARKET, deploymentBlock: 1, releaseFactoryAddress: CURRENT_FACTORY }, { marketplaceAddress: "nope", deploymentBlock: 1, releaseFactoryAddress: CURRENT_FACTORY }, { marketplaceAddress: OLD_MARKET, releaseFactoryAddress: CURRENT_FACTORY }, { marketplaceAddress: OLD_MARKET, deploymentBlock: 1, releaseFactoryAddress: "" }] };
    expect(retainedUnifiedMarketplaces(messy)).toEqual([]);
    expect(retainedUnifiedMarketplaces({ ...switched, deployed: false })).toEqual([]);
  });

  it("routes every new listing to the active marketplace, Genesis included", () => {
    const base = Object.freeze({ address: NEW_MARKET, chainId: 43114, enabled: true });
    expect(marketplaceConfigForEdition({ chainId: 43114, contractAddress: GENESIS, tokenIds: [0, 1, 2, 3] }, base, undefined, switched)).toMatchObject({ address: NEW_MARKET, assetClass: "GENESIS" });
  });

  it("refuses to prepare a new listing on a retained marketplace", async () => {
    const provider = { request: vi.fn() };
    await expect(readUnifiedListingContext({ provider, marketplaceAddress: OLD_MARKET, marketplaceChainId: 43114, tokenContractAddress: GENESIS, tokenId: "0", seller: SELLER }, switched))
      .rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE", message: expect.stringMatching(/only settles its existing listings/) });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("indexes the active and every retained marketplace from their own blocks, replacing single-fee entries", () => {
    const manifestEntry = { chainId: 43114, address: OLD_MARKET.toLowerCase(), contractType: "MARKETPLACE", startBlock: 98161532, platformFeeBps: 250 };
    const contracts = withUnifiedMarketplace([manifestEntry], { chainId: 43114, manifest: switched });
    const markets = contracts.filter((contract) => contract.contractType === "MARKETPLACE");
    expect(markets).toEqual([
      expect.objectContaining({ address: NEW_MARKET.toLowerCase(), startBlock: 98400000, feePolicy: "unified", platformFeeBps: null }),
      expect.objectContaining({ address: OLD_MARKET.toLowerCase(), startBlock: 98161532, feePolicy: "unified", platformFeeBps: null }),
    ]);
  });

  it("indexes the committed active marketplace and the retained one, each from its own deployment block", () => {
    const contracts = withUnifiedMarketplace([], { chainId: 43114, manifest: UNIFIED_MARKETPLACE });
    expect(contracts).toEqual([
      expect.objectContaining({ address: NEW_MARKET.toLowerCase(), startBlock: 98367443, feePolicy: "unified" }),
      expect.objectContaining({ address: OLD_MARKET.toLowerCase(), startBlock: 98161532, feePolicy: "unified" }),
    ]);
  });

  it("indexes exactly one marketplace when nothing is retained", () => {
    const contracts = withUnifiedMarketplace([], { chainId: 43114, manifest: { ...UNIFIED_MARKETPLACE, retainedMarketplaces: [] } });
    expect(contracts).toEqual([expect.objectContaining({ address: NEW_MARKET.toLowerCase(), startBlock: 98367443, feePolicy: "unified" })]);
  });
});
