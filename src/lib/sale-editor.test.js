import { describe, expect, it } from "vitest";
import { buildSaleChange, claimGuardErrors, describeSaleWindow, formatDuration, saleStatus, saleWindowWarning } from "./sale-editor.js";

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
    const claim = { state: "active", publicAllocation: 20n, minimumStart: BigInt(NOW + 86_400), live: true };
    const values = { maxSupply: 20n, startTime: BigInt(NOW + 86_400) };
    expect(claimGuardErrors(values, claim)).toEqual([]);
    expect(claimGuardErrors({ ...values, maxSupply: 0n }, claim)[0]).toMatch(/sale cap must stay 20/);
    expect(claimGuardErrors({ ...values, startTime: 0n }, claim)[0]).toMatch(/Genesis holder claims are still open/);
    expect(claimGuardErrors({ ...values, startTime: 0n }, { ...claim, live: false })).toEqual([]);
    expect(claimGuardErrors(values, { state: "unknown", message: "offline" })[0]).toMatch(/could not be checked: offline/);
    expect(claimGuardErrors(values, { state: "none" })).toEqual([]);
  });
});
