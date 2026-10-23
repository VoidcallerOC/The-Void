/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

// Studio no longer offers "use a file already uploaded/registered" pickers. Files are uploaded in the page, and the
// page does not ask the server for the artist's earlier uploads.

const studioFetch = vi.fn();
const fetchRegisteredMedia = vi.fn();
const uploadStudioFullTrack = vi.fn();
const uploadStudioPreview = vi.fn();
const uploadStudioArtwork = vi.fn();
vi.mock("../lib/studio-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  studioFetch: (...args) => studioFetch(...args),
  fetchRegisteredMedia: (...args) => fetchRegisteredMedia(...args),
  uploadStudioFullTrack: (...args) => uploadStudioFullTrack(...args),
  uploadStudioPreview: (...args) => uploadStudioPreview(...args),
  uploadStudioArtwork: (...args) => uploadStudioArtwork(...args),
}));
const { ArtistStudioPage } = await import("./ArtistStudioPage.jsx");

const wallet = { connected: true, authenticated: true, account: "0x4444444444444444444444444444444444444444", chainId: 43113, authHeaders: { authorization: "Bearer session" }, getProvider: () => ({ request: vi.fn() }) };
const DRAFT = "release-draft-1";

afterEach(() => { cleanup(); for (const mock of [studioFetch, fetchRegisteredMedia, uploadStudioFullTrack, uploadStudioPreview, uploadStudioArtwork]) mock.mockReset(); });

function mockStudio() {
  studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return { artists: [{ id: "artist-a", display_name: "Artist A", slug: "artist-a", status: "ACTIVE", owner_wallet: wallet.account }], releases: [{ id: DRAFT, artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT", release_metadata: { releaseType: "SINGLE", contractSymbol: "FNF" } }], editions: [], experiences: [] };
    if (path.includes("/provisioning/")) throw Object.assign(new Error("not configured"), { code: "RELEASE_FACTORY_V2_NOT_CONFIGURED" });
    if (/^\/studio\/releases\/[^/]+$/.test(path) && options.method === "PATCH") return { id: DRAFT, artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/releases\/[^/]+\/editions$/.test(path) && options.method === "POST") return { id: "ed-new", release_id: DRAFT, title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/editions\/[^/]+\/experiences$/.test(path)) return { id: options.payload.id, title: options.payload.title, status: "DRAFT" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });
}

async function openDraft() {
  render(<WalletCtx.Provider value={wallet}><MemoryRouter initialEntries={[`/studio?release=${DRAFT}`]}><ArtistStudioPage /></MemoryRouter></WalletCtx.Provider>);
  await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
  await waitFor(() => expect(screen.getByDisplayValue("Forgive & Forget")).toBeTruthy());
}
const toTracks = () => fireEvent.click(screen.getByRole("button", { name: /02\s*Tracks/ }));
const toExperiences = () => fireEvent.click(screen.getByRole("button", { name: /03\s*Experiences/ }));
const PICKER_LABELS = [/already uploaded/i, /already registered/i];

describe("Studio has no already-uploaded file pickers", () => {
  it("shows only the upload buttons on the Tracks step, even when the artist has earlier uploads", async () => {
    mockStudio();
    fetchRegisteredMedia.mockResolvedValue({ protected: [{ assetId: "asset-1", mediaType: "AUDIO", byteSize: 10, registeredAt: "2026-10-18T20:20:39Z" }], previews: [{ uri: "ipfs://bafybeiaoy7h6tlwy77jwy5ogaoslcdxbp5ohodmpwrbwkylfkofg67rgd4", byteSize: 10, uploadedAt: "2026-10-18T20:20:25Z" }] });
    await openDraft();
    toTracks();
    expect(await screen.findByText("Upload full track")).toBeTruthy();
    expect(screen.getByText("Upload preview")).toBeTruthy();
    for (const label of PICKER_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.queryByRole("combobox", { name: /uploaded|registered/i })).toBeNull();
  });

  it("shows only the upload button on the Experiences step", async () => {
    mockStudio();
    await openDraft();
    toExperiences();
    await screen.findByRole("button", { name: /Save catalog structure/i });
    for (const label of PICKER_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
  });

  it("does not ask the server for the artist's earlier uploads", async () => {
    mockStudio();
    await openDraft();
    toTracks();
    await screen.findByText("Upload full track");
    expect(fetchRegisteredMedia).not.toHaveBeenCalled();
  });
});
