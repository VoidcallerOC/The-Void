import { describe, it, expect, beforeEach } from "vitest";
import { VC_AUDIO, fmt } from "./audio.js";

const released = {
  n: "01",
  title: "The Hollow",
  tokenId: 1,
  src: "/assets/audio/ep1-01-the-hollow.mp3",
  previewSrc: "/assets/audio-preview/ep1-01-the-hollow-preview.mp3",
};
const unreleased = { n: "01", title: "Warning Signs", preview: true, src: "/assets/audio-preview/ep2-01.mp3" };

describe("audio gating", () => {
  beforeEach(() => {
    VC_AUDIO.setOwnership([]); // reset to no relics owned
  });

  it("gates a released track when the wallet does not own its relic", () => {
    expect(VC_AUDIO.isGated(released)).toBe(true);
    expect(VC_AUDIO.srcFor(released)).toBe(released.previewSrc);
    expect(VC_AUDIO.isPreview(released)).toBe(true);
  });

  it("unlocks the full track once ownership is set", () => {
    VC_AUDIO.setOwnership([1]);
    expect(VC_AUDIO.isGated(released)).toBe(false);
    expect(VC_AUDIO.srcFor(released)).toBe(released.src);
    expect(VC_AUDIO.isPreview(released)).toBe(false);
  });

  it("re-locks when ownership is cleared", () => {
    VC_AUDIO.setOwnership([1]);
    VC_AUDIO.setOwnership([]);
    expect(VC_AUDIO.isGated(released)).toBe(true);
  });

  it("treats inherently preview-only tracks as preview regardless of ownership", () => {
    expect(VC_AUDIO.isGated(unreleased)).toBe(false); // no tokenId/previewSrc → not gated
    expect(VC_AUDIO.isPreview(unreleased)).toBe(true); // but flagged preview-only
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
