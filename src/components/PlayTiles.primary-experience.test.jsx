import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyCollectionPage, ReleasePage } from "./PlatformPages.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { baseCatalogs, fetchPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";

// The release tile and the owned-collection tile resolve an edition's primary experience by the same
// rules as the edition page. These render the real pages over the real catalog mapping and capture what
// each tile's Play control is handed.

const { catalogState, plays } = vi.hoisted(() => ({ catalogState: { current: null }, plays: [] }));

vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.current }));
vi.mock("./PlayTokenButton.jsx", () => ({ PlayTokenButton: (props) => { plays.push(props); return null; } }));

const WALLET = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const editionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const releaseId = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const tokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const contractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const FULL_ID = `experience-${editionId}-full-track`;
const DEMO_ID = `experience-${editionId}-experience-audio`;
const PREVIEW = "ipfs://bafypublicpreviewclip";

const row = (id, title, type, primary, updatedAt = "2026-10-18T10:00:00Z") => ({ id, artist_id: "voidcaller", release_id: releaseId, edition_id: editionId, title, description: "", experience_type: type, version: 1, status: "PUBLISHED", created_at: "2026-10-18T10:00:00Z", updated_at: updatedAt, gated: true, protected: true, ...(primary === undefined ? {} : { primary_experience: primary }) });
const FULL = (primary = true) => row(FULL_ID, "Forgive & Forget", "AUDIO", primary);
const DEMO = (primary = false) => row(DEMO_ID, "Stranger Things", "DEMO", primary, "2026-10-18T12:00:00Z");

// The designation scenarios, as public listing rows.
const SCENARIOS = {
  designated: { rows: () => [DEMO(false), FULL(true)], state: null, playsId: FULL_ID },
  legacy: { rows: () => [row("legacy-a", "Track A", "AUDIO"), row("legacy-b", "Track B", "AUDIO")], state: null, playsId: "legacy-a" },
  missing: { rows: () => [DEMO(false)], state: "missing" },
  invalid: { rows: () => [{ ...FULL(true), protected: false, gated: false }, DEMO(false)], state: "invalid" },
  ambiguous: { rows: () => [FULL(true), DEMO(true)], state: "ambiguous" },
};

async function publishedCatalog(experiences) {
  const api = {
    artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }],
    releases: [{ id: releaseId, artist_id: "voidcaller", artist_slug: "voidcaller", artist_name: "Voidcaller", title: "Forgive & Forget", description: "", status: "PUBLISHED" }],
    editions: [{ id: editionId, release_id: releaseId, title: "Forgive & Forget", description: null, supply: "25", status: "PUBLISHED", application_metadata: { includes: ["Full song"], priceWei: "10000000000000000" }, chain_id: "43113", contract_address: contractAddress, token_id: tokenId, token_metadata: { name: "Forgive & Forget", image: "ipfs://bafyart", animation_url: PREVIEW } }],
    experiences,
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ data: api[String(url).split("/").at(-1)] }) });
  return collapsePublicCatalog(mergeCatalogs([...baseCatalogs(), await fetchPublishedCatalog({ fetchImpl })]));
}

// ----- owned-collection tile -----
const wallet = { account: WALLET, connected: true, authenticated: false, authHeaders: {}, chainId: 43113, getProvider: () => null, loadingOwnership: false, disconnect: () => {}, owned: {}, ownershipRecords: [{ wallet: WALLET, contract: contractAddress, tokenId, amount: 1, chain: { key: "fuji", id: 43113, name: "Avalanche Fuji" }, updatedAt: 1 }] };
function renderCollectionTile() {
  plays.length = 0;
  const markup = renderToStaticMarkup(React.createElement(WalletCtx.Provider, { value: wallet }, React.createElement(MemoryRouter, null, React.createElement(MyCollectionPage))));
  return { markup };
}

