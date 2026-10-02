/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createArtist, createCatalog, createEdition, createRelease } from "../domain/models.js";

const secondArtist = createCatalog({
  artists: [createArtist({ id: "artist-test-artist", name: "TEST ARTIST", slug: "test-artist" })],
  releases: [createRelease({ id: "release-test", artistId: "artist-test-artist", title: "TEST RELEASE" })],
  editions: [createEdition({ id: "edition-test", releaseId: "release-test", title: "TEST EDITION", contractAddress: "0x82b26da27136935454bdf1e40801190b521b82e5", chainId: 43113, tokenIds: ["777"] })],
});
vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => actual.mergeCatalogs([...actual.baseCatalogs(), secondArtist]) };
});
const { Reliquary } = await import("./Reliquary.jsx");
import { VOIDCALLER_CATALOG } from "../data.js";
import { WalletCtx } from "../lib/wallet-context.js";

const contract = VOIDCALLER_CATALOG.editions[0].contractAddress;
const wallet = "0x1111111111111111111111111111111111111111";

function renderReliquary(ownershipRecords) {
  return renderToStaticMarkup(
    <WalletCtx.Provider value={{ connected: true, account: wallet, loadingOwnership: false, ownershipRecords, owned: {}, disconnect: () => {} }}>
      <Reliquary />
    </WalletCtx.Provider>,
  );
}

describe("Reliquary token breakdown", () => {
  it("renders each owned token independently and preserves ERC-1155 quantity", () => {
    const markup = renderReliquary([
      { wallet, contract, tokenId: "1", amount: 2, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 },
      { wallet, contract, tokenId: "2", amount: 1, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 },
    ]);
    expect(markup.match(/data-token-id=/g)).toHaveLength(2);
    expect(markup).toContain('data-token-id="1"');
    expect(markup).toContain('data-token-id="2"');
    expect(markup).toContain("TOKEN #1 · 2 owned");
    expect(markup).toContain("TOKEN #2 · 1 owned");
  });

  it("resolves holdings for any artist on The Void, not only VOIDCALLER", () => {
    const markup = renderReliquary([
      { wallet, contract, tokenId: "1", amount: 1, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 },
      { wallet, contract: "0x82b26da27136935454bdf1e40801190b521b82e5", tokenId: "777", amount: 3, chain: { key: "fuji", id: 43113, name: "Avalanche Fuji" }, updatedAt: 1 },
    ]);
    expect(markup).toContain('data-token-id="777"');
    expect(markup).toContain("TEST ARTIST");
    expect(markup).toContain("2 ARTISTS");
  });
});
