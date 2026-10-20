import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { checkRoyaltyInvariance } from "./royalty-invariance.mjs";

const iface = new Interface(["function royaltyInfo(uint256,uint256) view returns (address,uint256)"]);
const CREATOR = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const answer = (price, bps) => iface.encodeFunctionResult("royaltyInfo", [CREATOR, (price * BigInt(bps)) / 10_000n]);
const decodePrice = (data) => iface.decodeFunctionData("royaltyInfo", data)[1];

describe("royaltyInfo invariance vetting aid", () => {
  it("accepts a collection that answers identically at every gas limit and for every caller", async () => {
    const result = await checkRoyaltyInvariance({ token: "0xtoken", tokenIds: [0, 1, 2, 3], call: async ({ data }) => answer(decodePrice(data), 500) });
    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(result.samples).toBe(4 * 2 * 4 * 3);
  });

  it("flags a collection whose answer depends on the gas supplied (the M-1 shape)", async () => {
    const result = await checkRoyaltyInvariance({ token: "0xtoken", tokenIds: [0], call: async ({ data, gas }) => answer(decodePrice(data), gas >= 100_000 ? 500 : 0) });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatch(/differently depending on gas or caller/);
  });

  it("flags a collection whose answer depends on the caller", async () => {
    const result = await checkRoyaltyInvariance({ token: "0xtoken", tokenIds: [0], call: async ({ data, from }) => answer(decodePrice(data), from.endsWith("1") ? 0 : 500) });
    expect(result.ok).toBe(false);
  });

  it("flags a collection that errors at any sampled gas level", async () => {
    const result = await checkRoyaltyInvariance({ token: "0xtoken", tokenIds: [0], call: async ({ data, gas }) => { if (gas < 100_000) throw new Error("out of gas"); return answer(decodePrice(data), 500); } });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatch(/error:/);
  });

  it("is honest about its limits: a collection that is only hostile at a gas level not sampled is not detected", async () => {
    const result = await checkRoyaltyInvariance({ token: "0xtoken", tokenIds: [0], gasLimits: [100_000, 1_000_000], call: async ({ data, gas }) => answer(decodePrice(data), gas === 77_777 ? 0 : 500) });
    expect(result.ok).toBe(true); // not proof: the aid samples, it does not prove
  });
});
