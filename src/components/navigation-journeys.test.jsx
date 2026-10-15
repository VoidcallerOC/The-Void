/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FUJI_RELEASE_CONFIG } from "../lib/fuji-release.js";
import { WalletCtx } from "../lib/wallet-context.js";

const FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const CLONE = "0xe87410E9a2c703B6BB696D4bFB5f268d3C5BCf65";
const LEGACY = FUJI_RELEASE_CONFIG.contractAddress;
const WALLET = "0x6a86efa012feda64b70112022487fee22e67d2fb";

const rows = {
  artists: [{ id: "voidcaller", display_name: "Voidcaller", slug: "voidcaller" }, { id: "artist-indigo", display_name: "Indigo Static", slug: "indigo-static" }],
  releases: [
    { id: "release-new", artist_id: "voidcaller", title: "Forgive & Forget", status: "PUBLISHED", published_at: "2026-10-13T00:00:00Z" },
    { id: "release-old", artist_id: "voidcaller", title: "Forgive & Forget", status: "PUBLISHED", published_at: "2026-10-04T00:00:00Z" },
    { id: "release-draft", artist_id: "voidcaller", title: "Unreleased Sketch", status: "DRAFT" },
    { id: "release-other", artist_id: "artist-indigo", title: "Someone Else", status: "PUBLISHED", published_at: "2026-10-12T00:00:00Z" },
  ],
  editions: [
    { id: "edition-new", release_id: "release-new", title: "Forgive & Forget", status: "PUBLISHED", chain_id: 43113, contract_address: CLONE, release_contract_address: CLONE, factory_address: FACTORY, token_id: "111" },
    { id: "edition-old", release_id: "release-old", title: "Forgive & Forget", status: "PUBLISHED", chain_id: 43113, contract_address: LEGACY, token_id: "222" },
    { id: "edition-draft", release_id: "release-draft", title: "Unreleased Sketch", status: "DRAFT", chain_id: 43113, contract_address: CLONE, release_contract_address: CLONE, factory_address: FACTORY, token_id: "333" },
    { id: "edition-other", release_id: "release-other", title: "Someone Else", status: "PUBLISHED", chain_id: 43113, contract_address: CLONE, release_contract_address: CLONE, factory_address: FACTORY, token_id: "444" },
  ],
};

// The public catalog as the app loads it: through fetchPublishedCatalog, over a stubbed API.
const apiFor = (rows) => async (url) => {
  const key = String(url).split("?")[0].replace(/^.*\/api\//, "");
  return { ok: true, json: async () => ({ data: rows[key] || [] }) };
};

vi.mock("../lib/catalog-source.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { collapsePublicCatalog } = await import("../lib/summit-demo.js");
  const published = await actual.fetchPublishedCatalog({ fetchImpl: apiFor(rows) });
  const collapsed = collapsePublicCatalog(actual.mergeCatalogs([...actual.baseCatalogs(), published]));
  const catalog = { ...collapsed, duplicates: actual.combineDuplicates(collapsed, published.duplicates) };
  return { ...actual, useMarketplaceCatalogs: () => catalog };
});
const { CollectionDetailPage, MyCollectionPage } = await import("./PlatformPages.jsx");

const records = [
  { wallet: WALLET, contract: CLONE.toLowerCase(), tokenId: "111", amount: 2, chain: { key: "fuji", id: 43113, name: "Avalanche Fuji" }, updatedAt: 1 },
  { wallet: WALLET, contract: LEGACY.toLowerCase(), tokenId: "222", amount: 1, chain: { key: "fuji", id: 43113, name: "Avalanche Fuji" }, updatedAt: 1 },
];
function renderMyCollection(ownershipRecords) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WalletCtx.Provider value={{ connected: true, account: WALLET, loadingOwnership: false, ownershipRecords, owned: {}, getProvider: () => null, disconnect: () => {} }}>
        <MyCollectionPage />
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
}
function renderCollection(id) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/collection/${id}`]}><Routes><Route path="/collection/:collection" element={<CollectionDetailPage />} /></Routes></MemoryRouter>,
  );
}

describe("Catalog -> collection -> releases", () => {
  it("keeps the collection's own release and adds the artist's other published releases", () => {
    const markup = renderCollection("voidcaller-collection");
    expect(markup).toContain('href="/release/voidcaller-self-titled"');
    expect(markup).toContain("More from");
    expect(markup).toContain('href="/release/release-new"');
  });

  it("lists each published release once, with its own release link", () => {
    const markup = renderCollection("voidcaller-collection");
    expect(markup.match(/href="\/release\/voidcaller-self-titled"/g)).toHaveLength(1);
    expect(markup.match(/href="\/release\/release-new"/g)).toHaveLength(1);
  });

  it("does not list drafts or another artist's releases", () => {
    const markup = renderCollection("voidcaller-collection");
    expect(markup).not.toContain("release-draft");
    expect(markup).not.toContain("Unreleased Sketch");
    expect(markup).not.toContain("release-other");
    expect(markup).not.toContain("Someone Else");
  });

  it("sends an unknown collection back to the catalog", () => {
    expect(renderCollection("nope")).not.toContain("More from");
  });
});

describe("My Collection -> owned editions", () => {
  it("shows the clone edition with quantity 2 and links to that exact edition", () => {
    const markup = renderMyCollection(records);
    expect(markup).toContain("2 owned");
    expect(markup).toContain('href="/edition/edition-new"');
  });

  it("keeps two same-title editions distinct instead of hiding the older one", () => {
    const markup = renderMyCollection(records);
    expect(markup.match(/<h3[^>]*>[^<]*Forgive &amp; Forget/gi)).toHaveLength(2);
    expect(markup).toContain('href="/edition/edition-old"');
    expect(markup).toContain("1 owned");
    expect(markup).not.toContain("edition-draft");
    expect(markup).not.toContain("edition-other");
  });

  it("shows nothing for zero balances", () => {
    const markup = renderMyCollection([]);
    expect(markup).not.toContain('href="/edition/edition-new"');
    expect(markup).toContain("Nothing held");
  });
});
