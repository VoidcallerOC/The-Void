/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditionPage, ExperiencePage, MyCollectionPage } from "./PlatformPages.jsx";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { holderAudioOptions } from "../lib/holder-audio.js";
import { WalletCtx } from "../lib/wallet-context.js";
import { VC_AUDIO } from "../lib/audio.js";
import { baseCatalogs, fetchPublishedCatalog, mergeCatalogs } from "../lib/catalog-source.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

// The build-configured release network (production: Avalanche C-Chain 43114).
const CHAIN = String(RELEASE_DEPLOYMENT.chainId);

// Mirrors the production Forgive & Forget rows (token #1, release-per-contract, mainnet)
// read from the public GET /api/releases, /api/editions and /api/experiences listings.
const { catalogState, grants } = vi.hoisted(() => ({ catalogState: { current: null }, grants: [] }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.current }));
vi.mock("../lib/media-auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestProtectedMediaGrant: vi.fn(async (request) => {
    grants.push(request);
    if (request.wallet === STRANGER) { const error = new Error("denied"); error.code = "EXPERIENCE_ENTITLEMENT_REQUIRED"; throw error; }
    return { grantId: `g-${request.experienceId}`, accessUrl: `/media/g-${request.experienceId}`, expiresAt: new Date(Date.now() + 300000).toISOString() };
  }),
}));

const STRANGER = "0x00000000000000000000000000000000000000aa";
const HOLDER = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const releaseId = "release-e6a28d6d-39c9-4879-a805-03afde89b58b";
const editionId = "edition-bc6d0d6a-b5e3-48ca-b4b0-d4fbb8ae485b";
const contract = "0xf0c091a159de16cf0f306b2b61d37685ec5a830e";
const FULL_ID = `experience-${editionId}-full-track`;
const DEMO_ID = `experience-${editionId}-experience-audio`;
const PREVIEW = "ipfs://bafypublicpreviewclip";
const DESCRIPTION = "There's gold in the sand you sift\nSecond line";
const exp = (id, title, type, primary) => ({ id, artist_id: "voidcaller", release_id: releaseId, edition_id: editionId, title, description: "", experience_type: type, version: 2, status: "PUBLISHED", updated_at: "2026-10-23T22:58:24Z", gated: true, protected: true, primary_experience: primary });
const FULL = exp(FULL_ID, "Forgive & Forget", "AUDIO", true);
const DEMO = exp(DEMO_ID, "Stranger Things", "DEMO", false);

async function catalogFor({ experiences = [FULL, DEMO], releaseDescription = DESCRIPTION, extraReleases = [] } = {}) {
  const api = {
    artists: [{ id: "voidcaller", slug: "voidcaller", display_name: "Voidcaller", status: "ACTIVE" }],
    releases: [{ id: releaseId, artist_id: "voidcaller", artist_slug: "voidcaller", artist_name: "Voidcaller", slug: "forgive-forget-7", title: "Forgive & Forget", description: releaseDescription, status: "PUBLISHED", release_metadata: { chainId: 43114, releaseType: "SINGLE", publicationArchitecture: "release-per-contract" } }, ...extraReleases],
    editions: [{ id: editionId, release_id: releaseId, title: "Forgive & Forget", description: null, supply: "0", status: "PUBLISHED", application_metadata: { includes: ["Forgive & Forget - Full Track", "Stranger Things - Demo"] }, chain_id: CHAIN, contract_address: contract, release_contract_address: contract, token_id: "1", token_metadata: { name: "Forgive & Forget", image: "ipfs://bafyart", animation_url: PREVIEW } }],
    experiences,
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ data: api[String(url).split("/").at(-1)] }) });
  return collapsePublicCatalog(mergeCatalogs([...baseCatalogs(), await fetchPublishedCatalog({ fetchImpl })]));
}

const walletFor = (account, holds = true) => ({ account, connected: true, authenticated: true, authHeaders: {}, chainId: Number(CHAIN), getProvider: () => null, owned: { cchain: new Set(), grotto: new Set(), fuji: new Set() }, ownershipRecords: holds ? [{ wallet: account, contract, tokenId: "1", amount: 1, chain: Number(CHAIN) }] : [] });
const page = (wallet, path, pattern, Page) => render(
  <WalletCtx.Provider value={wallet}><MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={<><Page /><StickyPlayer /></>} /></Routes></MemoryRouter></WalletCtx.Provider>,
);
const edition = (wallet = walletFor(HOLDER)) => page(wallet, `/edition/${editionId}`, "/edition/:edition", EditionPage);
const badges = () => screen.queryAllByText(/^(PREVIEW|FULL TRACK|DEMO)$/).map((node) => node.textContent);

beforeEach(() => {
  grants.length = 0;
  VC_AUDIO.queue = null; VC_AUDIO.idx = 0; VC_AUDIO.queueId = null; VC_AUDIO.mediaGrants.clear(); VC_AUDIO.grantedKeys.clear();
  vi.spyOn(VC_AUDIO, "play").mockResolvedValue(undefined);
  vi.spyOn(VC_AUDIO, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); VC_AUDIO.queue = null; VC_AUDIO.mediaGrants.clear(); VC_AUDIO.grantedKeys.clear(); });

