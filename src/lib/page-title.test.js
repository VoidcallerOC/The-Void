import { describe, expect, it } from "vitest";
import { VOIDCALLER_CATALOG } from "../data.js";
import { NOT_FOUND_TITLE, SITE_TITLE, normalizePathname, pageLabel, pageTitle } from "./page-title.js";

const catalog = VOIDCALLER_CATALOG;

describe("page titles · one per route", () => {
  it("keeps the site title on the home page only", () => {
    expect(pageTitle("/")).toBe(SITE_TITLE);
    expect(pageTitle("/discover")).not.toBe(SITE_TITLE);
  });

  it("names every primary destination differently", () => {
    const titles = ["/", "/discover", "/marketplace", "/claim", "/artists", "/verify", "/collection", "/studio", "/my-collection"].map((path) => pageTitle(path, catalog));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain("Discover · The Void");
    expect(titles).toContain("Artists · The Void");
    expect(titles).toContain("Catalog · The Void");
  });

  it("tells the artist, record, edition and collection pages of one artist apart", () => {
    const artist = catalog.artists[0];
    const release = catalog.releases[0];
    const edition = catalog.editions[0];
    const collection = catalog.collections[0];
    const titles = [
      pageTitle(`/artist/${artist.id}`, catalog),
      pageTitle(`/release/${release.id}`, catalog),
      pageTitle(`/edition/${edition.id}`, catalog),
      pageTitle(`/collection/${collection.id}`, catalog),
    ];
    expect(new Set(titles).size).toBe(4);
    expect(titles[0]).toBe(`${artist.name} · Artist · The Void`);
    expect(titles[1]).toBe(`${release.title} · Release · The Void`);
    expect(titles[2]).toBe(`${edition.title} · ${release.title} · Edition · The Void`);
    expect(titles[3]).toBe(`${collection.name} · Collection · The Void`);
  });

  it("does not repeat a release title that equals the edition title", () => {
    const local = { releases: [{ id: "r", title: "Forgive & Forget" }], editions: [{ id: "e", releaseId: "r", title: "Forgive & Forget" }] };
    expect(pageTitle("/edition/e", local)).toBe("Forgive & Forget · Edition · The Void");
  });

  it("falls back to the route kind while the catalog is still loading an id", () => {
    expect(pageLabel("/release/release-not-loaded-yet", { releases: [] })).toBe("Release");
    expect(pageLabel("/artist/someone", {})).toBe("Artist");
  });

  it("titles unknown routes as not found and ignores a trailing slash", () => {
    expect(pageTitle("/does-not-exist")).toBe(NOT_FOUND_TITLE);
    expect(NOT_FOUND_TITLE).toBe("Not found · The Void");
    expect(normalizePathname("/discover/")).toBe("/discover");
    expect(pageTitle("/discover/")).toBe("Discover · The Void");
    expect(pageTitle("/studio/profile/voidcaller")).toBe("Edit artist profile · The Void");
    expect(pageTitle("/verify/review/app-1")).toBe("Review application · The Void");
  });

  it("titles the flag-gated routes as not found unless their flag is on", () => {
    expect(pageTitle("/covenant")).toBe("Not found · The Void");
    expect(pageTitle("/covenant", {}, { voidLive: true })).toBe("Covenant · The Void");
    expect(pageTitle("/fuji-integration")).toBe("Not found · The Void");
    expect(pageTitle("/fuji-integration", {}, { summitDemo: true })).toBe("Fuji integration · The Void");
  });
});
