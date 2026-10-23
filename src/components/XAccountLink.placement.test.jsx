/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const studioFetch = vi.fn(async () => ({ artists: [] }));
vi.mock("../lib/studio-api.js", async (importOriginal) => ({ ...(await importOriginal()), studioFetch: (...args) => studioFetch(...args) }));
const { ArtistProfileEditPage } = await import("./ArtistProfileEditPage.jsx");
const { MyCollectionPage } = await import("./PlatformPages.jsx");
const { AppRoutes } = await import("../App.jsx");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); studioFetch.mockClear(); });

const wallet = (extra = {}) => ({ connected: false, authenticated: false, authHeaders: {}, wallets: [], ...extra });
const mount = (ui, ctx, path = "/") => render(<WalletCtx.Provider value={ctx}><MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter></WalletCtx.Provider>);

describe("X account control placement", () => {
  it("is on the artist profile edit page and visible, with its prerequisite, before the wallet is connected", () => {
    vi.stubGlobal("fetch", vi.fn());
    mount(<Routes><Route path="/studio/profile/:artistId" element={<ArtistProfileEditPage />} /></Routes>, wallet(), "/studio/profile/artist-a");
    expect(screen.getByLabelText("X account")).toBeTruthy();
    expect(screen.getByText(/Connect your wallet to link an X account/)).toBeTruthy();
  });

  it("is on the My collection page and visible, with its prerequisite, before sign-in", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
    mount(<MyCollectionPage />, wallet({ connected: true, account: "0x1111111111111111111111111111111111111111" }));
    expect(screen.getByLabelText("X account")).toBeTruthy();
    expect(screen.getByText(/Sign in with your wallet to link an X account/)).toBeTruthy();
  });

  it("shows the Connect X account control on the profile edit page for a signed-in wallet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).endsWith("/api/x-link") ? { ok: true, status: 200, json: async () => ({ data: { available: true, connected: false } }) } : { ok: true, status: 200, json: async () => ({ data: {} }) })));
    mount(<Routes><Route path="/studio/profile/:artistId" element={<ArtistProfileEditPage />} /></Routes>, wallet({ connected: true, authenticated: true, authHeaders: { authorization: "Bearer session" } }), "/studio/profile/artist-a");
    expect(await screen.findByText("Connect X account")).toBeTruthy();
  });

  it("keeps the registered /x/callback route in the app route table", () => {
    const paths = [];
    const walk = (node) => { if (!node || typeof node !== "object") return; if (node.props?.path) paths.push(node.props.path); [].concat(node.props?.children || []).forEach(walk); };
    walk(AppRoutes().props.children);
    expect(paths).toContain("x/callback");
  });
});
