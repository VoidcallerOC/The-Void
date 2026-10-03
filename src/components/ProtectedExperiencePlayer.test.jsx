/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const requestProtectedMediaGrant = vi.fn();
vi.mock("../lib/media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { ProtectedExperiencePlayer } = await import("./ProtectedExperiencePlayer.jsx");
const { VC_AUDIO } = await import("../lib/audio.js");
window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
window.HTMLMediaElement.prototype.pause = vi.fn();
window.HTMLMediaElement.prototype.load = vi.fn();

const experience = { id: "experience-1" };
const holder = { connected: true, authenticated: true, account: "0xabc", authHeaders: { authorization: "Bearer s" } };
const renderWith = (wallet) => render(<WalletCtx.Provider value={wallet}><ProtectedExperiencePlayer experience={experience} title="Forgive & Forget" collection="Forgive & Forget" /></WalletCtx.Provider>);

afterEach(() => { cleanup(); requestProtectedMediaGrant.mockReset(); VC_AUDIO.mediaGrants.clear(); VC_AUDIO.queueId = "tunnel-vision"; });

describe("protected experience player", () => {
  it("asks a visitor without a wallet to connect and requests nothing", () => {
    renderWith({ connected: false });
    expect(screen.getByText(/Connect the wallet that holds this edition/)).toBeTruthy();
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("plays the grant the gateway issues to a holder in the shared bottom player, not a second one", async () => {
    requestProtectedMediaGrant.mockResolvedValue({ grantId: "g1", accessUrl: "https://api.example/api/media/g1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const { container } = renderWith(holder);
    fireEvent.click(screen.getByText("Unlock & play"));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("https://api.example/api/media/g1"));
    expect(container.querySelector("audio")).toBeNull();
    expect(VC_AUDIO.queueId).toBe("protected:experience-1");
    expect(VC_AUDIO.queue[0]).toMatchObject({ title: "Forgive & Forget" });
    expect(VC_AUDIO.isPreview(VC_AUDIO.queue[0])).toBe(false);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(requestProtectedMediaGrant).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xabc", experienceId: "experience-1", mediaType: "AUDIO" }));
  });

  it("shows the gateway's refusal to a non-holder and plays nothing", async () => {
    requestProtectedMediaGrant.mockRejectedValue(new Error("This wallet does not hold the required edition."));
    const { container } = renderWith(holder);
    fireEvent.click(screen.getByText("Unlock & play"));
    await waitFor(() => expect(screen.getByText("This wallet does not hold the required edition.")).toBeTruthy());
    expect(container.querySelector("audio")).toBeNull();
  });
});
