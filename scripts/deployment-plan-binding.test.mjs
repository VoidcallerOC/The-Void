import { describe, expect, it } from "vitest";
import { BindingError, bindPlan, verifyBinding } from "./deployment-plan-binding.mjs";

const COMMIT = "90f46d21140295c5d9bc929cd02610209db56ff7";
const OTHER_COMMIT = "60b71f0f8534fbf2abaaed7ebd1fec5f19ba2ee4";
const FEE_RECIPIENT = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const DEPLOYER = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
const request = (step, nonce, predictedAddress, dataHash, contract) => ({ step, contract, chainId: 43114, from: DEPLOYER, to: null, nonce, value: "0", data: "0x60", dataHash, gasLimit: "1200000", predictedAddress });

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
    signingRequests: [
      request(1, 0, "0x262B774cf9a1949170B58E2d57F6189980FE757b", `0x${"a1".repeat(32)}`, "VoidReleaseFactoryV2Royalty"),
      request(2, 1, "0x0e770000000000000000000000000000000ff8f5", `0x${"a2".repeat(32)}`, "ReleaseMarketplaceV4"),
    ],
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
    eligibility: { rule: "0xrule" }, followUps: { issuerGrant: { from: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a" } },
    signingRequests: [request(1, 2, "0x1111111111111111111111111111111111111111", `0x${"b1".repeat(32)}`, "GenesisHolderClaim")],
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
    // The refusal names what blocks signing, so the operator knows to fund the deployer.
    const unfunded = releasePlan({ readyToBroadcast: false, checks: [{ check: "chainId", status: "PASS" }, { check: "deployer funded with 50% headroom", status: "FAIL", value: { balanceAvax: "0.0", requiredAvax: "0.106" } }] });
    expect(() => bindPlan("release-per-contract-mainnet", unfunded, COMMIT)).toThrow(/Failing: deployer funded with 50% headroom \{"balanceAvax":"0.0","requiredAvax":"0.106"\}/);
    expect(() => bindPlan("release-per-contract-mainnet", releasePlan(), "main")).toThrow(/commit SHA/);
    expect(() => bindPlan("unknown", releasePlan(), COMMIT)).toThrow(/Unknown plan kind/);
  });

  it("binds the Genesis claim plan's address, target, schedule and roles", () => {
    const approved = bindPlan("genesis-claim-mainnet", genesisPlan(), COMMIT);
    expect(verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ followUps: { ...genesisPlan().followUps, apiConfiguration: { changed: true } } }), COMMIT).digest).toBe(approved.digest);
    // The ISSUER_ROLE grant is bound to its verified authority, the artist wallet.
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ followUps: { issuerGrant: { from: DEPLOYER } } }), COMMIT)).toThrow(/issuerGrantFrom/);
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ roles: { ...genesisPlan().roles, signer: "0x6666666666666666666666666666666666666666" } }), COMMIT)).toThrow(/roles/);
    const moved = genesisPlan({ deployerNonce: 3 });
    moved.signingRequests = [{ ...moved.signingRequests[0], nonce: 3 }];
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", moved, COMMIT)).toThrow(/deployerNonce/);
    expect(() => verifyBinding(approved, "genesis-claim-mainnet", genesisPlan({ deployerNonce: 3 }), COMMIT)).toThrow(/disagrees with the plan/);
  });

  it("binds the exact unsigned transactions and refuses any change to them", () => {
    const approved = bindPlan("release-per-contract-mainnet", releasePlan(), COMMIT);
    expect(approved.fields.signingRequests).toHaveLength(2);
    // Gas estimates move; they are not bound.
    const regas = releasePlan();
    regas.signingRequests[0].gasLimit = "999";
    expect(verifyBinding(approved, "release-per-contract-mainnet", regas, COMMIT).digest).toBe(approved.digest);
    const tamper = (mutate) => { const plan = releasePlan(); mutate(plan); return plan; };
    // Modified artifact or constructor args show up as a different creation-data hash.
    expect(() => verifyBinding(approved, "release-per-contract-mainnet", tamper((plan) => { plan.signingRequests[1].dataHash = `0x${"ff".repeat(32)}`; }), COMMIT)).toThrow(/signingRequests/);
    // A request that disagrees with its own plan cannot even be bound.
    for (const mutate of [
      (plan) => { plan.signingRequests[0].nonce = 5; },
      (plan) => { plan.signingRequests[0].from = FEE_RECIPIENT; },
      (plan) => { plan.signingRequests[1].predictedAddress = "0x1111111111111111111111111111111111111111"; },
    ]) expect(() => bindPlan("release-per-contract-mainnet", tamper(mutate), COMMIT)).toThrow(/disagrees with the plan/);
    expect(() => bindPlan("release-per-contract-mainnet", tamper((plan) => { plan.signingRequests[0].chainId = 43113; }), COMMIT)).toThrow(/chain 43114/);
    expect(() => bindPlan("release-per-contract-mainnet", tamper((plan) => { plan.signingRequests[0].to = FEE_RECIPIENT; }), COMMIT)).toThrow(/contract creation/);
    expect(() => bindPlan("release-per-contract-mainnet", tamper((plan) => { plan.signingRequests[0].value = "1"; }), COMMIT)).toThrow(/zero-value/);
    expect(() => bindPlan("release-per-contract-mainnet", releasePlan({ signingRequests: null }), COMMIT)).toThrow(/exactly 2 unsigned signing request/);
    expect(() => bindPlan("genesis-claim-mainnet", genesisPlan({ signingRequests: [] }), COMMIT)).toThrow(/exactly 1 unsigned signing request/);
  });
});

describe("plan binding digest", () => {
  it("is the SHA-256 of the canonical binding, identical in Node and in the browser (ethers)", async () => {
    const { createHash } = await import("node:crypto");
    const { canonical } = await import("./plan-binding-core.mjs");
    const binding = bindPlan("release-per-contract-mainnet", releasePlan(), COMMIT);
    const nodeDigest = createHash("sha256").update(canonical({ kind: binding.kind, sourceCommit: binding.sourceCommit, fields: binding.fields })).digest("hex");
    expect(binding.digest).toBe(nodeDigest);
  });
});
