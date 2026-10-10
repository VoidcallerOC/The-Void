/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { FUJI_RELEASE_FACTORY_V2_CONFIG } from "../lib/fuji-release.js";

const studioFetch = vi.fn();
const readReleaseAlbumState = vi.fn();
vi.mock("../lib/studio-api.js", async (importOriginal) => ({ ...(await importOriginal()), studioFetch: (...args) => studioFetch(...args) }));
vi.mock("../lib/fuji-release.js", async (importOriginal) => ({ ...(await importOriginal()), readReleaseAlbumState: (...args) => readReleaseAlbumState(...args) }));
vi.mock("../lib/primary-sale.js", async (importOriginal) => ({ ...(await importOriginal()), createFujiPublicProvider: () => ({ request: vi.fn() }), readReleasePrimarySale: vi.fn(async () => null) }));
const { ArtistStudioPage } = await import("./ArtistStudioPage.jsx");

const CHAIN_ID = Number(FUJI_RELEASE_FACTORY_V2_CONFIG.chainId);
const CLONE = "0x1111111111111111111111111111111111111111";
const SALE = "0x2222222222222222222222222222222222222222";
const ANCHOR = "0x3333333333333333333333333333333333333333";
const PRE_ALBUM = { supported: false, created: false, closed: false, trackCount: 0n, singleCount: 0n };
const wallet = { connected: true, authenticated: true, account: "0x4444444444444444444444444444444444444444", chainId: CHAIN_ID, authHeaders: { authorization: "Bearer session" }, getProvider: () => null };
const artists = [{ id: "artist-a", display_name: "Artist A", slug: "artist-a" }];

function renderStudio(releaseId) {
  return render(
    <WalletCtx.Provider value={wallet}>
      <MemoryRouter initialEntries={[`/studio?release=${releaseId}`]}>
        <ArtistStudioPage />
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

function publishedCatalog(releaseMetadata) {
  return {
    artists,
    releases: [{ id: "rel-out", artist_id: "artist-a", title: "Out Now", status: "PUBLISHED", release_metadata: releaseMetadata }],
    editions: [{ id: "ed-out", release_id: "rel-out", title: "Track One", status: "PUBLISHED", supply: "25", chain_id: CHAIN_ID, contract_address: CLONE, token_id: "5", application_metadata: {} }],
    experiences: [],
  };
}

// A bound (provisioning CONFIRMED) but unpublished ALBUM draft.
function mockConfirmedAlbumDraft() {
  const catalog = { artists, releases: [{ id: "rel-draft", artist_id: "artist-a", title: "Album Draft", status: "DRAFT", release_metadata: { releaseType: "ALBUM" } }], editions: [], experiences: [] };
  studioFetch.mockImplementation(async (path) => {
    if (path === "/studio/catalog") return catalog;
    if (path.endsWith("/provisioning/prepare")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseKey: `0x${"ab".repeat(32)}`, artistWallet: wallet.account };
    if (path.endsWith("/provisioning/status")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseContractAddress: CLONE, primarySaleAddress: SALE, provenanceAnchorAddress: ANCHOR };
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => { cleanup(); studioFetch.mockReset(); readReleaseAlbumState.mockReset(); });

describe("Artist Studio release type after reload", () => {
  it("reloads a published ALBUM release as ALBUM and reads album state from its bound contract", async () => {
    studioFetch.mockResolvedValue(publishedCatalog({ releaseType: "ALBUM" }));
    readReleaseAlbumState.mockResolvedValue(PRE_ALBUM);
    renderStudio("rel-out");
    await waitFor(() => expect(readReleaseAlbumState).toHaveBeenCalledWith(expect.anything(), CLONE));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    expect(screen.getByLabelText(/Release type/).value).toBe("ALBUM");
    // A pre-album clone still fails closed.
    expect(await screen.findByText(/pre-album implementation/)).toBeTruthy();
  });

  it("keeps a legacy release with no stored type as EP and never reads album state", async () => {
    studioFetch.mockResolvedValue(publishedCatalog(null));
    renderStudio("rel-out");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    await waitFor(() => expect(screen.getByLabelText(/Release type/).value).toBe("EP"));
    expect(readReleaseAlbumState).not.toHaveBeenCalled();
  });

  it("reloads a bound ALBUM draft with the album panel and disables album actions on a pre-album clone", async () => {
    mockConfirmedAlbumDraft();
    readReleaseAlbumState.mockResolvedValue(PRE_ALBUM);
    renderStudio("rel-draft");
    expect(await screen.findByLabelText(/Designate this track as a Single/)).toBeTruthy();
    await waitFor(() => expect(readReleaseAlbumState).toHaveBeenCalledWith(expect.anything(), CLONE));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    expect(await screen.findByText(/pre-album implementation/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate Album Contract" }).disabled).toBe(true);
  });

  it("clears the single flag and track mint end when starting a new track", async () => {
    mockConfirmedAlbumDraft();
    readReleaseAlbumState.mockResolvedValue({ supported: true, created: true, closed: false, trackCount: 1n, singleCount: 0n });
    renderStudio("rel-draft");
    const single = await screen.findByLabelText(/Designate this track as a Single/);
    fireEvent.click(single);
    fireEvent.change(screen.getByLabelText(/Track mint end/), { target: { value: "2026-12-01T10:00" } });
    expect(single.checked).toBe(true);
    expect(screen.getByLabelText(/Track mint end/).value).toBe("2026-12-01T10:00");

    fireEvent.click(screen.getByText("Add tracks", { selector: "h2" }).closest("button"));
    fireEvent.change(screen.getByLabelText(/Select album \/ collection/), { target: { value: "rel-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add track" }));

    expect((await screen.findByLabelText(/Designate this track as a Single/)).checked).toBe(false);
    expect(screen.getByLabelText(/Track mint end/).value).toBe("");
  });
});
