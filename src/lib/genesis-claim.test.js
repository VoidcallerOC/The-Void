import { describe, expect, it, vi } from "vitest";
import {
  checkGenesisEligibility,
  confirmGenesisClaim,
  executeGenesisClaim,
  fetchGenesisClaimConfig,
  readGenesisClaimSaleGuard,
  requestGenesisVoucher,
  genesisClaimPhase,
  genesisSaleOpen,
} from "./genesis-claim.js";
import { Interface } from "ethers";

const WALLET = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const target = {
  enabled: true,
  destinationChainId: 43113,
  releaseContract: RELEASE,
  primarySale: SALE,
  claimContract: CLAIM,
  tokenId: "55",
  allocation: "20",
};

function jsonResponse(data, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

describe("Genesis claim browser executor", () => {
  it("retrieves and validates the configured release target", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: target }));
    await expect(fetchGenesisClaimConfig({ fetchImpl })).resolves.toMatchObject({
      destinationChainId: 43113,
      releaseContract: RELEASE,
      tokenId: "55",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/claims/config", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("rejects a legacy singleton claim target", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { ...target, releaseContract: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6" } }));
    await expect(fetchGenesisClaimConfig({ fetchImpl })).rejects.toThrow(/legacy Fuji V2 singleton/);
  });

  it("reports a server-side eligibility failure as an error, not ineligible", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "ELIGIBILITY_UNAVAILABLE", message: "C-Chain read unavailable." } }, { status: 503 }));
    await expect(checkGenesisEligibility(WALLET, { fetchImpl })).rejects.toMatchObject({ code: "ELIGIBILITY_UNAVAILABLE", status: 503 });
  });

  it("requests an authorization using only the connected claimant wallet", async () => {
    const issued = { voucher: { claimant: WALLET, quantity: "1" }, signature: "0x" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: issued }));
    await expect(requestGenesisVoucher(WALLET, { fetchImpl })).resolves.toEqual(issued);
    expect(fetchImpl).toHaveBeenCalledWith("/api/claims/vouchers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ wallet: WALLET }),
    }));
  });

  it("rejects wrong-network wallet actions before signing", async () => {
    const provider = { request: vi.fn().mockResolvedValue("0xa86a") };
    const voucher = { claimant: WALLET, destinationChainId: 43113, releaseContract: RELEASE, tokenId: "55" };
    await expect(executeGenesisClaim(provider, target, voucher, "0x")).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("rejects a voucher bound to a different release before opening the wallet signer", async () => {
    const provider = { request: vi.fn().mockResolvedValue("0xa869") };
    const voucher = { claimant: WALLET, destinationChainId: 43113, releaseContract: SALE, tokenId: "55" };
    await expect(executeGenesisClaim(provider, target, voucher, "0x")).rejects.toMatchObject({ code: "INVALID_RELEASE_BINDING" });
    expect(provider.request).toHaveBeenCalledOnce();
  });

  it("remains pending until a receipt arrives, then verifies ownership", async () => {
    let resolveReceipt;
    const waitForReceipt = vi.fn(() => new Promise((resolve) => { resolveReceipt = resolve; }));
    const verifyOwnership = vi.fn().mockResolvedValue(1n);
    const transaction = { hash: "0xclaim" };
    const pending = confirmGenesisClaim({
      send: vi.fn().mockResolvedValue(transaction),
      waitForReceipt,
      verifyOwnership,
      quantity: "1",
    });
    await Promise.resolve();
    expect(waitForReceipt).toHaveBeenCalledWith(transaction);
    expect(verifyOwnership).not.toHaveBeenCalled();
    resolveReceipt({ status: 1, hash: "0xclaim" });
    await expect(pending).resolves.toMatchObject({ transactionHash: "0xclaim", balance: 1n });
    expect(verifyOwnership).toHaveBeenCalledOnce();
  });

  it("does not report success for a failed transaction receipt", async () => {
    const verifyOwnership = vi.fn();
    await expect(confirmGenesisClaim({
      send: async () => ({ hash: "0xfailed" }),
      waitForReceipt: async () => ({ status: 0, hash: "0xfailed" }),
      verifyOwnership,
      quantity: "1",
    })).rejects.toMatchObject({ code: "CLAIM_TRANSACTION_FAILED" });
    expect(verifyOwnership).not.toHaveBeenCalled();
  });

  it("does not show owned if the receipt succeeds but token balance is absent", async () => {
    await expect(confirmGenesisClaim({
      send: async () => ({ hash: "0xclaim" }),
      waitForReceipt: async () => ({ status: 1, hash: "0xclaim" }),
      verifyOwnership: async () => 0n,
      quantity: "1",
    })).rejects.toMatchObject({ code: "POST_CLAIM_OWNERSHIP_UNVERIFIED" });
  });
});

