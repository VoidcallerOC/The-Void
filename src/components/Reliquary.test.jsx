/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Reliquary } from "./Reliquary.jsx";
import { VOIDCALLER_CATALOG } from "../data.js";
import { FUJI_RELEASE_CONFIG } from "../lib/fuji-release.js";
import { mapPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import { WalletCtx } from "../lib/wallet-context.js";

vi.mock("./ListingPanel.jsx", () => ({
  ListingPanel: ({ edition, tokenId, ownedAmount }) => (
    <div data-testid="listing-panel" data-edition-id={edition.id} data-token-id={tokenId} data-owned-amount={ownedAmount}>EXISTING LISTING PANEL</div>
  ),
}));

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    FUJI_LISTING_CONFIG: actual.resolveFujiListingConfig({
      VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: "0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b",
      VITE_FUJI_LISTING_CHAIN_ID: "43113",
    }),
  };
});

const wallet = "0x1111111111111111111111111111111111111111";
const fujiContract = FUJI_RELEASE_CONFIG.contractAddress.toLowerCase();
const fujiTokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const fujiEditionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const fujiReleaseId = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const productionFujiCatalog = collapsePublicCatalog(mergeCatalogs([
  VOIDCALLER_CATALOG,
  mapPublishedCatalog({
    artists: [{ id: "voidcaller", display_name: "Voidcaller", slug: "voidcaller", verified: true }],
    releases: [{
      id: fujiReleaseId,
      slug: "voidcaller",
      artist_id: "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724",
      artist_name: "Voidcaller",
      artist_slug: "voidcaller-7",
      title: "VOIDCALLER",
      description: "The first call. The first relic. One relic unlocks the full EP.",
      status: "PUBLISHED",
      release_metadata: { artwork: "/assets/voidcaller_art_4.png" },
    }],
    editions: [{
      id: fujiEditionId,
      release_id: fujiReleaseId,
      title: "VOIDCALLER",
      status: "PUBLISHED",
      supply: "25",
      chain_id: "43113",
      contract_address: fujiContract,
      token_id: fujiTokenId,
      application_metadata: {
        artwork: "/assets/voidcaller_art_4.png",
        includes: ["Full self-titled EP", "Collector Reliquary access", "Token-gated music experiences"],
        priceWei: "10000000000000000",
      },
    }],
  }),
]));

const cchainContract = VOIDCALLER_CATALOG.editions[0].contractAddress;
const cchainRecord = (tokenId, amount = 1) => ({ wallet, contract: cchainContract, tokenId, amount, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 });
const fujiRecord = (overrides = {}) => ({ wallet, contract: fujiContract, tokenId: fujiTokenId, amount: 1, chain: { key: "fuji", id: 43113, name: "Avalanche Fuji" }, updatedAt: 1, ...overrides });

function walletValue(ownershipRecords) {
  return {
    connected: true,
    account: wallet,
    chainId: 43113,
    loadingOwnership: false,
    ownershipRecords,
    owned: { cchain: new Set(["1", "2"]), fuji: new Set([fujiTokenId]) },
    disconnect: () => {},
  };
}

