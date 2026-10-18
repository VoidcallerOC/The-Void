/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

// "Save catalog structure" must keep the full song and the demo as two separate
// experiences. Before, the page saved ONE experience from `experienceAudio ||
// fullTrack`, so a demo silently replaced the full song.

const studioFetch = vi.fn();
const uploadStudioFullTrack = vi.fn();
vi.mock("../lib/studio-api.js", async (importOriginal) => ({ ...(await importOriginal()), studioFetch: (...args) => studioFetch(...args), uploadStudioFullTrack: (...args) => uploadStudioFullTrack(...args) }));
const { ArtistStudioPage } = await import("./ArtistStudioPage.jsx");

const wallet = { connected: true, authenticated: true, account: "0x4444444444444444444444444444444444444444", chainId: 43113, authHeaders: { authorization: "Bearer session" }, getProvider: () => ({ request: vi.fn() }) };
const MASTER_FILE = () => new File(["master"], "Forgive-Forget-master.wav", { type: "audio/wav" });
const DEMO_FILE = () => new File(["demo"], "stranger-demo-30s.wav", { type: "audio/wav" });

afterEach(() => { cleanup(); studioFetch.mockReset(); uploadStudioFullTrack.mockReset(); });

function mockStudio() {
  uploadStudioFullTrack.mockImplementation(async ({ file, mediaType }) => (String(mediaType).toUpperCase() === "DEMO"
    ? { assetId: "asset-demo", filename: file.name, contentType: "audio/wav", mediaType: "DEMO", byteSize: file.size }
    : { assetId: "asset-master", filename: file.name, contentType: "audio/wav", mediaType: "AUDIO", byteSize: file.size }));
  studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return { artists: [{ id: "artist-a", display_name: "Artist A", slug: "artist-a" }], releases: [], editions: [], experiences: [] };
    if (/^\/studio\/artists\/[^/]+\/releases$/.test(path) && options.method === "POST") return { id: "rel-new", artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/releases\/[^/]+\/editions$/.test(path) && options.method === "POST") return { id: "ed-new", release_id: "rel-new", title: "Forgive & Forget", status: "DRAFT" };
    if (/^\/studio\/editions\/[^/]+\/experiences$/.test(path)) return { id: options.payload.id, title: options.payload.title, status: "DRAFT" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });
}

const experienceSaves = () => studioFetch.mock.calls.filter(([path, options]) => /\/experiences$/.test(path) && options?.method === "POST").map(([path, options]) => ({ path, payload: options.payload }));
const upload = (button, file) => fireEvent.change(screen.getByText(button).closest("label").querySelector("input[type=file]"), { target: { files: [file] } });

async function openStudio() {
  render(<WalletCtx.Provider value={wallet}><MemoryRouter initialEntries={["/studio"]}><ArtistStudioPage /></MemoryRouter></WalletCtx.Provider>);
  await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
}

describe("Artist Studio: Save catalog structure with the full song and a demo", () => {
  it("saves two separate experiences, one per file, and never lets the demo replace the full song", async () => {
    mockStudio();
    await openStudio();
    fireEvent.change(screen.getByLabelText(/Release title/i), { target: { value: "Forgive & Forget" } });

    fireEvent.click(screen.getByRole("button", { name: /02\s*Tracks/ }));
    upload("Upload full track", MASTER_FILE());
    await waitFor(() => expect(screen.getByText(/Full track stored privately/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /03\s*Experiences/ }));
    fireEvent.change(screen.getByLabelText(/Experience name/i), { target: { value: "Stranger Things" } });
    fireEvent.change(screen.getByLabelText(/^Description/i), { target: { value: "Stranger things have happened..." } });
    fireEvent.change(screen.getByLabelText(/What does this track unlock/i), { target: { value: "DEMO" } });
    upload("Upload experience audio", DEMO_FILE());
    await waitFor(() => expect(screen.getByText(/Experience audio stored privately/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Save catalog structure/i }));
    await waitFor(() => expect(experienceSaves()).toHaveLength(2));

    const saves = experienceSaves();
    const demo = saves.find((save) => save.payload.productType === "DEMO");
    const full = saves.find((save) => save.payload.productType === "FULL_RECORD");
    expect(demo.payload).toMatchObject({ experienceType: "DEMO", title: "Stranger Things", mediaConfig: { protected: true, primary: false, protectedMedia: [{ assetId: "asset-demo", mediaType: "DEMO" }] } });
    expect(full.payload).toMatchObject({ experienceType: "AUDIO", mediaConfig: { protected: true, primary: true, protectedMedia: [{ assetId: "asset-master", mediaType: "AUDIO" }] } });
    expect(demo.payload.id).not.toBe(full.payload.id);
    expect(JSON.stringify(full.payload)).not.toContain("asset-demo");
    expect(JSON.stringify(demo.payload)).not.toContain("asset-master");
    expect(JSON.stringify(saves)).not.toMatch(/preview/i);
    await waitFor(() => expect(screen.getByText(/Catalog saved/)).toBeTruthy());
  });

  it("tells the artist that both files are unlocked as separate experiences", async () => {
    mockStudio();
    await openStudio();
    fireEvent.click(screen.getByRole("button", { name: /02\s*Tracks/ }));
    upload("Upload full track", MASTER_FILE());
    await waitFor(() => expect(screen.getByText(/Full track stored privately/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /03\s*Experiences/ }));
    expect(screen.getByText(/Holders unlock: Forgive-Forget-master\.wav \(the full track\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What does this track unlock/i), { target: { value: "DEMO" } });
    upload("Upload experience audio", DEMO_FILE());
    await waitFor(() => expect(screen.getByText(/Holders unlock two separate experiences: stranger-demo-30s\.wav, and the full track Forgive-Forget-master\.wav/)).toBeTruthy());
  });
});
