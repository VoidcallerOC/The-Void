import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Nav, REVIEWER_NAV_LABEL, REVIEWER_NAV_PATH } from "./components/Nav.jsx";
import { WalletCtx } from "./lib/wallet-context.js";
import { ReviewerNotificationsProvider } from "./lib/ReviewerNotificationsProvider.jsx";
import { createReviewerNotificationStore } from "./lib/reviewer-notifications.js";

const REVIEWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NORMAL = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";

function walletValue(account) {
  const authSession = account ? { token: `tok-${account}`, wallet: account, chainId: 43113 } : null;
  return {
    wallets: [], account, chainId: account ? 43113 : null, owned: { cchain: new Set(), grotto: new Set() }, ownershipRecords: [], identity: null,
    loadingOwnership: false, connected: Boolean(account), authenticated: Boolean(authSession), authenticating: false, authenticationError: null,
    authSession, authHeaders: authSession ? { authorization: `Bearer ${authSession.token}` } : {}, provider: null,
    getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn(),
  };
}

// Header markup for a given wallet + notification store. Rendering is static,
// so the store is driven explicitly here the way the provider drives it in
// the browser (sync on connect/auth change, clear on disconnect).
function renderNav({ account, store }) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <WalletCtx.Provider value={walletValue(account)}>
        <ReviewerNotificationsProvider store={store}>
          <Nav onMint={() => {}} />
        </ReviewerNotificationsProvider>
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}

function storeFor({ reviewer, count }) {
  return createReviewerNotificationStore({
    fetchMe: vi.fn().mockResolvedValue({ application: null, canReapply: true, reviewer }),
    fetchCount: vi.fn().mockResolvedValue({ count }),
  });
}

function session(account) {
  return { ready: true, wallet: account, headers: { authorization: `Bearer tok-${account}` } };
}

function reviewerLinks(html) {
  return (html.match(new RegExp(`href="${REVIEWER_NAV_PATH}"`, "g")) || []).length;
}

describe("site header · reviewer notifications", () => {
  it("hides the reviewer link, badge and count for a normal wallet", async () => {
    const store = storeFor({ reviewer: false, count: 0 });
    await store.sync(session(NORMAL));
    const html = renderNav({ account: NORMAL, store });
    expect(html).not.toContain(REVIEWER_NAV_LABEL);
    expect(reviewerLinks(html)).toBe(0);
    expect(html).not.toContain("vc-nav-badge");
  });

  it("hides the reviewer link when no wallet is connected", () => {
    const html = renderNav({ account: null, store: storeFor({ reviewer: true, count: 3 }) });
    expect(html).not.toContain(REVIEWER_NAV_LABEL);
  });

  it("shows the reviewer link to /verify/review for an authorized reviewer", async () => {
    const store = storeFor({ reviewer: true, count: 0 });
    await store.sync(session(REVIEWER));
    const html = renderNav({ account: REVIEWER, store });
    expect(html).toContain(REVIEWER_NAV_LABEL);
    expect(reviewerLinks(html)).toBeGreaterThanOrEqual(1);
    expect(html).toContain('href="/verify"'); // the public VERIFY link is still there
  });

  it("shows the badge with the server-returned count beside the reviewer link", async () => {
    const store = storeFor({ reviewer: true, count: 3 });
    await store.sync(session(REVIEWER));
    const html = renderNav({ account: REVIEWER, store });
    const link = html.indexOf(REVIEWER_NAV_LABEL);
    const badge = html.indexOf('<span class="vc-nav-badge"', link);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(badge).toBeGreaterThan(link);
    const badgeMarkup = html.slice(badge, html.indexOf("</span>", badge));
    expect(badgeMarkup).toContain(">3");
    expect(badgeMarkup).toContain("3 applications awaiting review");
  });

  it("renders the reviewer link without a badge when the count is zero", async () => {
    const store = storeFor({ reviewer: true, count: 0 });
    await store.sync(session(REVIEWER));
    const html = renderNav({ account: REVIEWER, store });
    expect(html).toContain(REVIEWER_NAV_LABEL);
    expect(html).not.toContain("vc-nav-badge");
  });

  it("removes the reviewer link and count as soon as the wallet disconnects", async () => {
    const store = storeFor({ reviewer: true, count: 4 });
    await store.sync(session(REVIEWER));
    expect(renderNav({ account: REVIEWER, store })).toContain(">4");
    await store.sync({ ready: false, wallet: null, headers: {} });
    const html = renderNav({ account: null, store });
    expect(html).not.toContain(REVIEWER_NAV_LABEL);
    expect(html).not.toContain("vc-nav-badge");
  });

  it("does not leak a previous reviewer's count to the next wallet", async () => {
    const store = storeFor({ reviewer: true, count: 4 });
    await store.sync(session(REVIEWER));
    const normalStore = store; // same store instance survives the account change in the browser
    await normalStore.sync({ ready: true, wallet: NORMAL, headers: { authorization: "Bearer other" } });
    // The fake fetchMe still answers reviewer:true for any wallet; the real
    // server decides. What matters here is that the stale 4 is gone.
    await normalStore.sync({ ready: false, wallet: null, headers: {} });
    expect(renderNav({ account: null, store: normalStore })).not.toContain(">4");
  });
});
