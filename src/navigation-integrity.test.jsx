/** @vitest-environment jsdom */
// Pre-mint navigation integrity (from the live Chrome walkthrough, PR #228): a link that does not
// resolve says so in place (never a silent redirect to a different page), and the mobile menu never
// stays over a page it navigated away from. The header/footer inventory and the full route table
// are covered by Nav.inventory.test.jsx and App.routes.test.jsx.
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { WalletCtx } from "./lib/wallet-context.js";
import { ReviewerNotificationsProvider } from "./lib/ReviewerNotificationsProvider.jsx";
import { createReviewerNotificationStore } from "./lib/reviewer-notifications.js";

let catalogState = { publishedLoading: false };
vi.mock("./lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  const base = actual.mergeCatalogs(actual.baseCatalogs());
  return { ...actual, useMarketplaceCatalogs: () => ({ ...base, duplicates: {}, publishedLoading: catalogState.publishedLoading }) };
});

const { Nav } = await import("./components/Nav.jsx");
const { NotFoundPage } = await import("./components/NotFoundPage.jsx");
const { ArtistPage, ReleasePage, EditionPage, ExperiencePage, CollectionDetailPage } = await import("./components/PlatformPages.jsx");

afterEach(() => { cleanup(); catalogState = { publishedLoading: false }; });

const wallet = {
  wallets: [], account: null, chainId: null, owned: { cchain: new Set(), grotto: new Set() }, ownershipRecords: [], identity: null,
  loadingOwnership: false, connected: false, authenticated: false, authenticating: false, authenticationError: null,
  authSession: null, authHeaders: {}, provider: null,
  getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn(),
};
const store = () => createReviewerNotificationStore({
  fetchMe: vi.fn().mockResolvedValue({ application: null, canReapply: true, reviewer: false }),
  fetchCount: vi.fn().mockResolvedValue({ count: 0 }),
});

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}
function Back() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>browser-back</button>;
}

function renderShell(initial = "/discover") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <WalletCtx.Provider value={wallet}>
        <ReviewerNotificationsProvider store={store()}>
          <Nav />
          <Where />
          <Back />
          <Link to="/artists">footer-artists</Link>
        </ReviewerNotificationsProvider>
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}
const menu = () => document.querySelector(".vc-nav-menu");
const burger = () => document.querySelector(".vc-nav-burger");
const openMenu = () => fireEvent.click(burger());

describe("mobile menu closes whenever the route changes", () => {
  it("closes after a menu item", () => {
    renderShell();
    openMenu();
    fireEvent.click(menu().querySelector('a[href="/marketplace"]'));
    expect(screen.getByTestId("where").textContent).toBe("/marketplace");
    expect(menu()).toBeNull();
  });

  it("closes after the logo/home link", () => {
    renderShell();
    openMenu();
    fireEvent.click(document.querySelector('nav a[href="/"]'));
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(menu()).toBeNull();
  });

  it("closes after a link outside the menu (footer, in-page)", () => {
    renderShell();
    openMenu();
    fireEvent.click(screen.getByText("footer-artists"));
    expect(screen.getByTestId("where").textContent).toBe("/artists");
    expect(menu()).toBeNull();
  });

  it("closes on browser back", () => {
    renderShell();
    fireEvent.click(document.querySelector('.vc-nav-links a[href="/claim"]'));
    openMenu();
    fireEvent.click(screen.getByText("browser-back"));
    expect(screen.getByTestId("where").textContent).toBe("/discover");
    expect(menu()).toBeNull();
  });

  it("closes on Escape and exposes its state to assistive tech", () => {
    renderShell();
    openMenu();
    expect(burger().getAttribute("aria-label")).toBe("Close menu");
    expect(burger().getAttribute("aria-expanded")).toBe("true");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menu()).toBeNull();
    expect(burger().getAttribute("aria-expanded")).toBe("false");
  });
});

function renderAt(path, pattern, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WalletCtx.Provider value={wallet}>
        <Routes>
          <Route path={pattern} element={element} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <Where />
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}

describe("unresolved links say so in place", () => {
  const cases = [
    ["/artist/nobody", "/artist/:artist", <ArtistPage key="a" />, "artist", "/artists"],
    ["/release/nobody", "/release/:release", <ReleasePage key="r" />, "release", "/discover"],
    ["/edition/nobody", "/edition/:edition", <EditionPage key="e" />, "edition", "/marketplace"],
    ["/experience/nobody", "/experience/:experience", <ExperiencePage key="x" />, "experience", "/discover"],
    ["/collection/nobody", "/collection/:collection", <CollectionDetailPage key="c" />, "collection", "/collection"],
  ];
  for (const [path, pattern, element, kind, backTo] of cases) {
    it(`${path} keeps its URL and shows the ${kind} not-found state`, () => {
      renderAt(path, pattern, element);
      expect(screen.getByTestId("where").textContent).toBe(path);
      expect(screen.getByTestId("not-found").getAttribute("data-not-found-kind")).toBe(kind);
      expect(screen.getByTestId("not-found").querySelector(`a[href="${backTo}"]`)).not.toBeNull();
    });
  }

  it("an unknown top-level path keeps its URL", () => {
    renderAt("/covenantx", "/known", <p>known</p>);
    expect(screen.getByTestId("where").textContent).toBe("/covenantx");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/nothing at this address/i);
  });

  it("artist and collection pages wait for the published catalog before deciding", () => {
    catalogState = { publishedLoading: true };
    renderAt("/artist/new-artist", "/artist/:artist", <ArtistPage />);
    expect(screen.getByText("Loading artist…")).toBeTruthy();
    expect(screen.queryByTestId("not-found")).toBeNull();
    cleanup();
    renderAt("/collection/new-collection", "/collection/:collection", <CollectionDetailPage />);
    expect(screen.getByText("Loading collection…")).toBeTruthy();
    expect(screen.queryByTestId("not-found")).toBeNull();
  });

  it("real records still render their own page", () => {
    renderAt("/artist/voidcaller", "/artist/:artist", <ArtistPage />);
    expect(screen.queryByTestId("not-found")).toBeNull();
    cleanup();
    renderAt("/release/voidcaller-self-titled", "/release/:release", <ReleasePage />);
    expect(screen.queryByTestId("not-found")).toBeNull();
    expect(screen.getByText("† Release")).toBeTruthy();
  });
});
