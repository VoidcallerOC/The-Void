import { describe, expect, it } from "vitest";
import { VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG } from "../data.js";
import { createArtist, createCatalog, createEdition, createRelease } from "../domain/models.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import {
  mapPublishedCatalog,
  mergeCatalogs,
  readStudioOverlay,
  resolveCatalog,
  upsertStudioOverlay,
  writeStudioOverlay,
} from "./catalog-source.js";

describe("catalog source", () => {
  it("keeps the static Voidcaller and Summit catalogs canonical when merging", () => {
    const overlay = createCatalog({
      artists: [createArtist({ id: "voidcaller", name: "Should not win" }), createArtist({ id: "new-artist", name: "New" })],
      releases: [createRelease({ id: "new-release", artistId: "new-artist", title: "New Record" })],
      editions: [createEdition({ id: "new-edition", releaseId: "new-release", title: "New Edition", contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 })],
    });
    const merged = mergeCatalogs([VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG, overlay]);
    expect(merged.artists.find((item) => item.id === "voidcaller").name).toBe("Voidcaller");
    expect(merged.artists.some((item) => item.id === "new-artist")).toBe(true);
    expect(merged.editions.some((item) => item.id === "summit-demo-edition")).toBe(true);
    expect(merged.editions.some((item) => item.id === "new-edition")).toBe(true);
  });

  it("resolves Summit records without falling back to the Voidcaller catalog", () => {
    expect(resolveCatalog("summit-demo-edition").editions[0].id).toBe("summit-demo-edition");
    expect(resolveCatalog("voidcaller-chapter-i").editions[0].id).toBe("voidcaller-chapter-i");
  });

  it("maps published API rows into the music-native domain without using fixture listings", () => {
    const catalog = mapPublishedCatalog({
      artists: [{ id: "a1", display_name: "Forge", slug: "forge", bio: "CT" }],
      releases: [{ id: "r1", artist_id: "a1", title: "Repair", description: "EP", status: "PUBLISHED", release_metadata: { artwork: "/assets/voidcaller_art_5.png" } }],
      editions: [{ id: "e1", release_id: "r1", title: "Chapter I", description: "Relic", supply: "25", status: "PUBLISHED", chain_id: 43113, contract_address: FUJI_RELEASE_CONFIG.contractAddress, application_metadata: { includes: ["Full EP"], fuji: { tokenId: "9", metadataUri: "ipfs://x" } } }],
      experiences: [{ id: "x1", title: "Session", experience_type: "AUDIO", edition_id: "e1", description: "Gated" }],
    });
    expect(catalog.editions[0]).toMatchObject({ id: "e1", title: "Chapter I", contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 });
    expect(catalog.editions[0].includes).toEqual(["Full EP"]);
    expect(catalog.experiences[0].title).toBe("Session");
  });

  it("persists a studio overlay without inventing marketplace listings", () => {
    const store = new Map();
    const fake = { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
    writeStudioOverlay(createCatalog({ editions: [createEdition({ id: "local", releaseId: "r", title: "Local" })] }), fake);
    expect(readStudioOverlay(fake).editions[0].id).toBe("local");
    upsertStudioOverlay({ artists: [createArtist({ id: "local-artist", name: "Local" })] }, fake);
    const next = readStudioOverlay(fake);
    expect(next.editions[0].id).toBe("local");
    expect(next.artists[0].name).toBe("Local");
    expect(next.editions[0].listings).toBeUndefined();
  });
});
