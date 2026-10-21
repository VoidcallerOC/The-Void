/** @vitest-environment jsdom */
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetTokenId, canListAsset, listingHref, requestedTokenId } from "../lib/asset-actions.js";
import { ListForSaleLink } from "./AssetActions.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { baseCatalogs, mergeCatalogs } from "../lib/catalog-source.js";

const { catalogState } = vi.hoisted(() => ({ catalogState: { current: null } }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});
const { MyCollectionPage } = await import("./PlatformPages.jsx");
const { Reliquary } = await import("./Reliquary.jsx");
const { EditionCard } = await import("./MarketplaceCards.jsx");

afterEach(cleanup);

const GENESIS = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const catalog = () => mergeCatalogs(baseCatalogs());
const genesis = () => catalog().editions.find((edition) => edition.id === "voidcaller-chapter-i");
// A factory-registered-looking edition the unified marketplace does not accept (no recorded factory): not listable.
const unlistable = { id: "not-listable", title: "Not listable", chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenIds: ["5"] };
const holding = (tokenId, amount = 1) => ({ wallet: "0xabc0000000000000000000000000000000000001", contract: GENESIS, tokenId: String(tokenId), amount, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" } });
const wallet = (records) => ({ connected: true, account: "0xabc0000000000000000000000000000000000001", loadingOwnership: false, ownershipRecords: records, owned: {}, chainId: 43114, getProvider: () => null, disconnect: () => {} });

let current = "";
function LocationProbe() {
  const location = useLocation();
  useEffect(() => { current = `${location.pathname}${location.search}${location.hash}`; }, [location]);
  return null;
}

describe("asset identity helpers", () => {
  it("keeps the exact token id and never substitutes a default", () => {
    const edition = genesis();
    expect(edition.tokenIds.map(String)).toEqual(["0", "1", "2", "3"]);
    expect(assetTokenId(edition, 2)).toBe("2");
    expect(assetTokenId(edition, "3")).toBe("3");
    expect(assetTokenId(edition, 4)).toBeNull();
    expect(assetTokenId(edition, "x")).toBeNull();
    expect(listingHref(edition, 2)).toBe("/edition/voidcaller-chapter-i?token=2#secondary-listing");
    expect(listingHref(edition, 9)).toBe("/edition/voidcaller-chapter-i#secondary-listing");
    expect(listingHref(edition)).toBe("/edition/voidcaller-chapter-i#secondary-listing");
    expect(requestedTokenId("?token=3")).toBe("3");
    expect(requestedTokenId("?token=3x")).toBeNull();
    expect(requestedTokenId("")).toBeNull();
  });

  it("offers listing only for marketplace-listable assets and their own token ids", () => {
    expect(canListAsset(genesis())).toBe(true);
    expect(canListAsset(genesis(), 1)).toBe(true);
    expect(canListAsset(genesis(), 4)).toBe(false);
    expect(canListAsset(unlistable)).toBe(false);
  });

  it("renders nothing for an asset the surface does not report as owned, or one that cannot be listed", () => {
    const html = (element) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
    expect(html(<ListForSaleLink edition={genesis()} tokenId={2} owned={false} />)).toBe("");
    expect(html(<ListForSaleLink edition={unlistable} owned />)).toBe("");
    expect(html(<ListForSaleLink edition={genesis()} tokenId={2} owned />)).toContain('href="/edition/voidcaller-chapter-i?token=2#secondary-listing"');
    expect(html(<ListForSaleLink edition={genesis()} tokenId={2} owned />)).toContain('aria-label="List for sale: Voidcaller Genesis, token #2"'.replace("Voidcaller Genesis", genesis().title));
  });
});

describe("asset-first entry points", () => {
  it("My collection: each held Genesis token lists itself, and the link lands on the edition carrying that token", async () => {
    catalogState.current = catalog();
    render(
      <WalletCtx.Provider value={wallet([holding(2), holding(3)])}>
        <MemoryRouter initialEntries={["/my-collection"]}>
          <LocationProbe />
          <Routes>
            <Route path="/my-collection" element={<MyCollectionPage />} />
            <Route path="/edition/:edition" element={<p>edition page</p>} />
          </Routes>
        </MemoryRouter>
      </WalletCtx.Provider>,
    );
    const links = screen.getAllByRole("link", { name: /^List for sale/ });
    expect(links.map((link) => link.getAttribute("href")).sort()).toEqual([
      "/edition/voidcaller-chapter-i?token=2#secondary-listing",
      "/edition/voidcaller-chapter-i?token=3#secondary-listing",
    ]);
    // The overview remains: the "Owned" link to the edition is still there.
    expect(screen.getAllByRole("link", { name: "Owned" }).length).toBe(2);
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: /token #3$/ })); });
    expect(current).toBe("/edition/voidcaller-chapter-i?token=3#secondary-listing");
    expect(screen.getByText("edition page")).toBeTruthy();
  });

  it("Reliquary: each held token card offers listing for exactly that token", () => {
    catalogState.current = catalog();
    const html = renderToStaticMarkup(
      <WalletCtx.Provider value={wallet([holding(1)])}>
        <MemoryRouter><Reliquary /></MemoryRouter>
      </WalletCtx.Provider>,
    );
    expect(html).toContain('href="/edition/voidcaller-chapter-i?token=1#secondary-listing"');
    expect(html).not.toContain("token=0");
  });

  it("Marketplace edition cards: an owned listable edition offers listing; an unowned one does not", () => {
    const edition = genesis();
    const item = { edition, artist: { name: "Voidcaller" }, release: { title: "Genesis" }, primary: { href: "/edition/x" }, chain: { id: 43114, name: "Avalanche C-Chain" }, experiences: [] };
    const owned = renderToStaticMarkup(<MemoryRouter><EditionCard item={item} owned /></MemoryRouter>);
    const browsing = renderToStaticMarkup(<MemoryRouter><EditionCard item={item} /></MemoryRouter>);
    expect(owned).toContain('href="/edition/voidcaller-chapter-i#secondary-listing"');
    expect(browsing).not.toContain("secondary-listing");
  });

  it("disconnected My collection shows the connect prompt and no owner-only action", () => {
    catalogState.current = catalog();
    render(
      <WalletCtx.Provider value={{ ...wallet([]), connected: false, account: null }}>
        <MemoryRouter><MyCollectionPage /></MemoryRouter>
      </WalletCtx.Provider>,
    );
    expect(screen.getByText(/Connect a wallet to reveal your collection/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^List for sale/ })).toBeNull();
  });
});
