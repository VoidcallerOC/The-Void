import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, getCreateAddress, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { ApprovedPlanError, EXECUTED_RELEASE_FACTORY, validateApprovedPlan } from "../scripts/approved-plan.mjs";
import { FACTORY_ARTIFACT_PATH } from "../scripts/deploy-release-per-contract-mainnet.mjs";
import { verifyBinding } from "../scripts/deployment-plan-binding.mjs";
import { bindPlan } from "../scripts/plan-binding-core.mjs";
import { assertReadyToSign } from "../scripts/mainnet-signing-requests.mjs";
import { createSigningSession } from "../scripts/mainnet-owner-signing.mjs";
import { execFileSync } from "node:child_process";
import unifiedManifest from "../config/unified-marketplace.json" with { type: "json" };

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
    const c = marketplaceTx.constructor;
    const marketplaceData = `${marketplace.bytecode.object}${coder.encode(["address", "address", "address", "address", "uint256", "address"], [c.feeRecipient, c.releaseFactory, c.legacyReleaseFactory, c.genesisCollection, c.genesisMaxTokenId, c.genesisRoyaltyReceiver]).slice(2)}`.toLowerCase();
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

  describe("release-per-contract-mainnet.json binding (PR #242 release gate)", () => {
    const entry = () => load("release-per-contract-mainnet.json");
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
    const hasHistory = (() => { try { git("rev-parse", "HEAD"); return true; } catch { return false; } })();

    it("the stored digest is what bindPlan produces for the full 40-hex source commit, and nothing else", () => {
      const { kind, plan, binding } = entry();
      expect(binding.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      const fresh = bindPlan(kind, plan, binding.sourceCommit);
      expect(fresh.digest).toBe(binding.digest);
      expect(fresh.fields).toEqual(binding.fields);
      // The same plan bound to any other commit yields another digest, so approval is never commit-agnostic.
      expect(bindPlan(kind, plan, "0".repeat(40)).digest).not.toBe(binding.digest);
      expect(() => verifyBinding(binding, kind, plan, "1".repeat(40))).toThrow(/was made on/);
    });

    // The owner signs from a clean checkout of exactly binding.sourceCommit (mainnet-owner-signing checkedOutCommit), so that
    // commit must be in this branch's history and must already carry the source the plan was built from.
    it.runIf(hasHistory)("the source commit is an ancestor of HEAD and carries the planned contracts", () => {
      const { plan, binding } = entry();
      expect(() => git("merge-base", "--is-ancestor", binding.sourceCommit, "HEAD")).not.toThrow();
      for (const path of ["contracts/VoidUnifiedMarketplace.sol", "contracts/VoidReleaseFactoryV2RoyaltySettled.sol", "scripts/deploy-release-per-contract-mainnet.mjs"]) {
        expect(git("show", `${binding.sourceCommit}:${path}`).length).toBeGreaterThan(0);
      }
      expect(plan.artifacts.marketplace.path).toBe("out/VoidUnifiedMarketplace.sol/VoidUnifiedMarketplace.json");
    });

    it("binds the intended release: factory -> unified marketplace, production factory, Genesis 0-3 at its royalty receiver, one fee recipient", () => {
      const { plan } = entry();
      const [factory, market] = plan.transactions;
      expect(plan.deployer).toMatchObject({ address: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", nonce: 3 });
      expect([factory.nonce, market.nonce]).toEqual([3, 4]);
      expect(factory.constructor.platformRecipient).toBe("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
      expect(market.constructor).toEqual({
        feeRecipient: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4",
        releaseFactory: factory.predictedAddress,
        legacyReleaseFactory: EXECUTED_RELEASE_FACTORY,
        genesisCollection: unifiedManifest.genesis.address,
        genesisMaxTokenId: 3,
        genesisRoyaltyReceiver: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a",
      });
      expect(market.sealedInBytecode).toEqual({ FACTORY_PLATFORM_FEE_BPS: 250, FACTORY_ROYALTY_BPS: 250, GENESIS_PLATFORM_FEE_BPS: 0, GENESIS_ROYALTY_BPS: 500 });
      plan.signingRequests.forEach((request, index) => {
        expect(request.nonce).toBe(plan.transactions[index].nonce);
        expect(request.predictedAddress).toBe(plan.transactions[index].predictedAddress);
        expect(keccak256(request.data)).toBe(request.dataHash.toLowerCase());
      });
      // Constructor arguments are the tail of each creation payload.
      const coder = AbiCoder.defaultAbiCoder();
      const c = market.constructor;
      expect(plan.signingRequests[1].data.endsWith(coder.encode(["address", "address", "address", "address", "uint256", "address"], [c.feeRecipient, c.releaseFactory, c.legacyReleaseFactory, c.genesisCollection, c.genesisMaxTokenId, c.genesisRoyaltyReceiver]).slice(2).toLowerCase())).toBe(true);
      expect(plan.constructorArgsEncoded.marketplace).toBe(coder.encode(["address", "address", "address", "address", "uint256", "address"], [c.feeRecipient, c.releaseFactory, c.legacyReleaseFactory, c.genesisCollection, c.genesisMaxTokenId, c.genesisRoyaltyReceiver]));
    });

    it("refuses any drift of a deployment-defining value, nonce, address or payload", () => {
      const original = entry();
      const tamper = (mutate) => { const copy = JSON.parse(JSON.stringify(original)); mutate(copy); return copy; };
      const other = "0x00000000000000000000000000000000000000F5";
      const cases = [
        [(e) => { e.plan.transactions[1].constructor.genesisRoyaltyReceiver = other; }, /changed after approval/],
        [(e) => { e.plan.transactions[1].constructor.genesisMaxTokenId = 4; }, /changed after approval/],
        [(e) => { e.plan.transactions[1].constructor.legacyReleaseFactory = other; }, /changed after approval/],
        [(e) => { e.plan.transactions[1].constructor.releaseFactory = other; }, /changed after approval/],
        [(e) => { e.plan.transactions[1].constructor.feeRecipient = other; }, /changed after approval/],
        // Changed creation data with a matching hash still differs from what was approved.
        [(e) => { const r = e.plan.signingRequests[1]; r.data = `${r.data}00`; r.dataHash = keccak256(r.data); }, /changed after approval/],
        [(e) => { e.plan.signingRequests[1].nonce = 5; }, /changed after approval|consecutive|predicted address/],
        [(e) => { e.plan.signingRequests[1].predictedAddress = other; }, /changed after approval|predicted address/],
      ];
      for (const [mutate, message] of cases) expect(() => validateApprovedPlan(tamper(mutate))).toThrow(message);
      // Re-binding a tampered Genesis or factory linkage is still refused by the release policy itself.
      for (const [field, value] of [["genesisRoyaltyReceiver", other], ["genesisCollection", other], ["legacyReleaseFactory", other], ["genesisMaxTokenId", 4]]) {
        const copy = tamper((e) => { e.plan.transactions[1].constructor[field] = value; });
        copy.binding = bindPlan(copy.kind, copy.plan, copy.binding.sourceCommit);
        expect(() => validateApprovedPlan(copy)).toThrow(/production factory and the recorded Genesis/);
      }
      const unbound = tamper((e) => { e.plan.transactions[1].constructor.releaseFactory = other; });
      unbound.binding = bindPlan(unbound.kind, unbound.plan, unbound.binding.sourceCommit);
      expect(() => validateApprovedPlan(unbound)).toThrow(/not bound to the factory of step 1/);
    });

    it("a valid binding alone never reaches the wallet: device confirmation and a fresh matching plan are still required", async () => {
      const { kind, plan, binding } = entry();
      const base = { kind, reviewedPlan: plan, approvedBinding: binding, commit: binding.sourceCommit, providers: {}, env: {} };
      await expect(createSigningSession({ ...base, recipientVerifiedOnDevice: "" })).rejects.toThrow(/Nano S Plus/);
      // A stale fresh plan (nonce moved) cannot match the approval, so no session reaches the signing phase.
      const stale = JSON.parse(JSON.stringify(plan));
      stale.deployer.nonce = 4;
      await expect(createSigningSession({ ...base, recipientVerifiedOnDevice: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4", replan: async () => stale })).rejects.toThrow(/differs from the approved plan/);
      // Signing from any other checkout than the bound commit is refused.
      await expect(createSigningSession({ ...base, commit: "2".repeat(40), recipientVerifiedOnDevice: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4", replan: async () => plan })).rejects.toThrow(/was made on/);
      // The recipient checks stay UNVERIFIED in the plan: only the owner's device confirmation completes them.
      expect(plan.checks.filter((check) => check.check.endsWith("verified")).map((check) => check.status)).toEqual(["UNVERIFIED", "UNVERIFIED"]);
    });
  });
});
