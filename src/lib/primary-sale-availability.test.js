import { describe, expect, it } from "vitest";
import {
  SALE_AVAILABILITY,
  isOpenEditionSupply,
  primarySaleAvailability,
  saleAvailabilityLabel,
} from "./primary-sale-availability.js";

// forgive-forget-28 on Fuji: open edition, 0.01 AVAX, sale cap 0, 1 per wallet, end time set.
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const END = Math.floor(Date.UTC(2026, 9, 31, 23, 59, 0) / 1000);
const openSale = { configured: true, paused: false, priceWei: "10000000000000000", maxSupply: "0", sold: "1", perWalletLimit: "1", startTime: "0", endTime: String(END) };

describe("primary sale availability", () => {
  it("treats supply 0, blank and Open as an open edition, never as empty", () => {
    for (const supply of [0, "0", "", null, undefined, "Open"]) expect(isOpenEditionSupply(supply)).toBe(true);
    for (const supply of ["1", 25, "333"]) expect(isOpenEditionSupply(supply)).toBe(false);
  });

  it("open edition + configured, unpaused, in-window sale is collectable until its end time", () => {
    const result = primarySaleAvailability(openSale, { editionSupply: "0", now: NOW });
    expect(result).toMatchObject({ state: SALE_AVAILABILITY.OPEN, openEdition: true, unlimited: true, endTime: END });
    expect(saleAvailabilityLabel(result)).toBe("Open edition · until Oct 31, 2026, 11:59 PM UTC");
  });

  it("open edition after its end time is ended, not sold out or zero supply", () => {
    const result = primarySaleAvailability(openSale, { editionSupply: "0", now: (END + 1) * 1000 });
    expect(result.state).toBe(SALE_AVAILABILITY.ENDED);
    expect(saleAvailabilityLabel(result)).toBe("Sale ended");
  });

  it("capped edition whose sale cap is reached is sold out", () => {
    const result = primarySaleAvailability({ ...openSale, maxSupply: "25", sold: "25" }, { editionSupply: "25", now: NOW });
    expect(result.state).toBe(SALE_AVAILABILITY.SOLD_OUT);
    expect(saleAvailabilityLabel(result)).toBe("Sold out");
  });

  it("sale that has not started reports its start time", () => {
    const start = Math.floor(Date.UTC(2026, 9, 12, 18, 0, 0) / 1000);
    const result = primarySaleAvailability({ ...openSale, startTime: String(start) }, { editionSupply: "0", now: NOW });
    expect(result.state).toBe(SALE_AVAILABILITY.NOT_STARTED);
    expect(saleAvailabilityLabel(result)).toBe("Starts Oct 12, 2026, 6:00 PM UTC");
  });

  it("paused and unconfigured sales are not collectable", () => {
    expect(primarySaleAvailability({ ...openSale, paused: true }, { now: NOW }).state).toBe(SALE_AVAILABILITY.PAUSED);
    expect(primarySaleAvailability({ ...openSale, configured: false }, { now: NOW }).state).toBe(SALE_AVAILABILITY.UNCONFIGURED);
    expect(primarySaleAvailability(null, { now: NOW }).state).toBe(SALE_AVAILABILITY.UNCONFIGURED);
  });

  it("accepts bigint sale tuples as read from chain", () => {
    const sale = { configured: true, paused: false, priceWei: 10n ** 16n, maxSupply: 0n, sold: 1n, perWalletLimit: 1n, startTime: 0n, endTime: BigInt(END) };
    expect(primarySaleAvailability(sale, { editionSupply: "0", now: NOW }).state).toBe(SALE_AVAILABILITY.OPEN);
  });
});
