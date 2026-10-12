import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "ethers";
import { bindPlan } from "./deployment-plan-binding.mjs";
import { buildDryRunPlan, validateDeploymentEnv } from "./deploy-release-per-contract-mainnet.mjs";
import { KINDS, cancelStep, checkedOutCommit, createSigningSession, createSigningServer, prepareStep, sessionView, submitStep, verifyCommand } from "./mainnet-owner-signing.mjs";
import { ARTIST, DEPLOYER, RECIPIENT, artifacts, fakeChain } from "../test/helpers/mainnet-fake-chain.mjs";

const KIND = "release-per-contract-mainnet";
const COMMIT = "dd9ee59d41363c016534579f3f6f10277a60c8d2";
const INPUTS = { DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "0", RELEASE_PLATFORM_RECIPIENT: RECIPIENT };
const planOn = (chain, inputs = INPUTS) => buildDryRunPlan(validateDeploymentEnv(inputs), chain, { load: artifacts });

/** The reviewed plan and its approved binding, then a session against a (possibly different) live chain. */
async function setup({ live = fakeChain(), reviewedOn = fakeChain(), commit = COMMIT, device = RECIPIENT, env = {}, mutatePlan } = {}) {
  const reviewedPlan = JSON.parse(JSON.stringify(await planOn(reviewedOn)));
  const approvedBinding = bindPlan(KIND, reviewedPlan, COMMIT);
  if (mutatePlan) mutatePlan(reviewedPlan);
  const session = await createSigningSession({
    kind: KIND, reviewedPlan, approvedBinding, commit, recipientVerifiedOnDevice: device, env,
    replan: (inputs) => planOn(live, inputs), verifyOptions: { load: artifacts },
  });
  return { session, live, reviewedPlan, approvedBinding };
}

/** What Rabby does after the owner approves: the chain mines the request, and the factory/marketplace views exist. */
function mineAsWallet(chain, session, n, overrides) {
  const hash = chain.mine(session.steps[n - 1].request, overrides);
  const [factory, marketplace] = session.plan.transactions;
  if (n === 1) chain.factoryViews(factory.predictedAddress, { implementation: factory.predictedImplementation });
  else chain.marketplaceViews(marketplace.predictedAddress, { registry: factory.predictedAddress });
  return hash;
}

