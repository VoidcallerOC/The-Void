import { describe, expect, it, vi } from "vitest";
import { getAddress } from "ethers";
import { ApiError } from "./api-errors.js";
import {
  createGenesisClaimService,
  ELIGIBILITY_RULE,
  GENESIS_CONTRACT,
  GENESIS_CHAIN_ID,
  LEGACY_FUJI_SINGLETON,
  loadGenesisClaimConfig,
} from "./genesis-claim.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const TEST_SIGNATURE = `0x${"ab".repeat(65)}`;

function config(overrides = {}) {
  return {
    destinationChainId: 43113,
    genesisRpcUrl: "https://genesis-rpc.example",
    destinationRpcUrl: "https://fuji-rpc.example",
    releaseContract: getAddress(RELEASE),
    primarySale: getAddress(SALE),
    claimContract: getAddress(CLAIM),
    tokenId: 987654321n,
    allocation: 25n,
    publicAllocation: 75n,
    privateKey: null,
    ...overrides,
  };
}

function service({ eligible = [], alreadyClaimed = false, claimedSupply = 0n, ...overrides } = {}) {
  const signTypedData = vi.fn().mockResolvedValue(TEST_SIGNATURE);
  const eligibilityReader = vi.fn().mockResolvedValue(eligible.map(String));
  const bindingReader = vi.fn().mockResolvedValue(undefined);
  const claimStateReader = vi.fn().mockResolvedValue({ alreadyClaimed, claimedSupply });
  const instance = createGenesisClaimService({
    config: config(),
    signer: { signTypedData },
    eligibilityReader,
    bindingReader,
    claimStateReader,
    clock: () => 1_800_000_000,
    nonce: () => 987654321n,
    ...overrides,
  });
  return { instance, signTypedData, eligibilityReader, bindingReader, claimStateReader };
}

describe("Genesis holder claim authorization", () => {
  it.each([0, 1, 2, 3])("accepts a wallet holding eligible Genesis token %i", async (tokenId) => {
    const { instance } = service({ eligible: [tokenId] });
    await expect(instance.checkEligibility(WALLET)).resolves.toEqual({ eligible: true, eligibleTokenIds: [String(tokenId)] });
  });

  it("treats multiple Genesis tokens as one wallet eligibility and one quantity-one voucher", async () => {
    const { instance, signTypedData } = service({ eligible: [0, 2, 3] });
    const eligibility = await instance.checkEligibility(WALLET);
    expect(eligibility).toEqual({ eligible: true, eligibleTokenIds: ["0", "2", "3"] });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher).toMatchObject({
      claimant: getAddress(WALLET),
      genesisContract: GENESIS_CONTRACT,
      genesisChainId: GENESIS_CHAIN_ID,
      eligibilityRule: ELIGIBILITY_RULE,
      destinationChainId: 43113,
      releaseContract: getAddress(RELEASE),
      tokenId: "987654321",
      quantity: "1",
      allocation: "25",
      nonce: "987654321",
      deadline: "1800000300",
    });
    expect(issued.signature).toBe(TEST_SIGNATURE);
    expect(issued.target).toMatchObject({ claimContract: getAddress(CLAIM), publicAllocation: "75" });
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(signTypedData.mock.calls[0][0]).toEqual({
      name: "The Void Genesis Holder Claim",
      version: "1",
      chainId: 43113,
      verifyingContract: getAddress(CLAIM),
    });
    expect(signTypedData.mock.calls[0][1].ClaimVoucher).toHaveLength(11);
  });

  it("denies a wallet with none of the four Genesis tokens", async () => {
    const { instance } = service();
    await expect(instance.checkEligibility(WALLET)).resolves.toEqual({ eligible: false, eligibleTokenIds: [] });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });

  it("returns an eligibility-unavailable error instead of mislabeling an RPC failure as ineligible", async () => {
    const { instance } = service({ eligibilityReader: vi.fn().mockRejectedValue(new Error("rpc offline")) });
    await expect(instance.checkEligibility(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
  });

  it("rejects already-claimed wallets on the destination contract", async () => {
    const { instance, signTypedData } = service({ eligible: [1], alreadyClaimed: true });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("rejects a drained reserved allocation", async () => {
    const { instance, signTypedData } = service({ eligible: [0], claimedSupply: 25n });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "CLAIM_ALLOCATION_EXHAUSTED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("fails closed if live contract bindings do not match configured release values", async () => {
    const { instance, signTypedData } = service({
      eligible: [3],
      bindingReader: vi.fn().mockRejectedValue(new ApiError(503, "CLAIM_BINDING_MISMATCH", "The claim target differs.")),
    });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ code: "CLAIM_BINDING_MISMATCH", status: 503 });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("validates disabled, incomplete, malformed, and legacy-target configuration", () => {
    expect(loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "false" })).toBeNull();
    expect(() => loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "true" })).toThrow(/GENESIS_CLAIM_RELEASE_CONTRACT/);
    const complete = {
      GENESIS_CLAIM_ENABLED: "true",
      RELEASE_NETWORK: "fuji",
      GENESIS_RPC_URL: "https://c-chain.example/rpc",
      GENESIS_DESTINATION_RPC_URL: "https://fuji.example/rpc",
      GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
      GENESIS_CLAIM_PRIMARY_SALE: SALE,
      GENESIS_CLAIM_CONTRACT: CLAIM,
      GENESIS_CLAIM_TOKEN_ID: "0",
      GENESIS_CLAIM_ALLOCATION: "25",
      GENESIS_PUBLIC_MINT_ALLOCATION: "75",
    };
    expect(() => loadGenesisClaimConfig({ ...complete, GENESIS_CLAIM_RELEASE_CONTRACT: LEGACY_FUJI_SINGLETON })).toThrow(/legacy Fuji V2 singleton/);
    expect(() => loadGenesisClaimConfig({ ...complete, GENESIS_CLAIM_TOKEN_ID: "not-a-number" })).toThrow(/non-negative integer/);
    expect(() => loadGenesisClaimConfig(complete)).toThrow(/GENESIS_CLAIM_SIGNER_PRIVATE_KEY/);
  });
});
