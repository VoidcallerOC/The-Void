import { describe, expect, it } from "vitest";
import { buildSaleChange, claimGuardErrors, describeSaleWindow, formatDuration, saleStatus, saleWindowWarning, toLocalInputValue } from "./sale-editor.js";

const NOW = 1_791_660_000; // 2026-10-10T19:20:00Z
const sale = (overrides = {}) => ({ priceWei: 10n ** 16n, maxSupply: 0n, sold: 0n, perWalletLimit: 1n, startTime: 0n, endTime: 0n, paused: false, configured: true, ...overrides });
const form = (overrides = {}) => ({ price: "0.01", maxSupply: "", perWalletLimit: "1", start: "", end: String(NOW + 3600), paused: false, ...overrides });

describe("sale editor", () => {
  it("derives upcoming / live / ended from the on-chain window and cap", () => {
    expect(saleStatus(null, NOW)).toBe("not-configured");
    expect(saleStatus(sale({ startTime: BigInt(NOW + 60) }), NOW)).toBe("upcoming");
    expect(saleStatus(sale({ endTime: BigInt(NOW + 60) }), NOW)).toBe("live");
    expect(saleStatus(sale({ endTime: BigInt(NOW - 60) }), NOW)).toBe("ended");
    expect(saleStatus(sale({ maxSupply: 5n, sold: 5n }), NOW)).toBe("ended");
  });

  it("describes the window and flags windows under an hour", () => {
    expect(describeSaleWindow({ startTime: 0n, endTime: BigInt(NOW + 3600), nowSec: NOW })).toMatch(/^Sale runs for 1 hour: now → .+ your time \(now → 20:20 UTC\)\.$/);
    expect(formatDuration(432_000)).toBe("5 days");
    expect(formatDuration(5400)).toBe("1 hour 30 minutes");
    expect(saleWindowWarning({ startTime: BigInt(NOW), endTime: BigInt(NOW + 300), nowSec: NOW })).toBe("Short window: the sale is open for only 5 minutes.");
    expect(saleWindowWarning({ startTime: 0n, endTime: BigInt(NOW + 3600), nowSec: NOW })).toBe("");
  });

  it("applies the contract's per-wallet rules for capped and open editions", () => {
    expect(buildSaleChange({ form: form({ maxSupply: "10", perWalletLimit: "" }), editionMaxSupply: 25n, nowSec: NOW }).errors).toContain("Per-wallet limit must be between 1 and the sale cap.");
    expect(buildSaleChange({ form: form({ maxSupply: "30", perWalletLimit: "1" }), editionMaxSupply: 25n, nowSec: NOW }).errors).toContain("Sale cap exceeds the edition supply of 25.");
    expect(buildSaleChange({ form: form({ maxSupply: "2", perWalletLimit: "3" }), editionMaxSupply: 0n, nowSec: NOW }).errors).toContain("Per-wallet limit can't be more than the sale cap.");
    const { values, errors } = buildSaleChange({ form: form({ perWalletLimit: "" }), editionMaxSupply: 0n, nowSec: NOW });
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ priceWei: 10n ** 16n, maxSupply: 0n, perWalletLimit: 0n, startTime: 0n, endTime: BigInt(NOW + 3600), paused: false });
  });

  it("requires a future end to sell, but lets an ended sale be paused", () => {
    const ended = form({ end: String(NOW - 60) });
    expect(buildSaleChange({ form: ended, editionMaxSupply: 0n, nowSec: NOW }).errors).toContain("The end time has already passed. Pick a future end time to reopen the sale.");
    expect(buildSaleChange({ form: { ...ended, paused: true }, editionMaxSupply: 0n, nowSec: NOW }).errors).toEqual([]);
  });

  it("enforces Genesis claim invariants only while they apply", () => {
    const claimEnd = BigInt(NOW + 86_400);
    const publicSaleEnd = claimEnd + 7n * 86_400n - 1n;
    const claim = { state: "active", publicAllocation: 0n, claimEnd, publicSaleEnd, publicPriceWei: 25n * 10n ** 16n, live: true };
    const values = { maxSupply: 0n, startTime: claimEnd, endTime: publicSaleEnd, priceWei: 25n * 10n ** 16n };
    expect(claimGuardErrors(values, claim)).toEqual([]);
    expect(claimGuardErrors({ ...values, maxSupply: 50n }, claim)[0]).toMatch(/must stay uncapped/);
    expect(claimGuardErrors({ ...values, maxSupply: 0n }, { ...claim, publicAllocation: 20n })[0]).toMatch(/sale cap must stay 20/);
    expect(claimGuardErrors({ ...values, startTime: 0n }, claim)[0]).toMatch(/must open exactly when they close/);
    expect(claimGuardErrors({ ...values, endTime: publicSaleEnd + 1n }, claim)[0]).toMatch(/must open exactly when they close/);
    expect(claimGuardErrors({ ...values, priceWei: 1n }, claim)[0]).toMatch(/public price can't change/);
    expect(claimGuardErrors({ ...values, startTime: 0n, priceWei: 1n }, { ...claim, live: false })).toEqual([]);
    expect(claimGuardErrors(values, { state: "unknown", message: "offline" })[0]).toMatch(/could not be checked: offline/);
    expect(claimGuardErrors(values, { state: "none" })).toEqual([]);
  });

  // Genesis open edition schedule: claim window, then a public window of T+300 → T+899.
  // 300 and 899 are not both multiples of 60, so a minute-resolution input cannot express it.
  describe("second-precision schedule (Genesis open edition)", () => {
    const T = NOW + 3600 + 1; // not minute aligned on purpose
    const open = (overrides = {}) => form({ price: "0.01", maxSupply: "", perWalletLimit: "", start: toLocalInputValue(T + 300), end: toLocalInputValue(T + 899), ...overrides });

    it("round-trips whole seconds through the datetime-local value", () => {
      // 300 and 899 differ by 599, which is not a multiple of 60: at most one bound can sit on a whole minute.
      expect([T + 300, T + 899].filter((bound) => bound % 60 !== 0).length).toBeGreaterThan(0);
      expect(toLocalInputValue(T + 300)).toMatch(/T\d{2}:\d{2}:01$/);
      expect(toLocalInputValue(NOW)).toMatch(/T\d{2}:\d{2}$/); // minute-aligned values keep the short form
      expect(buildSaleChange({ form: open(), editionMaxSupply: 0n, nowSec: NOW }).values).toMatchObject({ startTime: BigInt(T + 300), endTime: BigInt(T + 899) });
    });

    it("prepares the exact configureSale values for the open edition", () => {
      const { values, errors } = buildSaleChange({ form: open(), editionMaxSupply: 0n, nowSec: NOW });
      expect(errors).toEqual([]);
      expect(values).toEqual({ priceWei: 10_000_000_000_000_000n, maxSupply: 0n, perWalletLimit: 0n, startTime: BigInt(T + 300), endTime: BigInt(T + 899), paused: false, openEdition: true });
    });

    it("shows seconds in the window description so T+899 can be checked before signing", () => {
      const text = describeSaleWindow({ startTime: BigInt(T + 300), endTime: BigInt(T + 899), nowSec: NOW });
      expect(text).toContain("Sale runs for 9 minutes 59 seconds");
      expect(text).toMatch(/:\d{2}:\d{2}/);
    });
  });
});
