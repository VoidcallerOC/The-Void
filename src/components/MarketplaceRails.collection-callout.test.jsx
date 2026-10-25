/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const config = vi.hoisted(() => ({ address: "", chainId: 0, feeBps: "", currency: "native", apiBaseUrl: "/api", enabled: false }));
vi.mock("../lib/marketplace.js", async (importOriginal) => ({ ...(await importOriginal()), MARKETPLACE_CONFIG: config }));

const { CollectionMarketplaceCallout } = await import("./MarketplaceRails.jsx");
const { MyCollectionPage } = await import("./PlatformPages.jsx");

const ADDRESS = "0x0F5930113Ec750d867741E05F302053472115eb2";
const setLive = (live) => Object.assign(config, live ? { address: ADDRESS, chainId: 43114, enabled: true } : { address: "", chainId: 0, enabled: false });
const count = (markup, text) => markup.split(text).length - 1;

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WalletCtx.Provider value={{ connected: false, account: null, ownershipRecords: [], owned: {} }}>
        <MyCollectionPage />
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}

describe("My collection: Reliquary action", () => {
  beforeEach(() => setLive(false));

  it("renders the general Open reliquary action once, beside Artist studio", () => {
    const markup = renderPage();
    expect(count(markup, ">Open reliquary</a>")).toBe(1);
    expect(count(markup, 'href="/reliquary"')).toBe(1);
    expect(markup).toContain('href="/studio"');
  });

  it("keeps the marketplace action in the list-from-collection panel", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><CollectionMarketplaceCallout /></MemoryRouter>);
    expect(markup).toContain('href="/marketplace"');
    expect(markup).toContain(">Open marketplace</a>");
    expect(markup).not.toContain("reliquary");
  });
});

describe("List from your collection: status matches configuration", () => {
  const render = () => renderToStaticMarkup(<MemoryRouter><CollectionMarketplaceCallout /></MemoryRouter>);

  it("shows NOT YET LIVE with not-live copy when the marketplace is not configured", () => {
    setLive(false);
    const markup = render();
    expect(markup).toContain("NOT YET LIVE");
    expect(markup).toContain("It is not yet live.");
    expect(markup).not.toMatch(/>LIVE</);
  });

  it("shows LIVE without not-live copy when the marketplace is configured", () => {
    setLive(true);
    const markup = render();
    expect(markup).toMatch(/>LIVE</);
    expect(markup).toContain("can be listed for sale on the marketplace");
    expect(markup).not.toContain("not yet live");
    expect(markup).not.toContain("NOT YET LIVE");
  });
});
