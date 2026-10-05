import { describe, expect, it, vi } from "vitest";
import {
  checkGenesisEligibility,
  confirmGenesisClaim,
  executeGenesisClaim,
  fetchGenesisClaimConfig,
  requestGenesisVoucher,
} from "./genesis-claim.js";

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
