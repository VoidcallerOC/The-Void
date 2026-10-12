import { describe, expect, it } from "vitest";
import { bindPlan } from "../../scripts/plan-binding-core.mjs";
import { buildDryRunPlan, validateDeploymentEnv } from "../../scripts/deploy-release-per-contract-mainnet.mjs";
import { DEPLOYER, RECIPIENT, artifacts, fakeChain } from "../../test/helpers/mainnet-fake-chain.mjs";
import { PUBLIC_RPC, STEP_STATUS, confirmStep, initialState, loadApprovedPlans, nextAction, readiness, recordRejected, recordSubmitted, requestApproval, rpcFromQuery } from "./flow.js";

const COMMIT = "0046c710c07c693af8376a9b802394804ed7e2c8";
const INPUTS = { DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "0", RELEASE_PLATFORM_RECIPIENT: RECIPIENT };

/** An approved entry as committed under deploy/mainnet/approved-plans/, planned on a funded chain. */
async function approvedEntry() {
  const plan = JSON.parse(JSON.stringify(await buildDryRunPlan(validateDeploymentEnv(INPUTS), fakeChain(), { load: artifacts })));
  return { kind: "release-per-contract-mainnet", plan, binding: bindPlan("release-per-contract-mainnet", plan, COMMIT) };
}

/** What Rabby does after the owner approves: the chain mines the request; the contract's views exist. */
function mine(chain, entry, state, n, overrides) {
  const hash = chain.mine(state.steps[n - 1].request, overrides);
  const [factory, marketplace] = entry.plan.transactions;
  if (n === 1) chain.factoryViews(factory.predictedAddress, { implementation: factory.predictedImplementation });
  else chain.marketplaceViews(marketplace.predictedAddress, { registry: factory.predictedAddress });
  return hash;
}

describe("owner deployment page: approved plan", () => {
  it("offers only a valid, unchanged approved plan", async () => {
    const entry = await approvedEntry();
    const tampered = JSON.parse(JSON.stringify(entry));
    tampered.plan.signingRequests[0].data = `${tampered.plan.signingRequests[0].data}00`;
    const [good, bad] = loadApprovedPlans({ "good.json": { default: entry }, "bad.json": { default: tampered } });
    expect(good.error).toBeNull();
    expect(bad.error).toMatch(/does not hash to its bound value/);
  });

  it("uses Avalanche's public RPC, and accepts only a local node instead", () => {
    expect(rpcFromQuery("")).toEqual({ url: PUBLIC_RPC, override: false });
    expect(rpcFromQuery("?rpc=http://127.0.0.1:8545")).toEqual({ url: "http://127.0.0.1:8545", override: true });
    expect(() => rpcFromQuery("?rpc=https://evil.example/rpc")).toThrow(/Only a local node/);
    expect(() => rpcFromQuery("?rpc=http://127.0.0.1.evil.example:8545")).toThrow(/Only a local node/);
  });

  it("names the four transaction states the owner sees", () => {
    expect(Object.keys(STEP_STATUS)).toEqual(["prepared", "awaiting-wallet", "submitted", "confirmed", "failed"]);
  });
});

describe("owner deployment page: readiness and the next action", () => {
  it("lists every live check and says what blocks (unfunded deployer)", async () => {
    const entry = await approvedEntry();
    const state = initialState(entry);
    const ready = await readiness(fakeChain({ balance: 0n }), entry, state, 1);
    expect(ready.ready).toBe(false);
    expect(ready.checks.find((check) => /pay the gas/.test(check.name))).toMatchObject({ ok: false, detail: expect.stringMatching(/holds 0\.0 AVAX, needs up to/) });
    expect(nextAction(entry, state, { connected: true, ready })).toMatch(/^Step 1 is blocked: Deployer can pay the gas for the remaining steps/);
    expect(nextAction(entry, state, { connected: false, ready })).toMatch(/Connect Rabby/);
    const funded = await readiness(fakeChain(), entry, state, 1);
    expect(funded.ready).toBe(true);
    expect(nextAction(entry, state, { connected: true, ready: funded })).toMatch(/Review step 1, tick its box and press "Request approval in Rabby"/);
  });

  it("refuses a moved nonce, a pending transaction or an occupied address", async () => {
    const entry = await approvedEntry();
    const state = initialState(entry);
    for (const chain of [fakeChain({ nonce: 1 }), fakeChain({ pendingNonce: 1 }), fakeChain({ code: { [entry.plan.transactions[0].predictedAddress]: "0x60" } })]) {
      expect((await readiness(chain, entry, state, 1)).ready).toBe(false);
      await expect(requestApproval(chain, entry, state, 1)).rejects.toThrow(/nonce|pending|already has code/);
    }
  });
});

