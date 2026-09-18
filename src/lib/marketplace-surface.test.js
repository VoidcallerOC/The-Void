import { describe, expect, it } from "vitest";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { MARKETPLACE_CONFIG } from "./marketplace.js";
import {
  MARKETPLACE_STATE,
  attachIndexedListings,
  certifiedFujiReleaseUnchanged,
  findMarketplaceEdition,
  formatWeiAsAvax,
  listingMatchesEdition,
  listingsForEdition,
  marketplaceCatalog,
  parseAvaxToWei,
  primaryCollectForEdition,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
  secondaryTradingIsLive,
} from "./marketplace-surface.js";
import { FUJI_INTEGRATION_CATALOG, VOIDCALLER_CATALOG } from "../data.js";

const indexedListing = {
  listingId: "7",
  seller: "0x1111111111111111111111111111111111111111",
  chain: 43113,
  tokenContract: FUJI_RELEASE_CONFIG.contractAddress,
  tokenId: String(FUJI_INTEGRATION_CATALOG.editions[0].tokenIds[0]),
  amount: "1",
  price: "10000000000000000",
  status: "ACTIVE",
  authority: "INDEXED",
};

describe("marketplace infrastructure status", () => {
  it("is implemented / not live when no marketplace contract is configured", () => {
    expect(MARKETPLACE_CONFIG.enabled).toBe(false);
    expect(MARKETPLACE_CONFIG.address).toBe("");
    expect(resolveInfrastructureStatus()).toBe(MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE);
    expect(secondaryTradingIsLive()).toBe(false);
    expect(resolveSecondaryStatus()).toBe(MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE);
  });

  it("never treats catalog or fixture records as live trading", () => {
    const catalog = marketplaceCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((record) => record.editions.every((item) => !item.listings))).toBe(true);
    expect(listingsForEdition(undefined, VOIDCALLER_CATALOG.editions[0])).toEqual([]);
    expect(attachIndexedListings({ catalogs: [VOIDCALLER_CATALOG], listings: [] })).toEqual([]);
  });

  it("is live only when a valid marketplace address and chain are configured", () => {
    expect(resolveInfrastructureStatus({ enabled: true, address: "0x262B774cf9a1949170B58E2d57F6189980FE757b", chainId: 43113 })).toBe(MARKETPLACE_STATE.LIVE);
    expect(resolveInfrastructureStatus({ enabled: true, address: "not-an-address", chainId: 43113 })).toBe(MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE);
    expect(resolveSecondaryStatus({ infrastructure: MARKETPLACE_STATE.LIVE, listingsState: "error" })).toBe(MARKETPLACE_STATE.UNAVAILABLE);
    expect(resolveSecondaryStatus({ infrastructure: MARKETPLACE_STATE.LIVE, listingsState: "ready" })).toBe(MARKETPLACE_STATE.LIVE);
  });
});

describe("music-native catalog projection", () => {
  it("projects artist → release → edition → experience without token IDs as the product", () => {
    const summit = marketplaceCatalog().find((record) => record.release.id === "summit-demo-release");
    expect(summit.artist.name).toBe("THE VOID");
    expect(summit.release.title).toContain("SUMMIT");
    expect(summit.editions[0].edition.title).toBe("SUMMIT EDITION");
    expect(summit.editions[0].experiences[0].title).toBe("THE VOID — SUMMIT SESSION");
    expect(summit.editions[0].primary.href).toBe("/fuji-integration");
    expect(summit.editions[0].primary.status).toBe(MARKETPLACE_STATE.IMPLEMENTED_NOT_LIVE);
  });

  it("keeps the certified Summit Fuji configuration untouched", () => {
    expect(certifiedFujiReleaseUnchanged()).toBe(true);
    expect(FUJI_RELEASE_CONFIG.chainId).toBe(43113);
    expect(FUJI_RELEASE_CONFIG.contractName).toBe("VoidRelease1155");
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
    expect(findMarketplaceEdition("summit-demo-edition").edition.contractAddress).toBe(FUJI_RELEASE_CONFIG.contractAddress);
  });

  it("labels minted Voidcaller relics as primary-complete, not as live secondary listings", () => {
    const primary = primaryCollectForEdition(VOIDCALLER_CATALOG.editions[0]);
    expect(primary.availability).toBe("minted");
    expect(primary.href).toBe("/reliquary");
    expect(listingMatchesEdition({ tokenContract: VOIDCALLER_CATALOG.editions[0].contractAddress, chain: 43114, tokenId: "1" }, VOIDCALLER_CATALOG.editions[0])).toBe(true);
    expect(listingMatchesEdition({ tokenContract: VOIDCALLER_CATALOG.editions[0].contractAddress, chain: 43113, tokenId: "1" }, VOIDCALLER_CATALOG.editions[0])).toBe(false);
  });
});

describe("indexed listing attachment", () => {
  it("attaches only indexed listings that match an edition contract, chain, and token", () => {
    const attached = attachIndexedListings({ catalogs: [FUJI_INTEGRATION_CATALOG], listings: [indexedListing] });
    expect(attached).toHaveLength(1);
    expect(attached[0].edition.id).toBe("summit-demo-edition");
    expect(listingsForEdition([indexedListing], FUJI_INTEGRATION_CATALOG.editions[0])).toHaveLength(1);
  });

  it("does not synthesize a listing when the index is empty or mismatched", () => {
    expect(attachIndexedListings({ catalogs: [FUJI_INTEGRATION_CATALOG], listings: [] })).toEqual([]);
    expect(listingsForEdition([{ ...indexedListing, tokenContract: "0x0000000000000000000000000000000000000001" }], FUJI_INTEGRATION_CATALOG.editions[0])).toEqual([]);
    expect(() => attachIndexedListings({ catalogs: [FUJI_INTEGRATION_CATALOG], listings: null })).toThrow(/array/);
  });
});

describe("native price formatting", () => {
  it("formats and parses AVAX without using token IDs", () => {
    expect(formatWeiAsAvax("10000000000000000")).toBe("0.01 AVAX");
    expect(parseAvaxToWei("0.01")).toBe("10000000000000000");
    expect(parseAvaxToWei("not-a-price")).toBeNull();
  });
});
