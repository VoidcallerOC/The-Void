/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { baseCatalogs, mapPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { ReleasePage } from "./PlatformPages.jsx";

const { catalogState } = vi.hoisted(() => ({ catalogState: { current: null } }));

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});
vi.mock("../lib/wallet-context.js", () => ({ useWallet: () => ({ connected: false, owned: {}, ownershipRecords: [] }) }));

const ARTIST = { id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" };
const TOKEN_IMAGE = "ipfs://bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i";

function catalogOf({ releaseArtwork = "", tokenImage = TOKEN_IMAGE } = {}) {
  const release = {
    id: "release-ff",
    artist_id: "voidcaller",
    artist_slug: "voidcaller",
    artist_name: "Voidcaller",
    title: "Forgive & Forget",
    status: "PUBLISHED",
    release_metadata: releaseArtwork ? { artwork: releaseArtwork } : {},
  };
  const edition = {
    id: "edition-ff",
    release_id: "release-ff",
    title: "Forgive & Forget",
    status: "PUBLISHED",
    supply: "0",
    chain_id: "43114",
    contract_address: "0x1111111111111111111111111111111111111111",
    primary_sale_address: "0x2222222222222222222222222222222222222222",
    token_id: "1",
    token_metadata: tokenImage ? { image: tokenImage } : null,
  };
  const published = mapPublishedCatalog({ artists: [ARTIST], releases: [release], editions: [edition], experiences: [] });
  const merged = mergeCatalogs([...baseCatalogs(), published]);
  return { ...merged, collections: merged.collections || [], duplicates: {}, publishedLoading: false };
}

function renderRelease(id = "release-ff") {
  return render(
    <MemoryRouter initialEntries={[`/release/${id}`]}>
      <Routes>
        <Route path="/release/:release" element={<ReleasePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("Release page hero artwork", () => {
  it("uses the edition token image when the release has no stored artwork", () => {
    catalogState.current = catalogOf({ releaseArtwork: "" });
    renderRelease();
    const imgs = screen.getAllByAltText("Forgive & Forget artwork");
    const hero = imgs[0];
    expect(hero.getAttribute("src")).toContain("bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i");
    expect(hero.getAttribute("src")).not.toContain("voidcaller_art_4");
  });

  it("keeps the release artwork when the release has one stored", () => {
    catalogState.current = catalogOf({ releaseArtwork: "/assets/custom-cover.png", tokenImage: "" });
    renderRelease();
    const imgs = screen.getAllByAltText("Forgive & Forget artwork");
    const hero = imgs[0];
    expect(hero.getAttribute("src")).toBe("/assets/custom-cover.png");
  });
});
