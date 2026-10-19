/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, RouterProvider, createMemoryRouter, useLocation } from "react-router-dom";
import { WalletCtx } from "./lib/wallet-context.js";
import { ReviewerNotificationsProvider } from "./lib/ReviewerNotificationsProvider.jsx";
import { createReviewerNotificationStore } from "./lib/reviewer-notifications.js";
import { VOIDCALLER_CATALOG } from "./data.js";

// The route table mounted in a memory router with the real header and footer, a light page shell in
// place of the production Layout (no wallet provider, audio bar or starfield), the static Voidcaller
// catalog, and every API call answered 503 so the pages render their fallbacks.
const state = vi.hoisted(() => ({ publishedLoading: false }));
vi.mock("./lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { collapsePublicCatalog } = await import("./lib/summit-demo.js");
  const collapsed = collapsePublicCatalog(actual.mergeCatalogs(actual.baseCatalogs()));
  return { ...actual, useMarketplaceCatalogs: () => ({ ...collapsed, duplicates: collapsed.duplicates || {}, get publishedLoading() { return state.publishedLoading; } }) };
});
vi.mock("./lib/marketplace-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchIndexedListings: vi.fn(async () => []),
  fetchMarketplaceVolume: vi.fn(async () => null),
  fetchMarketplacePresentation: vi.fn(async () => null),
  fetchMarketplacePresentationEditor: vi.fn(async () => null),
}));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("./components/Layout.jsx", async () => {
  const { Nav } = await import("./components/Nav.jsx");
  const { Footer } = await import("./components/Footer.jsx");
  const { DocumentTitle } = await vi.importActual("./components/Layout.jsx");
  const { useMarketplaceCatalogs } = await import("./lib/catalog-source.js");
  function Layout() {
    const catalog = useMarketplaceCatalogs();
    return (
      <WalletCtx.Provider value={wallet}>
        <ReviewerNotificationsProvider store={createReviewerNotificationStore({ fetchMe: async () => ({ application: null, canReapply: true, reviewer: false }), fetchCount: async () => ({ count: 0 }) })}>
          <DocumentTitle catalog={catalog} />
          <Nav />
          <main><Outlet context={{ catalog }} /></main>
          <Footer />
        </ReviewerNotificationsProvider>
      </WalletCtx.Provider>
    );
  }
  return { Layout };
});
const wallet = {
  wallets: [], account: null, chainId: null, owned: {}, ownershipRecords: [], connected: false, authenticated: false, authenticating: false, authenticationError: null,
  needsNetworkSwitch: false, authSession: null, authHeaders: {}, loadingOwnership: false, getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn(), ensureNetwork: vi.fn(),
};
const { AppRoutes } = await import("./App.jsx");

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname}{search}</output>;
}
function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}
const heading = () => screen.getAllByRole("heading", { level: 1 })[0].textContent.trim();
const location = () => screen.getByTestId("location").textContent;

// Visible page identity of each primary destination: the URL, the H1 and the document title.
const PRIMARY_PAGES = [
  ["/discover", /Currently featuring Voidcaller/i, "Discover · The Void"],
  ["/marketplace", /Releases/i, "Marketplace · The Void"],
  ["/claim", /Genesis claim/i, "Genesis claim · The Void"],
  ["/artists", /^Artists$/i, "Artists · The Void"],
  ["/collection", /^The Void$/i, "Catalog · The Void"],
  ["/verify", /Become verified/i, "Become verified · The Void"],
  ["/studio", /Create the relic/i, "Artist studio · The Void"],
];

beforeEach(() => {
  state.publishedLoading = false;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({ error: "unavailable" }), text: async () => "" })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route table · primary destinations", () => {
  it("covers every header link with a route of its own", () => {
    mount("/");
    const header = [...document.querySelectorAll(".vc-nav-links a")].map((a) => a.getAttribute("href"));
    expect(header).toEqual(PRIMARY_PAGES.map(([path]) => path));
  });

  for (const [path, h1, title] of PRIMARY_PAGES) {
    it(`renders ${path} with its own heading and document title`, async () => {
      mount(path);
      await waitFor(() => expect(heading()).toMatch(h1));
      expect(location()).toBe(path);
      await waitFor(() => expect(document.title).toBe(title));
    });
  }

  it("never gives two primary destinations the same heading or title", async () => {
    const seen = [];
    for (const [path] of PRIMARY_PAGES) {
      mount(path);
      await waitFor(() => expect(screen.getAllByRole("heading", { level: 1 }).length).toBeGreaterThan(0));
      seen.push(`${heading()}|${document.title}`);
      cleanup();
    }
    expect(new Set(seen).size).toBe(PRIMARY_PAGES.length);
  });
});

describe("route table · the single-artist catalog", () => {
  it("keeps the artist, record, edition and collection pages distinct although each is headed Voidcaller", async () => {
    const pages = ["/artist/voidcaller", "/release/voidcaller-self-titled", "/edition/voidcaller-chapter-i", "/collection/voidcaller-collection"];
    const identities = [];
    for (const path of pages) {
      mount(path);
      await waitFor(() => expect(heading()).toMatch(/Voidcaller/i));
      expect(location()).toBe(path);
      identities.push(document.title);
      cleanup();
    }
    const artist = VOIDCALLER_CATALOG.artists[0];
    const release = VOIDCALLER_CATALOG.releases.find((item) => item.id === "voidcaller-self-titled");
    const edition = VOIDCALLER_CATALOG.editions.find((item) => item.id === "voidcaller-chapter-i");
    const collection = VOIDCALLER_CATALOG.collections.find((item) => item.id === "voidcaller-collection");
    expect(identities).toEqual([
      `${artist.name} · Artist · The Void`,
      `${release.title} · Release · The Void`,
      `${edition.title} · ${release.title} · Edition · The Void`,
      `${collection.name} · Collection · The Void`,
    ]);
    expect(new Set(identities).size).toBe(4);
  });
});

