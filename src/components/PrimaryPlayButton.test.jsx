/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { primaryPlayback } from "../domain/models.js";

// The unavailable-primary control is the real PlayTokenButton, so a verified holder clicking it is the
// strongest check that it cannot ask the gateway for a protected grant.
const requestProtectedMediaGrant = vi.fn();
vi.mock("../lib/media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { PrimaryPlayButton } = await import("./PrimaryPlayButton.jsx");
const { VC_AUDIO } = await import("../lib/audio.js");
window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
window.HTMLMediaElement.prototype.pause = vi.fn();
window.HTMLMediaElement.prototype.load = vi.fn();

const gated = { protected: true, type: "AUDIO" };
const full = { id: "full", primary: true, media: gated };
const demo = { id: "demo", primary: false, media: { protected: true, type: "DEMO" } };
const token = { id: "tok", tokenId: "987654321", editionId: "e1", name: "Forgive & Forget", metadata: { name: "Forgive & Forget", animationUrl: "https://example.test/preview.mp3" } };
const holder = { connected: true, authenticated: true, account: "0xabc", authHeaders: { authorization: "Bearer s" } };
const show = (experiences, props = {}) => render(<WalletCtx.Provider value={holder}><PrimaryPlayButton token={token} playback={primaryPlayback(experiences)} queueId="token:tok" {...props} /></WalletCtx.Provider>);

afterEach(() => {
  cleanup();
  requestProtectedMediaGrant.mockReset();
  VC_AUDIO.mediaGrants.clear();
  VC_AUDIO.mediaRequests.clear();
  VC_AUDIO.setMediaAuthorization();
  VC_AUDIO.setOwnership([]);
  VC_AUDIO.queue = null;
  VC_AUDIO.el = null;
});

describe.each([
  ["missing", [demo]],
  ["invalid", [{ ...full, primary: "true" }, demo]],
  ["ambiguous", [full, { ...demo, primary: true }]],
])("%s primary", (state, experiences) => {
  it("offers only the labelled public preview and never requests a protected grant, even for a holder", async () => {
    VC_AUDIO.setOwnership([token.tokenId]);
    show(experiences, { primary: true });
    expect(screen.queryByRole("button", { name: /^Play Forgive/ })).toBeNull(); // no plain "Play"
    expect(screen.getByText("Full track unavailable").getAttribute("data-primary-state")).toBe(state);
    fireEvent.click(screen.getByRole("button", { name: /Play public preview Forgive/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("https://example.test/preview.mp3"));
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
    expect(VC_AUDIO.queue[0].protectedMedia).toBeUndefined();
  });
});

describe("resolved primary", () => {
  it("keeps the plain Play and the protected grant for a holder (designated)", async () => {
    VC_AUDIO.setOwnership([token.tokenId]);
    requestProtectedMediaGrant.mockResolvedValue({ grantId: "g1", accessUrl: "/api/media/g1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    show([demo, full]);
    expect(screen.queryByText("Full track unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^▶ Play Forgive|^Play Forgive/ }));
    await waitFor(() => expect(requestProtectedMediaGrant).toHaveBeenCalledWith(expect.objectContaining({ experienceId: "full", mediaType: "AUDIO" })));
  });

  it("keeps the legacy first-listed experience when nothing is designated", () => {
    show([{ id: "a", media: gated }, { id: "b", media: gated }]);
    expect(screen.queryByText("Full track unavailable")).toBeNull();
    expect(screen.getByRole("button", { name: /^Play Forgive/ })).toBeTruthy();
  });
});
