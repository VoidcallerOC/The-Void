/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FUJI_RELEASE_CONFIG } from "../lib/fuji-release.js";

const FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const CLONE = "0xe87410E9a2c703B6BB696D4bFB5f268d3C5BCf65";
const OTHER_CLONE = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const artist = { id: "voidcaller", display_name: "Voidcaller", slug: "voidcaller" };
const rel = (id, title, status, publishedAt, extra = {}) => ({ id, artist_id: "voidcaller", title, status, published_at: publishedAt, ...extra });
const ed = (id, releaseId, title, status, token, contract = CLONE) => ({
  id, release_id: releaseId, title, status, chain_id: FUJI_RELEASE_CONFIG.chainId,
  contract_address: contract, release_contract_address: contract, factory_address: FACTORY, token_id: token,
});

const rows = {
  artists: [artist],
  releases: [
    rel("release-7e7cecfe-73ca-44ed-afca-0b7391b6ebff", "Fuji Rehearsal A", "PUBLISHED", "2026-10-05T00:00:00Z"),
    rel("release-forgive", "Forgive & Forget", "PUBLISHED", "2026-10-13T00:00:00Z"),
    rel("release-single-2", "Second Single", "PUBLISHED", "2026-10-12T00:00:00Z"),
    rel("release-draft", "Unreleased Sketch", "DRAFT", null),
    rel("release-archived", "Retired Pressing", "ARCHIVED", "2026-10-01T00:00:00Z"),
  ],
  editions: [
    ed("edition-e2d7f780-5f9f-4499-8030-ebc41c287a0c", "release-7e7cecfe-73ca-44ed-afca-0b7391b6ebff", "Fuji Rehearsal A", "PUBLISHED", "555"),
    ed("edition-forgive", "release-forgive", "Forgive & Forget", "PUBLISHED", "111"),
    ed("edition-single-2", "release-single-2", "Second Single", "PUBLISHED", "222", OTHER_CLONE),
    ed("edition-draft", "release-draft", "Unreleased Sketch", "DRAFT", "333"),
    ed("edition-archived", "release-archived", "Retired Pressing", "ARCHIVED", "444"),
  ],
};

// The public catalog as the app loads it: through fetchPublishedCatalog, over a stubbed API.
const apiFor = (rows) => async (url) => {
  const key = String(url).split("?")[0].replace(/^.*\/api\//, "");
  return { ok: true, json: async () => ({ data: rows[key] || [] }) };
};

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { collapsePublicCatalog } = await import("../lib/summit-demo.js");
  const published = await actual.fetchPublishedCatalog({ fetchImpl: apiFor(rows) });
  return { ...actual, useMarketplaceCatalogs: () => collapsePublicCatalog(actual.mergeCatalogs([...actual.baseCatalogs(), published])) };
});
const { ArtistPage } = await import("./PlatformPages.jsx");

function render(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}><Routes><Route path="/artist/:artist" element={<ArtistPage />} /></Routes></MemoryRouter>,
  );
}

describe("Artist page releases", () => {
  it("lists every published release of the artist, not only the legacy EP", () => {
    const markup = render("/artist/voidcaller");
    expect(markup).toContain("Chapter I");
    expect(markup).toContain("Forgive &amp; Forget");
    expect(markup).toContain("Second Single");
  });

  it("links each published release's card to its own edition", () => {
    const markup = render("/artist/voidcaller");
    expect(markup).toContain('href="/edition/edition-forgive"');
    expect(markup).toContain('href="/edition/edition-single-2"');
  });

  it("keeps draft and archived releases off the public artist page", () => {
    const markup = render("/artist/voidcaller");
    expect(markup).not.toContain("Unreleased Sketch");
    expect(markup).not.toContain("Retired Pressing");
    expect(markup).not.toContain("edition-draft");
    expect(markup).not.toContain("edition-archived");
  });

  it("does not list Fuji Rehearsal A, which is not a public release", () => {
    const markup = render("/artist/voidcaller");
    expect(markup).not.toContain("Fuji Rehearsal A");
    expect(markup).not.toContain("edition-e2d7f780");
    expect(markup).toContain("Forgive &amp; Forget");
  });

  it("redirects an unknown artist instead of rendering releases", () => {
    expect(render("/artist/nobody")).not.toContain("Forgive");
  });
});
