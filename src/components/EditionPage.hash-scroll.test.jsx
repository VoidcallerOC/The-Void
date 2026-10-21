/** @vitest-environment jsdom */
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditionPage } from "./PlatformPages.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { baseCatalogs, mergeCatalogs } from "../lib/catalog-source.js";

const { catalogState } = vi.hoisted(() => ({ catalogState: { current: null } }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});

// The Genesis edition (0xD1B4…98eE, token ids 0-3) as the base catalog defines it.
const GENESIS_EDITION = "voidcaller-chapter-i";
const wallet = { account: null, connected: false, authenticated: false, authHeaders: {}, chainId: null, getProvider: () => null, owned: { cchain: new Set(), grotto: new Set(), fuji: new Set() }, ownershipRecords: [] };
const loaded = () => mergeCatalogs(baseCatalogs());
const loading = () => ({ ...mergeCatalogs([]), publishedLoading: true });

const nav = { current: null };
function NavigateProbe() {
  const navigate = useNavigate();
  useEffect(() => { nav.current = navigate; }, [navigate]);
  return null;
}
function renderAt(url) {
  return render(
    <WalletCtx.Provider value={wallet}>
      <MemoryRouter initialEntries={[url]}>
        <NavigateProbe />
        <Routes><Route path="/edition/:edition" element={<EditionPage />} /></Routes>
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

let scrolled;
beforeEach(() => {
  scrolled = [];
  // jsdom implements neither layout nor scrolling: record which element was asked to scroll.
  Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(options) { scrolled.push({ id: this.id, options }); });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => setTimeout(() => callback(0), 0));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => clearTimeout(handle));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const flushFrame = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

describe("EditionPage #secondary-listing navigation (List for sale)", () => {
  it("scrolls to the listing panel once the edition renders after an asynchronous catalog load", async () => {
    catalogState.current = loading();
    const view = renderAt(`/edition/${GENESIS_EDITION}#secondary-listing`);
    await flushFrame();
    expect(document.getElementById("secondary-listing")).toBeNull();
    expect(scrolled).toEqual([]); // nothing to scroll to yet, and no exception
    catalogState.current = loaded();
    view.rerender(
      <WalletCtx.Provider value={wallet}>
        <MemoryRouter initialEntries={[`/edition/${GENESIS_EDITION}#secondary-listing`]}>
          <NavigateProbe />
          <Routes><Route path="/edition/:edition" element={<EditionPage />} /></Routes>
        </MemoryRouter>
      </WalletCtx.Provider>,
    );
    await flushFrame();
    expect(document.getElementById("secondary-listing")).not.toBeNull();
    expect(scrolled).toEqual([{ id: "secondary-listing", options: { behavior: "smooth", block: "start" } }]);
  });

  it("scrolls when only the hash changes on the same edition, and again when the same link is followed twice", async () => {
    catalogState.current = loaded();
    renderAt(`/edition/${GENESIS_EDITION}`);
    await flushFrame();
    expect(scrolled).toEqual([]); // no fragment, no scroll
    await act(async () => nav.current(`/edition/${GENESIS_EDITION}#secondary-listing`));
    await flushFrame();
    expect(scrolled.map((item) => item.id)).toEqual(["secondary-listing"]);
    await act(async () => nav.current(`/edition/${GENESIS_EDITION}#secondary-listing`));
    await flushFrame();
    expect(scrolled.map((item) => item.id)).toEqual(["secondary-listing", "secondary-listing"]);
  });

  it("does not throw for a missing edition or an unrelated fragment", async () => {
    catalogState.current = loaded();
    renderAt("/edition/does-not-exist#secondary-listing");
    await flushFrame();
    expect(scrolled).toEqual([]);
    cleanup();
    renderAt(`/edition/${GENESIS_EDITION}#something-else`);
    await flushFrame();
    expect(scrolled).toEqual([]);
  });

  it("lands on a panel that states why listing is unavailable instead of failing silently (wallet disconnected)", async () => {
    catalogState.current = loaded();
    renderAt(`/edition/${GENESIS_EDITION}#secondary-listing`);
    await flushFrame();
    const panel = document.getElementById("secondary-listing");
    expect(panel.textContent).toMatch(/List for sale/i);
    // Disconnected: the panel offers the wallet button and a status line; no listing control is enabled.
    expect(panel.querySelector("button:not([disabled])")?.textContent || "").not.toMatch(/^LIST FOR SALE$/);
    expect(panel.querySelectorAll('[role="status"], span').length).toBeGreaterThan(0);
  });
});
