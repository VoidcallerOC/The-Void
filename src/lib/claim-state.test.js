import { describe, expect, it } from "vitest";
import { CLAIM_STATES, claimState, releaseBindingFor } from "./claim-state.js";

const edition = {
  chainId: 43113,
  releaseContractAddress: "0x1111111111111111111111111111111111111111",
  contractAddress: "0x1111111111111111111111111111111111111111",
  primarySaleAddress: "0x2222222222222222222222222222222222222222",
  factoryAddress: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265",
  tokenIds: ["7"],
  publicationArchitecture: "release-per-contract",
};

describe("Claim release identity", () => {
  it("uses chain, release contract, and token as the canonical identity", () => {
    expect(releaseBindingFor(edition)).toMatchObject({ valid: true, chainId: 43113, tokenId: "7" });
  });
  it("fails closed instead of falling back to the legacy Fuji singleton", () => {
    const legacy = { ...edition, releaseContractAddress: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6", contractAddress: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6" };
    expect(releaseBindingFor(legacy).valid).toBe(false);
    expect(claimState({ edition: legacy, walletConnected: true, chainId: 43113 }).state).toBe(CLAIM_STATES.INVALID_RELEASE_BINDING);
  });
  it("does not enable the CTA when the claim executor is unavailable", () => {
    expect(claimState({ edition, walletConnected: true, chainId: 43113, balance: 0n }).state).toBe(CLAIM_STATES.RELEASE_UNAVAILABLE);
  });
  it("reports an existing balance as already claimed", () => {
    expect(claimState({ edition, walletConnected: true, chainId: 43113, balance: 1n }).state).toBe(CLAIM_STATES.ALREADY_CLAIMED);
  });
});
