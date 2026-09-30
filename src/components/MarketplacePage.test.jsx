/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { baseCatalogs, mapPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { EditionCard } from "./MarketplaceCards.jsx";
import { MarketplacePage } from "./MarketplacePage.jsx";

const { catalogState, fetchListings, walletState } = vi.hoisted(() => ({
  catalogState: { current: null },
  fetchListings: vi.fn(),
  walletState: { current: { connected: false, owned: {} } },
}));

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});

vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchIndexedListings: (...args) => fetchListings(...args) };
});

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({
      ...actual.MARKETPLACE_CONFIG,
      address: "0x982b28352fd612fe934c5e1ad8fea399689190d2",
      chainId: 43113,
      enabled: true,
    }),
  };
});

vi.mock("../lib/wallet-context.js", () => ({
  useWallet: () => walletState.current,
}));

const realReleaseId = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const realEditionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const realTokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const contractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const seller = "0xaBd3746e8b852f55be52fc44faB6cAb908b1c174";

function publicCatalog() {
  const published = mapPublishedCatalog({
    artists: [
      { id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" },
      { id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", slug: "wer", display_name: "wer", status: "ACTIVE" },
      { id: "artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138", slug: "qwe", display_name: "qwe", status: "ACTIVE" },
    ],
    releases: [
      { id: realReleaseId, artist_id: "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724", artist_slug: "voidcaller-7", artist_name: "Voidcaller", title: "VOIDCALLER", description: "The first call. The first relic. One relic unlocks the full EP.", status: "PUBLISHED" },
      { id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", artist_id: "artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3", artist_slug: "voidcaller-8", artist_name: "Voidcaller", title: "Marketplace Fuji E2E Test", description: "One-copy end-to-end test edition", status: "PUBLISHED" },
      { id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", artist_id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", artist_slug: "wer", artist_name: "wer", title: "PINATA CERTIFICATION 2026-09-27", description: "Metadata certification test", status: "PUBLISHED" },
    ],
    editions: [
      { id: realEditionId, release_id: realReleaseId, title: "VOIDCALLER", description: "Official Fuji V2 edition", status: "PUBLISHED", supply: "25", chain_id: "43113", contract_address: contractAddress, token_id: realTokenId, application_metadata: { artwork: "/assets/voidcaller_art_4.png", includes: ["Full self-titled EP", "Collector Reliquary access", "Token-gated music experiences"], priceWei: "10000000000000000" } },
      { id: "edition-b87f40b1-9419-4e90-8e2f-5b8986df043c", release_id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", title: "Marketplace Fuji E2E Test", status: "PUBLISHED", chain_id: "43113", contract_address: contractAddress, token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909" },
      { id: "edition-8ed9867c-e102-49c5-97a0-54ccf15605d2", release_id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", title: "wer", status: "PUBLISHED", chain_id: "43113", contract_address: contractAddress, token_id: "86336109522257422783953313092869910591261689395232051112421244253165221467155" },
    ],
    experiences: [],
  });
  return mergeCatalogs([...baseCatalogs(), published]);
}

function renderMarketplace() {
  return render(<MemoryRouter><MarketplacePage /></MemoryRouter>);
}

beforeEach(() => {
  catalogState.current = publicCatalog();
  walletState.current = { connected: false, owned: {} };
  fetchListings.mockReset();
  fetchListings.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("public marketplace inventory", () => {
  it("shows only official collectible editions and one concise empty secondary state, not artist or publishing rails", async () => {
    const { container } = renderMarketplace();
    await waitFor(() => expect(screen.getByText("No active listings")).toBeTruthy());

    expect(screen.getByRole("heading", { name: "Official editions available to collect" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Secondary collector listings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "VOIDCALLER" })).toBeTruthy();
    expect(screen.getByText("Full self-titled EP")).toBeTruthy();
    expect(container.textContent).toMatch(/Avalanche Fuji.*43113|Fuji.*43113/i);
    expect(container.textContent).toContain("0.01 AVAX");
    expect(container.textContent).not.toMatch(/Marketplace Fuji E2E|PINATA CERTIFICATION|\bwer\b|\bqwe\b/i);
    expect(container.textContent).not.toMatch(/Recently listed|Add tracks|Open artist studio|From the artists/i);
    expect(container.querySelectorAll(`[data-edition-id="${realEditionId}"]`)).toHaveLength(1);
    expect(container.querySelectorAll("[data-edition-id='edition-b87f40b1-9419-4e90-8e2f-5b8986df043c']")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Collect" }).getAttribute("href")).toBe(`/edition/${realEditionId}`);

    const secondaryHeading = screen.getByRole("heading", { name: "Secondary collector listings" });
    const secondary = secondaryHeading.closest("section");
    expect(within(secondary).getByText("No active listings")).toBeTruthy();
    expect(secondary.querySelectorAll("[data-edition-id]")).toHaveLength(0);
  });

  it("shows an indexed offer once and keeps its primary collect action in that single card", async () => {
    fetchListings.mockResolvedValueOnce([{
      id: "listing-1",
      listingId: "1",
      seller,
      chain: 43113,
      tokenContract: contractAddress,
      tokenId: realTokenId,
      amount: "1",
      price: "20000000000000000",
      status: "ACTIVE",
      authority: "INDEXED",
    }]);
    const { container } = renderMarketplace();
    await waitFor(() => expect(screen.getByText("Seller · 0xaBd3…c174")).toBeTruthy());

    expect(container.querySelectorAll(`[data-edition-id="${realEditionId}"]`)).toHaveLength(1);
    const secondaryHeading = screen.getByRole("heading", { name: "Secondary collector listings" });
    const secondary = secondaryHeading.closest("section");
    expect(within(secondary).getByText("Available · 1 · 0.02 AVAX")).toBeTruthy();
    expect(within(secondary).getByText("Full self-titled EP")).toBeTruthy();
    expect(within(secondary).getByRole("link", { name: "View edition" }).getAttribute("href")).toBe(`/edition/${realEditionId}`);
    expect(within(secondary).getByRole("link", { name: "Collect" }).getAttribute("href")).toBe(`/edition/${realEditionId}`);
    expect(screen.getByText("Official editions grouped below")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Marketplace Fuji E2E|PINATA CERTIFICATION/i);
  });
});

describe("marketplace card destinations", () => {
  it("routes owned editions to a real experience and otherwise labels edition routes View edition", () => {
    const item = {
      artist: { name: "Voidcaller" },
      release: { title: "VOIDCALLER", artwork: "/cover.png" },
      edition: { id: "voidcaller-chapter-i", title: "Chapter I · The Relic", chainId: 43114, tokenIds: ["1"], includes: [] },
      chain: { name: "Avalanche C-Chain", id: 43114 },
      primary: { availability: "minted", href: "/edition/voidcaller-chapter-i" },
      experiences: [{ id: "voidcaller-legacy-track-1" }],
    };
    const { rerender } = render(<MemoryRouter><EditionCard item={item} owned /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Open experience" }).getAttribute("href")).toBe("/experience/voidcaller-legacy-track-1");
    rerender(<MemoryRouter><EditionCard item={{ ...item, experiences: [] }} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "View edition" }).getAttribute("href")).toBe("/edition/voidcaller-chapter-i");
  });
});
