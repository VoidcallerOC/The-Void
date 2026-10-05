import { describe, expect, it, vi } from "vitest";
import { LEGACY_CHAIN_ID, LEGACY_CONTRACT } from "./legacy-genesis.js";
import { CLAIM_ELIGIBLE_TOKEN_IDS, checkMainCollectionEligibility } from "./claim-eligibility.js";

const wallet = "0x1111111111111111111111111111111111111111";

describe("main collection claim eligibility", () => {
  it("checks only the canonical C-Chain collection and grants access for any positive eligible token", async () => {
    const ownershipReader = vi.fn(async () => ({
      cchain: new Set([2]),
      grotto: new Set([99]),
      fuji: new Set([88]),
    }));

    await expect(checkMainCollectionEligibility(wallet, { ownershipReader })).resolves.toEqual({ eligible: true, ownedTokenIds: [2] });
    expect(ownershipReader).toHaveBeenCalledOnce();
    expect(ownershipReader).toHaveBeenCalledWith(wallet, expect.objectContaining({
      throwOnError: true,
      tokenIds: [0, 1, 2, 3],
      chains: {
        cchain: expect.objectContaining({ id: LEGACY_CHAIN_ID, contract: LEGACY_CONTRACT, tokenIds: [0, 1, 2, 3] }),
      },
    }));
    expect(CLAIM_ELIGIBLE_TOKEN_IDS).toEqual([0, 1, 2, 3]);
  });

  it("denies only after successful reads show no eligible C-Chain balance", async () => {
    const ownershipReader = vi.fn(async () => ({ cchain: new Set(), grotto: new Set([0]) }));

    await expect(checkMainCollectionEligibility(wallet, { ownershipReader })).resolves.toEqual({ eligible: false, ownedTokenIds: [] });
  });

  it("does not attempt an ownership read without a connected wallet", async () => {
    const ownershipReader = vi.fn();

    await expect(checkMainCollectionEligibility(null, { ownershipReader })).rejects.toMatchObject({ code: "WALLET_REQUIRED" });
    expect(ownershipReader).not.toHaveBeenCalled();
  });

  it("treats a missing ownership result as unavailable, not as ineligible", async () => {
    await expect(checkMainCollectionEligibility(wallet, { ownershipReader: vi.fn(async () => ({})) }))
      .rejects.toMatchObject({ code: "OWNERSHIP_READ_FAILED" });
  });
});
