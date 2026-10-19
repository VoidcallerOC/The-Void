/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Nav, REVIEWER_NAV_LABEL, REVIEWER_NAV_PATH } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { ReviewerNotificationsProvider } from "../lib/ReviewerNotificationsProvider.jsx";
import { createReviewerNotificationStore } from "../lib/reviewer-notifications.js";

// The header a collector sees, in order: collector destinations, then the artist-facing pair.
const PRIMARY_NAV = [
  ["DISCOVER", "/discover"],
  ["MARKETPLACE", "/marketplace"],
  ["CLAIM", "/claim"],
  ["ARTISTS", "/artists"],
  ["COLLECTION", "/collection"],
  ["VERIFY", "/verify"],
  ["ARTIST STUDIO", "/studio"],
];
const REVIEWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => cleanup());

function walletValue(account) {
  const authSession = account ? { token: `tok-${account}`, wallet: account, chainId: 43114 } : null;
  return {
    wallets: [], account, chainId: account ? 43114 : null, owned: {}, ownershipRecords: [], connected: Boolean(account), authenticated: Boolean(authSession), authenticating: false,
    authenticationError: null, needsNetworkSwitch: false, authSession, authHeaders: authSession ? { authorization: `Bearer ${authSession.token}` } : {},
    getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn(),
  };
}
function storeFor({ reviewer, count }) {
  return createReviewerNotificationStore({ fetchMe: vi.fn().mockResolvedValue({ application: null, canReapply: true, reviewer }), fetchCount: vi.fn().mockResolvedValue({ count }) });
}
function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}
function renderHeader({ path = "/", account = null, store = storeFor({ reviewer: false, count: 0 }) } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WalletCtx.Provider value={walletValue(account)}>
        <ReviewerNotificationsProvider store={store}>
          <Nav />
          <Routes><Route path="*" element={<LocationProbe />} /></Routes>
        </ReviewerNotificationsProvider>
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}
const desktopLinks = () => [...document.querySelectorAll(".vc-nav-links a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]);
const mobileLinks = () => [...document.querySelectorAll(".vc-nav-menu a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]);

describe("site header · navigation inventory", () => {
  it("lists the primary destinations once each, every one to a distinct route", () => {
    renderHeader();
    expect(desktopLinks()).toEqual(PRIMARY_NAV);
    const hrefs = desktopLinks().map(([, href]) => href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("links the logo to the home page", () => {
    renderHeader({ path: "/discover" });
    const logo = document.querySelector("nav a[href='/']");
    expect(logo).toBeTruthy();
    expect(within(logo).getByAltText("VOIDCALLER")).toBeTruthy();
  });

  it("gives the mobile menu the same destinations in the same order, and closes it after a choice", () => {
    renderHeader();
    expect(document.querySelector(".vc-nav-menu")).toBeNull();
    fireEvent.click(document.querySelector("button[aria-label='Open menu']"));
    expect(mobileLinks()).toEqual(PRIMARY_NAV);
    fireEvent.click(within(document.querySelector(".vc-nav-menu")).getByText("ARTISTS"));
    expect(screen.getByTestId("location").textContent).toBe("/artists");
    expect(document.querySelector(".vc-nav-menu")).toBeNull();
    expect(document.querySelector("button[aria-label='Open menu']")).toBeTruthy();
  });

  it("marks only the section that contains the current route as active", () => {
    renderHeader({ path: "/collection/voidcaller-collection" });
    const active = [...document.querySelectorAll(".vc-nav-links a.active")].map((a) => a.textContent.trim());
    expect(active).toEqual(["COLLECTION"]);
  });

  it("marks nothing active on the home page", () => {
    renderHeader({ path: "/" });
    expect(document.querySelectorAll(".vc-nav-links a.active")).toHaveLength(0);
  });

  it("shows the reviewer queue only to an authorized reviewer wallet, in both menus", async () => {
    renderHeader({ account: REVIEWER });
    expect(desktopLinks().map(([label]) => label)).not.toContain(REVIEWER_NAV_LABEL);
    cleanup();
    const store = storeFor({ reviewer: true, count: 2 });
    await store.sync({ ready: true, wallet: REVIEWER, headers: { authorization: `Bearer tok-${REVIEWER}` } });
    renderHeader({ account: REVIEWER, store });
    expect(desktopLinks()).toContainEqual([`${REVIEWER_NAV_LABEL}2`, REVIEWER_NAV_PATH]);
    fireEvent.click(document.querySelector("button[aria-label='Open menu']"));
    expect(mobileLinks().map(([, href]) => href)).toContain(REVIEWER_NAV_PATH);
    // Same order in both menus, reviewer link included.
    expect(mobileLinks()).toEqual(desktopLinks());
  });
});

describe("site footer · navigation inventory", () => {
  it("routes its internal links to distinct existing pages and opens external ones in a new tab", () => {
    render(<MemoryRouter><Footer /></MemoryRouter>);
    const internal = [...document.querySelectorAll("footer a[href^='/']")].map((a) => a.getAttribute("href"));
    expect(internal).toEqual(["/discover", "/marketplace", "/artists", "/verify", "/collection", "/studio", "/release/voidcaller-self-titled"]);
    expect(new Set(internal).size).toBe(internal.length);
    for (const a of document.querySelectorAll("footer a[href^='http']")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });
});
