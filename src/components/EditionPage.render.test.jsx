import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditionPage } from "./PlatformPages.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { baseCatalogs, fetchPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import { getEditionCatalog } from "../domain/models.js";

const { catalogState } = vi.hoisted(() => ({ catalogState: { current: null } }));

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketplaceCatalogs: () => catalogState.current };
});

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({
      ...actual.MARKETPLACE_CONFIG,
      address: "0x982b28352fd612fe934c5e1ad8fea399689190d2",
      chainId: 43113,
      enabled: true,
    }),
  };
});

const editionId = "edition-b87f40b1-9419-4e90-8e2f-5b8986df043c";
const releaseId = "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7";
const aliasArtistId = "artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3";
const tokenId = "69621777096996404494569967715110965261109496187347335164928263396549073080909";
const contractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";

// Captured from the live published API: the release includes joined artist
// name/slug, but /api/artists omits its artist_id row; the canonical Voidcaller
// artist is present and the published alias should resolve to it.
const productionApi = {
  artists: [
    { id: "artist-454ea216-9ce5-4c9d-b904-08eb7bb18bf3", slug: "asdf", display_name: "asdf", status: "ACTIVE" },
    { id: "artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138", slug: "qwe", display_name: "qwe", status: "ACTIVE" },
    { id: "artist-fa19e2f0-bc20-4b7c-8698-c5f1db59fd6a", slug: "sdfg", display_name: "sdfg", status: "ACTIVE" },
    { id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" },
    { id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", slug: "wer", display_name: "wer", status: "ACTIVE" },
  ],
  releases: [{
    id: releaseId,
    artist_id: aliasArtistId,
    artist_slug: "voidcaller-8",
    artist_name: "Voidcaller",
    title: "Marketplace Fuji E2E Test",
    description: "One-copy Fuji V2 ERC1155 marketplace end-to-end test edition.",
    status: "PUBLISHED",
    release_metadata: { artwork: "/assets/voidcaller_art_5.png" },
  }],
  editions: [{
    id: editionId,
    release_id: releaseId,
    title: "Marketplace Fuji E2E Test",
    description: null,
    supply: "1",
    status: "PUBLISHED",
    application_metadata: {
      artwork: "/assets/voidcaller_art_4.png",
      includes: ["Full self-titled EP", "Collector Reliquary access", "Token-gated music experiences"],
      priceWei: "1000000000000000",
      marketplace: {},
    },
    chain_id: "43113",
    contract_address: contractAddress,
    token_id: tokenId,
  }],
  experiences: [],
};

const wallet = {
  account: seller,
  connected: true,
  authenticated: false,
  authHeaders: {},
  chainId: 43113,
  getProvider: () => null,
  owned: { cchain: new Set(), grotto: new Set(), fuji: new Set([tokenId]) },
  ownershipRecords: [],
};

async function productionCatalog() {
  const fetchImpl = async (url) => {
    const key = String(url).split("/").at(-1);
    if (!Object.hasOwn(productionApi, key)) throw new Error(`Unexpected catalog URL: ${url}`);
    return { ok: true, json: async () => ({ data: productionApi[key] }) };
  };
  const published = await fetchPublishedCatalog({ fetchImpl });
  return collapsePublicCatalog(mergeCatalogs([...baseCatalogs(), published]));
}

function renderEdition() {
  return renderToStaticMarkup(
    React.createElement(
      WalletCtx.Provider,
      { value: wallet },
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/edition/${editionId}`] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/edition/:edition", element: React.createElement(EditionPage) }),
        ),
      ),
    ),
  );
}

describe("production EditionPage route render", () => {
  beforeEach(async () => {
    catalogState.current = await productionCatalog();
  });

  it("resolves the omitted Voidcaller alias and renders the Fuji listing control for its owner", () => {
    const resolved = getEditionCatalog(catalogState.current, editionId);
    expect(resolved.edition.id).toBe(editionId);
    expect(resolved.release.id).toBe(releaseId);
    expect(resolved.release.artistId).toBe("voidcaller");
    expect(resolved.artist).toMatchObject({ id: "voidcaller", name: "Voidcaller" });
    expect(resolved.edition.chainId).toBe(43113);
    expect(resolved.edition.tokenIds).toEqual([tokenId]);

    const markup = renderEdition();
    const buttonStart = markup.indexOf("<button");
    const buttonSuffix = ">LIST EDITION</button>";
    const buttonEnd = markup.indexOf(buttonSuffix, buttonStart);
    const button = buttonStart >= 0 && buttonEnd >= 0 ? markup.slice(buttonStart, buttonEnd + buttonSuffix.length) : null;
    expect(markup).toContain("Marketplace Fuji E2E Test");
    expect(button).toBeTruthy();
    expect(button).not.toContain("disabled");
  });
});
