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

  it("removes Fuji E2E, Pinata certification, and named test/demo inventory while preserving real Voidcaller records", () => {
    const testReleases = [
      { id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", artistId: "artist-e2e", title: "Marketplace Fuji E2E Test", status: "published" },
      { id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", artistId: "artist-wer", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
      { id: "release-f049bc8c-2ff1-4ebf-8830-ebd92784864a", artistId: "artist-sdfg", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
      { id: "release-f2ce5be7-969a-4e9f-87fb-be839b9df380", artistId: "artist-asdf", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
      { id: "release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3", artistId: "artist-qwe", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
      { id: "release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de", artistId: "artist-pinata", title: "PINATA CERTIFICATION 2026-09-27", status: "published" },
    ];
    const testEditions = testReleases.map((release, index) => ({
      id: ["edition-b87f40b1-9419-4e90-8e2f-5b8986df043c", "edition-8ed9867c-e102-49c5-97a0-54ccf15605d2", "edition-ce4230f8-59fd-4cc4-a193-c62a4653f4c3", "edition-3de74dd9-8f60-4369-afba-e2d76a1bef9c", "edition-fe58c325-131d-4eb6-8af4-544720d5c403", "edition-56dbb8af-7da2-46e3-9d59-db255362cd3e"][index],
      releaseId: release.id,
      title: ["Marketplace Fuji E2E Test", "wer", "sdfg", "wert", "qwe", "Pinata JSON Certification Test Object"][index],
      status: "published",
    }));
    const source = {
      artists: [
        { id: "voidcaller", name: "Voidcaller", slug: "voidcaller" },
        { id: "artist-wer", name: "wer", slug: "wer" },
        { id: "artist-sdfg", name: "sdfg", slug: "sdfg" },
        { id: "artist-asdf", name: "asdf", slug: "asdf" },
        { id: "artist-qwe", name: "qwe", slug: "qwe" },
        { id: "artist-e2e", name: "Voidcaller", slug: "voidcaller-8" },
        { id: "artist-pinata", name: "Voidcaller", slug: "voidcaller-6" },
      ],
      releases: [
        ...testReleases,
        { id: "release-8f6d5a9f-585d-4948-b05b-7098125d16cf", artistId: "artist-canonical-alias", artistName: "Voidcaller", artistSlug: "voidcaller-7", title: "VOIDCALLER", status: "published" },
      ],
      editions: [
        ...testEditions,
        { id: "edition-ecf27444-94b7-40d5-bace-5f061792f55e", releaseId: "release-8f6d5a9f-585d-4948-b05b-7098125d16cf", title: "VOIDCALLER", status: "available" },
        { id: "voidcaller-legacy-edition", releaseId: "voidcaller-legacy-genesis", title: "Chapter I · The Relic", status: "minted" },
      ],
      tokens: [{ id: "e2e-token", editionId: testEditions[0].id }, { id: "real-token", editionId: "edition-ecf27444-94b7-40d5-bace-5f061792f55e" }],
      experiences: [{ id: "e2e-experience", releaseId: testReleases[0].id, editionId: testEditions[0].id }],
      collections: [{ id: "e2e-collection", editionIds: [testEditions[0].id] }],
    };

    const result = collapsePublicCatalog(source);
    expect(result.releases.map((item) => item.id)).toEqual(["release-8f6d5a9f-585d-4948-b05b-7098125d16cf"]);
    expect(result.editions.map((item) => item.id)).toContain("edition-ecf27444-94b7-40d5-bace-5f061792f55e");
    expect(result.editions.map((item) => item.id)).toContain("voidcaller-legacy-edition");
    expect(result.editions).toHaveLength(2);
    expect(result.tokens.map((item) => item.id)).toEqual(["real-token"]);
    expect(result.experiences).toEqual([]);
    expect(result.collections).toEqual([]);
    expect(result.artists.some((item) => item.id === "voidcaller")).toBe(true);
    expect(source.artists).toHaveLength(7);
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
