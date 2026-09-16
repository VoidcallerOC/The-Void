import { describe, it, expect, beforeEach } from "vitest";
import { VC_AUDIO, fmt } from "./audio.js";

const released = {
  n: "01",
  title: "The Hollow",
  tokenId: 1,
  previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3",
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
