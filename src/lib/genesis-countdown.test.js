import { describe, expect, it } from "vitest";
import { GENESIS_CLAIM_COUNTDOWN_LABEL, GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS, GENESIS_CLAIM_COUNTDOWN_TIME_ZONE, countdownParts } from "./genesis-countdown.js";

const T = GENESIS_CLAIM_COUNTDOWN_TARGET_SECONDS;

describe("Genesis claim countdown target", () => {
  it("is Monday, October 26, 2026 at 9:00:00 AM EDT", () => {
    expect(T).toBe(1793019600);
    expect(new Date(T * 1000).toISOString()).toBe("2026-10-26T13:00:00.000Z");
    const ny = new Intl.DateTimeFormat("en-US", { timeZone: GENESIS_CLAIM_COUNTDOWN_TIME_ZONE, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(T * 1000));
    expect(ny).toBe("Monday, October 26, 2026 at 9:00:00 AM EDT");
    expect(GENESIS_CLAIM_COUNTDOWN_LABEL).toBe("Monday, October 26 · 9:00 AM EDT");
  });
});

describe("countdownParts", () => {
  it("splits the remaining time from the absolute target", () => {
    const now = (T - (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)) * 1000;
    expect(countdownParts(T, now)).toEqual({ done: false, totalSeconds: 183_845, days: 2, hours: 3, minutes: 4, seconds: 5 });
  });

  it("rounds a partial second up so it never shows zero early", () => {
    expect(countdownParts(T, (T - 0.4) * 1000)).toMatchObject({ done: false, seconds: 1 });
  });

  it("reaches zero exactly at the target", () => {
    expect(countdownParts(T, T * 1000)).toEqual({ done: true, totalSeconds: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
  });

  it("never goes negative or resets after the target", () => {
    for (const later of [1, 3_600, 400 * 86_400]) {
      expect(countdownParts(T, (T + later) * 1000)).toEqual({ done: true, totalSeconds: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
    }
  });
});