describe("owner deployment page: prepared, approval requested, submitted, confirmed", () => {
  it("runs both steps in order and verifies each from the chain", async () => {
    const entry = await approvedEntry();
    const chain = fakeChain();
    const state = initialState(entry);
    await expect(requestApproval(chain, entry, state, 2)).rejects.toThrow(/only after every earlier step is confirmed/);
    const tx = await requestApproval(chain, entry, state, 1);
    expect(tx).toEqual({ from: DEPLOYER, data: entry.plan.signingRequests[0].data, value: "0x0", gas: "0x124f80", nonce: "0x0", chainId: "0xa86a" });
    expect(state.steps[0].status).toBe("awaiting-wallet");
    recordRejected(state, 1);
    expect(state.steps[0].status).toBe("prepared");
    await requestApproval(chain, entry, state, 1);
    recordSubmitted(state, 1, mine(chain, entry, state, 1));
    expect(state.steps[0].status).toBe("submitted");
    await confirmStep(chain, entry, state, 1);
    expect(state.steps[0]).toMatchObject({ status: "confirmed", verified: { address: entry.plan.transactions[0].predictedAddress, implementationAddress: entry.plan.transactions[0].predictedImplementation, platformRecipient: RECIPIENT } });
    await requestApproval(chain, entry, state, 2);
    recordSubmitted(state, 2, mine(chain, entry, state, 2));
    await confirmStep(chain, entry, state, 2);
    expect(state.steps.map((step) => step.status)).toEqual(["confirmed", "confirmed"]);
    expect(nextAction(entry, state, { connected: true })).toMatch(/All steps are confirmed. Run the GitHub verification/);
  });

  it("keeps a slow transaction submitted and re-checkable, never confirmed early", async () => {
    const entry = await approvedEntry();
    const chain = fakeChain();
    const state = initialState(entry);
    recordSubmitted(state, 1, `0x${"7".repeat(64)}`);
    await confirmStep(chain, entry, state, 1, { timeoutMs: 1 });
    expect(state.steps[0]).toMatchObject({ status: "submitted", error: expect.stringMatching(/Not confirmed yet/) });
  });

  it("stops everything when the mined transaction differs from the approved plan", async () => {
    const entry = await approvedEntry();
    const chain = fakeChain();
    const state = initialState(entry);
    await requestApproval(chain, entry, state, 1);
    recordSubmitted(state, 1, mine(chain, entry, state, 1, { tx: { data: `${entry.plan.signingRequests[0].data}ff` } }));
    await confirmStep(chain, entry, state, 1);
    expect(state.steps[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/creation data hash/) });
    expect(nextAction(entry, state, {})).toMatch(/^Stop\. Step 1 failed verification/);
    await expect(requestApproval(chain, entry, state, 2)).rejects.toThrow(/failed verification/);
  });

  it("resumes after a reload from the stored hash, and refuses a hash for a later step first", async () => {
    const entry = await approvedEntry();
    const chain = fakeChain();
    const first = initialState(entry);
    await requestApproval(chain, entry, first, 1);
    const hash = mine(chain, entry, first, 1);
    const reloaded = initialState(entry, { 1: hash });
    expect(reloaded.steps.map((step) => step.status)).toEqual(["submitted", "prepared"]);
    expect(() => recordSubmitted(reloaded, 2, `0x${"8".repeat(64)}`)).toThrow(/only after every earlier step is confirmed/);
    await confirmStep(chain, entry, reloaded, 1);
    expect(reloaded.steps[0].status).toBe("confirmed");
    expect(() => recordSubmitted(reloaded, 1, "0x12")).toThrow(/32-byte/);
  });
});
