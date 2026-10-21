/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { baseCatalogs, mergeCatalogs } from "../lib/catalog-source.js";

const { catalogState, purchaseProps } = vi.hoisted(() => ({ catalogState: { current: null }, purchaseProps: { current: null } }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.current }));
vi.mock("../lib/marketplace-surface.js", async (importOriginal) => ({ ...(await importOriginal()), resolveSecondaryStatus: () => "LIVE" }));
vi.mock("../lib/secondary-listing.js", async (importOriginal) => ({ ...(await importOriginal()), isReleasePerContractCandidate: () => true }));
vi.mock("./PurchasePanel.jsx", () => ({ PurchasePanel: (props) => { purchaseProps.current = props; return <div data-testid="purchase">offers for token {props.tokenId}</div>; } }));
vi.mock("./PlayTokenButton.jsx", () => ({ PlayTokenButton: ({ label }) => <button type="button">{label}</button> }));
const { TokenPage } = await import("./TokenPage.jsx");

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/edition/:edition/token/:tokenId" element={<TokenPage />} />
      <Route path="/edition/:edition" element={<p>edition page</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { catalogState.current = mergeCatalogs(baseCatalogs()); purchaseProps.current = null; });
afterEach(cleanup);

describe("standalone token page", () => {
  it("shows token 0's own name and metadata GIF, and only that token's offers", () => {
    renderAt("/edition/voidcaller-chapter-i/token/0");
    expect(screen.getByRole("heading", { level: 1, name: "Enough" })).toBeTruthy();
    const img = screen.getByAltText("Enough, token #0 artwork");
    expect(img.getAttribute("src")).toBe("https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif");
    fireEvent.error(img);
    expect(screen.getByAltText("Enough, token #0 artwork").getAttribute("src")).toBe("/assets/track-art/ep1-enough.png");
    expect(screen.getByText(/0xd1b4367dd9f235f9ee61878019d66e31511e98ee/i)).toBeTruthy();
    expect(purchaseProps.current.tokenId).toBe("0");
    expect(purchaseProps.current.edition.id).toBe("voidcaller-chapter-i");
    expect(screen.getByRole("link", { name: "View edition" }).getAttribute("href")).toBe("/edition/voidcaller-chapter-i");
  });

  it("a different token is its own page", () => {
    renderAt("/edition/voidcaller-chapter-i/token/3");
    expect(screen.getByRole("heading", { level: 1, name: "Complex" })).toBeTruthy();
    expect(purchaseProps.current.tokenId).toBe("3");
  });

  it("a token id outside the edition, or not a number, is not found and offers no purchase", () => {
    renderAt("/edition/voidcaller-chapter-i/token/9");
    expect(screen.queryByTestId("purchase")).toBeNull();
    expect(document.body.textContent).toMatch(/not found/i);
    cleanup();
    renderAt("/edition/voidcaller-chapter-i/token/abc");
    expect(screen.queryByTestId("purchase")).toBeNull();
  });
});
