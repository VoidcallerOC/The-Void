/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { baseCatalogs, mapPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { EditionCard } from "./MarketplaceCards.jsx";
import { MarketplacePage } from "./MarketplacePage.jsx";

const { catalogState, fetchListings, fetchVolume, fetchPresentation, fetchEditor, walletState } = vi.hoisted(() => ({
  catalogState: { current: null },
  fetchListings: vi.fn(),
  fetchVolume: vi.fn(),
  fetchPresentation: vi.fn(),
  fetchEditor: vi.fn(),
  walletState: { current: { connected: false, owned: {} } },
}));

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});

vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchIndexedListings: (...args) => fetchListings(...args),
    fetchMarketplaceVolume: (...args) => fetchVolume(...args),
    fetchMarketplacePresentation: (...args) => fetchPresentation(...args),
    fetchMarketplacePresentationEditor: (...args) => fetchEditor(...args),
  };
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
const contractAddress = "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6";
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
      { id: "release-1b4a2d71-218f-47a2-afde-cd5171909ace", artist_id: "voidcaller", artist_slug: "voidcaller", artist_name: "Voidcaller", title: "Forgive & Forget", description: "The space between Silence and Sound/", status: "PUBLISHED" },
      { id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", artist_id: "artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3", artist_slug: "voidcaller-8", artist_name: "Voidcaller", title: "Marketplace Fuji E2E Test", description: "One-copy end-to-end test edition", status: "PUBLISHED" },
      { id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", artist_id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", artist_slug: "wer", artist_name: "wer", title: "PINATA CERTIFICATION 2026-09-27", description: "Metadata certification test", status: "PUBLISHED" },
    ],
    editions: [
      { id: realEditionId, release_id: realReleaseId, title: "VOIDCALLER", description: "Official Fuji V2 edition", status: "PUBLISHED", supply: "25", chain_id: "43113", contract_address: contractAddress, token_id: realTokenId, application_metadata: { artwork: "/assets/voidcaller_art_4.png", includes: ["Full self-titled EP", "Collector Reliquary access", "Token-gated music experiences"], priceWei: "10000000000000000" } },
      { id: "edition-9362e29d-341d-4e84-a64b-45753e7d0ff1", release_id: "release-1b4a2d71-218f-47a2-afde-cd5171909ace", title: "Forgive & Forget", status: "PUBLISHED", supply: "0", chain_id: "43113", contract_address: contractAddress, token_id: "5539478311145551066997171016458124004742133628133122798593311459807321372836" },
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
  fetchVolume.mockReset();
  fetchVolume.mockResolvedValue({ currency: "AVAX", overallVolumeWei: "30000000000000000" });
  fetchPresentation.mockReset();
  fetchPresentation.mockResolvedValue({ heroArtwork: null, updatedAt: null });
  fetchEditor.mockReset();
  fetchEditor.mockResolvedValue({ admin: false });
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
    expect(screen.getByLabelText("Overall volume").textContent).toMatch(/Overall volume\s*0\.03 AVAX/i);
    expect(container.textContent).toMatch(/Avalanche Fuji.*43113|Fuji.*43113/i);
    expect(container.textContent).toContain("0.01 AVAX");
    expect(container.textContent).not.toMatch(/Marketplace Fuji E2E|PINATA CERTIFICATION|\bwer\b|\bqwe\b/i);
    expect(container.textContent).not.toMatch(/Forgive & Forget/);
    expect(container.querySelectorAll("[data-edition-id='edition-9362e29d-341d-4e84-a64b-45753e7d0ff1']")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Recently listed|Add tracks|Open artist studio|From the artists/i);
    expect(container.textContent).not.toMatch(/Overall Mint Volume|Floor over mint|25x|25×/i);
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
    expect(within(secondary).getAllByRole("link", { name: /^View token #/ })[0].getAttribute("href")).toBe(`/edition/${realEditionId}/token/${realTokenId}`);
    expect(within(secondary).getByRole("link", { name: "Collect" }).getAttribute("href")).toBe(`/edition/${realEditionId}`);
    expect(screen.getByText("Official editions grouped below")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Marketplace Fuji E2E|PINATA CERTIFICATION/i);
  });
});

