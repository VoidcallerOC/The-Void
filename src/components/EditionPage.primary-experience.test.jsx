import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditionPage, ExperiencePage } from "./PlatformPages.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { baseCatalogs, fetchPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";

// The edition page's main Play button must play the edition's designated primary
// experience (the full track), however the public listing happens to be ordered. These
// tests render the real EditionPage / ExperiencePage over the real catalog mapping and
// capture which experience the Play button is handed.

const { catalogState, plays } = vi.hoisted(() => ({ catalogState: { current: null }, plays: [] }));

vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.current }));
vi.mock("./PlayTokenButton.jsx", () => ({ PlayTokenButton: (props) => { plays.push(props); return null; } }));
vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: "0x42B740aA92A6F48380F6D97AD91e332a7921a744", chainId: 43113, enabled: true }) };
});

const editionId = "edition-ecf27444-94b7-40d5-bace-5f061792f55e";
const releaseId = "release-8f6d5a9f-585d-4948-b05b-7098125d16cf";
const tokenId = "33778802922810732976408591241428358474475553907731009337085064305512658576739";
const contractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const FULL_ID = `experience-${editionId}-full-track`;
const DEMO_ID = `experience-${editionId}-experience-audio`;
const PREVIEW = "ipfs://bafypublicpreviewclip";

const wallet = { account: "0xabd3746e8b852f55be52fc44fab6cab908b1c174", connected: true, authenticated: false, authHeaders: {}, chainId: 43113, getProvider: () => null, owned: { cchain: new Set(), grotto: new Set(), fuji: new Set([tokenId]) }, ownershipRecords: [] };

// A row of the public experience listing (EXPERIENCE_PUBLIC_SELECT).
const row = (id, title, type, primary, updatedAt) => ({ id, artist_id: "voidcaller", release_id: releaseId, edition_id: editionId, title, description: "", experience_type: type, version: 1, status: "PUBLISHED", created_at: "2026-10-18T10:00:00Z", updated_at: updatedAt, gated: true, protected: true, ...(primary === undefined ? {} : { primary_experience: primary }) });
// The API lists experiences newest-updated first.
const listing = (rows) => [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

async function catalogFor(experiences) {
  const api = {
    artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }],
    releases: [{ id: releaseId, artist_id: "voidcaller", artist_slug: "voidcaller", artist_name: "Voidcaller", title: "Forgive & Forget", description: "", status: "PUBLISHED" }],
    editions: [{ id: editionId, release_id: releaseId, title: "Forgive & Forget", description: null, supply: "25", status: "PUBLISHED", application_metadata: { includes: ["Full song"], priceWei: "10000000000000000" }, chain_id: "43113", contract_address: contractAddress, token_id: tokenId, token_metadata: { name: "Forgive & Forget", image: "ipfs://bafyart", animation_url: PREVIEW } }],
    experiences,
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ data: api[String(url).split("/").at(-1)] }) });
  return collapsePublicCatalog(mergeCatalogs([...baseCatalogs(), await fetchPublishedCatalog({ fetchImpl })]));
}

const tree = (path, pattern, Page) => React.createElement(WalletCtx.Provider, { value: wallet }, React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Routes, null, React.createElement(Route, { path: pattern, element: React.createElement(Page) }))));
const renderEdition = () => { plays.length = 0; return renderToStaticMarkup(tree(`/edition/${editionId}`, "/edition/:edition", EditionPage)); };
const renderExperience = (id) => { plays.length = 0; return renderToStaticMarkup(tree(`/experience/${id}`, "/experience/:experience", ExperiencePage)); };
const mainPlay = () => plays.find((props) => props.label === "Play preview");
const publicPlay = () => plays.find((props) => props.label === "Play public preview");

const FULL = (updatedAt) => row(FULL_ID, "Forgive & Forget", "AUDIO", true, updatedAt);
const DEMO = (updatedAt) => row(DEMO_ID, "Stranger Things", "DEMO", false, updatedAt);

