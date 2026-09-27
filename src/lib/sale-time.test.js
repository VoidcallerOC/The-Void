import { describe, expect, it } from "vitest";
import { SALE_TIME_UNSET, normalizeSaleTimeToUnixSeconds } from "./sale-time.js";

// Fixed reference instant: 2026-09-27 (local). Bare clock times resolve
// against this day, so tests compute the expected seconds with the same
// local-time construction the helper uses and never hardcode a zone.
const NOW = new Date(2026, 8, 27, 9, 30, 0, 0).getTime();
const secondsForToday = (hour, minute = 0) =>
  Math.floor(new Date(2026, 8, 27, hour, minute, 0, 0).getTime() / 1000);

describe("normalizeSaleTimeToUnixSeconds", () => {
  it("reproduces the production bug input and converts 6:00am to today's 6am in seconds", () => {
    // Regression for: "Cannot convert 6:00am to a BigInt".
    const seconds = normalizeSaleTimeToUnixSeconds("6:00am", { now: NOW });
    expect(seconds).toBe(secondsForToday(6, 0));
    expect(Number.isInteger(seconds)).toBe(true);
    // The whole point: BigInt() must accept the normalized value.
    expect(() => BigInt(seconds)).not.toThrow();
    expect(BigInt(seconds)).toBe(BigInt(secondsForToday(6, 0)));
  });

  it("handles the 12am / 12pm midnight and noon boundaries", () => {
    expect(normalizeSaleTimeToUnixSeconds("12:00am", { now: NOW })).toBe(secondsForToday(0, 0));
    expect(normalizeSaleTimeToUnixSeconds("12:00pm", { now: NOW })).toBe(secondsForToday(12, 0));
    expect(normalizeSaleTimeToUnixSeconds("12am", { now: NOW })).toBe(secondsForToday(0, 0));
    expect(normalizeSaleTimeToUnixSeconds("12pm", { now: NOW })).toBe(secondsForToday(12, 0));
  });

  it("parses assorted am/pm and 24-hour clock forms", () => {
    expect(normalizeSaleTimeToUnixSeconds("6am", { now: NOW })).toBe(secondsForToday(6, 0));
    expect(normalizeSaleTimeToUnixSeconds("6:30pm", { now: NOW })).toBe(secondsForToday(18, 30));
    expect(normalizeSaleTimeToUnixSeconds("6:00 AM", { now: NOW })).toBe(secondsForToday(6, 0));
    expect(normalizeSaleTimeToUnixSeconds("6:00 p.m.", { now: NOW })).toBe(secondsForToday(18, 0));
    expect(normalizeSaleTimeToUnixSeconds("18:30", { now: NOW })).toBe(secondsForToday(18, 30));
    expect(normalizeSaleTimeToUnixSeconds("11:59pm", { now: NOW })).toBe(secondsForToday(23, 59));
  });

  it("combines an explicit calendar date with a 12-hour clock time", () => {
    expect(normalizeSaleTimeToUnixSeconds("2026-09-27 6:00am", { now: NOW })).toBe(secondsForToday(6, 0));
  });

  it("passes through values that are already Unix seconds unchanged", () => {
    expect(normalizeSaleTimeToUnixSeconds("1790000000")).toBe(1790000000);
    expect(normalizeSaleTimeToUnixSeconds(1790000000)).toBe(1790000000);
    expect(normalizeSaleTimeToUnixSeconds(1790000000n)).toBe(1790000000);
    expect(normalizeSaleTimeToUnixSeconds(1790000000.9)).toBe(1790000000);
  });

  it("treats empty, null, undefined, and zero as unset (0)", () => {
    expect(normalizeSaleTimeToUnixSeconds("")).toBe(SALE_TIME_UNSET);
    expect(normalizeSaleTimeToUnixSeconds("   ")).toBe(SALE_TIME_UNSET);
    expect(normalizeSaleTimeToUnixSeconds(null)).toBe(SALE_TIME_UNSET);
    expect(normalizeSaleTimeToUnixSeconds(undefined)).toBe(SALE_TIME_UNSET);
    expect(normalizeSaleTimeToUnixSeconds(0)).toBe(0);
  });

  it("parses ISO 8601 / datetime-local strings to seconds", () => {
    expect(normalizeSaleTimeToUnixSeconds("2026-09-27T06:00:00Z")).toBe(Math.floor(Date.parse("2026-09-27T06:00:00Z") / 1000));
    // datetime-local (no zone) is interpreted in local time, like the picker.
    expect(normalizeSaleTimeToUnixSeconds("2026-09-27T06:00")).toBe(secondsForToday(6, 0));
  });

  it("rejects garbage cleanly instead of letting it reach BigInt", () => {
    for (const bad of ["6:00xm", "not-a-time", "25:00", "13:00pm", "6:99am", "tomorrow"]) {
      expect(() => normalizeSaleTimeToUnixSeconds(bad)).toThrow(/valid sale time/);
    }
    expect(() => normalizeSaleTimeToUnixSeconds(-5)).toThrow(/valid sale time/);
  });
});