describe("Genesis claim sale guard", () => {
  const binding = { chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE, tokenId: "55" };
  const claimIface = new Interface([
    "function releaseContract() view returns (address)",
    "function primarySale() view returns (address)",
    "function tokenId() view returns (uint256)",
    "function allocation() view returns (uint256)",
    "function publicAllocation() view returns (uint256)",
    "function claimStart() view returns (uint256)",
    "function claimEnd() view returns (uint256)",
    "function publicSaleStart() view returns (uint256)",
    "function publicSaleEnd() view returns (uint256)",
    "function publicPriceWei() view returns (uint256)",
    "function claimedSupply() view returns (uint256)",
  ]);
  // Concurrent phases: the sale opens with the claims (publicSaleStart == claimStart) and runs 7 days.
  const onchain = { releaseContract: RELEASE, primarySale: SALE, tokenId: 55n, allocation: 0n, publicAllocation: 0n, claimStart: 1_791_000_000n, claimEnd: 1_791_086_400n, publicSaleStart: 1_791_000_000n, publicSaleEnd: 1_791_604_799n, publicPriceWei: 250_000_000_000_000_000n, claimedSupply: 4n };
  const provider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa869";
      const name = claimIface.parseTransaction({ data: params[0].data }).name;
      expect(params[0].to).toBe(CLAIM);
      return claimIface.encodeFunctionResult(name, [onchain[name]]);
    }),
  };

  it("reads the claim invariants when the claim targets this sale", async () => {
    await expect(readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => target, nowSec: 1_791_086_399 })).resolves.toMatchObject({
      state: "active", claimContract: CLAIM, allocation: 0n, publicAllocation: 0n, claimStart: 1_791_000_000n, claimEnd: 1_791_086_400n, publicSaleStart: 1_791_000_000n, publicSaleEnd: 1_791_604_799n, publicPriceWei: 250_000_000_000_000_000n, live: true,
    });
    // Once the claim window closes, the sale is the artist's again.
    await expect(readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => target, nowSec: 1_791_086_400 })).resolves.toMatchObject({ state: "active", live: false });
  });

  it("reports no claim when none is configured or it targets another token", async () => {
    await expect(readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => { throw Object.assign(new Error("off"), { code: "CLAIM_UNAVAILABLE" }); } })).resolves.toEqual({ state: "none" });
    await expect(readGenesisClaimSaleGuard(provider, { ...binding, tokenId: "56" }, { fetchConfig: async () => target })).resolves.toEqual({ state: "none" });
  });

  it("throws when the claim binding cannot be checked", async () => {
    await expect(readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => { throw Object.assign(new Error("mismatch"), { code: "CLAIM_BINDING_MISMATCH", status: 503 }); } })).rejects.toThrow("mismatch");
  });
});

describe("Genesis claim phases", () => {
  // claimStart + 24h claims, sale open from claimStart for 7 days (endTime inclusive).
  const claimStart = 1000;
  const claimEnd = claimStart + 86_400;
  const publicSaleEnd = claimStart + 7 * 86_400 - 1;
  const schedule = { claimStart: String(claimStart), claimEnd: String(claimEnd), publicSaleStart: String(claimStart), publicSaleEnd: String(publicSaleEnd) };
  it.each([
    [claimStart - 1, "upcoming"], [claimStart, "genesis"], [claimEnd - 1, "genesis"], [claimEnd, "public"],
    [publicSaleEnd, "public"], [publicSaleEnd + 1, "closed"],
  ])("at %i the phase is %s", (now, phase) => {
    expect(genesisClaimPhase(schedule, now)).toBe(phase);
  });

  it("is in the Genesis phase while the paid mint is already open in the first window", () => {
    for (const now of [claimStart, claimStart + 3600, claimEnd - 1]) {
      expect(genesisClaimPhase(schedule, now)).toBe("genesis");
      expect(genesisSaleOpen(schedule, now)).toBe(true);
    }
  });

  it.each([
    [claimStart - 1, false], [claimStart, true], [claimEnd - 1, true], [claimEnd, true],
    [publicSaleEnd, true], [publicSaleEnd + 1, false],
  ])("at %i the paid mint open is %s", (now, open) => {
    expect(genesisSaleOpen(schedule, now)).toBe(open);
  });

  it("falls back to claimStart when the target has no publicSaleStart", () => {
    const legacy = { claimStart: schedule.claimStart, claimEnd: schedule.claimEnd, publicSaleEnd: schedule.publicSaleEnd };
    expect(genesisSaleOpen(legacy, claimStart - 1)).toBe(false);
    expect(genesisSaleOpen(legacy, claimStart)).toBe(true);
  });
});
