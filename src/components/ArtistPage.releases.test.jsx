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
    rel("release-forgive", "Forgive & Forget", "PUBLISHED", "2026-10-13T00:00:00Z"),
    rel("release-single-2", "Second Single", "PUBLISHED", "2026-10-12T00:00:00Z"),
    rel("release-draft", "Unfinished Demo", "DRAFT", null),
    rel("release-archived", "Retired Test", "ARCHIVED", "2026-10-01T00:00:00Z"),
  ],
  editions: [
    ed("edition-forgive", "release-forgive", "Forgive & Forget", "PUBLISHED", "111"),
    ed("edition-single-2", "release-single-2", "Second Single", "PUBLISHED", "222", OTHER_CLONE),
    ed("edition-draft", "release-draft", "Unfinished Demo", "DRAFT", "333"),
    ed("edition-archived", "release-archived", "Retired Test", "ARCHIVED", "444"),
  ],
};

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { collapsePublicCatalog } = await import("../lib/summit-demo.js");
  const published = collapsePublicCatalog(actual.mapPublishedCatalog(rows));
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
    expect(markup).not.toContain("Unfinished Demo");
    expect(markup).not.toContain("Retired Test");
    expect(markup).not.toContain("edition-draft");
    expect(markup).not.toContain("edition-archived");
  });

  it("redirects an unknown artist instead of rendering releases", () => {
    expect(render("/artist/nobody")).not.toContain("Forgive");
  });
});