describe("owner signing session: refuses before anything reaches the wallet", () => {
  it("starts only when the reviewed plan, the binding and a fresh plan agree on the checked-out commit", async () => {
    const { session } = await setup();
    expect(session).toMatchObject({ kind: KIND, commit: COMMIT });
    expect(session.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
  });

  it("refuses any private key in the environment", async () => {
    await expect(setup({ env: { DEPLOYER_PRIVATE_KEY: `0x${"44".repeat(32)}` } })).rejects.toThrow(/never reads a private key/);
  });

  it("refuses a reviewed plan that does not produce the approved binding", async () => {
    await expect(setup({ mutatePlan: (plan) => { plan.signingRequests[0].dataHash = `0x${"ff".repeat(32)}`; } })).rejects.toThrow(/does not produce the approved binding/);
  });

  it("refuses another commit", async () => {
    await expect(setup({ commit: "60b71f0f8534fbf2abaaed7ebd1fec5f19ba2ee4" })).rejects.toThrow(/made on/);
  });

  it("refuses when the live chain no longer matches the reviewed plan (the nonce moved)", async () => {
    // The moved nonce fails the fresh plan's own check, so it cannot even be bound.
    await expect(setup({ live: fakeChain({ nonce: 1 }) })).rejects.toThrow(/not ready to sign/);
  });

  it("refuses when the live plan is not ready to sign (unfunded)", async () => {
    await expect(setup({ live: fakeChain({ balance: 0n }) })).rejects.toThrow(/not ready/);
  });

  it("requires the fee recipient exactly as read on the Nano S Plus screen", async () => {
    await expect(setup({ device: "" })).rejects.toThrow(/recipient-verified-on-device/);
    await expect(setup({ device: ARTIST })).rejects.toThrow(/recipient-verified-on-device/);
    await expect(setup({ device: RECIPIENT.toLowerCase() })).resolves.toBeTruthy();
  });

  it("refuses a plan made for any deployer but the defined one", async () => {
    await expect(setup({ mutatePlan: (plan) => { plan.planInputs.EXPECTED_DEPLOYER_ADDRESS = ARTIST; } })).rejects.toThrow(/defined deployer/);
  });

  it("refuses a dirty working tree", () => {
    const exec = (_cmd, args) => (args[0] === "status" ? " M scripts/x.mjs\n" : `${COMMIT}\n`);
    expect(() => checkedOutCommit({ exec })).toThrow(/tracked modifications/);
    expect(checkedOutCommit({ exec: (_cmd, args) => (args[0] === "status" ? "" : `${COMMIT}\n`) })).toBe(COMMIT);
  });
});

describe("owner signing session: one step at a time, verified from chain", () => {
  it("offers step 2 only after step 1 is verified, and writes the record after both", async () => {
    const { session, live } = await setup();
    const replan = () => planOn(live);
    await expect(prepareStep(session, 2, { provider: live, replan })).rejects.toThrow(/only after every earlier step is verified/);
    const prepared = await prepareStep(session, 1, { provider: live, replan });
    expect(prepared.transaction).toEqual({ from: DEPLOYER, data: session.steps[0].request.data, value: "0x0", gas: "0x124f80", nonce: "0x0", chainId: "0xa86a" });
    await expect(prepareStep(session, 1, { provider: live, replan })).rejects.toThrow(/awaiting-wallet/);
    const written = [];
    const writeRecord = async (path, record) => written.push({ path, record });
    await submitStep(session, 1, mineAsWallet(live, session, 1), { provider: live, writeRecord });
    expect(session.steps[0]).toMatchObject({ status: "verified", verified: { address: session.plan.transactions[0].predictedAddress } });
    expect(written).toHaveLength(0);
    await prepareStep(session, 2, { provider: live, replan });
    await submitStep(session, 2, mineAsWallet(live, session, 2), { provider: live, writeRecord });
    expect(session.steps.map((step) => step.status)).toEqual(["verified", "verified"]);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(`deployments/release-per-contract-mainnet-${session.plan.transactions[0].predictedAddress}.json`);
    expect(written[0].record).toMatchObject({ signedBy: { deployer: DEPLOYER }, plan: { sourceCommit: COMMIT, digest: session.digest }, marketplace: { factoryAddress: session.plan.transactions[0].predictedAddress } });
  });

  it("stops everything when a mined transaction differs from the review", async () => {
    const { session, live } = await setup();
    await prepareStep(session, 1, { provider: live });
    const step = await submitStep(session, 1, mineAsWallet(live, session, 1, { tx: { data: "0x6001600155ff" } }), { provider: live });
    expect(step).toMatchObject({ status: "failed", error: expect.stringMatching(/creation data hash/) });
    await expect(prepareStep(session, 2, { provider: live })).rejects.toThrow(/failed verification/);
  });

  it("re-checks the live chain before each signature", async () => {
    const { session, live } = await setup();
    live.state.pendingNonce = 1;
    await expect(prepareStep(session, 1, { provider: live })).rejects.toThrow(/pending transactions/);
    expect(session.steps[0].status).toBe("pending");
  });

  it("re-matches a fresh plan to the approval before the first signature", async () => {
    const { session, live } = await setup();
    await expect(prepareStep(session, 1, { provider: live, replan: () => planOn(fakeChain({ nonce: 3 })) })).rejects.toThrow(/not ready to sign|differs from the approved plan/);
    // A ready fresh plan that differs from the approval (another nonce) is refused by the comparison.
    await expect(prepareStep(session, 1, { provider: live, replan: () => planOn(fakeChain({ nonce: 3 }), { ...INPUTS, EXPECTED_DEPLOYER_NONCE: "3" }) })).rejects.toThrow(/differs from the approved plan/);
    expect(session.steps[0].status).toBe("pending");
  });

  it("lets the owner retry after rejecting in Rabby, and accepts a hash only for a step handed to the wallet", async () => {
    const { session, live } = await setup();
    await expect(submitStep(session, 1, `0x${"1".repeat(64)}`, { provider: live })).rejects.toThrow(/not handed to the wallet/);
    await prepareStep(session, 1, { provider: live });
    cancelStep(session, 1);
    expect(session.steps[0].status).toBe("pending");
    await prepareStep(session, 1, { provider: live });
    await expect(submitStep(session, 1, "0x12", { provider: live })).rejects.toThrow(/32-byte/);
  });

  it("shows the page public facts only", async () => {
    const { session } = await setup();
    const view = sessionView(session);
    expect(view).toMatchObject({ chainId: 43114, deployer: DEPLOYER, feeRecipient: RECIPIENT, commit: COMMIT });
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE_KEY|privateKey|mnemonic/i);
    expect(view.steps[0]).toMatchObject({ step: 1, nonce: 0, from: DEPLOYER, dataHash: session.steps[0].request.dataHash, gasLimit: "1200000" });
  });
});