describe("marketplace hero artwork", () => {
  const heroBg = (container) => container.querySelector(".vc-market-hero-bg");

  it("shows no hero artwork when none is configured, never an edition image", async () => {
    const { container } = renderMarketplace();
    await waitFor(() => expect(screen.getByText("No active listings")).toBeTruthy());
    expect(heroBg(container)).toBeNull();
  });

  it("shows the configured artwork, and an indexed listing's token art never replaces it", async () => {
    fetchPresentation.mockResolvedValue({ heroArtwork: "/assets/hero-b.png", updatedAt: "2026-10-03T00:00:00Z" });
    fetchListings.mockResolvedValueOnce([{ id: "listing-1", listingId: "1", seller, chain: 43113, tokenContract: contractAddress, tokenId: realTokenId, amount: "1", price: "500000000000000000", status: "ACTIVE", authority: "INDEXED" }]);
    const { container } = renderMarketplace();
    await waitFor(() => expect(heroBg(container)).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Seller · 0xaBd3…c174")).toBeTruthy());
    expect(heroBg(container).style.backgroundImage).toContain("/assets/hero-b.png");
    expect(heroBg(container).style.backgroundImage).not.toContain("voidcaller_art_4");
  });

  it("offers the header editor only to a wallet the server confirms as admin", async () => {
    walletState.current = { connected: true, authenticated: true, account: "0x284c09a7cc187e096cbbdc88d99defe6df32180a", authHeaders: {}, owned: {} };
    const first = renderMarketplace();
    await waitFor(() => expect(fetchEditor).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Admin · Header artwork" })).toBeNull();
    first.unmount();
    fetchEditor.mockResolvedValue({ admin: true });
    renderMarketplace();
    await waitFor(() => expect(screen.getByRole("button", { name: "Admin · Header artwork" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Admin · Header artwork" }));
    expect(screen.getByLabelText("Upload header image").getAttribute("type")).toBe("file");
  });

  it("does not ask the server about admin rights for a signed-out visitor", async () => {
    renderMarketplace();
    await waitFor(() => expect(screen.getByText("No active listings")).toBeTruthy());
    expect(fetchEditor).not.toHaveBeenCalled();
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

describe("secondary listings come first on the page when they exist", () => {
  const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const headings = () => ({
    shelf: screen.getByRole("region", { name: "The shelf" }),
    official: screen.getByRole("heading", { name: "Official editions available to collect" }),
    secondary: screen.getByRole("heading", { name: "Secondary collector listings" }),
  });
  const genesisListing = {
    id: "07b7aa4a-312a-4a22-bd50-2de63e674192", listingId: "1", seller: "0x6a86efa012feda64b70112022487fee22e67d2fb", chain: 43114,
    marketplace: "0x75964c44ca586b13e98e7c30e74d2b4114f65b06", tokenContract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
    contract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", tokenId: "0", amount: "1", initialAmount: "1",
    price: "10000000000000000", currency: "native", expiresAt: 0, status: "ACTIVE", authority: "INDEXED",
  };

  it("an active Genesis listing (production listing #1 shape) renders above the empty primary rails with its seller and price", async () => {
    catalogState.current = mergeCatalogs(baseCatalogs()); // the shipped catalog, where Genesis is the public Voidcaller edition
    fetchListings.mockResolvedValueOnce([genesisListing]);
    const { container } = renderMarketplace();
    await waitFor(() => expect(container.querySelector("[data-edition-id='voidcaller-chapter-i']")).toBeTruthy());
    const { shelf, official, secondary } = headings();
    expect(before(secondary, shelf)).toBe(true);
    expect(before(secondary, official)).toBe(true);
    const section = secondary.closest("section");
    expect(within(section).getByText(/0X6A86…D2FB|0x6a86…d2fb/i)).toBeTruthy();
    expect(section.textContent).toContain("0.01 AVAX");
    expect(within(section).queryByText("No active listings")).toBeNull();
  });

  it("a factory-release listing also moves the secondary section first", async () => {
    fetchListings.mockResolvedValueOnce([{ id: "l", listingId: "2", seller, chain: 43113, tokenContract: contractAddress, tokenId: realTokenId, amount: "1", price: "20000000000000000", status: "ACTIVE", authority: "INDEXED" }]);
    const { container } = renderMarketplace();
    await waitFor(() => expect(container.textContent).toContain("0.02 AVAX"));
    const { official, secondary } = headings();
    expect(before(secondary, official)).toBe(true);
  });

  it("with no eligible listing the original order and the empty state are kept", async () => {
    catalogState.current = mergeCatalogs(baseCatalogs());
    fetchListings.mockResolvedValueOnce([{ ...genesisListing, status: "CANCELLED" }, { ...genesisListing, id: "x", amount: "0" }]);
    renderMarketplace();
    await waitFor(() => expect(screen.getByText("No active listings")).toBeTruthy());
    const { shelf, official, secondary } = headings();
    expect(before(shelf, secondary)).toBe(true);
    expect(before(official, secondary)).toBe(true);
  });
});

describe("secondary listing cards show the exact listed token's metadata", () => {
  const genesis = (tokenId, extra = {}) => ({
    id: `g-${tokenId}-${extra.listingId || "1"}`, listingId: "1", seller: "0x6a86efa012feda64b70112022487fee22e67d2fb", chain: 43114,
    tokenContract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee", tokenId: String(tokenId), amount: "1", price: "10000000000000000",
    status: "ACTIVE", authority: "INDEXED", ...extra,
  });
  const card = () => document.querySelector("[data-edition-id='voidcaller-chapter-i']");
  beforeEach(() => { catalogState.current = mergeCatalogs(baseCatalogs()); });

  it("listing #1 (token 0) leads with that token's own name and art, keeping edition context, seller, price and links", async () => {
    fetchListings.mockResolvedValueOnce([genesis(0)]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    const el = card();
    expect(within(el).getByRole("heading", { name: "Enough" })).toBeTruthy();
    expect(el.textContent).toMatch(/Token #0 · from the .+ edition/);
    expect(el.querySelector("img").getAttribute("src")).toBe("https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif");
    expect(el.querySelector("img").getAttribute("alt")).toBe("Enough, token #0 artwork");
    expect(el.textContent).toContain("Token #0 · Enough");
    expect(el.textContent).toMatch(/Seller · 0x6a86…d2fb/i);
    expect(el.textContent).toContain("Available · 1 · 0.01 AVAX");
    expect(within(el).getAllByRole("link", { name: "View token #0, Enough" }).map((link) => link.getAttribute("href"))).toEqual(["/edition/voidcaller-chapter-i/token/0", "/edition/voidcaller-chapter-i/token/0"]);
    expect(within(el).queryByRole("link", { name: "View edition" })).toBeNull();
  });

  it("if the token's IPFS image fails, it falls back to that token's local art, then the edition art", async () => {
    fetchListings.mockResolvedValueOnce([genesis(0)]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    const img = () => card().querySelector("img");
    expect(img().getAttribute("src")).toBe("https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif");
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe("/assets/track-art/ep1-enough.png");
    expect(img().getAttribute("alt")).toBe("Enough, token #0 artwork");
    fireEvent.error(img());
    expect(img().getAttribute("alt")).toMatch(/edition artwork$/);
  });

  it("a different token id resolves to its own, different metadata", async () => {
    fetchListings.mockResolvedValueOnce([genesis(2)]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByRole("heading", { name: "Don't Look Down" })).toBeTruthy();
    expect(card().querySelector("img").getAttribute("src")).toBe("https://gateway.pinata.cloud/ipfs/QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs");
    expect(card().textContent).not.toContain("Enough");
  });

  it("offers for two different tokens keep the edition heading and name each token on its own offer row", async () => {
    fetchListings.mockResolvedValueOnce([genesis(0), genesis(3, { listingId: "2" })]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    const el = card();
    expect(within(el).queryByRole("heading", { name: "Enough" })).toBeNull();
    expect(el.querySelector("img").getAttribute("alt")).toMatch(/edition artwork$/);
    expect(el.textContent).toContain("Token #0 · Enough");
    expect(el.textContent).toContain("Token #3 · Complex");
  });

  it("two offers for the same token share one identical token identity without inventing differences", async () => {
    fetchListings.mockResolvedValueOnce([genesis(1), genesis(1, { listingId: "2", seller: "0x0000000000000000000000000000000000000abc" })]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByRole("heading", { name: "The Hollow" })).toBeTruthy();
    expect(card().textContent.match(/Token #1 · The Hollow/g)).toHaveLength(2);
  });

  it("a token with no catalog metadata says so and never presents edition art as the token's", async () => {
    const catalog = mergeCatalogs(baseCatalogs());
    catalogState.current = { ...catalog, tokens: (catalog.tokens || []).filter((token) => !(token.editionId === "voidcaller-chapter-i" && String(token.tokenId) === "0")) };
    fetchListings.mockResolvedValueOnce([genesis(0)]);
    renderMarketplace();
    await waitFor(() => expect(card()).toBeTruthy());
    const el = card();
    expect(el.textContent).toContain("Token #0 · Token metadata unavailable");
    expect(el.querySelector("img").getAttribute("alt")).toMatch(/edition artwork$/);
    expect(within(el).queryByRole("heading", { name: "Enough" })).toBeNull();
  });
});