describe("route table · client-side navigation, history, mobile menu", () => {
  function mountRouter(path) {
    const router = createMemoryRouter([{ path: "*", element: <><AppRoutes /><LocationProbe /></> }], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return router;
  }
  const headerLink = (label) => within(document.querySelector(".vc-nav-links")).getByText(label);

  it("changes both the URL and the page on each header click, including rapid adjacent clicks", async () => {
    mountRouter("/");
    fireEvent.click(headerLink("DISCOVER"));
    await waitFor(() => expect(heading()).toMatch(/Currently featuring Voidcaller/i));
    expect(location()).toBe("/discover");
    fireEvent.click(headerLink("ARTISTS"));
    fireEvent.click(headerLink("COLLECTION"));
    fireEvent.click(headerLink("ARTISTS"));
    await waitFor(() => expect(heading()).toMatch(/^Artists$/i));
    expect(location()).toBe("/artists");
    expect(document.title).toBe("Artists · The Void");
    expect([...document.querySelectorAll(".vc-nav-links a.active")].map((a) => a.textContent.trim())).toEqual(["ARTISTS"]);
  });

  it("walks back and forward through history with the matching page each time", async () => {
    const router = mountRouter("/discover");
    fireEvent.click(headerLink("ARTISTS"));
    await waitFor(() => expect(location()).toBe("/artists"));
    fireEvent.click(headerLink("COLLECTION"));
    await waitFor(() => expect(location()).toBe("/collection"));
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(location()).toBe("/artists"));
    expect(heading()).toMatch(/^Artists$/i);
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(location()).toBe("/discover"));
    expect(heading()).toMatch(/Currently featuring Voidcaller/i);
    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(location()).toBe("/artists"));
    expect(heading()).toMatch(/^Artists$/i);
  });

  it("reaches the same page from the mobile menu as from the desktop header, then closes the menu", async () => {
    mountRouter("/");
    fireEvent.click(document.querySelector("button[aria-label='Open menu']"));
    fireEvent.click(within(document.querySelector(".vc-nav-menu")).getByText("COLLECTION"));
    await waitFor(() => expect(heading()).toMatch(/^The Void$/i));
    expect(location()).toBe("/collection");
    expect(document.querySelector(".vc-nav-menu")).toBeNull();
  });

  it("follows an in-page card from the artists list to the artist and on to the edition", async () => {
    mountRouter("/artists");
    await waitFor(() => expect(heading()).toMatch(/^Artists$/i));
    fireEvent.click(document.querySelector("main a[href='/artist/voidcaller']"));
    await waitFor(() => expect(location()).toBe("/artist/voidcaller"));
    expect(document.title).toBe(`${VOIDCALLER_CATALOG.artists[0].name} · Artist · The Void`);
    fireEvent.click(document.querySelector("main a[href='/edition/voidcaller-chapter-i']"));
    await waitFor(() => expect(location()).toBe("/edition/voidcaller-chapter-i"));
    expect(document.title).toMatch(/^Chapter I · The Relic · .* · Edition · The Void$/);
  });
});

describe("route table · unknown routes and ids", () => {
  it("keeps an unknown URL and says the page does not exist instead of showing the home page", async () => {
    mount("/does-not-exist");
    expect(await screen.findByTestId("not-found")).toBeTruthy();
    expect(heading()).toMatch(/Nothing here/i);
    expect(within(screen.getByTestId("not-found")).getByText("/does-not-exist")).toBeTruthy();
    expect(location()).toBe("/does-not-exist");
    expect(document.title).toBe("Not found · The Void");
    expect(within(screen.getByTestId("not-found")).getByText("Discover").getAttribute("href")).toBe("/discover");
  });

  it("sends an unknown artist, record, edition, experience or collection id to its list page", async () => {
    for (const [path, listPath, h1] of [
      ["/artist/nope", "/artists", /^Artists$/i],
      ["/release/nope", "/discover", /Currently featuring Voidcaller/i],
      ["/edition/nope", "/marketplace", /Releases/i],
      ["/experience/nope", "/discover", /Currently featuring Voidcaller/i],
      ["/collection/nope", "/collection", /^The Void$/i],
    ]) {
      mount(path);
      await waitFor(() => expect(location()).toBe(listPath));
      await waitFor(() => expect(heading()).toMatch(h1));
      cleanup();
    }
  });

  it("waits for the published catalog before giving up on an artist id (direct load / refresh)", async () => {
    state.publishedLoading = true;
    mount("/artist/published-later");
    expect(await screen.findByText("Loading artist…")).toBeTruthy();
    expect(location()).toBe("/artist/published-later");
  });

  it("treats a trailing slash as the same page", async () => {
    mount("/discover/");
    await waitFor(() => expect(heading()).toMatch(/Currently featuring Voidcaller/i));
    expect(document.title).toBe("Discover · The Void");
  });
});
