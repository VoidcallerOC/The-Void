import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditionPage, ExperiencePage } from "./PlatformPages.jsx";
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
      address: "0x42B740aA92A6F48380F6D97AD91e332a7921a744",
      chainId: 43113,
      enabled: true,
    }),
  };
});

const editionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const releaseId = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const tokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const contractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";

const productionApi = {
  artists: [
    { id: "artist-454ea216-9ce5-4c9d-b904-08eb7bb18bf3", slug: "asdf", display_name: "asdf", status: "ACTIVE" },
    { id: "artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138", slug: "qwe", display_name: "qwe", status: "ACTIVE" },
    { id: "artist-fa19e2f0-bc20-4b7c-8698-c5f1db59fd6a", slug: "sdfg", display_name: "sdfg", status: "ACTIVE" },
    { id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", slug: "wer", display_name: "wer", status: "ACTIVE" },
    { id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" },
    { id: "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724", slug: "voidcaller-7", display_name: "Voidcaller", status: "ACTIVE" },
  ],
  releases: [
    { id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", artist_id: "artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3", artist_slug: "voidcaller-8", artist_name: "Voidcaller", title: "Marketplace Fuji E2E Test", description: "One-copy Fuji V2 ERC1155 marketplace end-to-end test edition.", status: "PUBLISHED" },
    { id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", artist_id: "artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e", artist_slug: "wer", artist_name: "wer", title: "PINATA CERTIFICATION 2026-09-27", description: "Non-sensitive production Pinata metadata certification object.", status: "PUBLISHED" },
    { id: releaseId, artist_id: "artist-cf2c2990-b0b0-4933-bcac-556cf55c0724", artist_slug: "voidcaller-7", artist_name: "Voidcaller", title: "VOIDCALLER", description: "The first call. The first relic. One relic unlocks the full EP.", status: "PUBLISHED" },
  ],
  editions: [
    { id: "edition-b87f40b1-9419-4e90-8e2f-5b8986df043c", release_id: "release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7", title: "Marketplace Fuji E2E Test", supply: "1", status: "PUBLISHED", chain_id: "43113", contract_address: contractAddress, token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909", application_metadata: { includes: ["Test only"] } },
    { id: "edition-8ed9867c-e102-49c5-97a0-54ccf15605d2", release_id: "release-7f12ecfb-99eb-4b05-9b07-f862480829c5", title: "wer", supply: "1", status: "PUBLISHED", chain_id: "43113", contract_address: contractAddress, token_id: "86336109522257422783953313092869910591261689395232051112421244253165221467155" },
    { id: editionId, release_id: releaseId, title: "VOIDCALLER", description: null, supply: "25", status: "PUBLISHED", application_metadata: { artwork: "/assets/voidcaller_art_4.png", includes: ["Full self-titled EP", "Collector Reliquary access", "Token-gated music experiences"], priceWei: "10000000000000000" }, chain_id: "43113", contract_address: contractAddress, primary_sale_address: "0x8b743f91940a267899986d2e99b4375e1d87c321", token_id: tokenId },
  ],
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

function renderExperience(experienceId = "missing-experience") {
  return renderToStaticMarkup(
    React.createElement(
      WalletCtx.Provider,
      { value: wallet },
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/experience/${experienceId}`] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/experience/:experience", element: React.createElement(ExperiencePage) }),
        ),
      ),
    ),
  );
}

describe("production EditionPage route render", () => {
  beforeEach(async () => {
    catalogState.current = await productionCatalog();
  });

  it("filters published test inventory while preserving and rendering the canonical Fuji Voidcaller edition", () => {
    const resolved = getEditionCatalog(catalogState.current, editionId);
    expect(resolved.edition.id).toBe(editionId);
    expect(resolved.release.id).toBe(releaseId);
    expect(resolved.release.artistId).toBe("voidcaller");
    expect(resolved.artist).toMatchObject({ id: "voidcaller", name: "Voidcaller" });
    expect(resolved.edition.chainId).toBe(43113);
    expect(resolved.edition.tokenIds).toEqual([tokenId]);
    expect(catalogState.current.releases.some((item) => /E2E|PINATA|CERTIFICATION/i.test(item.title))).toBe(false);
    expect(catalogState.current.editions.some((item) => /E2E|PINATA|CERTIFICATION|^(wer|sdfg|qwe|asdf)$/i.test(item.title))).toBe(false);
    expect(catalogState.current.artists.some((item) => /^(wer|sdfg|qwe|asdf)$/i.test(item.name))).toBe(false);

    const markup = renderEdition();
    expect(markup).toContain("VOIDCALLER");
    expect(markup).not.toContain("Marketplace Fuji E2E Test");
    expect(markup).not.toContain("PINATA CERTIFICATION");
    expect(markup).toContain('id="secondary-listing"');
    expect(markup).toContain("Verifying the factory release, wallet balance, marketplace and royalty on chain");
    expect(markup).not.toContain("LIST EDITION");
    expect(markup).not.toContain("REVIEW LISTING");
  });

  it("keeps an unavailable secondary listing control visible for unsupported editions", () => {
    catalogState.current = {
      ...catalogState.current,
      editions: catalogState.current.editions.map((item) => item.id === editionId ? { ...item, chainId: 43114 } : item),
    };

    const markup = renderEdition();
    expect(markup).toContain('id="secondary-listing"');
    expect(markup).toContain("LIST FOR SALE");
    expect(markup).toContain("This edition is unsupported; no transaction can be submitted.");
  });

  it("keeps an experience route in loading state until the published catalog settles", () => {
    catalogState.current = { ...catalogState.current, experiences: [], publishedLoading: true };
    expect(renderExperience()).toContain("Loading experience");
    catalogState.current = { ...catalogState.current, publishedLoading: false };
    expect(renderExperience()).not.toContain("Loading experience");
  });
});
