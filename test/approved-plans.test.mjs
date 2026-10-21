import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, getCreateAddress, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { ApprovedPlanError, EXECUTED_RELEASE_FACTORY, validateApprovedPlan } from "../scripts/approved-plan.mjs";
import { FACTORY_ARTIFACT_PATH } from "../scripts/deploy-release-per-contract-mainnet.mjs";
import { verifyBinding } from "../scripts/deployment-plan-binding.mjs";
import { bindPlan } from "../scripts/plan-binding-core.mjs";
import { assertReadyToSign } from "../scripts/mainnet-signing-requests.mjs";

// Every committed approved plan must be bound, for C-Chain and the defined deployer, and its
// transactions must be exactly the contracts compiled from this commit with the plan's constructor
// arguments. Each plan is checked against the artifacts it names. The executed VoidReleaseFactoryV2Royalty
// plan lives in deploy/mainnet/executed-plans/, outside the directory the owner page offers for signing.
// CI builds the contracts (forge test) before this runs; without them the test fails in CI.
const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(ROOT, "deploy/mainnet/approved-plans");
const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
const load = (name) => JSON.parse(readFileSync(resolve(DIR, name), "utf8"));
// The executed plan that created factory 0x262B… and marketplace 0x0e77…, kept outside the approved-plans directory.
const executedPlan = () => JSON.parse(readFileSync(resolve(ROOT, "deploy/mainnet/executed-plans/release-per-contract-mainnet-0x262B774cf9a1949170B58E2d57F6189980FE757b.json"), "utf8"));
const artifact = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
const built = existsSync(resolve(ROOT, load("release-per-contract-mainnet.json").plan.artifacts.factory.path));

describe("approved mainnet plans", () => {
  it("has the release-infrastructure plan, and only known kinds", () => {
    expect(files).toContain("release-per-contract-mainnet.json");
    for (const name of files) expect(load(name).kind).toBe(name.replace(/\.json$/, ""));
  });

  for (const name of files) {
    it(`${name}: bound, on chain 43114, from the defined deployer, at its CREATE addresses`, () => {
      expect(() => validateApprovedPlan(load(name))).not.toThrow();
    });
  }

  it.runIf(built || process.env.CI)("release-per-contract-mainnet.json: every transaction is the contract compiled from this commit", () => {
    const { plan } = load("release-per-contract-mainnet.json");
    const [factory, marketplace, implementation] = [plan.artifacts.factory.path, plan.artifacts.marketplace.path, plan.artifacts.implementation.path].map(artifact);
    const coder = AbiCoder.defaultAbiCoder();
    const [factoryTx, marketplaceTx] = plan.transactions;
    const factoryData = `${factory.bytecode.object}${coder.encode(["address"], [factoryTx.constructor.platformRecipient]).slice(2)}`.toLowerCase();
    const marketplaceData = `${marketplace.bytecode.object}${coder.encode(["address", "uint256", "address"], [marketplaceTx.constructor.feeRecipient, marketplaceTx.constructor.platformFeeBps, marketplaceTx.constructor.releaseFactory]).slice(2)}`.toLowerCase();
    expect(plan.signingRequests[0].data).toBe(factoryData);
    expect(plan.signingRequests[1].data).toBe(marketplaceData);
    expect(plan.artifacts.factory.initCodeHash).toBe(keccak256(factory.bytecode.object));
    expect(plan.artifacts.marketplace.initCodeHash).toBe(keccak256(marketplace.bytecode.object));
    expect(plan.artifacts.implementation.runtimeCodeHash).toBe(keccak256(implementation.deployedBytecode.object));
    expect(factoryTx.predictedImplementation).toBe(getCreateAddress({ from: factoryTx.predictedAddress, nonce: 1 }));
    // Only the executed plan for 0x262B… may name another factory artifact; every new plan names the settled one.
    if (factoryTx.predictedAddress !== EXECUTED_RELEASE_FACTORY) expect(plan.artifacts.factory.path).toBe(FACTORY_ARTIFACT_PATH);
  });

  it("the executed release plan can never authorize a new deployment", async () => {
    const entry = executedPlan();
    expect(() => validateApprovedPlan(entry)).not.toThrow();
    const [first] = entry.plan.signingRequests;
    expect(first.predictedAddress).toBe(EXECUTED_RELEASE_FACTORY);
    // Owner page: its live checks refuse the used nonce and the occupied address.
    const live = { getNetwork: async () => ({ chainId: 43114n }), send: async () => "0xa86a", getTransactionCount: async () => 3, getCode: async (target) => (target === first.from ? "0x" : "0x60") };
    await expect(assertReadyToSign(live, first, [first.predictedAddress])).rejects.toThrow(/nonce is 3|already has code|chain/);
    // Command-line signer: a fresh plan for the settled factory does not reproduce the executed binding.
    const fresh = { ...entry.plan, signingRequests: entry.plan.signingRequests.map((request) => ({ ...request, nonce: request.nonce + 3, dataHash: `0x${"ab".repeat(32)}` })) };
    expect(() => verifyBinding(entry.binding, entry.kind, fresh, entry.binding.sourceCommit)).toThrow();
    // A new plan naming the deployed credit-only factory is refused outright.
    const replayed = JSON.parse(JSON.stringify(entry.plan));
    replayed.signingRequests.forEach((request, index) => { request.nonce = 3 + index; request.predictedAddress = getCreateAddress({ from: request.from, nonce: request.nonce }); });
    replayed.deployer.nonce = 3;
    replayed.transactions.forEach((transaction, index) => { transaction.nonce = replayed.signingRequests[index].nonce; transaction.predictedAddress = replayed.signingRequests[index].predictedAddress; });
    replayed.transactions[1].constructor.releaseFactory = replayed.signingRequests[0].predictedAddress;
    const rebound = { kind: entry.kind, plan: replayed, binding: bindPlan(entry.kind, replayed, entry.binding.sourceCommit) };
    expect(() => validateApprovedPlan(rebound)).toThrow(/must deploy VoidReleaseFactoryV2RoyaltySettled/);
  });

  it("refuses an approved plan changed after approval, or for another deployer, chain or recipient", () => {
    const original = load("release-per-contract-mainnet.json");
    const tamper = (mutate) => { const copy = JSON.parse(JSON.stringify(original)); mutate(copy); return copy; };
    const cases = [
      [(e) => { e.plan.signingRequests[0].data = `${e.plan.signingRequests[0].data}00`; }, /does not hash to its bound value/],
      [(e) => { e.plan.signingRequests[1].dataHash = `0x${"ff".repeat(32)}`; }, /changed after approval/],
      [(e) => { e.plan.chainId = 43113; }, /Not a C-Chain mainnet dry-run plan|not for Avalanche/],
      [(e) => { e.binding.kind = "genesis-claim-mainnet"; }, /another kind/],
      [(e) => { e.kind = "something-else"; }, /Unknown plan kind/],
    ];
    for (const [mutate, message] of cases) expect(() => validateApprovedPlan(tamper(mutate))).toThrow(message);
    expect(() => validateApprovedPlan(tamper((e) => { e.plan.signingRequests[0].data = "0x00"; }))).toThrow(ApprovedPlanError);
  });
});
