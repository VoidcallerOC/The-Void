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

describe("retry, source identity, stale grants, and diagnostics", () => {
  const WALLET = "0x6a86efa012feda64b70112022487fee22e67d2fb";
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  afterEach(() => { VC_AUDIO.setDiagnosticsEnabled(false); vi.useRealTimers(); });

  it("resets and reloads the element when retrying a failed source instead of reusing it", async () => {
    const track = { n: "p1", title: "Public", src: "https://a.example/audio/song.mp3" };
    VC_AUDIO.setQueue([track], "retry-q");
    await VC_AUDIO.play(0);
    const el = VC_AUDIO.el;
    const loadsBefore = el.loads;
    el.error = { code: 2 };
    const removed = vi.spyOn(el, "removeAttribute");
    await VC_AUDIO.play(0);
    expect(removed).toHaveBeenCalledWith("src");
    expect(el.loads).toBe(loadsBefore + 1);
    expect(el.src).toBe(track.src);
  });

  it("reuses a healthy element on the same source without reloading", async () => {
    const track = { n: "p1", title: "Public", src: "https://a.example/audio/song.mp3" };
    VC_AUDIO.setQueue([track], "reuse-q");
    await VC_AUDIO.play(0);
    const loads = VC_AUDIO.el.loads;
    await VC_AUDIO.play(0);
    expect(VC_AUDIO.el.loads).toBe(loads);
  });

  it("treats the same filename on different hosts as different sources", async () => {
    const { sameSource, sourceIdentity } = await import("./audio.js");
    expect(sameSource("https://a.example/ipfs/x/song.mp3", "https://b.example/ipfs/x/song.mp3")).toBe(false);
    expect(sameSource("https://a.example/one/song.mp3", "https://a.example/two/song.mp3")).toBe(false);
    expect(sameSource("https://a.example/one/song.mp3?sig=1", "https://a.example/one/song.mp3?sig=2")).toBe(true);
    expect(sourceIdentity("https://a.example/one/song.mp3?sig=1")).toBe("https://a.example/one/song.mp3");

    const first = { n: "a", title: "A", src: "https://a.example/ipfs/x/song.mp3" };
    const second = { n: "b", title: "B", src: "https://b.example/ipfs/x/song.mp3" };
    VC_AUDIO.setQueue([first, second], "hosts-q");
    await VC_AUDIO.play(0);
    await VC_AUDIO.play(1);
    expect(VC_AUDIO.el.src).toBe(second.src);
  });

  it("does not request a protected grant when the public preview errors", async () => {
    VC_AUDIO.grantedKeys.add(`${fullTrack.protectedMedia.experienceId}:AUDIO:${fullTrack.n}`);
    VC_AUDIO.setMediaAuthorization({ wallet: WALLET, authHeaders: {} });
    VC_AUDIO.setQueue([fullTrack], "preview-q");
    VC_AUDIO.ensure();
    VC_AUDIO.el.src = PREVIEW;
    VC_AUDIO.el.error = { code: 4 };
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.lastError).toMatchObject({ code: 4, kind: "media" }));
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("bounds protected renewal on repeated errors and does not loop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    let n = 1;
    requestProtectedMediaGrant.mockImplementation(async () => grant(`full-${++n}`));
    for (let i = 0; i < 6; i += 1) {
      vi.setSystemTime(Date.now() + 11_000);
      VC_AUDIO.el.error = { code: 2 };
      VC_AUDIO.el.emit("error");
      await vi.waitFor(() => expect(VC_AUDIO.mediaRequests.size).toBe(0));
      await Promise.resolve();
    }
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(VC_AUDIO.maxRenewalAttempts);
    await vi.waitFor(() => expect(VC_AUDIO.lastError).toMatchObject({ code: 2, kind: "media" }));
  });

  it("stays capped at two renewals when metadata loads between repeated errors", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    let n = 1;
    requestProtectedMediaGrant.mockImplementation(async () => grant(`full-${++n}`));
    for (let i = 0; i < 6; i += 1) {
      vi.setSystemTime(Date.now() + 11_000);
      VC_AUDIO.el.emit("loadedmetadata");
      VC_AUDIO.el.error = { code: 2 };
      VC_AUDIO.el.emit("error");
      await vi.waitFor(() => expect(VC_AUDIO.mediaRequests.size).toBe(0));
      await Promise.resolve();
    }
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(2);
  });

  it("gives a new explicit play attempt a fresh renewal budget, still capped at two", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    let n = 1;
    requestProtectedMediaGrant.mockImplementation(async () => grant(`full-${++n}`));
    const failRepeatedly = async (times) => {
      for (let i = 0; i < times; i += 1) {
        vi.setSystemTime(Date.now() + 11_000);
        VC_AUDIO.el.error = { code: 2 };
        VC_AUDIO.el.emit("error");
        await vi.waitFor(() => expect(VC_AUDIO.mediaRequests.size).toBe(0));
        await Promise.resolve();
      }
    };
    await failRepeatedly(4);
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(2);
    VC_AUDIO.el.error = null;
    await VC_AUDIO.play();
    await failRepeatedly(4);
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(4);
  });

  it("keeps the 10 second throttle between renewals", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    requestProtectedMediaGrant.mockResolvedValue(grant("full-2"));
    VC_AUDIO.el.error = { code: 2 };
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.el.src).toBe("/api/media/full-2"));
    VC_AUDIO.el.error = { code: 2 };
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.lastError).toMatchObject({ code: 2 }));
    expect(requestProtectedMediaGrant).toHaveBeenCalledTimes(1);
  });

  it("ignores a grant that arrives after the track changed", async () => {
    VC_AUDIO.grantedKeys.add(`${fullTrack.protectedMedia.experienceId}:AUDIO:${fullTrack.n}`);
    const pending = deferred();
    requestProtectedMediaGrant.mockReturnValue(pending.promise);
    const other = { n: "other", title: "Other", src: "https://a.example/other.mp3" };
    VC_AUDIO.setQueue([fullTrack, other], "late-q");
    const started = VC_AUDIO.play(0);
    await VC_AUDIO.play(1);
    pending.resolve(grant("late-1"));
    await started;
    await Promise.resolve();
    expect(VC_AUDIO.idx).toBe(1);
    expect(VC_AUDIO.el.src).toBe(other.src);
  });

  it("ignores a grant that arrives after the wallet changed", async () => {
    VC_AUDIO.grantedKeys.add(`${fullTrack.protectedMedia.experienceId}:AUDIO:${fullTrack.n}`);
    const pending = deferred();
    requestProtectedMediaGrant.mockReturnValue(pending.promise);
    VC_AUDIO.setQueue([fullTrack], "wallet-q");
    const started = VC_AUDIO.play(0);
    VC_AUDIO.setMediaAuthorization({ wallet: "0x1111111111111111111111111111111111111111", authHeaders: {} });
    pending.resolve(grant("old-wallet-grant"));
    await started;
    expect(VC_AUDIO.mediaGrants.size).toBe(0);
    expect(VC_AUDIO.isBearer(fullTrack)).toBe(false);
    expect(VC_AUDIO.el?.src || "").not.toContain("old-wallet-grant");
  });

  it("distinguishes a NotAllowedError (needs a tap) from a media decode error", async () => {
    await VC_AUDIO.playGranted(fullTrack, grant("full-1"), "token:ff");
    VC_AUDIO.el.play = () => Promise.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }));
    await expect(VC_AUDIO.play()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(VC_AUDIO.needsGesture).toBe(true);
    expect(VC_AUDIO.lastError).toMatchObject({ kind: "gesture", code: null });

    VC_AUDIO.el.play = FakeAudio.prototype.play;
    await VC_AUDIO.play();
    expect(VC_AUDIO.needsGesture).toBe(false);
    VC_AUDIO.grantedKeys.clear();
    VC_AUDIO.el.error = { code: 3 };
    VC_AUDIO.el.emit("error");
    await vi.waitFor(() => expect(VC_AUDIO.lastError).toMatchObject({ kind: "media", code: 3 }));
    expect(VC_AUDIO.needsGesture).toBe(false);
  });

  it("records nothing by default and, when enabled, keeps a bounded ring without URLs, wallets, or grant IDs", async () => {
    VC_AUDIO.diagnostics.events = [];
    VC_AUDIO.diagnostics.enabled = false;
    await VC_AUDIO.playGranted(fullTrack, { ...grant("secret-grant-id"), accessUrl: "https://api.example/api/media/secret-grant-id?token=abc" }, "token:ff");
    expect(VC_AUDIO.diagnostics.events).toHaveLength(0);

    VC_AUDIO.setDiagnosticsEnabled(true);
    VC_AUDIO.el.error = { code: 3 };
    VC_AUDIO.grantedKeys.clear();
    VC_AUDIO.el.emit("error");
    VC_AUDIO.el.emit("stalled");
    VC_AUDIO.record("play-rejected", { name: WALLET, host: "https://evil/path?q=1" });
    for (let i = 0; i < 150; i += 1) VC_AUDIO.el.emit("emptied");
    const { AUDIO_DEBUG_LIMIT, audioDebugRequested } = await import("./audio.js");
    expect(VC_AUDIO.diagnostics.events.length).toBe(AUDIO_DEBUG_LIMIT);
    const text = VC_AUDIO.diagnosticsText();
    expect(JSON.parse(text)).toEqual({ events: expect.any(Array) });
    expect(text).not.toMatch(/userAgent/i);
    expect(text).not.toContain(navigator.userAgent);
    for (const secret of ["secret-grant-id", "token=abc", "/api/media", WALLET, "6a86efa", "evil", "experience-ff"]) expect(text).not.toContain(secret);
    expect(audioDebugRequested("?audioDebug=1")).toBe(true);
    expect(audioDebugRequested("")).toBe(false);
    expect(audioDebugRequested("?audioDebug=true")).toBe(false);
  });

  it("records source category and hostname only", async () => {
    VC_AUDIO.setDiagnosticsEnabled(true);
    await VC_AUDIO.playGranted(fullTrack, { ...grant("g-9"), accessUrl: "https://api.example/api/media/g-9" }, "token:ff");
    const select = VC_AUDIO.diagnostics.events.find((e) => e.type === "source-select");
    expect(select).toMatchObject({ category: "protected", host: "api.example", reused: false });
    expect(Object.keys(select).sort()).toEqual(expect.arrayContaining(["t", "type", "category", "host"]));
  });
});