function renderReliquary(ownershipRecords, catalog = VOIDCALLER_CATALOG) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/reliquary"]}>
      <Routes>
        <Route path="/reliquary" element={<Outlet context={{ catalog }} />}>
          <Route index element={(
            <WalletCtx.Provider value={walletValue(ownershipRecords)}>
              <Reliquary />
            </WalletCtx.Provider>
          )} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function renderInteractiveReliquary(ownershipRecords, catalog = VOIDCALLER_CATALOG) {
  return render(
    <MemoryRouter initialEntries={["/reliquary"]}>
      <Routes>
        <Route path="/reliquary" element={<Outlet context={{ catalog }} />}>
          <Route index element={(
            <WalletCtx.Provider value={walletValue(ownershipRecords)}>
              <Reliquary />
            </WalletCtx.Provider>
          )} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Reliquary token breakdown", () => {
  it("renders each owned C-Chain token independently and preserves ERC-1155 quantities", () => {
    const markup = renderReliquary([cchainRecord("1", 2), cchainRecord("2")]);
    expect(markup.match(/data-token-id=/g)).toHaveLength(2);
    expect(markup).toContain('data-token-id="1"');
    expect(markup).toContain('data-token-id="2"');
    expect(markup).toContain("TOKEN #1 · 2 owned");
    expect(markup).toContain("TOKEN #2 · 1 owned");
  });

  it("resolves the published Fuji edition metadata and displays the real ownership counts", () => {
    const edition = productionFujiCatalog.editions.find((item) => item.id === fujiEditionId);
    const release = productionFujiCatalog.releases.find((item) => item.id === fujiReleaseId);
    expect(edition).toMatchObject({ releaseId: fujiReleaseId, title: "VOIDCALLER", chainId: 43113, contractAddress: fujiContract, tokenIds: [fujiTokenId], supply: "25" });
    expect(release).toMatchObject({ title: "VOIDCALLER", artistId: "voidcaller", artwork: "/assets/voidcaller_art_4.png" });

    const markup = renderReliquary([fujiRecord()], productionFujiCatalog);
    expect(markup).toContain("1 TOKEN · 1 UNIT · 1 ARTIST");
    expect(markup).toContain(`data-token-id="${fujiTokenId}"`);
    expect(markup).toContain(`data-contract="${fujiContract}"`);
    expect(markup).toContain("Voidcaller");
    expect(markup).toContain("VOIDCALLER · TOKEN #");
    expect(markup).toContain('/assets/voidcaller_art_4.png');
  });

  it("exposes the listing action only for a canonical Fuji owned item", () => {
    const markup = renderReliquary([fujiRecord()], productionFujiCatalog);
    expect(markup).toContain("LIST ON SECONDARY MARKET");

    const cchainMarkup = renderReliquary([cchainRecord("1")]);
    expect(cchainMarkup).not.toContain("LIST ON SECONDARY MARKET");

    const unknownMarkup = renderReliquary([fujiRecord({ contract: "0x2222222222222222222222222222222222222222" })], productionFujiCatalog);
    expect(unknownMarkup).not.toContain("LIST ON SECONDARY MARKET");
  });

  it("opens the existing listing flow with the actual edition, token ID, and owned balance", () => {
    renderInteractiveReliquary([fujiRecord({ amount: 3 })], productionFujiCatalog);
    fireEvent.click(screen.getByRole("button", { name: "LIST ON SECONDARY MARKET" }));
    const panel = screen.getByTestId("listing-panel");
    expect(panel.getAttribute("data-edition-id")).toBe(fujiEditionId);
    expect(panel.getAttribute("data-token-id")).toBe(fujiTokenId);
    expect(panel.getAttribute("data-owned-amount")).toBe("3");
  });

  it("keeps Fuji and existing C-Chain editions supported together", () => {
    const markup = renderReliquary([cchainRecord("1"), fujiRecord()], productionFujiCatalog);
    expect(markup).toContain("2 TOKENS · 2 UNITS · 1 ARTIST");
    expect(markup).toContain('data-token-id="1"');
    expect(markup).toContain(`data-token-id="${fujiTokenId}"`);
  });

  it("filters unknown contracts and unknown token IDs while retaining the Fuji holding", () => {
    const markup = renderReliquary([
      fujiRecord(),
      fujiRecord({ contract: "0x2222222222222222222222222222222222222222" }),
      fujiRecord({ tokenId: "999999999999999999999999999999999999" }),
    ], productionFujiCatalog);
    expect(markup).toContain("1 TOKEN · 1 UNIT · 1 ARTIST");
    expect(markup.match(/data-token-id=/g)).toHaveLength(1);
    expect(markup).toContain(`data-token-id="${fujiTokenId}"`);
  });
});
