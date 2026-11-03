import { describe, expect, it } from "vitest";
import { baseCatalogs, mapPublishedCatalog, mergeCatalogs } from "./catalog-source.js";
import { featuredMintItem, mintLabel, timeLeftLabel } from "./featured-mint.js";

const editionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
function catalogWithCollectableEdition() {
  const published = mapPublishedCatalog({
    artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }],
    releases: [{ id: "rel-1", artist_id: "voidcaller", title: "VOIDCALLER", description: "", status: "PUBLISHED" }],
    editions: [{ id: editionId, release_id: "rel-1", title: "VOIDCALLER", status: "PUBLISHED", supply: "25", chain_id: "43113", contract_address: "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6", token_id: "1", application_metadata: { priceWei: "10000000000000000" } }],
    experiences: [],
  });
  return mergeCatalogs([...baseCatalogs(), published]);
}

describe("featured mint", () => {
  it("is null when nothing is on primary sale, so every Mint surface hides itself", () => {
    expect(featuredMintItem(mergeCatalogs(baseCatalogs()))).toBeNull();
  });

  it("names the edition on sale, its page and price", () => {
    const featured = featuredMintItem(catalogWithCollectableEdition());
    expect(featured).toMatchObject({ title: "VOIDCALLER", href: `/edition/${editionId}` });
    expect(mintLabel(featured)).toBe("Mint VOIDCALLER · 0.01 AVAX");
  });
});

describe("time left in the sale", () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const at = (seconds) => Math.floor(now / 1000) + seconds;
  it("reads in days, then hours, then the last hour, and is empty once over or unknown", () => {
    expect(timeLeftLabel(at(6.5 * 86400), now)).toBe("6 days left");
    expect(timeLeftLabel(at(30 * 3600), now)).toBe("30 hours left");
    expect(timeLeftLabel(at(90 * 60), now)).toBe("1 hour left");
    expect(timeLeftLabel(at(20 * 60), now)).toBe("Last hour");
    expect(timeLeftLabel(at(-5), now)).toBe("");
    expect(timeLeftLabel(0, now)).toBe("");
  });
});