describe("edition page main Play button", () => {
  beforeEach(() => { catalogState.current = null; });

  it("plays the designated full track even when the demo was updated last and sorts first", async () => {
    const rows = listing([FULL("2026-10-18T10:00:00Z"), DEMO("2026-10-18T12:00:00Z")]);
    expect(rows[0].id).toBe(DEMO_ID); // the API's own order puts the demo first
    catalogState.current = await catalogFor(rows);
    const markup = renderEdition();

    const play = mainPlay();
    expect(play.protectedExperience.id).toBe(FULL_ID);
    expect(play.track.protectedMedia).toEqual({ experienceId: FULL_ID, mediaType: "AUDIO" });
    // Both experiences are still listed, each as its own experience.
    expect(markup).toContain("Stranger Things");
    expect(markup).toContain(`/experience/${DEMO_ID}`);
    expect(markup).toContain(`/experience/${FULL_ID}`);
  });

  it("is not changed by timestamps, listing order or insertion order", async () => {
    const stamps = [["2026-10-18T10:00:00Z", "2026-10-18T12:00:00Z"], ["2026-10-18T12:00:00Z", "2026-10-18T10:00:00Z"], ["2026-10-18T11:00:00Z", "2026-10-18T11:00:00Z"]];
    for (const [full, demo] of stamps) {
      for (const order of ["listed", "reversed"]) {
        const rows = listing([FULL(full), DEMO(demo)]);
        catalogState.current = await catalogFor(order === "listed" ? rows : [...rows].reverse());
        renderEdition();
        expect(mainPlay().protectedExperience.id).toBe(FULL_ID);
      }
    }
  });

  it("keeps the public preview as its own control next to the gated main Play", async () => {
    catalogState.current = await catalogFor(listing([FULL("2026-10-18T10:00:00Z"), DEMO("2026-10-18T12:00:00Z")]));
    renderEdition();
    const { track } = mainPlay();
    expect(track.previewSrc).toContain("bafypublicpreviewclip");
    expect(track.protectedMedia.experienceId).not.toBe(DEMO_ID);
    expect(JSON.stringify(track.protectedMedia)).not.toMatch(/preview/i);
    expect(publicPlay()).toBeUndefined(); // one control while the primary resolves
  });

  // Withheld, not silently replaced: no gated Play at all, only the explicitly labelled public preview.
  const expectGatedPlayWithheld = (markup, state) => {
    expect(mainPlay()).toBeUndefined();
    expect(plays.filter((props) => props.protectedExperience)).toEqual([]);
    expect(plays.filter((props) => props.track?.protectedMedia)).toEqual([]);
    const pub = publicPlay();
    expect(plays).toHaveLength(1);
    expect(pub.label).toBe("Play public preview");
    expect(pub.protectedExperience ?? null).toBeNull();
    expect(pub.track.previewSrc).toContain("bafypublicpreviewclip");
    expect(markup).toContain(`data-primary-state="${state}"`);
    expect(markup).toContain("Full-track playback is unavailable");
  };

  it("withholds the gated Play when the designated primary is missing (only the demo is published)", async () => {
    catalogState.current = await catalogFor([DEMO("2026-10-18T12:00:00Z")]);
    const markup = renderEdition();
    expectGatedPlayWithheld(markup, "missing");
    expect(markup).toContain(`/experience/${DEMO_ID}`); // still reachable as its own experience
  });

  it("withholds the gated Play when the primary is invalid", async () => {
    // Designated, but not a gated experience.
    catalogState.current = await catalogFor([{ ...FULL("2026-10-18T10:00:00Z"), protected: false, gated: false }, DEMO("2026-10-18T12:00:00Z")]);
    expectGatedPlayWithheld(renderEdition(), "invalid");
  });

  it("withholds the gated Play when two experiences claim to be primary", async () => {
    catalogState.current = await catalogFor([row(FULL_ID, "Forgive & Forget", "AUDIO", true, "2026-10-18T10:00:00Z"), row(DEMO_ID, "Stranger Things", "DEMO", true, "2026-10-18T12:00:00Z")]);
    expectGatedPlayWithheld(renderEdition(), "ambiguous");
  });

  it("keeps the previous behaviour for editions without any designation (Genesis and older releases)", async () => {
    catalogState.current = await catalogFor([row("legacy-a", "Track A", "AUDIO", undefined, "2026-10-18T12:00:00Z"), row("legacy-b", "Track B", "AUDIO", undefined, "2026-10-18T10:00:00Z")]);
    renderEdition();
    expect(mainPlay().protectedExperience.id).toBe("legacy-a"); // first listed, as before
    expect(publicPlay()).toBeUndefined();
    catalogState.current = await catalogFor([row("only", "Only experience", "AUDIO", undefined, "2026-10-18T10:00:00Z")]);
    renderEdition();
    expect(mainPlay().protectedExperience.id).toBe("only");
  });
});

describe("each experience stays independently playable on its own page", () => {
  it("plays the demo's own DEMO file on the demo page and the full track's AUDIO file on the full-track page", async () => {
    catalogState.current = await catalogFor(listing([FULL("2026-10-18T10:00:00Z"), DEMO("2026-10-18T12:00:00Z")]));

    renderExperience(DEMO_ID);
    const demo = plays.find((props) => props.protectedOnly);
    expect(demo.protectedExperience).toMatchObject({ id: DEMO_ID, media: { protected: true, type: "DEMO" } });
    expect(demo.track.protectedMedia).toEqual({ experienceId: DEMO_ID, mediaType: "DEMO" });

    renderExperience(FULL_ID);
    const full = plays.find((props) => props.protectedOnly);
    expect(full.protectedExperience).toMatchObject({ id: FULL_ID, media: { protected: true, type: "AUDIO" } });
    expect(full.track.protectedMedia).toEqual({ experienceId: FULL_ID, mediaType: "AUDIO" });
  });
});
