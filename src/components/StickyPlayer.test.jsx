/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("sticky player seek accessibility", () => {
  it("exposes a labeled Seek slider with valuetext and keyboard-driven seeking", () => {
    const track = { n: "1", title: "Stranger Things", time: "03:00" };
    VC_AUDIO.queue = [track];
    VC_AUDIO.queueId = "self-titled";
    const element = { currentTime: 15, duration: 60 };
    VC_AUDIO.el = element;
    const seekFrac = vi.spyOn(VC_AUDIO, "seekFrac");

    render(<StickyPlayer />);

    const seek = screen.getByRole("slider", { name: "Seek" });
    expect(seek.getAttribute("aria-valuetext")).toBe("00:15 of 01:00");
    expect(seek.min).toBe("0");
    expect(seek.max).toBe("1000");
    expect(Number(seek.value)).toBe(250);

    fireEvent.change(seek, { target: { value: "500" } });
    expect(seekFrac).toHaveBeenCalledWith(0.5);
  });

  it("keeps Play transport controls alongside the Seek slider", () => {
    VC_AUDIO.el = { currentTime: 0, duration: 120 };
    render(<StickyPlayer />);
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Master volume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });
});

describe("sticky player tap-to-play and audio diagnostics", () => {
  afterEach(() => { VC_AUDIO.needsGesture = false; VC_AUDIO.lastError = null; VC_AUDIO.setDiagnosticsEnabled(false); vi.unstubAllGlobals(); });

  it("shows a tap-to-play state after a NotAllowedError instead of failing silently", () => {
    const track = { n: "1", title: "Song", time: "03:00" };
    VC_AUDIO.queue = [track];
    VC_AUDIO.needsGesture = true;
    VC_AUDIO.lastError = { track, code: null, kind: "gesture", message: "Tap play to start playback." };
    const play = vi.spyOn(VC_AUDIO, "play").mockResolvedValue();
    render(<StickyPlayer />);
    const tap = screen.getByRole("button", { name: "Tap to play" });
    expect(tap.getAttribute("data-state")).toBe("tap-to-play");
    fireEvent.click(tap);
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });

  it("hides the diagnostics panel by default", () => {
    render(<StickyPlayer />);
    expect(screen.queryByRole("region", { name: "Audio diagnostics" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy diagnostics" })).toBeNull();
  });

  it("copies sanitized diagnostics with navigator.clipboard when enabled", async () => {
    VC_AUDIO.setDiagnosticsEnabled(true);
    VC_AUDIO.record("play-attempt", { category: "preview", host: "gateway.example" });
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<StickyPlayer />);
    expect(screen.getByRole("region", { name: "Audio diagnostics" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await screen.findByText("Copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("gateway.example"));
    const copied = writeText.mock.calls[0][0];
    expect(copied).not.toMatch(/userAgent/i);
    expect(copied).not.toContain(navigator.userAgent);
  });

  it("falls back to a textarea copy when the clipboard API is unavailable", async () => {
    VC_AUDIO.setDiagnosticsEnabled(true);
    vi.stubGlobal("navigator", { userAgent: "test" });
    document.execCommand = vi.fn().mockReturnValue(true);
    render(<StickyPlayer />);
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await screen.findByText("Copied");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
