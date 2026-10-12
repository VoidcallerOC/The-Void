import { describe, expect, it } from "vitest";
import { BindingError, bindPlan, verifyBinding } from "./deployment-plan-binding.mjs";

const COMMIT = "90f46d21140295c5d9bc929cd02610209db56ff7";
const OTHER_COMMIT = "60b71f0f8534fbf2abaaed7ebd1fec5f19ba2ee4";
const FEE_RECIPIENT = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";

function releasePlan(overrides = {}) {
  return {
    mode: "DRY_RUN", network: "mainnet", chainId: 43114, readyToBroadcast: true, broadcasted: false,
    deployer: { address: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", nonce: 0, pendingNonce: 0, balanceWei: "1000", balanceAvax: "0.000000000000001" },
    artifacts: { factory: { initCodeHash: "0x01" }, implementation: { runtimeCodeHash: "0x02" }, marketplace: { initCodeHash: "0x03" } },
    transactions: [
      { step: 1, nonce: 0, contract: "VoidReleaseFactoryV2Royalty", constructor: { platformRecipient: FEE_RECIPIENT }, predictedAddress: "0x262B774cf9a1949170B58E2d57F6189980FE757b", predictedImplementation: "0x80640000000000000000000000000000000f9006", estimatedGas: "100" },
      { step: 2, nonce: 1, contract: "ReleaseMarketplaceV4", constructor: { feeRecipient: FEE_RECIPIENT, platformFeeBps: 250, releaseFactory: "0x262B774cf9a1949170B58E2d57F6189980FE757b" }, predictedAddress: "0x0e770000000000000000000000000000000ff8f5", estimatedGas: "200" },
    ],
    constructorArgsEncoded: { factory: "0xaa", marketplace: "0xbb" },
    gas: { maxFeePerGasWei: "25000000000" },
    ...overrides,
  };
}

function genesisPlan(overrides = {}) {
  return {
    mode: "DRY_RUN", network: "mainnet", chainId: 43114, deployer: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", deployerNonce: 2,
    predictedClaimAddress: "0x1111111111111111111111111111111111111111",
    target: { releaseContract: "0x2222222222222222222222222222222222222222", primarySale: "0x3333333333333333333333333333333333333333", tokenId: "7", edition: { sold: "0" } },
    schedule: { claimStart: "1800000000", claimWindowSeconds: "86400" }, supply: { claimAllocation: "0", publicAllocation: "0" },
    roles: { admin: "0x4444444444444444444444444444444444444444", signer: "0x5555555555555555555555555555555555555555" },
    eligibility: { rule: "0xrule" }, followUps: {},
    ...overrides,
  };
}

describe("deployment plan binding", () => {
  it("binds the approved release plan to its commit and accepts an identical fresh plan", () => {
    const approved = bindPlan("release-per-contract-mainnet", releasePlan(), COMMIT);
    expect(approved).toMatchObject({ kind: "release-per-contract-mainnet", sourceCommit: COMMIT });
    expect(approved.digest).toMatch(/^[0-9a-f]{64}$/);
    // Balance and gas price move between the plan and the broadcast; they are not part of the binding.
    const fresh = releasePlan({ deployer: { ...releasePlan().deployer, balanceWei: "999" }, gas: { maxFeePerGasWei: "1" } });
    expect(verifyBinding(approved, "release-per-contract-mainnet", fresh, COMMIT).digest).toBe(approved.digest);
  });

  it("refuses a fresh plan whose nonce, addresses, recipient or artifacts changed", () => {
    const approved = bindPlan("release-per-contract-mainnet", releasePlan(), COMMIT);
    const moved = releasePlan({ deployer: { ...releasePlan().deployer, nonce: 1 } });
    expect(() => verifyBinding(approved, "release-per-contract-mainnet", moved, COMMIT)).toThrow(/deployerNonce/);
    const recipient = releasePlan();
    recipient.transactions[0].constructor.platformRecipient = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
    expect(() => verifyBinding(approved, "release-per-contract-mainnet", recipient, COMMIT)).toThrow(/transactions/);
    const artifact = releasePlan({ artifacts: { ...releasePlan().artifacts, marketplace: { initCodeHash: "0x04" } } });
    expect(() => verifyBinding(approved, "release-per-contract-mainnet", artifact, COMMIT)).toThrow(/artifacts/);
  });

  it("refuses another commit, another kind, a non-mainnet plan or an unready plan", () => {
    const approved = bindPlan("release-per-contract-mainnet", releasePlan(), COMMIT);
    expect(() => verifyBinding(approved, "release-per-contract-mainnet", releasePlan(), OTHER_COMMIT)).toThrow(/made on/);
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan(), COMMIT)).toThrow(/approved binding is for/);
    expect(() => bindPlan("release-per-contract-mainnet", releasePlan({ chainId: 43113, network: "fuji" }), COMMIT)).toThrow(BindingError);
    expect(() => bindPlan("release-per-contract-mainnet", releasePlan({ readyToBroadcast: false }), COMMIT)).toThrow(/not ready/);
    expect(() => bindPlan("release-per-contract-mainnet", releasePlan(), "main")).toThrow(/commit SHA/);
    expect(() => bindPlan("unknown", releasePlan(), COMMIT)).toThrow(/Unknown plan kind/);
  });

  it("binds the Genesis claim plan's address, target, schedule and roles", () => {
    const approved = bindPlan("genesis-claim-mainnet", genesisPlan(), COMMIT);
    expect(verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ followUps: { changed: true } }), COMMIT).digest).toBe(approved.digest);
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ roles: { ...genesisPlan().roles, signer: "0x6666666666666666666666666666666666666666" } }), COMMIT)).toThrow(/roles/);
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ deployerNonce: 3 }), COMMIT)).toThrow(/deployerNonce/);
  });
});
