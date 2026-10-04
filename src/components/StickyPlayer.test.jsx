/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StickyPlayer } from "./StickyPlayer.jsx";
import { MASTER_VOLUME_STORAGE_KEY, VC_AUDIO } from "../lib/audio.js";

beforeEach(() => {
  localStorage.clear();
  VC_AUDIO.volumePercent = null;
  VC_AUDIO.el = null;
  VC_AUDIO.playing = false;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  VC_AUDIO.volumePercent = null;
  VC_AUDIO.el = null;
  VC_AUDIO.queue = null;
  VC_AUDIO.mediaGrants.clear();
  VC_AUDIO.playing = false;
});

describe("sticky player master volume", () => {
  it("shows a 0 to 100 percent slider at an audible default and keeps play controls", () => {
    render(<StickyPlayer />);
    const slider = screen.getByRole("slider", { name: "Master volume" });
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.value).toBe("80");
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("persists the slider as a percent and reapplies it after reload", () => {
    localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, "40");
    VC_AUDIO.volumePercent = null;
    const first = render(<StickyPlayer />);
    const slider = screen.getByRole("slider", { name: "Master volume" });
    expect(slider.value).toBe("40");
    fireEvent.change(slider, { target: { value: "15" } });
    expect(localStorage.getItem(MASTER_VOLUME_STORAGE_KEY)).toBe("15");
    expect(screen.getByRole("slider", { name: "Master volume" }).value).toBe("15");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    first.unmount();

    VC_AUDIO.volumePercent = null;
    render(<StickyPlayer />);
    expect(screen.getByRole("slider", { name: "Master volume" }).value).toBe("15");
    const element = { volume: 1 };
    VC_AUDIO.el = element;
    VC_AUDIO.applyMasterVolume();
    expect(element.volume).toBe(0.15);
  });

  it("keeps volume and transport controls in a dedicated responsive row", () => {
    const { container } = render(<StickyPlayer />);
    const controls = container.querySelector(".vc-sticky-controls");

    expect(controls).toBeTruthy();
    expect(controls.querySelector('input[type="range"]')).toBeTruthy();
    expect(controls.querySelector('[aria-label="Play"]')).toBeTruthy();
    expect(controls.querySelector('[aria-label="Previous track"]')).toBeTruthy();
    expect(controls.querySelector('[aria-label="Next track"]')).toBeTruthy();
  });

  it("shows the native duration for a protected bearer track", () => {
    const track = { n: "full", title: "Stranger Things", protectedMedia: { experienceId: "experience-1", mediaType: "AUDIO" } };
    VC_AUDIO.queue = [track];
    VC_AUDIO.queueId = "protected:experience-1";
    VC_AUDIO.el = { currentTime: 5, duration: 60 };
    VC_AUDIO.mediaGrants.set("experience-1:AUDIO:full", { accessUrl: "/api/media/grant-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    render(<StickyPlayer />);

    expect(screen.getByText("00:05 / 01:00")).toBeTruthy();
    expect(screen.getByText("BEARER")).toBeTruthy();
  });
});
