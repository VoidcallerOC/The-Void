/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const requestProtectedMediaGrant = vi.fn();
vi.mock("../lib/media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { PlayTokenButton } = await import("./PlayTokenButton.jsx");
const { StickyPlayer } = await import("./StickyPlayer.jsx");
const { VC_AUDIO } = await import("../lib/audio.js");
window.HTMLMediaElement.prototype.play = vi.fn(function play() { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
window.HTMLMediaElement.prototype.pause = vi.fn(function pause() { this.dispatchEvent(new Event("pause")); });
window.HTMLMediaElement.prototype.load = vi.fn();

const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const PREVIEW = "https://gateway.pinata.cloud/ipfs/preview";
const fullExperience = { id: "experience-ff-full-track", title: "Forgive & Forget", media: { protected: true, type: "AUDIO" } };
const demoExperience = { id: "experience-ff-experience-audio", title: "Stranger Things", media: { protected: true, type: "DEMO" } };
const trackFor = (experience) => ({ n: TOKEN, tokenId: TOKEN, title: "Forgive & Forget", previewSrc: PREVIEW, src: PREVIEW, preview: true, protectedMedia: { experienceId: experience.id, mediaType: experience.media.type }, protectedTitle: experience.title });
const holder = { connected: true, authenticated: true, account: "0x6a86efa012feda64b70112022487fee22e67d2fb", authHeaders: { authorization: "Bearer s" } };
const grant = (id) => ({ grantId: id, accessUrl: `/api/media/${id}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });

function Page({ wallet, experience, label }) {
  // Pages rebuild the track object on every render, like ExperiencePage does.
  return <WalletCtx.Provider value={wallet}><PlayTokenButton track={trackFor(experience)} protectedExperience={experience} protectedOnly queueId={`token:${TOKEN}`} label={label} /><StickyPlayer /></WalletCtx.Provider>;
}

afterEach(() => {
  cleanup();
  requestProtectedMediaGrant.mockReset();
  VC_AUDIO.mediaGrants.clear();
  VC_AUDIO.mediaRequests.clear();
  VC_AUDIO.grantedKeys.clear();
  VC_AUDIO.lastError = null;
  VC_AUDIO.setMediaAuthorization();
  VC_AUDIO.setOwnership([]);
  VC_AUDIO.queue = null;
  VC_AUDIO.el = null;
});

describe("experience page playback for a holder", () => {
  it("plays the Stranger Things demo under its own name and the full record under its own, from separate grants", async () => {
    VC_AUDIO.setMediaAuthorization({ wallet: holder.account, authHeaders: holder.authHeaders });
    requestProtectedMediaGrant.mockImplementation(async ({ mediaType }) => grant(mediaType === "DEMO" ? "demo-1" : "full-1"));
    const demo = render(<Page wallet={holder} experience={demoExperience} label="Play Stranger Things" />);
    fireEvent.click(screen.getByRole("button", { name: /Play Stranger Things/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("/api/media/demo-1"));
    expect(requestProtectedMediaGrant).toHaveBeenLastCalledWith(expect.objectContaining({ experienceId: demoExperience.id, mediaType: "DEMO" }));
    await waitFor(() => expect(screen.getByText("Stranger Things", { selector: "span" })).toBeTruthy());
    expect(screen.getByText("BEARER")).toBeTruthy();
    demo.unmount();

    render(<Page wallet={holder} experience={fullExperience} label="Play Forgive & Forget" />);
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive & Forget/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("/api/media/full-1"));
    expect(requestProtectedMediaGrant).toHaveBeenLastCalledWith(expect.objectContaining({ experienceId: fullExperience.id, mediaType: "AUDIO" }));
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(2);
    expect(VC_AUDIO.el.getAttribute("src")).not.toBe(PREVIEW);
  });

  it("shows Pause while the bearer stream plays and resumes it without a new grant", async () => {
    VC_AUDIO.setMediaAuthorization({ wallet: holder.account, authHeaders: holder.authHeaders });
    requestProtectedMediaGrant.mockResolvedValue(grant("full-1"));
    render(<Page wallet={holder} experience={fullExperience} label="Play Forgive & Forget" />);
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive & Forget/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pause Forgive/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^Pause Forgive/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Play Forgive & Forget/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Play Forgive & Forget/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pause Forgive/ })).toBeTruthy());
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(1);
    expect(window.HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  });

  it("shows the player error for a stream that stops, and never the public preview", async () => {
    VC_AUDIO.setMediaAuthorization({ wallet: holder.account, authHeaders: holder.authHeaders });
    requestProtectedMediaGrant.mockResolvedValueOnce(grant("demo-1")).mockRejectedValueOnce(new Error("Current confirmed ownership of the required experience entitlement is required."));
    render(<Page wallet={holder} experience={demoExperience} label="Play Stranger Things" />);
    fireEvent.click(screen.getByRole("button", { name: /Play Stranger Things/ }));
    await waitFor(() => expect(VC_AUDIO.el?.getAttribute("src")).toBe("/api/media/demo-1"));
    Object.defineProperty(VC_AUDIO.el, "error", { value: { code: 2 }, configurable: true });
    VC_AUDIO.el.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/entitlement/));
    expect(VC_AUDIO.el.getAttribute("src")).toBe("/api/media/demo-1");
  });

  it("refuses a non-holder on both experiences without touching the preview", async () => {
    requestProtectedMediaGrant.mockRejectedValue(new Error("Current confirmed ownership of the required experience entitlement is required."));
    for (const [experience, label] of [[demoExperience, "Play Stranger Things"], [fullExperience, "Play Forgive & Forget"]]) {
      const view = render(<Page wallet={{ ...holder, account: "0x2222222222222222222222222222222222222222" }} experience={experience} label={label} />);
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(screen.getByText(/entitlement is required/)).toBeTruthy());
      expect(VC_AUDIO.el).toBeNull();
      view.unmount();
    }
  });
});
