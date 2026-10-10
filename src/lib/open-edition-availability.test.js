import { describe, expect, it } from "vitest";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { mapPublishedCatalog } from "./catalog-source.js";
import {
  editionIsCollectable,
  editionSupplyLabel,
  flattenMarketplaceEditions,
  primaryCollectForEdition,
  releaseScopedFirst,
} from "./marketplace-surface.js";

// forgive-forget-28 (Fuji, 2026-10-10): factory release contract with its own sale.
const RELEASE_CONTRACT = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const SALE = "0xfb13eed6d3f1457937d845a06f33f2bc0c407cc3";
const TOKEN_ID = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const END = String(Math.floor(Date.UTC(2026, 9, 31, 23, 59, 0) / 1000));
const OPEN_SALE = { configured: true, paused: false, price_wei: "10000000000000000", max_supply: "0", sold: "1", per_wallet_limit: "1", start_time: "0", end_time: END };

function apiCatalog({ releaseType = "SINGLE", supply = "0", sale = OPEN_SALE, availability = "open" } = {}) {
  return mapPublishedCatalog({
    artists: [{ id: "a1", display_name: "Voidcaller", slug: "voidcaller-9" }],
    releases: [
      { id: "r-factory", artist_id: "a1", title: "forgive-forget-28", status: "PUBLISHED", release_metadata: { releaseType } },
      { id: "r-shared", artist_id: "a1", title: "Fuji Rehearsal A", status: "PUBLISHED" },
    ],
    editions: [
      { id: "e-shared", release_id: "r-shared", title: "Fuji Rehearsal A", supply: "25", status: "PUBLISHED", chain_id: 43113, contract_address: FUJI_RELEASE_CONFIG.contractAddress, token_id: "9" },
      {
        id: "e-factory", release_id: "r-factory", title: "forgive-forget-28", supply, status: "PUBLISHED", chain_id: 43113,
        contract_address: RELEASE_CONTRACT, release_contract_address: RELEASE_CONTRACT, primary_sale_address: SALE, token_id: TOKEN_ID,
        ...(sale ? { primary_sale: sale } : {}), ...(availability ? { primary_availability: availability } : {}),
      },
    ],
  });
}

const factoryOf = (catalog) => catalog.editions.find((edition) => edition.id === "e-factory");

describe("open edition availability (catalog + marketplace surface)", () => {
  it("maps the API's live sale state and price onto the factory edition", () => {
    const edition = factoryOf(apiCatalog());
    expect(edition).toMatchObject({
      supply: "0",
      saleAvailability: "open",
      primarySaleAddress: SALE,
      contractAddress: RELEASE_CONTRACT,
      tokenIds: [TOKEN_ID],
      priceWei: "10000000000000000",
      primarySale: { configured: true, paused: false, maxSupply: "0", sold: "1", perWalletLimit: "1", startTime: "0", endTime: END },
    });
  });

  for (const releaseType of ["SINGLE", "EP", "ALBUM"]) {
    it(`${releaseType}: open edition + live sale is collectable and listed before the shared-contract release`, () => {
      const catalog = apiCatalog({ releaseType });
      const edition = factoryOf(catalog);
      const primary = primaryCollectForEdition(edition, { now: NOW });
      expect(primary).toMatchObject({ availability: "available", label: "Collect", releaseScoped: true, saleState: "open", href: "/edition/e-factory" });
      expect(editionIsCollectable(edition, primary)).toBe(true);
      expect(editionSupplyLabel(edition, primary)).toBe("Open edition · until Oct 31, 2026, 11:59 PM UTC");

      const official = releaseScopedFirst(flattenMarketplaceEditions([catalog]).filter((item) => item.primary.availability === "available"));
      expect(official.map((item) => item.edition.id)).toEqual(["e-factory", "e-shared"]);
    });
  }

  it("open edition after the sale end time reads 'Sale ended' and is not collectable", () => {
    const edition = factoryOf(apiCatalog());
    const primary = primaryCollectForEdition(edition, { now: (Number(END) + 60) * 1000 });
    expect(primary).toMatchObject({ availability: "unavailable", saleState: "ended" });
    expect(editionSupplyLabel(edition, primary)).toBe("Sale ended");
  });

  it("capped edition whose sale is sold out reads 'Sold out'", () => {
    const edition = factoryOf(apiCatalog({ supply: "25", sale: { ...OPEN_SALE, max_supply: "25", sold: "25" }, availability: "sold-out" }));
    const primary = primaryCollectForEdition(edition, { now: NOW });
    expect(primary).toMatchObject({ availability: "unavailable", saleState: "sold-out" });
    expect(editionSupplyLabel(edition, primary)).toBe("Sold out");
  });

  it("sale not yet started reads 'Starts <time>'", () => {
    const start = String(Math.floor(Date.UTC(2026, 9, 12, 18, 0, 0) / 1000));
    const edition = factoryOf(apiCatalog({ sale: { ...OPEN_SALE, start_time: start }, availability: "not-started" }));
    const primary = primaryCollectForEdition(edition, { now: NOW });
    expect(primary).toMatchObject({ availability: "unavailable", saleState: "not-started" });
    expect(editionSupplyLabel(edition, primary)).toBe("Starts Oct 12, 2026, 6:00 PM UTC");
  });

  it("never labels a factory open edition as empty, even without sale state from the API", () => {
    const edition = factoryOf(apiCatalog({ sale: null, availability: null }));
    const primary = primaryCollectForEdition(edition, { now: NOW });
    expect(primary).toMatchObject({ availability: "unavailable", saleState: null, releaseScoped: true });
    expect(editionSupplyLabel(edition, primary)).toBe("Open edition");
  });

  it("keeps the shared-contract release on its own catalog path", () => {
    const shared = apiCatalog().editions.find((edition) => edition.id === "e-shared");
    const primary = primaryCollectForEdition(shared, { now: NOW });
    expect(primary).toMatchObject({ availability: "available", certified: true });
    expect(primary.releaseScoped).toBeUndefined();
    expect(editionSupplyLabel(shared, primary)).toBe("Supply 25");
  });
});
