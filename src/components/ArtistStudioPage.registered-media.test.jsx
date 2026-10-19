/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

// Reopening a draft loses the upload state held in the page. The artist's already-registered private
// files and previews are offered instead, and saving the catalog from them never uploads anything.

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
const FULL_ID = "asset-1463db33-e45f-44ec-bff1-2908e883eb48";
const DEMO_ID = "asset-2deb8f1e-bb4e-4180-80c0-5fab71d57cca";
const NEW_PREVIEW = "ipfs://bafybeiaoy7h6tlwy77jwy5ogaoslcdxbp5ohodmpwrbwkylfkofg67rgd4";
const OLD_PREVIEW = "ipfs://bafybeifir35fxkrjnblk6yyqicxjl44y7bo3gzjz5ronqbw6yoq56mqaqy";

const registeredListing = {
  protected: [
    { assetId: DEMO_ID, mediaType: "DEMO", byteSize: 10584246, contentType: "audio/wav", registeredAt: "2026-10-18T20:23:22Z" },
    { assetId: FULL_ID, mediaType: "AUDIO", byteSize: 65861868, contentType: "audio/wav", registeredAt: "2026-10-18T20:20:39Z" },
  ],
  previews: [
    { uri: NEW_PREVIEW, contentType: "audio/mpeg", byteSize: 721695, uploadedAt: "2026-10-18T20:20:25Z" },
    { uri: OLD_PREVIEW, contentType: "audio/mpeg", byteSize: 481115, uploadedAt: "2026-10-18T18:45:56Z" },
  ],
};

afterEach(() => { cleanup(); for (const mock of [studioFetch, fetchRegisteredMedia, uploadStudioFullTrack, uploadStudioPreview, uploadStudioArtwork]) mock.mockReset(); });

