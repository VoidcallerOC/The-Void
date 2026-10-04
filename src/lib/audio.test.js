import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_MASTER_VOLUME_PERCENT, MASTER_VOLUME_STORAGE_KEY, VC_AUDIO, fmt, readMasterVolumePercent } from "./audio.js";

const released = {
  n: "01",
  title: "The Hollow",
  tokenId: 1,
  previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3",
  preview: true,
  protectedMedia: { experienceId: "voidcaller-full-ep", mediaType: "AUDIO" },
};
const unreleased = { n: "01", title: "Warning Signs", preview: true, src: "/assets/audio-preview/ep2-01.mp3" };

describe("audio gating", () => {
  beforeEach(() => {
    VC_AUDIO.el = null;
    VC_AUDIO.setOwnership([]);
    VC_AUDIO.setMediaAuthorization();
    VC_AUDIO.mediaGrants.clear();
    VC_AUDIO.mediaRequests.clear();
  });

  it("uses only a public preview when the wallet has no entitlement", () => {
    expect(VC_AUDIO.isGated(released)).toBe(true);
    expect(VC_AUDIO.srcFor(released)).toBe(released.previewSrc);
    expect(VC_AUDIO.isPreview(released)).toBe(true);
  });

  it("does not expose a full URL merely because the browser reports token ownership", () => {
    VC_AUDIO.setOwnership([1]);
    expect(VC_AUDIO.isGated(released)).toBe(true);
    expect(VC_AUDIO.srcFor(released)).toBe(released.previewSrc);
    expect(VC_AUDIO.isPreview(released)).toBe(true);
  });

  it("uses a short-lived API grant only after authorization succeeds", () => {
    VC_AUDIO.setOwnership([1]);
    VC_AUDIO.mediaGrants.set("voidcaller-full-ep:AUDIO:01", { grantId: "opaque-grant", accessUrl: "/api/media/opaque-grant", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(VC_AUDIO.isGated(released)).toBe(false);
    expect(VC_AUDIO.srcFor(released)).toBe("/api/media/opaque-grant");
    expect(VC_AUDIO.isPreview(released)).toBe(false);
    expect(VC_AUDIO.isBearer(released)).toBe(true);
  });

  it("does not start the public preview while an authenticated holder grant is pending", () => {
    VC_AUDIO.setOwnership([1]);
    VC_AUDIO.setMediaAuthorization({ wallet: "0xabc", authHeaders: { authorization: "Bearer session" } });
    expect(VC_AUDIO.srcFor(released)).toBeNull();
    expect(VC_AUDIO.isPreview(released)).toBe(true);
  });

  it("keeps the public preview for a visitor without holder authorization", () => {
    expect(VC_AUDIO.srcFor(released)).toBe(released.previewSrc);
  });

  it("re-locks protected playback when grants are removed", () => {
    VC_AUDIO.setOwnership([1]);
    VC_AUDIO.mediaGrants.set("voidcaller-full-ep:AUDIO:01", { grantId: "opaque-grant", accessUrl: "/api/media/opaque-grant", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    VC_AUDIO.mediaGrants.clear();
    VC_AUDIO.setOwnership([]);
    expect(VC_AUDIO.isGated(released)).toBe(true);
  });

  it("treats inherently preview-only tracks as previews regardless of ownership", () => {
    expect(VC_AUDIO.isGated(unreleased)).toBe(false);
    expect(VC_AUDIO.isPreview(unreleased)).toBe(true);
    expect(VC_AUDIO.srcFor(unreleased)).toBe(unreleased.src);
  });
});

describe("fmt", () => {
  it("formats seconds as mm:ss", () => {
    expect(fmt(0)).toBe("00:00");
    expect(fmt(65)).toBe("01:05");
    expect(fmt(3599)).toBe("59:59");
  });
});

function fakeElement() {
  return {
    volume: 1,
    src: "",
    paused: true,
    duration: 30,
    currentTime: 0,
    preload: "",
    crossOrigin: "",
    addEventListener() {},
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    removeAttribute(name) { if (name === "src") this.src = ""; },
    load() {},
    getAttribute(name) { return name === "src" ? this.src : null; },
  };
}

describe("master volume", () => {
  let memory;

  beforeEach(() => {
    memory = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key) => (memory.has(key) ? memory.get(key) : null),
        setItem: (key, value) => { memory.set(key, String(value)); },
      },
    });
    VC_AUDIO.volumePercent = null;
    VC_AUDIO.el = fakeElement();
    VC_AUDIO.mediaGrants.clear();
    VC_AUDIO.queue = null;
  });

  afterEach(() => {
    VC_AUDIO.volumePercent = null;
    VC_AUDIO.el = null;
    VC_AUDIO.queue = null;
    VC_AUDIO.mediaGrants.clear();
    vi.unstubAllGlobals();
  });

  it("defaults to an audible 80 percent when nothing is stored", () => {
    expect(readMasterVolumePercent()).toBe(DEFAULT_MASTER_VOLUME_PERCENT);
    expect(VC_AUDIO.masterVolumePercent()).toBe(80);
    VC_AUDIO.applyMasterVolume();
    expect(VC_AUDIO.el.volume).toBe(0.8);
    expect(VC_AUDIO.el.volume).not.toBe(0);
  });

  it("persists a 0–100 percent level and restores it after a reload", () => {
    VC_AUDIO.setMasterVolumePercent(35);
    expect(memory.get(MASTER_VOLUME_STORAGE_KEY)).toBe("35");
    expect(VC_AUDIO.el.volume).toBe(0.35);
    VC_AUDIO.volumePercent = null;
    VC_AUDIO.el = fakeElement();
    expect(VC_AUDIO.masterVolumePercent()).toBe(35);
    VC_AUDIO.applyMasterVolume();
    expect(VC_AUDIO.el.volume).toBe(0.35);
  });

  it("keeps an explicit mute and clamps above 100 instead of treating the value as basis points", () => {
    VC_AUDIO.setMasterVolumePercent(0);
    expect(VC_AUDIO.masterVolumePercent()).toBe(0);
    expect(VC_AUDIO.el.volume).toBe(0);
    VC_AUDIO.setMasterVolumePercent(1000);
    expect(VC_AUDIO.masterVolumePercent()).toBe(100);
    expect(VC_AUDIO.el.volume).toBe(1);
    expect(memory.get(MASTER_VOLUME_STORAGE_KEY)).toBe("100");
  });

  it("ignores a corrupt stored value and stays audible", () => {
    memory.set(MASTER_VOLUME_STORAGE_KEY, "nope");
    expect(readMasterVolumePercent()).toBe(80);
    expect(VC_AUDIO.masterVolumePercent()).toBe(80);
  });

  it("uses the same master level for a preview source and a full-track source", () => {
    VC_AUDIO.setMasterVolumePercent(55);
    VC_AUDIO.setQueue([unreleased], "preview-q");
    VC_AUDIO.setTrack(0);
    expect(VC_AUDIO.isPreview(unreleased)).toBe(true);
    expect(VC_AUDIO.el.src).toBe(unreleased.src);
    expect(VC_AUDIO.el.volume).toBe(0.55);

    VC_AUDIO.mediaGrants.set("voidcaller-full-ep:AUDIO:01", {
      grantId: "opaque-grant",
      accessUrl: "/api/media/opaque-grant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    VC_AUDIO.setQueue([released], "full-q");
    VC_AUDIO.setTrack(0);
    expect(VC_AUDIO.isPreview(released)).toBe(false);
    expect(VC_AUDIO.el.src).toBe("/api/media/opaque-grant");
    expect(VC_AUDIO.el.volume).toBe(0.55);
  });
});