describe("holder full-track / demo selector", () => {
  it("orders the full track before the demo and classifies each", async () => {
    const catalog = await catalogFor();
    expect(holderAudioOptions(catalog.experiences.filter((item) => item.editionId === editionId)).map((o) => [o.experience.id, o.kind])).toEqual([[FULL_ID, "full"], [DEMO_ID, "demo"]]);
  });

  it("shows both selectable experiences to the holder", async () => {
    catalogState.current = await catalogFor();
    edition();
    expect(screen.getByRole("button", { name: /Full track · Forgive & Forget/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Demo · Stranger Things/ })).toBeTruthy();
  });

  it("full requests the full-track grant, demo the demo grant; label follows; switching stops the previous source", async () => {
    catalogState.current = await catalogFor();
    edition();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Full track/ })); });
    expect(grants.at(-1)).toMatchObject({ wallet: HOLDER, experienceId: FULL_ID, mediaType: "AUDIO" });
    expect(VC_AUDIO.srcFor(VC_AUDIO.queue[0])).toBe(`/media/g-${FULL_ID}`);
    expect(badges()).toEqual(["FULL TRACK"]);
    const pausesBefore = VC_AUDIO.pause.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Demo · Stranger Things/ })); });
    expect(VC_AUDIO.pause.mock.calls.length).toBeGreaterThan(pausesBefore);
    expect(grants.at(-1)).toMatchObject({ experienceId: DEMO_ID, mediaType: "DEMO" });
    expect(VC_AUDIO.queue).toHaveLength(1);
    expect(VC_AUDIO.queue[0].protectedMedia.experienceId).toBe(DEMO_ID);
    expect(VC_AUDIO.srcFor(VC_AUDIO.queue[0])).toBe(`/media/g-${DEMO_ID}`);
    expect(VC_AUDIO.queue[0].previewSrc).toBe("");
    expect(badges()).toEqual(["DEMO"]);
    expect(screen.getByText("Stranger Things", { selector: "span" })).toBeTruthy();
  });

  it("the gateway refusal blocks a wallet the UI believed held the token, with no playback", async () => {
    catalogState.current = await catalogFor();
    edition(walletFor(STRANGER));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Demo · Stranger Things/ })); });
    expect(screen.getByText(/does not currently hold the edition/)).toBeTruthy();
    expect(VC_AUDIO.queue).toBeNull();
    expect(VC_AUDIO.play).not.toHaveBeenCalled();
  });

  it("non-holders get no selector and keep the public preview", async () => {
    catalogState.current = await catalogFor();
    edition(walletFor(STRANGER, false));
    expect(screen.queryByRole("group", { name: "Holder audio" })).toBeNull();
    expect(screen.getByRole("button", { name: /Play preview/ })).toBeTruthy();
  });

  it("missing experience data gives a clear fallback, not an unlocked control", async () => {
    catalogState.current = await catalogFor({ experiences: [] });
    edition();
    expect(screen.getByText(/Holder audio for this edition is not available yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Full track/ })).toBeNull();
  });

  it("the experience page lists both siblings for the holder", async () => {
    catalogState.current = await catalogFor();
    page(walletFor(HOLDER), `/experience/${DEMO_ID}`, "/experience/:experience", ExperiencePage);
    expect(screen.getByRole("button", { name: /Full track · Forgive & Forget/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Demo · Stranger Things/ })).toBeTruthy();
  });
});

describe("collector-facing release metadata", () => {
  it("renders the saved release description with line breaks on the edition page", async () => {
    catalogState.current = await catalogFor();
    edition();
    const node = screen.getByTestId("collector-description");
    expect(node.textContent).toBe(DESCRIPTION);
    expect(node.style.whiteSpace).toBe("pre-line");
  });

  it("renders it on the owned token card in My collection", async () => {
    catalogState.current = await catalogFor();
    page(walletFor(HOLDER), "/my-collection", "/my-collection", MyCollectionPage);
    expect(screen.getByText(/Token #1/)).toBeTruthy();
    expect(screen.getByTestId("collector-description").textContent).toBe(DESCRIPTION);
  });

  it("missing optional metadata renders nothing and does not crash", async () => {
    catalogState.current = await catalogFor({ releaseDescription: "" });
    edition();
    expect(screen.queryByTestId("collector-description")).toBeNull();
  });

  it("an archived predecessor release does not displace the active release metadata", async () => {
    catalogState.current = await catalogFor({ extraReleases: [{ id: "release-b96d6a64-3379-4da0-b834-ae2e00bf9571", artist_id: "voidcaller", title: "Forgive & Forget", description: "OLD ARCHIVED", status: "ARCHIVED" }] });
    edition();
    expect(screen.getByTestId("collector-description").textContent).toBe(DESCRIPTION);
  });
});
