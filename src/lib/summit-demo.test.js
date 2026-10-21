import { describe, expect, it } from "vitest";
import { DISCOVERY, DISCOVERY_CATEGORIES, VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_INTEGRATION_CATALOG } from "./fixtures/summit-fuji-catalog.js";
import { isSummitDemoEnabled, isSummitDemoRecord, isNonPublicTestRecord, isWithdrawnPublicListing, stripSummitDemoCatalog, collapsePublicCatalog, SUMMIT_DEMO_IDS } from "./summit-demo.js";

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

  it("drops the withdrawn Fuji Forgive & Forget listing and keeps VOIDCALLER", () => {
    const releaseId = "release-1b4a2d71-218f-47a2-afde-cd5171909ace";
    const editionId = "edition-9362e29d-341d-4e84-a64b-45753e7d0ff1";
    const experienceId = "experience-d798300c-37eb-4cc6-aad3-4b078b77135a";
    const source = {
      artists: [{ id: "voidcaller", name: "Voidcaller", slug: "voidcaller" }],
      releases: [
        { id: "voidcaller-legacy-genesis", artistId: "voidcaller", title: "VOIDCALLER", status: "published" },
        { id: releaseId, artistId: "voidcaller", slug: "forgive-forget-23", title: "Forgive & Forget", status: "published" },
      ],
      editions: [
        { id: "voidcaller-legacy-edition", releaseId: "voidcaller-legacy-genesis", title: "Chapter I · The Relic", status: "minted" },
        { id: editionId, releaseId, title: "Forgive & Forget", status: "published" },
      ],
      tokens: [{ id: "forgive-token", editionId }],
      experiences: [{ id: experienceId, releaseId, editionId, title: "Stranger Things" }],
      collections: [],
    };
    const result = collapsePublicCatalog(source);
    expect(isWithdrawnPublicListing({ id: editionId })).toBe(true);
    expect(isNonPublicTestRecord({ id: editionId, title: "Forgive & Forget" })).toBe(false);
    expect(result.artists.map((item) => item.id)).toEqual(["voidcaller"]);
    expect(result.releases.map((item) => item.id)).toEqual(["voidcaller-legacy-genesis"]);
    expect(result.editions.map((item) => item.id)).toEqual(["voidcaller-legacy-edition"]);
    expect(result.tokens).toEqual([]);
    expect(result.experiences).toEqual([]);
  });

  it("withdraws the original mainnet Forgive & Forget from discovery and leaves its replacement draft alone", () => {
    const original = "release-83611741-c9ee-4487-a438-b6fa844762e6";
    for (const id of [original, "edition-6e35101c-4987-4695-ac96-d83061ef2673", "edition-11e2e1a2-5a57-47e3-ac3d-e44d409af3a7", "experience-edition-6e35101c-4987-4695-ac96-d83061ef2673-full-track"]) {
      expect(isWithdrawnPublicListing({ id })).toBe(true);
    }
    // Any row carrying the release or edition id leaves discovery too (API rows use snake_case).
    expect(isWithdrawnPublicListing({ id: "x", release_id: original })).toBe(true);
    expect(isWithdrawnPublicListing({ id: "x", editionId: "edition-6e35101c-4987-4695-ac96-d83061ef2673" })).toBe(true);
    // The replacement draft and Genesis are not withdrawn.
    expect(isWithdrawnPublicListing({ id: "release-273f5476-0cdb-45d3-83d3-5908eb42bc6c" })).toBe(false);
    expect(isWithdrawnPublicListing({ id: "voidcaller-legacy-genesis" })).toBe(false);
    expect(isWithdrawnPublicListing({ id: "voidcaller-legacy-edition", releaseId: "voidcaller-legacy-genesis" })).toBe(false);
  });

  it("drops Fuji Rehearsal A everywhere in the public catalog while keeping both Forgive & Forget editions", () => {
    const releaseId = "release-7e7cecfe-73ca-44ed-afca-0b7391b6ebff";
    const editionId = "edition-e2d7f780-5f9f-4499-8030-ebc41c287a0c";
    const source = {
      artists: [{ id: "voidcaller", name: "Voidcaller", slug: "voidcaller" }],
      releases: [
        { id: "voidcaller-legacy-genesis", artistId: "voidcaller", title: "VOIDCALLER", status: "published" },
        { id: releaseId, artistId: "voidcaller", title: "Fuji Rehearsal A", status: "published" },
        { id: "release-090b0c0e-b9ed-483a-b6b8-f9f459dab216", artistId: "voidcaller", title: "Forgive & Forget", status: "published", publishedAt: "2026-10-13T00:00:00Z" },
        { id: "release-dc027a1f-ebbd-4550-9d75-1fb1f643e021", artistId: "voidcaller", title: "Forgive & Forget", status: "published", publishedAt: "2026-10-04T00:00:00Z" },
      ],
      editions: [
        { id: "voidcaller-legacy-edition", releaseId: "voidcaller-legacy-genesis", title: "Chapter I · The Relic", status: "minted" },
        { id: editionId, releaseId, title: "Fuji Rehearsal A", status: "available" },
        { id: "edition-332337ec-c3f2-4bf3-8db7-c5baa94dcb64", releaseId: "release-090b0c0e-b9ed-483a-b6b8-f9f459dab216", title: "Forgive & Forget", status: "available" },
        { id: "edition-8f80ce4f-034c-45ad-b0b7-5a9b3963e0a6", releaseId: "release-dc027a1f-ebbd-4550-9d75-1fb1f643e021", title: "Forgive & Forget", status: "available" },
      ],
      tokens: [{ id: "rehearsal-token", editionId }, { id: "forgive-token", editionId: "edition-332337ec-c3f2-4bf3-8db7-c5baa94dcb64" }],
      experiences: [
        { id: "experience-c157e09c-2d89-4f81-a6d1-7cd13dc1198b", releaseId, editionId, title: "Full record" },
        { id: "experience-ac708f12-2ddb-46c0-9362-375fc7d3f08e", releaseId, editionId, title: "Full record" },
        { id: "experience-88480cc0-2e75-42c9-b971-75faba55a6e9", releaseId: "release-090b0c0e-b9ed-483a-b6b8-f9f459dab216", editionId: "edition-332337ec-c3f2-4bf3-8db7-c5baa94dcb64", title: "Stranger Things" },
      ],
      collections: [],
    };
    const result = collapsePublicCatalog(source);
    expect(isWithdrawnPublicListing({ id: editionId })).toBe(true);
    expect(isWithdrawnPublicListing({ id: "x", release_id: releaseId })).toBe(true);
    expect(result.releases.map((item) => item.id)).not.toContain(releaseId);
    expect(result.editions.map((item) => item.id)).not.toContain(editionId);
    expect(result.tokens.map((item) => item.id)).toEqual(["forgive-token"]);
    expect(result.experiences.map((item) => item.id)).toEqual(["experience-88480cc0-2e75-42c9-b971-75faba55a6e9"]);
    // The newer Forgive & Forget stays the discovery winner; the older one stays recoverable for holders.
    expect(result.editions.map((item) => item.id)).toEqual(["voidcaller-legacy-edition", "edition-332337ec-c3f2-4bf3-8db7-c5baa94dcb64"]);
    expect(result.duplicates.editions.map((item) => item.id)).toEqual(["edition-8f80ce4f-034c-45ad-b0b7-5a9b3963e0a6"]);
  });
});