// ----- release tile (the built-in release lists one tile per track) -----
// Tracks that name their experience keep it; these tiles resolve the token's own experiences, so the
// track's experienceId is removed and the token's experiences replaced by the scenario's.
async function releaseCatalog(rows) {
  const catalog = await publishedCatalog([]);
  const release = catalog.releases.find((item) => item.id === "voidcaller-self-titled");
  const token = catalog.tokens.find((item) => String(item.tokenId) === "0" && item.editionId === "voidcaller-chapter-i");
  const experiences = rows.map((r) => ({ type: "experience", id: r.id, title: r.title, experienceType: r.experience_type, editionId: "voidcaller-chapter-i", media: { type: r.experience_type, protected: r.protected !== false, previewAvailable: true }, ...(typeof r.primary_experience === "boolean" ? { primary: r.primary_experience } : {}) }));
  return {
    ...catalog,
    releases: catalog.releases.map((item) => (item === release ? { ...item, tracks: item.tracks.map((track) => { const copy = { ...track }; if (String(copy.tokenId) === "0") delete copy.experienceId; return copy; }) } : item)),
    tokens: catalog.tokens.map((item) => (item === token ? { ...item, experiences: experiences.map((e) => e.id) } : item)),
    experiences: [...catalog.experiences, ...experiences],
  };
}
function renderReleaseTile() {
  plays.length = 0;
  const markup = renderToStaticMarkup(React.createElement(WalletCtx.Provider, { value: wallet }, React.createElement(MemoryRouter, { initialEntries: ["/release/voidcaller-self-titled"] }, React.createElement(Routes, null, React.createElement(Route, { path: "/release/:release", element: React.createElement(ReleasePage) })))));
  return { markup };
}

const gatedProps = (plays) => plays.filter((props) => props.protectedExperience || props.track?.protectedMedia);

describe("owned-collection tile", () => {
  beforeEach(() => { catalogState.current = null; });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (scenario.state) {
      it(`${name} primary: public-preview label, unavailable notice, no protected media`, async () => {
        catalogState.current = await publishedCatalog(scenario.rows());
        const { markup } = renderCollectionTile();
        expect(plays).toHaveLength(1);
        const [tile] = plays;
        expect(tile.label).toBe("Play public preview");
        expect(tile.protectedExperience ?? null).toBeNull();
        expect(tile.track.protectedMedia).toBeUndefined();
        expect(tile.track.previewSrc).toContain("bafypublicpreviewclip");
        expect(gatedProps(plays)).toEqual([]);
        expect(markup).toContain(`data-primary-state="${scenario.state}"`);
        expect(markup).toContain("Full track unavailable");
        // The demo is never offered as the main tile experience.
        expect(markup).not.toContain(`/experience/${DEMO_ID}`);
      });
    } else {
      it(`${name} primary: keeps the plain Play on the resolved experience`, async () => {
        catalogState.current = await publishedCatalog(scenario.rows());
        const { markup } = renderCollectionTile();
        expect(plays).toHaveLength(1);
        const [tile] = plays;
        expect(tile.label ?? "Play").toBe("Play");
        expect(tile.protectedExperience.id).toBe(scenario.playsId);
        expect(tile.track.protectedMedia.experienceId).toBe(scenario.playsId);
        expect(markup).not.toContain("Full track unavailable");
        expect(markup).toContain(`/experience/${scenario.playsId}`);
      });
    }
  }
});

describe("release tile", () => {
  beforeEach(() => { catalogState.current = null; });

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (scenario.state) {
      it(`${name} primary: public-preview label, unavailable notice, no protected media`, async () => {
        catalogState.current = await releaseCatalog(scenario.rows());
        const { markup } = renderReleaseTile();
        const tile = plays.find((props) => props.label === "Play public preview");
        expect(tile).toBeTruthy();
        expect(tile.protectedExperience ?? null).toBeNull();
        expect(tile.track.protectedMedia).toBeUndefined(); // even the built-in track that normally brings its own
        expect(markup).toContain(`data-primary-state="${scenario.state}"`);
        expect(markup).toContain("Full track unavailable");
        expect(plays.filter((props) => props.label === "Play public preview")).toHaveLength(1); // only the affected tile
        expect(gatedProps(plays.filter((props) => props.label === "Play public preview"))).toEqual([]);
      });
    } else {
      it(`${name} primary: keeps the plain Play on the resolved experience`, async () => {
        catalogState.current = await releaseCatalog(scenario.rows());
        const { markup } = renderReleaseTile();
        expect(plays.some((props) => props.label === "Play public preview")).toBe(false);
        expect(markup).not.toContain("Full track unavailable");
        const tile = plays.find((props) => props.protectedExperience?.id === scenario.playsId);
        expect(tile).toBeTruthy();
        expect(tile.track.protectedMedia).toBeTruthy();
      });
    }
  }

  it("a track that names its experience keeps it regardless of designations", async () => {
    catalogState.current = await publishedCatalog([]);
    renderReleaseTile();
    expect(plays.some((props) => props.label === "Play public preview")).toBe(false);
    expect(plays.find((props) => props.protectedExperience?.id === "voidcaller-legacy-track-0")).toBeTruthy();
  });
});
