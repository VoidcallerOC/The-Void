import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, getCreateAddress, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { ApprovedPlanError, validateApprovedPlan } from "../scripts/approved-plan.mjs";
import { FACTORY_ARTIFACT_PATH, IMPLEMENTATION_ARTIFACT_PATH, MARKETPLACE_ARTIFACT_PATH } from "../scripts/deploy-release-per-contract-mainnet.mjs";

// Every committed approved plan must be bound, for C-Chain and the defined deployer, and its
// transactions must be exactly the contracts compiled from this commit with the plan's constructor
// arguments. CI builds the contracts (forge test) before this runs; without them the test fails in CI.
const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(ROOT, "deploy/mainnet/approved-plans");
const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
const load = (name) => JSON.parse(readFileSync(resolve(DIR, name), "utf8"));
const artifact = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
const built = existsSync(resolve(ROOT, FACTORY_ARTIFACT_PATH));

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
    const [factory, marketplace, implementation] = [FACTORY_ARTIFACT_PATH, MARKETPLACE_ARTIFACT_PATH, IMPLEMENTATION_ARTIFACT_PATH].map(artifact);
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
