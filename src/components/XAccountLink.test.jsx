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
  it("explains the wallet prerequisite instead of hiding, and makes no API request, when the wallet is not connected", async () => {
    renderCard({ connected: false, authenticated: false, authHeaders: {} });
    await act(async () => {});
    expect(screen.getByLabelText("X account")).toBeTruthy();
    expect(screen.getByText(/Connect your wallet to link an X account/)).toBeTruthy();
    expect(screen.getByText(/Linking is optional/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.queryByText("Connect X account")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks a connected but unsigned wallet to sign in, shows the sign-in error, and makes no API request", async () => {
    renderCard({ connected: true, authenticated: false, authHeaders: {}, authenticationError: "Wallet signature was rejected." });
    await act(async () => {});
    expect(screen.getByText(/Sign in with your wallet to link an X account/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Wallet signature was rejected.");
    expect(screen.getByRole("button", { name: "Authenticate wallet" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for the right network when the wallet is on the wrong chain", async () => {
    renderCard({ connected: true, authenticated: false, needsNetworkSwitch: true, releaseNetworkName: "Avalanche C-Chain", authHeaders: {} });
    await act(async () => {});
    expect(screen.getByText(/Switch your wallet to Avalanche C-Chain/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("swaps the prerequisite for the connect control once the wallet is signed in", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    const view = render(<WalletCtx.Provider value={{ connected: true, authenticated: false, authHeaders: {} }}><XAccountLink /></WalletCtx.Provider>);
    expect(screen.getByText(/Sign in with your wallet/)).toBeTruthy();
    view.rerender(<WalletCtx.Provider value={signedIn}><XAccountLink /></WalletCtx.Provider>);
    expect(await screen.findByText("Connect X account")).toBeTruthy();
    expect(screen.queryByText(/Sign in with your wallet to link/)).toBeNull();
  });

  it("shows the optional disconnected state with what will be associated", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    renderCard();
    expect(await screen.findByText("Connect X account")).toBeTruthy();
    expect(screen.getAllByText(/optional/i).length).toBeGreaterThan(1);
    expect(screen.getByText(/X user ID, username, display name and profile image link/)).toBeTruthy();
    expect(screen.getByText(/does not change your wallet, collection or marketplace access/)).toBeTruthy();
  });

  it("renders the connect action as the prominent X button with a logo and disables it while pending", async () => {
    routes["GET /x-link"] = () => ok({ available: true, connected: false });
    renderCard();
    const button = (await screen.findByText("Connect X account")).closest("button");
    expect(button.className).toBe("vc-x-connect");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(button.disabled).toBe(false);
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

  describe("header variant", () => {
    const renderNav = (wallet = signedIn) => render(<WalletCtx.Provider value={wallet}><XAccountLink variant="nav" /></WalletCtx.Provider>);

    it("is always visible: before a wallet session it shows Connect X, makes no request, and starts wallet sign-in", async () => {
      const connect = vi.fn();
      const authenticate = vi.fn();
      renderNav({ connected: false, authenticated: false, authHeaders: {}, wallets: [{ provider: "p1" }], connect, authenticate });
      await act(async () => {});
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Connect X account" }));
      await waitFor(() => expect(connect).toHaveBeenCalledWith("p1"));
      cleanup();
      renderNav({ connected: true, authenticated: false, authHeaders: {}, wallets: [], connect, authenticate });
      fireEvent.click(screen.getByRole("button", { name: "Connect X account" }));
      await waitFor(() => expect(authenticate).toHaveBeenCalled());
      expect(fetch).not.toHaveBeenCalled();
    });

    it("asks the visitor to pick a wallet first when several are available", async () => {
      renderNav({ connected: false, authenticated: false, authHeaders: {}, wallets: [{ provider: "a" }, { provider: "b" }], connect: vi.fn() });
      fireEvent.click(screen.getByRole("button", { name: "Connect X account" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a wallet/);
    });

    it("stays visible, disabled, while the X status loads", async () => {
      routes["GET /x-link"] = () => new Promise(() => {});
      renderNav();
      const button = await screen.findByRole("button", { name: "Connect X account" });
      expect(button.disabled).toBe(true);
    });

    it("shows a compact Connect X button and starts the same X flow", async () => {
      routes["GET /x-link"] = () => ok({ available: true, connected: false });
      routes["POST /x-link/start"] = () => ok({ authorizationUrl: "https://x.com/i/oauth2/authorize?state=s" });
      vi.spyOn(window, "open").mockReturnValue(popup);
      renderNav();
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect X account" }).disabled).toBe(false));
      const button = screen.getByRole("button", { name: "Connect X account" });
      expect(button.className).toContain("vc-x-connect--nav");
      fireEvent.click(button);
      await waitFor(() => expect(popup.location.href).toContain("https://x.com/i/oauth2/authorize"));
      expect(screen.getByRole("button", { name: "Connect X account" }).disabled).toBe(true);
    });

    it("shows the linked @username once connected, a quiet notice when linking is unavailable, and a retry on error", async () => {
      routes["GET /x-link"] = () => ok(linked);
      renderNav();
      const chip = await screen.findByText("@void_fan");
      expect(chip.closest("a").getAttribute("href")).toBe("https://x.com/void_fan");
      cleanup();
      routes["GET /x-link"] = () => ok({ available: false, connected: false });
      renderNav();
      expect(await screen.findByText("X unavailable")).toBeTruthy();
      cleanup();
      routes["GET /x-link"] = () => fail(500, "SERVER", "boom");
      renderNav();
      const retry = await screen.findByText("X retry");
      routes["GET /x-link"] = () => ok({ available: true, connected: false });
      fireEvent.click(retry);
      expect(await screen.findByRole("button", { name: "Connect X account" })).toBeTruthy();
    });
  });
});
