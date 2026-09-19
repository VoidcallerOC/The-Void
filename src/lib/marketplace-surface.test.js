import { describe, expect, it } from "vitest";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { MARKETPLACE_CONFIG } from "./marketplace.js";
import {
  MARKETPLACE_STATE,
  attachIndexedListings,
  certifiedFujiReleaseUnchanged,
  collectableFirst,
  editionTypeLabel,
  featuredMarketplaceRecord,
  findMarketplaceEdition,
  flattenMarketplaceEditions,
  formatWeiAsAvax,
  listingMatchesEdition,
  listingsForEdition,
  marketplaceCatalog,
  marketplaceCopy,
  marketplaceStatusLabel,
  parseAvaxToWei,
  primaryCollectForEdition,
  resolveInfrastructureStatus,
  resolveSecondaryStatus,
  secondaryTradingIsLive,
} from "./marketplace-surface.js";
import { VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_INTEGRATION_CATALOG } from "./fixtures/summit-fuji-catalog.js";

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
    expect(marketplaceStatusLabel(resolveSecondaryStatus())).toBe("NOT YET LIVE");
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

  it("keeps product copy free of engineering certification banners", () => {
    expect(marketplaceCopy().title).toBe("Marketplace");
    expect(marketplaceCopy().body).not.toMatch(/IMPLEMENTED \/ NOT LIVE/);
    expect(marketplaceCopy().body).toMatch(/collect/i);
    expect(marketplaceCopy().eyebrow).toMatch(/music marketplace/i);
  });

  it("does not feature Summit as a public marketplace release", () => {
    const records = marketplaceCatalog();
    expect(records.some((record) => record.release.id === "summit-demo-release")).toBe(false);
    expect(flattenMarketplaceEditions().some((item) => item.edition.id === "summit-demo-edition")).toBe(false);
    const featured = featuredMarketplaceRecord(records);
    expect(featured.release.id).not.toBe("summit-demo-release");
    expect(featured.release.title).not.toMatch(/SUMMIT/i);
    expect(featured.editions[0].edition.title).not.toMatch(/SUMMIT/i);
  });
});

describe("music-native catalog projection", () => {
  it("projects artist → release → edition → experience for the public Voidcaller catalog", () => {
    const relic = marketplaceCatalog().find((record) => record.release.id === "voidcaller-self-titled");
    expect(relic.artist.name).toBe("Voidcaller");
    expect(relic.release.title).toBe("VOIDCALLER");
    expect(relic.editions[0].edition.title).toBe("Chapter I · The Relic");
    expect(relic.editions[0].primary.href).toBe("/edition/voidcaller-chapter-i");
    expect(editionTypeLabel(relic.editions[0].edition)).toBe("Collectible release");
  });

  it("keeps the certified Fuji configuration untouched", () => {
    expect(certifiedFujiReleaseUnchanged()).toBe(true);
    expect(FUJI_RELEASE_CONFIG.chainId).toBe(43113);
    expect(FUJI_RELEASE_CONFIG.contractName).toBe("VoidRelease1155");
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
  });

  it("can still project the Summit fixture when tests supply it explicitly", () => {
    const summit = marketplaceCatalog([FUJI_INTEGRATION_CATALOG]).find((record) => record.release.id === "summit-demo-release");
    expect(summit.editions[0].edition.title).toBe("SUMMIT EDITION");
    expect(summit.editions[0].primary.href).toBe("/edition/summit-demo-edition");
    expect(summit.editions[0].primary.certified).toBe(true);
    expect(findMarketplaceEdition("summit-demo-edition", [FUJI_INTEGRATION_CATALOG]).edition.contractAddress).toBe(FUJI_RELEASE_CONFIG.contractAddress);
    expect(collectableFirst(flattenMarketplaceEditions([FUJI_INTEGRATION_CATALOG]))[0].edition.id).toBe("summit-demo-edition");
  });

  it("labels minted Voidcaller relics as primary-complete, not as live secondary listings", () => {
    const primary = primaryCollectForEdition(VOIDCALLER_CATALOG.editions[0]);
    expect(primary.availability).toBe("minted");
    expect(primary.href).toBe("/edition/voidcaller-chapter-i");
    expect(listingMatchesEdition({ tokenContract: VOIDCALLER_CATALOG.editions[0].contractAddress, chain: 43114, tokenId: "1" }, VOIDCALLER_CATALOG.editions[0])).toBe(true);
    expect(listingMatchesEdition({ tokenContract: VOIDCALLER_CATALOG.editions[0].contractAddress, chain: 43113, tokenId: "1" }, VOIDCALLER_CATALOG.editions[0])).toBe(false);
    expect(flattenMarketplaceEditions().some((item) => item.edition.id === "voidcaller-chapter-i")).toBe(true);
  });

  it("surfaces a studio overlay edition in the marketplace catalog without fabricating listings", () => {
    const overlay = {
      artists: [{ type: "artist", id: "forge", name: "Forge", handle: "forge", releases: [], collectionIds: [], experiences: [], socials: [], verified: true, verification: { status: "verified" }, wallet: "", address: "", bio: "", avatar: "", banner: "" }],
      releases: [{ type: "release", id: "the-repair", artistId: "forge", title: "THE REPAIR", subtitle: "", description: "Chapter I", story: "", status: "published", artwork: "/assets/voidcaller_art_5.png", editions: [], tracks: [], experiences: [] }],
      editions: [{ type: "edition", id: "chapter-i-the-repair", releaseId: "the-repair", title: "CHAPTER I — THE REPAIR", description: "ERC-1155 release edition", includes: ["Full self-titled EP"], tokenIds: ["1"], contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113, chain: "Avalanche Fuji", supply: "25", status: "available", metadataUri: "ipfs://x", experienceIds: [], experiences: [], tier: "standard", valueProposition: "" }],
    };
    const records = marketplaceCatalog([VOIDCALLER_CATALOG, overlay]);
    const created = records.find((record) => record.release.id === "the-repair");
    expect(created.artist.name).toBe("Forge");
    expect(created.editions[0].primary.href).toBe("/edition/chapter-i-the-repair");
    expect(created.editions[0].primary.certified).toBe(true);
    expect(created.editions[0].listings).toBeUndefined();
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
