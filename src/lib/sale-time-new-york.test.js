import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeSaleTimeToUnixSeconds } from "./sale-time.js";
import { buildSaleChange, formatSaleInstant, toLocalInputValue } from "./sale-editor.js";

// The Forgive & Forget Halloween launch entered by an artist in America/New_York. Studio shows and takes
// local wall-clock times (12-hour AM/PM in an en-US browser) and converts them to Unix seconds internally.
// 2026-10-23 8:00:00 PM EDT (UTC-4) = 2026-10-24T00:00:00Z.
const START = 1_792_800_000;
// 2026-10-31 11:59:59 PM EDT (UTC-4) = 2026-11-01T03:59:59Z. US DST ends 2026-11-01 at 2:00 AM local.
const END = 1_793_505_599;
const CLAIM_END = START + 86_400;
const PRICE_WEI = 250_000_000_000_000_000n;

let previousTz;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("Halloween sale times in America/New_York", () => {
  it("runs in the New York zone", () => {
    expect(new Date(START * 1000).getTimezoneOffset()).toBe(240);
    expect(new Date((END + 1 + 2 * 3600) * 1000).getTimezoneOffset()).toBe(300);
  });

  it("converts the local start and end exactly, with seconds", () => {
    expect(normalizeSaleTimeToUnixSeconds("2026-10-23T20:00")).toBe(START);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-23T20:00:00")).toBe(START);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-23 8:00pm")).toBe(START);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-23 8:00 PM")).toBe(START);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-31T23:59:59")).toBe(END);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-31 11:59:59 PM")).toBe(END);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-31 11:59:59pm")).toBe(END);
    expect(normalizeSaleTimeToUnixSeconds("2026-10-24T20:00:00")).toBe(CLAIM_END);
  });

  it("round-trips the on-chain bounds into the Studio datetime inputs", () => {
    expect(toLocalInputValue(START)).toBe("2026-10-23T20:00");
    expect(toLocalInputValue(END)).toBe("2026-10-31T23:59:59");
    expect(normalizeSaleTimeToUnixSeconds(toLocalInputValue(END))).toBe(END);
  });

  it("guards against off-by-one-second, off-by-one-day and UTC-for-local mistakes", () => {
    // The whole-minute form drops the 59 seconds; midnight is already the next day and closed.
    expect(normalizeSaleTimeToUnixSeconds("2026-10-31T23:59")).toBe(END - 59);
    expect(normalizeSaleTimeToUnixSeconds("2026-11-01T00:00")).toBe(END + 1);
    // Reading the local wall clock as UTC would end the sale four hours early.
    expect(normalizeSaleTimeToUnixSeconds("2026-10-31T23:59:59Z")).toBe(END - 4 * 3600);
    // In UTC the end falls on November 1.
    expect(new Date(END * 1000).toISOString()).toBe("2026-11-01T03:59:59.000Z");
    expect(new Date(START * 1000).toISOString()).toBe("2026-10-24T00:00:00.000Z");
    // The public window is exactly 8 days 4 hours (whole hours, inside the 7-14 day production policy).
    expect(END - START + 1).toBe(705_600);
    expect((END - START + 1) % 3600).toBe(0);
  });

  it("applies the DST change on November 1", () => {
    // The same local end one day later is in EST (UTC-5): one hour more than a plain 24 hours.
    expect(normalizeSaleTimeToUnixSeconds("2026-11-01T23:59:59") - END).toBe(86_400 + 3600);
    expect(normalizeSaleTimeToUnixSeconds("2026-11-01T03:00")).toBe(Date.UTC(2026, 10, 1, 8, 0, 0) / 1000);
  });

  it("displays the bounds in local 12-hour time alongside UTC", () => {
    expect(formatSaleInstant(START).local).toMatch(/Oct 23, 2026.*8:00\sPM/);
    expect(formatSaleInstant(END).local).toMatch(/Oct 31, 2026.*11:59:59\sPM/);
    expect(formatSaleInstant(END).utc).toMatch(/1 Nov 2026.*03:59:59 UTC/);
  });

  it("accepts exactly the claim's schedule in Studio, 3 paid per wallet, and refuses a minute-rounded end", () => {
    const claim = { state: "active", live: true, publicAllocation: 0n, publicSaleStart: BigInt(START), publicSaleEnd: BigInt(END), publicPriceWei: PRICE_WEI };
    const form = { price: "0.25", maxSupply: "0", perWalletLimit: "3", start: "2026-10-23T20:00", end: "2026-10-31T23:59:59", paused: false };
    const nowSec = START - 3600;
    const ok = buildSaleChange({ form, editionMaxSupply: 0n, claim, nowSec });
    expect(ok.errors).toEqual([]);
    expect(ok.values).toMatchObject({ priceWei: PRICE_WEI, maxSupply: 0n, perWalletLimit: 3n, startTime: BigInt(START), endTime: BigInt(END), openEdition: true });
    expect(buildSaleChange({ form: { ...form, end: "2026-10-31T23:59" }, editionMaxSupply: 0n, claim, nowSec }).errors.join(" ")).toMatch(/must open together with the claims/);
    expect(buildSaleChange({ form: { ...form, start: "2026-10-23T20:00:01" }, editionMaxSupply: 0n, claim, nowSec }).errors.join(" ")).toMatch(/must open together with the claims/);
  });
});
