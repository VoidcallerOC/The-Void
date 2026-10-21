/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { X_LINK_MESSAGE } from "../lib/x-link-api.js";
import { XAccountLink } from "./XAccountLink.jsx";
import { XLinkCallbackPage } from "./XLinkCallbackPage.jsx";
import { MemoryRouter } from "react-router-dom";

const signedIn = { connected: true, authenticated: true, authHeaders: { authorization: "Bearer session" } };
const linked = { available: true, connected: true, status: "CONNECTED", username: "void_fan", displayName: "Void Fan", profileUrl: "https://x.com/void_fan", verifiedAt: "2026-10-21T00:00:00.000Z" };
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status, code, message) => ({ ok: false, status, json: async () => ({ error: { code, message } }) });

let routes;
let popup;
beforeEach(() => {
  routes = {};
  popup = { closed: false, close: vi.fn(() => { popup.closed = true; }), location: { href: "" } };
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const key = `${options.method || "GET"} ${String(url).replace(/^.*\/api/, "")}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key](options);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderCard = (wallet = signedIn) => render(<WalletCtx.Provider value={wallet}><XAccountLink /></WalletCtx.Provider>);

describe("XAccountLink", () => {
  it("renders nothing and makes no request for visitors who are not signed in", async () => {
    renderCard({ connected: true, authenticated: false, authHeaders: {} });
    await act(async () => {});
    expect(screen.queryByText(/X account/)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the optional disconnected state with what will be associated", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    renderCard();
    expect(await screen.findByText("Connect X account")).toBeTruthy();
    expect(screen.getAllByText(/optional/i).length).toBeGreaterThan(1);
    expect(screen.getByText(/X user ID, username, display name and profile image link/)).toBeTruthy();
    expect(screen.getByText(/does not change your wallet, collection or marketplace access/)).toBeTruthy();
  });

  it("shows the verified username, a public profile link, status and a disconnect control", async () => {
    routes["GET /x-link"] = () => ok(linked);
    renderCard();
    const link = await screen.findByText("@void_fan");
    expect(link.closest("a").getAttribute("href")).toBe("https://x.com/void_fan");
    expect(link.closest("a").getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("Status: Connected")).toBeTruthy();
    expect(screen.getByText("Disconnect X account")).toBeTruthy();
  });

  it("disconnects with explicit confirmation payload and returns to the disconnected state", async () => {
    routes["GET /x-link"] = () => ok(linked);
    routes["POST /x-link/disconnect"] = (options) => { expect(JSON.parse(options.body)).toEqual({ confirm: true }); return ok({ available: true, connected: false }); };
    renderCard();
    fireEvent.click(await screen.findByText("Disconnect X account"));
    expect(await screen.findByText("Connect X account")).toBeTruthy();
  });

  it("connects through X's page: pending state, popup relay, session-bound callback, connected state", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    routes["POST /x-link/start"] = (options) => { expect(options.headers.authorization).toBe("Bearer session"); return ok({ authorizationUrl: "https://x.com/i/oauth2/authorize?state=s" }); };
    routes["POST /x-link/callback"] = (options) => { expect(JSON.parse(options.body)).toMatchObject({ code: "c", state: "s" }); expect(options.headers.authorization).toBe("Bearer session"); return ok(linked); };
    vi.spyOn(window, "open").mockReturnValue(popup);
    renderCard();
    fireEvent.click(await screen.findByText("Connect X account"));
    expect((await screen.findByText("Waiting for X…")).closest("button").disabled).toBe(true); // no duplicate attempts
    await waitFor(() => expect(popup.location.href).toContain("https://x.com/i/oauth2/authorize"));
    // A message from a foreign origin or another window is ignored.
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", source: popup, data: { type: X_LINK_MESSAGE, code: "bad", state: "bad" } })); });
    expect(screen.getByText("Waiting for X…")).toBeTruthy();
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: popup, data: { type: X_LINK_MESSAGE, code: "c", state: "s" } })); });
    expect(await screen.findByText("@void_fan")).toBeTruthy();
  });

  it("handles a closed X window as a cancellation without losing the session", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    routes["POST /x-link/start"] = () => ok({ authorizationUrl: "https://x.com/i/oauth2/authorize?state=s" });
    vi.spyOn(window, "open").mockReturnValue(popup);
    renderCard();
    fireEvent.click(await screen.findByText("Connect X account"));
    await screen.findByText("Waiting for X…");
    popup.closed = true;
    expect(await screen.findByText(/cancelled/i, {}, { timeout: 2500 })).toBeTruthy();
    expect(screen.getByText("Connect X account")).toBeTruthy();
  });

  it("shows a denial or failure from the server and stays disconnected", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    routes["POST /x-link/start"] = () => ok({ authorizationUrl: "https://x.com/i/oauth2/authorize?state=s" });
    routes["POST /x-link/callback"] = () => fail(409, "X_ACCOUNT_ALREADY_LINKED", "That X account is already connected to another Void account. It was not transferred.");
    vi.spyOn(window, "open").mockReturnValue(popup);
    renderCard();
    fireEvent.click(await screen.findByText("Connect X account"));
    await waitFor(() => expect(popup.location.href).not.toBe(""));
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: popup, data: { type: X_LINK_MESSAGE, code: "c", state: "s" } })); });
    expect((await screen.findByRole("alert")).textContent).toMatch(/already connected to another Void account/);
    expect(screen.getByText("Connect X account")).toBeTruthy();
  });

  it("reports a blocked pop-up and a failed start without changing state", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    vi.spyOn(window, "open").mockReturnValue(null);
    renderCard();
    fireEvent.click(await screen.findByText("Connect X account"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/blocked/);
    window.open.mockReturnValue(popup);
    routes["POST /x-link/start"] = () => fail(503, "X_LINK_NOT_CONFIGURED", "X account linking is not available right now.");
    fireEvent.click(screen.getByText("Connect X account"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not available/));
    expect(popup.close).toHaveBeenCalled();
  });

  it("says linking is unavailable when X is not configured, without blocking anything else", async () => {
    routes["GET /x-link"] = () => ok({ available: false, connected: false });
    renderCard();
    expect(await screen.findByText(/not available right now/)).toBeTruthy();
    expect(screen.queryByText("Connect X account")).toBeNull();
  });

  it("degrades to a retry when the status request fails", async () => {
    routes["GET /x-link"] = () => fail(500, "INTERNAL_ERROR", "The request could not be completed.");
    renderCard();
    expect(await screen.findByText("Retry")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("XLinkCallbackPage", () => {
  it("hands code and state to the opener, strips the URL and holds no session", async () => {
    const opener = { closed: false, postMessage: vi.fn() };
    window.opener = opener;
    window.history.replaceState(null, "", "/x/callback?code=abc&state=xyz");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<MemoryRouter><XLinkCallbackPage /></MemoryRouter>);
    await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith({ type: X_LINK_MESSAGE, code: "abc", state: "xyz", error: null }, window.location.origin));
    expect(window.location.search).toBe("");
    expect(close).toHaveBeenCalled();
    window.opener = null;
  });

  it("tells the user to start again when there is no opener", async () => {
    window.opener = null;
    window.history.replaceState(null, "", "/x/callback?code=abc&state=xyz");
    render(<MemoryRouter><XLinkCallbackPage /></MemoryRouter>);
    expect(await screen.findByText(/cannot finish the connection/)).toBeTruthy();
  });
});
