/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the two Forgive & Forget full-track experiences in
// the shared player: the full record (AUDIO) and the Stranger Things demo
// (DEMO) are independent bearer streams of one token, each with its own grant,
// pause/resume without a fresh grant, renewal when a grant lapses mid-track,
// and errors reported instead of silently swapped for the public preview.

const requestProtectedMediaGrant = vi.fn();
vi.mock("./media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { VC_AUDIO, playbackErrorMessage, sameTrack } = await import("./audio.js");

const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const PREVIEW = "https://gateway.pinata.cloud/ipfs/bafybeiaoy7h6tlwy77jwy5ogaoslcdxbp5ohodmpwrbwkylfkofg67rgd4";
const fullTrack = { n: TOKEN, tokenId: TOKEN, title: "Forgive & Forget", previewSrc: PREVIEW, src: PREVIEW, preview: true, protectedMedia: { experienceId: "experience-ff-full-track", mediaType: "AUDIO" } };
const demoTrack = { ...fullTrack, protectedTitle: "Stranger Things", protectedMedia: { experienceId: "experience-ff-experience-audio", mediaType: "DEMO" } };
const grant = (id) => ({ grantId: id, accessUrl: `/api/media/${id}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });

class FakeAudio {
  constructor() { this.listeners = new Map(); this.src = ""; this.paused = true; this.currentTime = 0; this.duration = 373; this.volume = 1; this.error = null; this.loads = 0; }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  emit(name) { for (const fn of this.listeners.get(name) || []) fn(); }
  getAttribute(name) { return name === "src" ? this.src : null; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() { this.loads += 1; }
  play() { this.paused = false; this.emit("play"); return Promise.resolve(); }
  pause() { this.paused = true; this.emit("pause"); }
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio);
  VC_AUDIO.el = null;
  VC_AUDIO.queue = null;
  VC_AUDIO.setOwnership([]);
  VC_AUDIO.setMediaAuthorization({ wallet: "0x6a86efa012feda64b70112022487fee22e67d2fb", authHeaders: { authorization: "Bearer session" } });
  VC_AUDIO.mediaGrants.clear();
  VC_AUDIO.mediaRequests.clear();
  VC_AUDIO.grantedKeys.clear();
  VC_AUDIO.renewals.clear();
  VC_AUDIO.lastError = null;
  requestProtectedMediaGrant.mockReset();
});
afterEach(() => { VC_AUDIO.el = null; VC_AUDIO.setMediaAuthorization(); vi.unstubAllGlobals(); });

describe("independent full-track experiences", () => {
  it("plays each experience from its own grant and keeps the other experience's grant separate", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff", "Forgive & Forget");
    expect(VC_AUDIO.el.src).toBe("/api/media/full-1");
    expect(VC_AUDIO.isBearer(fullTrack)).toBe(true);
    expect(VC_AUDIO.isBearer(demoTrack)).toBe(false);
    expect(VC_AUDIO.srcFor(demoTrack)).toBe(PREVIEW);

    await VC_AUDIO.playGranted(demoTrack, grant("demo-1"), "token:ff", "Forgive & Forget");
    expect(VC_AUDIO.el.src).toBe("/api/media/demo-1");
    expect(VC_AUDIO.isBearer(demoTrack)).toBe(true);
    expect(VC_AUDIO.srcFor(fullTrack)).toBe("/api/media/full-1");
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("pauses and resumes a bearer stream in place without requesting a new grant", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    VC_AUDIO.el.currentTime = 120;
    VC_AUDIO.pause();
    expect(VC_AUDIO.playing).toBe(false);
    await VC_AUDIO.play();
    expect(VC_AUDIO.playing).toBe(true);
    expect(VC_AUDIO.el.src).toBe("/api/media/full-1");
    expect(VC_AUDIO.el.currentTime).toBe(120);
    expect(VC_AUDIO.el.loads).toBe(0);
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("seeks within the bearer stream", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    VC_AUDIO.seekFrac(0.5);
    expect(VC_AUDIO.el.currentTime).toBeCloseTo(186.5, 3);
    expect(VC_AUDIO.el.src).toBe("/api/media/full-1");
  });

  it("renews a lapsed grant once and resumes at the same position when the element errors", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    VC_AUDIO.el.currentTime = 301;
    VC_AUDIO.el.error = { code: 2 };
    requestProtectedMediaGrant.mockResolvedValue(grant("full-2"));
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.el.src).toBe("/api/media/full-2"));
    expect(requestProtectedMediaGrant).toHaveBeenCalledWith(expect.objectContaining({ experienceId: "experience-ff-full-track", mediaType: "AUDIO", wallet: "0x6a86efa012feda64b70112022487fee22e67d2fb" }));
    VC_AUDIO.el.emit("loadedmetadata");
    expect(VC_AUDIO.el.currentTime).toBe(301);
    expect(VC_AUDIO.el.paused).toBe(false);
    expect(VC_AUDIO.lastError).toBeNull();
    expect(VC_AUDIO.el.src).not.toBe(PREVIEW);
  });

  it("reports a renewal refusal instead of falling back to the public preview", async () => {
    await VC_AUDIO.playGranted(demoTrack, grant("demo-1"), "token:ff");
    VC_AUDIO.el.error = { code: 2 };
    requestProtectedMediaGrant.mockRejectedValue(new Error("Current confirmed ownership of the required experience entitlement is required."));
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.lastError?.message).toMatch(/entitlement/));
    expect(VC_AUDIO.el.src).toBe("/api/media/demo-1");
    expect(VC_AUDIO.srcFor(demoTrack)).toBe(PREVIEW);
  });

  it("reports a decode error for the current track and clears it when playback starts again", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    VC_AUDIO.el.error = { code: 3 };
    VC_AUDIO.grantedKeys.clear();
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.lastError).toMatchObject({ code: 3, message: playbackErrorMessage(3) }));
    expect(VC_AUDIO.lastError.track).toBe(VC_AUDIO.queue[0]);
    await VC_AUDIO.el.play();
    expect(VC_AUDIO.lastError).toBeNull();
  });

  it("treats a rebuilt track object for the same token and experience as the same playback", () => {
    expect(sameTrack(fullTrack, { ...fullTrack })).toBe(true);
    expect(sameTrack(fullTrack, demoTrack)).toBe(false);
    expect(sameTrack(fullTrack, { ...fullTrack, n: "1" })).toBe(false);
  });
});