function mockStudio() {
  fetchRegisteredMedia.mockResolvedValue(registeredListing);
  studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return { artists: [{ id: "artist-a", display_name: "Artist A", slug: "artist-a", status: "ACTIVE", owner_wallet: wallet.account }], releases: [{ id: DRAFT, artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT", release_metadata: { releaseType: "SINGLE", contractSymbol: "FNF" } }], editions: [], experiences: [] };
    if (path.includes("/provisioning/")) throw Object.assign(new Error("not configured"), { code: "RELEASE_FACTORY_V2_NOT_CONFIGURED" });
    if (/^\/studio\/releases\/[^/]+$/.test(path) && options.method === "PATCH") return { id: DRAFT, artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/releases\/[^/]+\/editions$/.test(path) && options.method === "POST") return { id: "ed-new", release_id: DRAFT, title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/editions\/[^/]+\/experiences$/.test(path)) return { id: options.payload.id, title: options.payload.title, status: "DRAFT" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });
}

const experienceSaves = () => studioFetch.mock.calls.filter(([path, options]) => /\/experiences$/.test(path) && options?.method === "POST").map(([, options]) => options.payload);
const editionSaves = () => studioFetch.mock.calls.filter(([path, options]) => /\/editions$/.test(path) && options?.method === "POST").map(([, options]) => options.payload);
const choose = async (name, value) => fireEvent.change(await screen.findByLabelText(name), { target: { value } });

async function openDraft() {
  render(<WalletCtx.Provider value={wallet}><MemoryRouter initialEntries={[`/studio?release=${DRAFT}`]}><ArtistStudioPage /></MemoryRouter></WalletCtx.Provider>);
  await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
  await waitFor(() => expect(screen.getByDisplayValue("Forgive & Forget")).toBeTruthy());
}
const toTracks = () => fireEvent.click(screen.getByRole("button", { name: /02\s*Tracks/ }));
const toExperiences = () => fireEvent.click(screen.getByRole("button", { name: /03\s*Experiences/ }));

describe("Studio reattaches files the artist already registered", () => {
  it("offers only unattached files of the right type, plus the previously uploaded previews", async () => {
    mockStudio();
    await openDraft();
    toTracks();
    await waitFor(() => expect(fetchRegisteredMedia).toHaveBeenCalledWith(expect.objectContaining({ artistId: "artist-a" })));
    const fullOptions = await screen.findByLabelText("Use a full track already registered");
    expect([...fullOptions.querySelectorAll("option")].map((option) => option.value).filter(Boolean)).toEqual([FULL_ID]); // AUDIO only, never the demo
    const previewOptions = screen.getByLabelText("Use a preview already uploaded");
    expect([...previewOptions.querySelectorAll("option")].map((option) => option.value).filter(Boolean)).toEqual([NEW_PREVIEW, OLD_PREVIEW]); // newest first
    toExperiences();
    fireEvent.change(screen.getByLabelText(/What does this track unlock/i), { target: { value: "DEMO" } });
    const demoOptions = await screen.findByLabelText(/Use a experience audio already registered/i);
    expect([...demoOptions.querySelectorAll("option")].map((option) => option.value).filter(Boolean)).toEqual([DEMO_ID]); // DEMO only
  });

  it("saves the full song (primary), the separate demo and the newer preview from existing assets, with no upload", async () => {
    mockStudio();
    await openDraft();
    toTracks();
    await choose("Use a preview already uploaded", NEW_PREVIEW);
    await choose("Use a full track already registered", FULL_ID);
    await waitFor(() => expect(screen.getByText(new RegExp(`Using the registered full track ${FULL_ID}`))).toBeTruthy());
    toExperiences();
    fireEvent.change(screen.getByLabelText(/Experience name/i), { target: { value: "Stranger Things" } });
    fireEvent.change(screen.getByLabelText(/What does this track unlock/i), { target: { value: "DEMO" } });
    await choose(/Use a experience audio already registered/i, DEMO_ID);
    await waitFor(() => expect(screen.getByText(/Holders unlock two separate experiences/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Save catalog structure/i }));
    await waitFor(() => expect(experienceSaves()).toHaveLength(2));

    const saves = experienceSaves();
    const demo = saves.find((payload) => payload.productType === "DEMO");
    const full = saves.find((payload) => payload.productType === "FULL_RECORD");
    expect(full.mediaConfig).toMatchObject({ protected: true, primary: true, protectedMedia: [{ assetId: FULL_ID, mediaType: "AUDIO" }] });
    expect(demo.mediaConfig).toMatchObject({ protected: true, primary: false, protectedMedia: [{ assetId: DEMO_ID, mediaType: "DEMO" }] });
    expect(full.id).not.toBe(demo.id);
    expect(JSON.stringify(full)).not.toContain(DEMO_ID);
    expect(JSON.stringify(demo)).not.toContain(FULL_ID);
    // The newer preview is the public preview in the edition metadata; the older one is untouched and unused.
    expect(editionSaves()).toHaveLength(1);
    expect(editionSaves()[0].metadata.previewAudio).toBe(NEW_PREVIEW);
    expect(JSON.stringify([...experienceSaves(), editionSaves()])).not.toContain(OLD_PREVIEW);
    // The preview never appears inside a private experience.
    expect(JSON.stringify(saves)).not.toContain("bafybeiaoy7");
    // Nothing was uploaded or newly registered.
    expect(uploadStudioFullTrack).not.toHaveBeenCalled();
    expect(uploadStudioPreview).not.toHaveBeenCalled();
    expect(uploadStudioArtwork).not.toHaveBeenCalled();
    expect(studioFetch.mock.calls.filter(([path]) => /\/media(\/|$)/.test(path))).toEqual([]);
    await waitFor(() => expect(screen.getByText(/Catalog saved/)).toBeTruthy());
  });

  it("saving again sends the same two stable ids and assets", async () => {
    mockStudio();
    await openDraft();
    toTracks();
    await choose("Use a full track already registered", FULL_ID);
    toExperiences();
    fireEvent.change(screen.getByLabelText(/What does this track unlock/i), { target: { value: "DEMO" } });
    await choose(/Use a experience audio already registered/i, DEMO_ID);
    fireEvent.click(screen.getByRole("button", { name: /Save catalog structure/i }));
    await waitFor(() => expect(experienceSaves()).toHaveLength(2));
    toExperiences();
    fireEvent.click(screen.getByRole("button", { name: /Save catalog structure/i }));
    await waitFor(() => expect(experienceSaves()).toHaveLength(4));
    const [a, b, c, d] = experienceSaves();
    expect([c.id, d.id]).toEqual([a.id, b.id]);
    expect([c.mediaConfig, d.mediaConfig]).toEqual([a.mediaConfig, b.mediaConfig]);
    expect(editionSaves()).toHaveLength(1); // one edition, not a second
    expect(uploadStudioFullTrack).not.toHaveBeenCalled();
  });

  it("shows no picker when nothing registered is waiting, and still offers the normal upload", async () => {
    mockStudio();
    fetchRegisteredMedia.mockResolvedValue({ protected: [], previews: [] });
    await openDraft();
    toTracks();
    await waitFor(() => expect(fetchRegisteredMedia).toHaveBeenCalled());
    expect(screen.queryByLabelText("Use a full track already registered")).toBeNull();
    expect(screen.queryByLabelText("Use a preview already uploaded")).toBeNull();
    expect(screen.getByText("Upload full track")).toBeTruthy();
  });
});
