/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { baseCatalogs, mapPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { createCollection } from "../domain/models.js";
import { DiscoverPage } from "./PlatformPages.jsx";

const { catalogState, walletState } = vi.hoisted(() => ({
  catalogState: { current: null },
  walletState: { current: { connected: false, owned: {}, ownershipRecords: [] } },
}));

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});
vi.mock("../lib/wallet-context.js", () => ({ useWallet: () => walletState.current }));

const ARTIST = { id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" };
const contract = "0x1111111111111111111111111111111111111111";
const sale = "0x2222222222222222222222222222222222222222";
const id = (letter) => ({ release: `release-${letter}`, edition: `edition-${letter}` });

// A factory (release-per-contract) edition whose sale state the API reports.
function factory(letter, availability, extra = {}) {
  return {
    release: { id: id(letter).release, artist_id: "voidcaller", artist_slug: "voidcaller", artist_name: "Voidcaller", title: `Release ${letter}`, status: "PUBLISHED" },
    edition: { id: id(letter).edition, release_id: id(letter).release, title: `Edition ${letter}`, status: "PUBLISHED", supply: "10", chain_id: "43113", contract_address: contract, primary_sale_address: sale, token_id: String(100 + letter.charCodeAt(0)), primary_availability: availability, ...extra },
  };
}

function catalogOf(rows, collections = []) {
  const published = mapPublishedCatalog({ artists: [ARTIST], releases: rows.map((row) => row.release), editions: rows.map((row) => row.edition), experiences: [] });
  const merged = mergeCatalogs([...baseCatalogs(), published]);
  return { ...merged, collections: [...(merged.collections || []), ...collections], duplicates: {}, publishedLoading: false };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function renderDiscover() {
  return render(
    <MemoryRouter initialEntries={["/discover"]}>
      <Routes>
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}
const collect = () => screen.getByRole("heading", { name: "Official editions available to collect" }).closest("section");

beforeEach(() => {
  walletState.current = { connected: false, owned: {}, ownershipRecords: [] };
});
afterEach(() => cleanup());

describe("Discover owns primary collecting", () => {
  const rows = [factory("A", "open"), factory("B", "sold-out"), factory("C", "ended"), factory("D", "not-started"), factory("E", "open"), factory("F", "paused")];
  const collections = [createCollection({ id: "col-1", name: "First Collection", artistIds: ["voidcaller"], releaseIds: ["release-A", "release-B", "release-C", "release-D", "release-F"] })];

  it("lists only editions whose primary sale is open, once each, grouped by collection", () => {
    catalogState.current = catalogOf(rows, collections);
    const { container } = renderDiscover();
    const section = collect();

    expect(section.querySelector("[data-edition-id='edition-A']")).toBeTruthy();
    expect(section.querySelector("[data-edition-id='edition-E']")).toBeTruthy();
    for (const letter of ["B", "C", "D", "F"]) expect(container.querySelector(`[data-edition-id='edition-${letter}']`)).toBeNull();
    for (const letter of ["A", "E"]) expect(container.querySelectorAll(`[data-edition-id='edition-${letter}']`)).toHaveLength(1);
    expect(within(section).getAllByRole("link", { name: "Collect" })).toHaveLength(2);

    const grouped = within(section).getByLabelText("First Collection editions");
    expect(grouped.querySelector("[data-edition-id='edition-A']")).toBeTruthy();
    expect(grouped.querySelector("[data-edition-id='edition-E']")).toBeNull();
    expect(within(section).getByRole("link", { name: "First Collection" }).getAttribute("href")).toBe("/collection/col-1");
    expect(within(section).getByLabelText("More official editions").querySelector("[data-edition-id='edition-E']")).toBeTruthy();
  });

  it("an edition with no sale state is never presented as collectable just because it exists", () => {
    catalogState.current = catalogOf([factory("G", undefined)]);
    const { container } = renderDiscover();
    expect(container.querySelector("[data-edition-id='edition-G']")).toBeNull();
    expect(screen.getByText("Nothing to collect right now")).toBeTruthy();
  });

  it("Collect uses the established edition-page flow through the real router", () => {
    catalogState.current = catalogOf([factory("A", "open")]);
    renderDiscover();
    const link = within(collect()).getByRole("link", { name: "Collect" });
    expect(link.getAttribute("href")).toBe("/edition/edition-A");
    fireEvent.click(link);
    expect(screen.getByTestId("location").textContent).toBe("/edition/edition-A");
  });

  it("states plainly that no primary edition is open, without the retired Shelf or secondary copy", () => {
    catalogState.current = catalogOf([factory("B", "sold-out"), factory("C", "ended")]);
    const { container } = renderDiscover();
    expect(screen.getByText("Nothing to collect right now")).toBeTruthy();
    expect(container.textContent).toMatch(/No official edition has an open primary sale/);
    expect(container.textContent).not.toMatch(/The shelf|Pressings|secondary listing|No active listings/i);
    expect(within(collect()).queryByRole("link", { name: "Collect" })).toBeNull();
  });

  it("shows a loading state, not the empty state, while the published catalog is still arriving", () => {
    catalogState.current = { ...catalogOf([]), publishedLoading: true };
    renderDiscover();
    expect(screen.getByText("Loading official editions…")).toBeTruthy();
    expect(screen.queryByText("Nothing to collect right now")).toBeNull();
  });

  it("keeps the existing exploration controls and links to collections and the secondary marketplace", () => {
    catalogState.current = catalogOf([factory("A", "open")]);
    renderDiscover();
    expect(screen.getByRole("navigation", { name: "Discovery categories" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse collections" }).getAttribute("href")).toBe("/collection");
    expect(screen.getByRole("link", { name: "Secondary marketplace" }).getAttribute("href")).toBe("/marketplace");
    expect(screen.queryByRole("region", { name: "The shelf" })).toBeNull();
  });
});
