import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { VOIDCALLER_CATALOG } from "../data.js";
import { createCatalog } from "../domain/models.js";
import { mapPublishedCatalog, mergeCatalogs, withoutShadowedLegacyAlbum } from "../lib/catalog-source.js";
import { LEGACY_ALBUM_ID, LEGACY_CHAIN_ID, LEGACY_CONTRACT, LEGACY_EDITION_ID, legacyExperienceId } from "../lib/legacy-genesis.js";
import { Footer } from "./Footer.jsx";

// API rows shaped like the 019 seed (same shape as legacy-catalog.test.js).
const apiRows = {
  artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE", verified: true, application_metadata: {} }],
  releases: [{ id: LEGACY_ALBUM_ID, artist_id: "voidcaller", slug: LEGACY_ALBUM_ID, title: "VOIDCALLER", status: "PUBLISHED", release_metadata: { subtitle: "Self-titled EP" } }],
  editions: [{
    id: LEGACY_EDITION_ID,
    release_id: LEGACY_ALBUM_ID,
    title: "Chapter I · The Relic",
    supply: "1620",
    status: "PUBLISHED",
    chain_id: String(LEGACY_CHAIN_ID),
    contract_address: LEGACY_CONTRACT,
    application_metadata: { legacy: true, tokenIds: ["0", "1", "2", "3"] },
  }],
  experiences: [0, 1, 2, 3].map((tokenId) => ({
    id: legacyExperienceId(tokenId),
    edition_id: LEGACY_EDITION_ID,
    release_id: LEGACY_ALBUM_ID,
    title: `Track ${tokenId}`,
    experience_type: "AUDIO",
    status: "PUBLISHED",
    gated: true,
    protected: true,
  })),
};

function footerMarkup() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>,
  );
}

function relicEpReleaseHref(html) {
  const labelIdx = html.indexOf(">I · Voidcaller (EP)<");
  expect(labelIdx).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<a ", labelIdx);
  expect(open).toBeGreaterThanOrEqual(0);
  const match = html.slice(open, labelIdx).match(/href="(\/release\/[^"]+)"/);
  expect(match).not.toBeNull();
  return match[1];
}

describe("Footer Relic EP link", () => {
  it("points at a release that survives merged-catalog legacy shadowing", () => {
    const href = relicEpReleaseHref(footerMarkup());
    const releaseId = href.replace(/^\/release\//, "");

    expect(releaseId).toBe("voidcaller-self-titled");
    expect(releaseId).not.toBe(LEGACY_ALBUM_ID);

    const published = mapPublishedCatalog(apiRows);
    const merged = mergeCatalogs([VOIDCALLER_CATALOG, withoutShadowedLegacyAlbum(published)]);
    expect(merged.releases.some((item) => item.id === releaseId)).toBe(true);
    expect(merged.releases.some((item) => item.id === LEGACY_ALBUM_ID)).toBe(false);
  });

  it("does not target the shadowed legacy album id even when that id alone would resolve", () => {
    const href = relicEpReleaseHref(footerMarkup());
    const empty = createCatalog({ artists: [], releases: [], editions: [], tokens: [], collections: [], experiences: [] });
    const publishedOnly = withoutShadowedLegacyAlbum(mapPublishedCatalog(apiRows), [empty]);
    expect(publishedOnly.releases.some((item) => item.id === LEGACY_ALBUM_ID)).toBe(true);
    expect(href).not.toBe(`/release/${LEGACY_ALBUM_ID}`);
  });
});
