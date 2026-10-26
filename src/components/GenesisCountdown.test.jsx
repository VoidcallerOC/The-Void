/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenesisCountdown } from "./GenesisCountdown.jsx";
import { GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS as T } from "../lib/genesis-countdown.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("GenesisCountdown", () => {
  it("ticks from the clock and switches to the scheduled-now message at zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime((T - 2) * 1000);
    const { container } = render(<GenesisCountdown />);
    expect(container.textContent).toContain("Monday, October 26 · 9:00 AM EDT");
    expect(container.querySelectorAll(".vc-countdown-value")[3].textContent).toBe("02");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelectorAll(".vc-countdown-value")[3].textContent).toBe("01");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getAllByText("Genesis claims are scheduled to open now.").length).toBeGreaterThan(0);
    expect(container.querySelector(".vc-countdown-grid")).toBeNull();
  });

  it("catches up after a suspended tab instead of decrementing a stale counter", () => {
    vi.useFakeTimers();
    vi.setSystemTime((T - 7_200) * 1000);
    const { container } = render(<GenesisCountdown />);
    vi.setSystemTime((T - 60) * 1000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    const values = [...container.querySelectorAll(".vc-countdown-value")].map((node) => node.textContent);
    expect(values).toEqual(["0", "00", "01", "00"]);
  });

  it("shows the post-start state, never a negative countdown, when opened after the target", () => {
    vi.useFakeTimers();
    vi.setSystemTime((T + 90_000) * 1000);
    const { container } = render(<GenesisCountdown />);
    expect(container.textContent).toContain("Genesis claims are scheduled to open now.");
    expect(container.textContent).toContain("The claim status on this page confirms when claiming is actually available.");
    expect(container.textContent).not.toMatch(/-\d/);
  });
});
