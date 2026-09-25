import { describe, expect, it } from "vitest";
import { VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_INTEGRATION_CATALOG } from "./fixtures/summit-fuji-catalog.js";
import { createArtist, createCatalog, createEdition, createRelease } from "../domain/models.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import {
  baseCatalogs,
  fetchPublishedCatalog,
  mapPublishedCatalog,
  mergeCatalogs,
  readStudioOverlay,
  resolveCatalog,
  upsertStudioOverlay,
  writeStudioOverlay,
} from "./catalog-source.js";
import { collapsePublicCatalog, stripSummitDemoCatalog } from "./summit-demo.js";

describe("catalog source", () => {
  it("keeps Summit out of the production catalog", () => {
    expect(baseCatalogs()).toEqual([VOIDCALLER_CATALOG]);
    expect(baseCatalogs().some((catalog) => catalog.releases.some((item) => item.id === "summit-demo-release"))).toBe(false);
    const leaked = mergeCatalogs([VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG]);
    expect(stripSummitDemoCatalog(leaked).releases.some((item) => item.id === "summit-demo-release")).toBe(false);
    expect(stripSummitDemoCatalog(leaked).editions.some((item) => item.id === "summit-demo-edition")).toBe(false);
  });

  it("keeps the static Voidcaller catalog canonical when merging overlays", () => {
    const overlay = createCatalog({
      artists: [createArtist({ id: "voidcaller", name: "Should not win" }), createArtist({ id: "new-artist", name: "New" })],
      releases: [createRelease({ id: "new-release", artistId: "new-artist", title: "New Record" })],
      editions: [createEdition({ id: "new-edition", releaseId: "new-release", title: "New Edition", contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 })],
    });
    const merged = mergeCatalogs([VOIDCALLER_CATALOG, overlay]);
    expect(merged.artists.find((item) => item.id === "voidcaller").name).toBe("Voidcaller");
    expect(merged.artists.some((item) => item.id === "new-artist")).toBe(true);
    expect(merged.editions.some((item) => item.id === "summit-demo-edition")).toBe(false);
    expect(merged.editions.some((item) => item.id === "new-edition")).toBe(true);
  });

  it("shows one Voidcaller on the public artists grid when Studio published aliases leak", () => {
    const published = mapPublishedCatalog({
      artists: [
        { id: "artist-void-1", display_name: "THE VOID", slug: "the-void", bio: "A music-native release prepared for the Summit demo on Avalanche Fuji." },
        { id: "artist-voidcaller-2", display_name: "Voidcaller", slug: "voidcaller-2", bio: "A music-native project where records become relics and ownership unlocks the full experience." },
        { id: "artist-voidcaller-3", display_name: "Voidcaller", slug: "voidcaller-3" },
      ],
    });
    const publicCatalog = collapsePublicCatalog(mergeCatalogs([VOIDCALLER_CATALOG, published]));
    expect(publicCatalog.artists.map((item) => item.id)).toEqual(["voidcaller"]);
    expect(publicCatalog.artists[0].verified).toBe(false);
    expect(publicCatalog.releases.filter((item) => item.artistId === "voidcaller")).toHaveLength(1);
  });

  it("resolves Summit records only when the test fixture catalog is supplied", () => {
    expect(resolveCatalog("summit-demo-edition").editions.some((item) => item.id === "summit-demo-edition")).toBe(false);
    expect(resolveCatalog("summit-demo-edition", [VOIDCALLER_CATALOG, FUJI_INTEGRATION_CATALOG]).editions[0].id).toBe("summit-demo-edition");
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
    expect(catalog.artists[0].verified).toBe(false);
  });

  it("only marks published artists verified when the API row is verified", () => {
    const unverified = mapPublishedCatalog({ artists: [{ id: "a1", display_name: "Forge", slug: "forge" }] });
    const verified = mapPublishedCatalog({ artists: [{ id: "a1", display_name: "Forge", slug: "forge", verified: true }] });
    const byStatus = mapPublishedCatalog({ artists: [{ id: "a1", display_name: "Forge", slug: "forge", verification_status: "VERIFIED" }] });
    expect(unverified.artists[0].verified).toBe(false);
    expect(verified.artists[0].verified).toBe(true);
    expect(byStatus.artists[0].verified).toBe(true);
  });

  it("strips Summit records from published API catalog responses", async () => {
    const payload = (data) => ({ ok: true, json: async () => ({ data }) });
    const fetchImpl = async (url) => {
      if (url.endsWith("/api/artists")) return payload([
        { id: "summit-demo-artist", display_name: "THE VOID", slug: "the-void" },
        { id: "artist-a5c0ab65", display_name: "THE VOID", slug: "the-void-2", bio: "A music-native release prepared for the Summit demo on Avalanche Fuji." },
        { id: "artist-voidcaller-4", display_name: "Voidcaller", slug: "voidcaller-4" },
        { id: "artist-forge", display_name: "Forge", slug: "forge", bio: "CT" },
      ]);
      if (url.endsWith("/api/releases")) return payload([{ id: "r-summit", artist_id: "summit-demo-artist", title: "THE VOID — SUMMIT DEMO", description: "Fixture", status: "PUBLISHED", release_metadata: {} }]);
      if (url.endsWith("/api/editions")) return payload([{ id: "e-summit", release_id: "r-summit", title: "SUMMIT EDITION", description: "Fixture", supply: "10", status: "PUBLISHED", chain_id: 43113, contract_address: FUJI_RELEASE_CONFIG.contractAddress, application_metadata: {} }]);
      if (url.endsWith("/api/experiences")) return payload([{ id: "summit-session", title: "THE VOID — SUMMIT SESSION", experience_type: "AUDIO", edition_id: "e-summit", description: "Fixture" }]);
      throw new Error(`unexpected ${url}`);
    };
    const catalog = await fetchPublishedCatalog({ fetchImpl });
    expect(catalog.releases).toEqual([]);
    expect(catalog.editions).toEqual([]);
    expect(catalog.experiences).toEqual([]);
    expect(catalog.artists.map((item) => item.id)).toEqual(["artist-forge"]);
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
