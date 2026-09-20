import { describe, expect, it } from "vitest";
import { DISCOVERY, DISCOVERY_CATEGORIES, VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_INTEGRATION_CATALOG } from "./fixtures/summit-fuji-catalog.js";
import { isSummitDemoEnabled, isSummitDemoRecord, stripSummitDemoCatalog, collapsePublicCatalog, SUMMIT_DEMO_IDS } from "./summit-demo.js";

describe("summit demo boundary", () => {
  it("is off by default", () => {
    expect(isSummitDemoEnabled()).toBe(false);
  });

  it("recognizes only the certification fixture ids and public labels", () => {
    expect(isSummitDemoRecord({ id: SUMMIT_DEMO_IDS.release })).toBe(true);
    expect(isSummitDemoRecord({ id: "summit-token-1" })).toBe(true);
    expect(isSummitDemoRecord({ id: "published-row", title: "THE VOID — SUMMIT DEMO" })).toBe(true);
    expect(isSummitDemoRecord({ id: "published-edition", title: "SUMMIT EDITION" })).toBe(true);
    expect(isSummitDemoRecord({ id: "artist-uuid", display_name: "THE VOID", slug: "the-void-2", bio: "A music-native release prepared for the Summit demo on Avalanche Fuji." })).toBe(true);
    expect(isSummitDemoRecord({ id: "voidcaller-self-titled" })).toBe(false);
    expect(isSummitDemoRecord({ id: "voidcaller-chapter-i", title: "Chapter I · The Relic" })).toBe(false);
  });

  it("never ships Summit in production discovery or the public catalog", () => {
    expect(DISCOVERY_CATEGORIES).not.toContain("summit");
    expect(DISCOVERY.summit).toBeUndefined();
    expect(VOIDCALLER_CATALOG.releases.some((item) => /summit/i.test(item.title) || item.id.includes("summit"))).toBe(false);
    expect(VOIDCALLER_CATALOG.editions.some((item) => /summit/i.test(item.title) || item.id.includes("summit"))).toBe(false);
    const stripped = stripSummitDemoCatalog(FUJI_INTEGRATION_CATALOG);
    expect(stripped.releases).toEqual([]);
    expect(stripped.editions).toEqual([]);
    expect(stripped.experiences).toEqual([]);
  });

  it("collapses published Voidcaller aliases and Summit artists out of the public catalog", () => {
    const leaked = {
      artists: [
        { id: "voidcaller", name: "Voidcaller", handle: "VoidcallerOC", verified: true },
        { id: "artist-the-void-2", display_name: "THE VOID", slug: "the-void-2", bio: "A music-native release prepared for the Summit demo on Avalanche Fuji." },
        { id: "artist-voidcaller-3", name: "Voidcaller", slug: "voidcaller-3" },
        { id: "artist-cert", name: "Voidcaller Certification Artist", slug: "voidcaller-certification-artist" },
        { id: "forge", name: "Forge", slug: "forge" },
      ],
      releases: [],
      editions: [],
      tokens: [],
      collections: [],
      experiences: [],
    };
    const publicCatalog = collapsePublicCatalog(leaked);
    expect(publicCatalog.artists.map((item) => item.id)).toEqual(["voidcaller", "forge"]);
    expect(publicCatalog.artists[0].verified).toBe(true);
  });
});
