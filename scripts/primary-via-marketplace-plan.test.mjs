import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { DEFAULTS, buildPlan, expectedSplit } from "./primary-via-marketplace-plan.mjs";

const cfg = { release: ethers.getAddress(DEFAULTS.release), artist: ethers.getAddress(DEFAULTS.artist), oldSale: ethers.getAddress(DEFAULTS.oldSale), marketplace: ethers.getAddress(DEFAULTS.marketplace), tokenId: 7n, quantity: 3n, priceWei: ethers.parseEther("0.25") };

describe("primary sale through the existing marketplace", () => {
  it("emits the five artist-signed calls in order, none carrying AVAX", () => {
    const plan = buildPlan(cfg);
    expect(plan.map((c) => c.step)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.every((c) => c.value === "0")).toBe(true);
    expect(plan.slice(0, 4).every((c) => c.to === cfg.release)).toBe(true);
    expect(plan[4].to).toBe(cfg.marketplace);
    // grantRole(ISSUER, artist) precedes the mint, and the legacy sale is revoked before listing.
    expect(plan[0].data.startsWith("0x2f2ff15d")).toBe(true);
    expect(plan[1].data.startsWith("0xd547741f")).toBe(true);
  });

  it("splits one 0.25 AVAX sale 95 / 2.5 / 2.5 with the artist receiving 97.5% in total", () => {
    const s = expectedSplit(cfg.priceWei);
    expect(s).toMatchObject({ gross: 250000000000000000n, platform: 6250000000000000n, artistRoyalty: 6250000000000000n, sellerProceeds: 237500000000000000n });
    expect(s.artistTotal + s.platform).toBe(s.gross);
    expect(s.artistTotal).toBe(243750000000000000n);
  });
});