function raw(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("owner signing server (loopback only)", () => {
  it("serves the page and runs both steps over HTTP with same-origin requests", async () => {
    const { session, live } = await setup();
    const written = [];
    const handle = createSigningServer(session, { provider: live, replan: () => planOn(live), writeRecord: async (path) => written.push(path), log: () => {} });
    const url = await handle.listen(0);
    const origin = new URL(url).origin;
    const post = (path, body = {}) => raw(new URL(path, url), { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/);
      const page = await raw(url);
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
      expect(page.text).toContain("io.rabby");
      expect((await raw(new URL("ethers.js", url))).status).toBe(200);
      for (const n of [1, 2]) {
        const prepared = await post(`steps/${n}/prepare`);
        expect(prepared.status).toBe(200);
        expect(JSON.parse(prepared.text).transaction.nonce).toBe(`0x${n - 1}`);
        const submitted = await post(`steps/${n}/submitted`, { hash: mineAsWallet(live, session, n) });
        expect([200, 202]).toContain(submitted.status);
        for (let i = 0; i < 50 && session.steps[n - 1].status === "submitted"; i += 1) await new Promise((r) => setTimeout(r, 10));
        expect(JSON.parse((await raw(new URL("session", url))).text).steps[n - 1].status).toBe("verified");
      }
      expect(written).toEqual([`deployments/release-per-contract-mainnet-${session.plan.transactions[0].predictedAddress}.json`]);
    } finally {
      await handle.close();
    }
  });

  it("refuses cross-origin writes, another Host header and requests without the session token", async () => {
    const { session, live } = await setup();
    const handle = createSigningServer(session, { provider: live, log: () => {} });
    const url = await handle.listen(0);
    try {
      expect((await raw(new URL("steps/1/prepare", url), { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
      expect((await raw(new URL("steps/1/prepare", url), { method: "POST", body: "{}" })).status).toBe(403);
      expect((await raw(url, { headers: { host: "attacker.example:80" } })).status).toBe(421);
      expect((await raw(new URL("/s/00000000000000000000000000000000/session", url))).status).toBe(404);
      expect(session.steps[0].status).toBe("pending");
    } finally {
      await handle.close();
    }
  });
});

describe("verify command", () => {
  it("re-verifies mined transactions against the reviewed plan file from the RPC alone", async () => {
    const { session, live, reviewedPlan, approvedBinding } = await setup();
    const hashes = [mineAsWallet(live, session, 1), mineAsWallet(live, session, 2)];
    const dir = mkdtempSync(join(tmpdir(), "void-verify-"));
    writeFileSync(join(dir, "plan.json"), JSON.stringify(reviewedPlan));
    writeFileSync(join(dir, "binding.json"), JSON.stringify(approvedBinding));
    const original = KINDS[KIND].verifyStep;
    KINDS[KIND].verifyStep = (provider, plan, step, hash, options) => original(provider, plan, step, hash, { ...options, load: artifacts });
    try {
      const result = await verifyCommand({ kind: KIND, plan: join(dir, "plan.json"), binding: join(dir, "binding.json"), tx: hashes }, { providers: { provider: live } });
      expect(result).toMatchObject({ mode: "VERIFIED", record: { plan: { sourceCommit: COMMIT, digest: approvedBinding.digest }, factory: { address: getAddress(reviewedPlan.transactions[0].predictedAddress) } } });
      await expect(verifyCommand({ kind: KIND, plan: join(dir, "plan.json"), tx: hashes.slice(0, 1) }, { providers: { provider: live } })).rejects.toThrow(/one --tx per planned step/);
    } finally {
      KINDS[KIND].verifyStep = original;
    }
  });
});
