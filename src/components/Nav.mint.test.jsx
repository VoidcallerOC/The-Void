/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { WalletCtx } from "../lib/wallet-context.js";
import { ReviewerNotificationsProvider } from "../lib/ReviewerNotificationsProvider.jsx";
import { createReviewerNotificationStore } from "../lib/reviewer-notifications.js";

const { featuredState } = vi.hoisted(() => ({ featuredState: { current: null } }));
vi.mock("../lib/featured-mint.js", async (importOriginal) => ({ ...(await importOriginal()), useFeaturedMint: () => featuredState.current }));

import { Nav } from "./Nav.jsx";
import { Footer } from "./Footer.jsx";

afterEach(() => { cleanup(); featuredState.current = null; });

const wallet = { wallets: [], account: null, chainId: null, owned: {}, ownershipRecords: [], connected: false, authenticated: false, authSession: null, authHeaders: {}, getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn() };
function renderShell() {
  const store = createReviewerNotificationStore({ fetchMe: vi.fn().mockResolvedValue({ application: null, canReapply: true, reviewer: false }), fetchCount: vi.fn().mockResolvedValue({ count: 0 }) });
  return render(
    <MemoryRouter>
      <WalletCtx.Provider value={wallet}>
        <ReviewerNotificationsProvider store={store}><Nav /><Footer /></ReviewerNotificationsProvider>
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}
const navLinks = () => [...document.querySelectorAll(".vc-nav-links a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]);

describe("header and footer while a release is minting", () => {
  it("swaps CLAIM for MINT, linked to the edition on sale, and names the release in the footer", () => {
    featuredState.current = { title: "Forgive & Forget", href: "/edition/ff" };
    renderShell();
    expect(navLinks()).toContainEqual(["MINT", "/edition/ff"]);
    expect(navLinks().some(([label]) => label === "CLAIM")).toBe(false);
    const footerLink = [...document.querySelectorAll("footer a")].find((a) => a.textContent.includes("II · Forgive & Forget"));
    expect(footerLink?.getAttribute("href")).toBe("/edition/ff");
  });

  it("keeps CLAIM and the forthcoming footer entry when nothing is minting", () => {
    renderShell();
    expect(navLinks()).toContainEqual(["CLAIM", "/claim"]);
    expect(navLinks().some(([label]) => label === "MINT")).toBe(false);
    expect(document.querySelector("footer").textContent).toContain("II · Forthcoming");
  });
});
