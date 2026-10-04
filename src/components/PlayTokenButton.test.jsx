/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const requestProtectedMediaGrant = vi.fn();
vi.mock("../lib/media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { PlayTokenButton } = await import("./PlayTokenButton.jsx");
const { VC_AUDIO } = await import("../lib/audio.js");
window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
window.HTMLMediaElement.prototype.pause = vi.fn();
window.HTMLMediaElement.prototype.load = vi.fn();

const experience = { id: "experience-1", media: { protected: true, type: "DEMO" } };
const track = { n: "1", tokenId: "987654321", title: "Forgive & Forget", previewSrc: "/preview.mp3", src: "/preview.mp3", protectedMedia: { experienceId: experience.id, mediaType: "DEMO" } };
const holder = { connected: true, authenticated: true, account: "0xabc", authHeaders: { authorization: "Bearer s" } };
const renderWith = (wallet, props = {}) => render(<WalletCtx.Provider value={wallet}><PlayTokenButton track={track} queueId="token:1" protectedExperience={experience} {...props} /></WalletCtx.Provider>);

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

describe("shared protected token playback", () => {
  it("uses the public preview for a non-holder on the main release path", async () => {
    renderWith({ connected: false }, { protectedOnly: false });
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("/preview.mp3"));
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("requests and plays the protected grant for a Fuji holder", async () => {
    VC_AUDIO.setOwnership([track.tokenId]);
    requestProtectedMediaGrant.mockResolvedValue({ grantId: "g1", accessUrl: "/api/media/g1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    renderWith(holder);
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("/api/media/g1"));
    expect(requestProtectedMediaGrant).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xabc", experienceId: "experience-1", mediaType: "DEMO" }));
    expect(VC_AUDIO.isPreview(VC_AUDIO.queue[0])).toBe(false);
  });

  it("does not fall back to the preview for a protected experience denial", async () => {
    requestProtectedMediaGrant.mockRejectedValue(new Error("This wallet does not hold the required edition."));
    renderWith(holder, { protectedOnly: true });
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive/ }));
    await waitFor(() => expect(screen.getByText("This wallet does not hold the required edition.")).toBeTruthy());
    expect(VC_AUDIO.el).toBeNull();
  });
});
