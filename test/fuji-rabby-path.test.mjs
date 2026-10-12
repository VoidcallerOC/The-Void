import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Interface, getAddress, getCreateAddress, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { validateApprovedPlan } from "../scripts/approved-plan.mjs";
import { PROBE_ARTIFACT_PATH, PROBE_KIND, PROBE_LABEL, buildProbePlan, probeCreationData } from "../scripts/fuji-rabby-probe.mjs";
import { NETWORK_PROFILES, profileOfKind } from "../scripts/network-profiles.mjs";
import { bindPlan, verifyBinding } from "../scripts/plan-binding-core.mjs";
import { confirmStep, connectionCheck, initialState, loadApprovedPlans, nextAction, readiness, recordRejected, recordSubmitted, requestApproval, rpcFromQuery } from "../src/owner-deploy/flow.js";
import { ARTIST, DEPLOYER, RECIPIENT, fakeChain } from "./helpers/mainnet-fake-chain.mjs";

// The Fuji Rabby test path: its own network profile, plan kind, binding and page, with no route from
// a Fuji plan to a mainnet signature or from a mainnet plan to the Fuji page.
const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const COMMIT = "1111111111111111111111111111111111111111";
const ARTIFACT = { bytecode: { object: "0x60806040" }, deployedBytecode: { object: "0x6001" } };
const VIEWS = new Interface(["function label() view returns (bytes32)", "function creator() view returns (address)"]);
const FUJI = NETWORK_PROFILES.fuji;
const MAINNET_PLAN = JSON.parse(read("deploy/mainnet/approved-plans/release-per-contract-mainnet.json"));
const clone = (value) => JSON.parse(JSON.stringify(value));

/** A Fuji chain where the deployer sits at nonce 71; the probe answers its views once mined. */
function fujiChain(options = {}) {
  const chain = fakeChain({ chainId: 43113n, nonce: 71, ...options });
  chain.getBlockNumber = async () => 59_350_812;
  const funded = chain.getBalance;
  chain.getBalance = async (address) => (getAddress(address) === DEPLOYER ? funded(address) : 0n);
  chain.probeViews = (address, { label = PROBE_LABEL, creator = DEPLOYER } = {}) => {
    chain.state.views[getAddress(address)] = (data) => {
      const name = VIEWS.parseTransaction({ data }).name;
      return VIEWS.encodeFunctionResult(name, [name === "label" ? label : creator]);
    };
  };
  return chain;
}

async function fujiEntry(chain = fujiChain()) {
  const plan = clone(await buildProbePlan(chain, ARTIFACT, { now: new Date(0) }));
  return { kind: PROBE_KIND, plan, binding: bindPlan(PROBE_KIND, plan, COMMIT) };
}

describe("Fuji network profile", () => {
  it("is a separate chain, RPC, explorer, plan directory and plan kind from mainnet", () => {
    const { mainnet, fuji } = NETWORK_PROFILES;
    expect(fuji.chainId).toBe(43113);
    expect(mainnet.chainId).toBe(43114);
    for (const key of ["rpc", "explorer", "plansDir"]) expect(fuji[key]).not.toBe(mainnet[key]);
    expect(fuji.kinds.filter((kind) => mainnet.kinds.includes(kind))).toEqual([]);
    expect(profileOfKind(PROBE_KIND)).toBe(fuji);
    expect(profileOfKind("release-per-contract-mainnet")).toBe(mainnet);
    // The test uses the same Rabby account that will sign mainnet; never the artist or the Nano.
    expect(fuji.deployer).toBe(DEPLOYER);
    expect([ARTIST, RECIPIENT]).not.toContain(fuji.deployer);
  });

  it("uses the public Fuji RPC, and only a local node instead", () => {
    expect(rpcFromQuery("", FUJI)).toEqual({ url: FUJI.rpc, override: false });
    expect(() => rpcFromQuery("?rpc=https://api.avax.network/ext/bc/C/rpc", FUJI)).toThrow(/Only a local node/);
  });
});

describe("Fuji test plan", () => {
  it("is one zero-value creation of the probe at the deployer's live Fuji nonce, with its cost", async () => {
    const { plan } = await fujiEntry();
    const [request] = plan.signingRequests;
    expect(request).toMatchObject({ chainId: 43113, from: DEPLOYER, to: null, nonce: 71, value: "0", data: probeCreationData(ARTIFACT) });
    expect(request.predictedAddress).toBe(getCreateAddress({ from: DEPLOYER, nonce: 71 }));
    expect(plan.probe.label).toBe(PROBE_LABEL);
    expect(BigInt(plan.cost.maxCostWei)).toBe(BigInt(request.gasLimit) * 10_000_000_000n);
  });

  it("is never planned from another chain, with pending transactions, or onto existing code", async () => {
    await expect(buildProbePlan(fakeChain({ nonce: 71 }), ARTIFACT)).rejects.toThrow(/not Fuji/);
    await expect(buildProbePlan(fujiChain({ pendingNonce: 72 }), ARTIFACT)).rejects.toThrow(/pending/);
    await expect(buildProbePlan(fujiChain({ code: { [getCreateAddress({ from: DEPLOYER, nonce: 71 })]: "0x60" } }), ARTIFACT)).rejects.toThrow(/already has code/);
  });
});

describe("chain separation, both directions", () => {
  it("the Fuji page refuses the mainnet plan and the mainnet page refuses the Fuji plan", async () => {
    const fuji = await fujiEntry();
    expect(() => validateApprovedPlan(fuji, "fuji")).not.toThrow();
    expect(() => validateApprovedPlan(fuji)).toThrow(/Unknown plan kind rabby-probe-fuji for Avalanche C-Chain/);
    expect(() => validateApprovedPlan(fuji, "mainnet")).toThrow(/Unknown plan kind/);
    expect(() => validateApprovedPlan(MAINNET_PLAN, "fuji")).toThrow(/Unknown plan kind release-per-contract-mainnet for Avalanche Fuji/);
    const [m, f] = loadApprovedPlans({ "m.json": MAINNET_PLAN, "f.json": fuji }, "fuji");
    expect(m.error).toMatch(/Unknown plan kind/);
    expect(f.error).toBeNull();
    expect(loadApprovedPlans({ "f.json": fuji }, "mainnet")[0].error).toMatch(/Unknown plan kind/);
  });

  it("a Fuji plan relabelled as mainnet, or a mainnet plan as Fuji, does not bind", async () => {
    const fuji = await fujiEntry();
    expect(() => bindPlan("release-per-contract-mainnet", fuji.plan, COMMIT)).toThrow(/Not a C-Chain mainnet/);
    expect(() => bindPlan("genesis-claim-mainnet", fuji.plan, COMMIT)).toThrow(/Not a C-Chain mainnet/);
    expect(() => bindPlan(PROBE_KIND, MAINNET_PLAN.plan, COMMIT)).toThrow(/Not a Fuji dry-run plan/);
    const moved = clone(fuji);
    moved.plan.chainId = 43114;
    moved.plan.signingRequests[0].chainId = 43114;
    expect(() => validateApprovedPlan(moved, "fuji")).toThrow(/Not a Fuji dry-run plan/);
    const request = clone(fuji);
    request.plan.signingRequests[0].chainId = 43114;
    expect(() => bindPlan(PROBE_KIND, request.plan, COMMIT)).toThrow(/on chain 43113/);
    expect(() => verifyBinding(MAINNET_PLAN.binding, PROBE_KIND, fuji.plan, COMMIT)).toThrow(/is for release-per-contract-mainnet/);
  });

  it("refuses a Fuji plan changed after approval, for another account, or not the probe", async () => {
    const original = await fujiEntry();
    const cases = [
      [(e) => { e.plan.signingRequests[0].data = `${e.plan.signingRequests[0].data}00`; }, /does not hash/],
      [(e) => { e.plan.deployer.nonce = 72; }, /disagrees with the plan/],
      [(e) => { e.plan.probe.initCodeHash = `0x${"11".repeat(32)}`; }, /changed after approval/],
      [(e) => { e.plan.probe.label = `0x${"00".repeat(32)}`; e.binding = bindPlan(PROBE_KIND, e.plan, COMMIT); }, /not the RabbySigningProbe/],
      [(e) => { e.plan.deployer.address = ARTIST; e.plan.signingRequests[0].from = ARTIST; e.binding = bindPlan(PROBE_KIND, e.plan, COMMIT); }, /not the defined deployer/],
    ];
    for (const [mutate, message] of cases) {
      const copy = clone(original);
      mutate(copy);
      expect(() => validateApprovedPlan(copy, "fuji")).toThrow(message);
    }
  });

  it("the mainnet bundle holds only mainnet plans, the Fuji bundle only Fuji plans, and neither switches network", () => {
    expect(read("src/owner-deploy/main.js")).toMatch(/startPage\("mainnet", import\.meta\.glob\("\.\.\/\.\.\/deploy\/mainnet\/approved-plans\/\*\.json"/);
    expect(read("src/owner-deploy/main.js")).not.toMatch(/fuji/i);
    expect(read("src/owner-deploy/fuji-main.js")).toMatch(/startPage\("fuji", import\.meta\.glob\("\.\.\/\.\.\/deploy\/fuji\/approved-plans\/\*\.json"/);
    expect(read("src/owner-deploy/fuji-main.js")).not.toMatch(/mainnet\/approved-plans/);
    expect(read("owner-deploy.html")).toContain('src="/src/owner-deploy/main.js"');
    expect(read("fuji-rabby-test.html")).toContain('src="/src/owner-deploy/fuji-main.js"');
    expect(read("fuji-rabby-test.html")).toMatch(/FUJI TESTNET ONLY/);
    for (const file of readdirSync(resolve(ROOT, "src/owner-deploy"))) {
      expect(read(`src/owner-deploy/${file}`)).not.toMatch(/wallet_switchEthereumChain|wallet_addEthereumChain/);
    }
  });

  it("serves /fuji-rabby-test with the owner page's headers on the Fuji project only, never in the mainnet build", () => {
    const config = JSON.parse(read("vercel.json"));
    expect(config.rewrites).toContainEqual({ source: "/fuji-rabby-test", destination: "/fuji-rabby-test.html" });
    expect(config.headers.find((h) => h.source === "/(owner-deploy|fuji-rabby-test)(.html)?").headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
    expect(read("deploy/vercel-mainnet/vercel.json")).not.toMatch(/fuji/);
    expect(read("vite.config.js")).toMatch(/process\.env\.VITE_RELEASE_NETWORK === 'mainnet' \? \{\} : \{ fujiRabbyTest: 'fuji-rabby-test\.html' \}/);
  });
});

describe("Rabby connection check (no transaction)", () => {
  it("passes only for Rabby, the deployer, on the page's own chain", () => {
    expect(connectionCheck(FUJI, { rabbyFound: true, account: DEPLOYER.toLowerCase(), chainId: 43113 }).ok).toBe(true);
    const failing = (input) => connectionCheck(FUJI, input).checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failing({ rabbyFound: false })).toEqual(["Rabby detected", `Account is the deployer ${DEPLOYER}`, "Chain is Avalanche Fuji testnet (43113)"]);
    expect(failing({ rabbyFound: true, account: ARTIST, chainId: 43113 })).toEqual([`Account is the deployer ${DEPLOYER}`]);
    expect(failing({ rabbyFound: true, account: DEPLOYER, chainId: 43114 })).toEqual(["Chain is Avalanche Fuji testnet (43113)"]);
    expect(connectionCheck(NETWORK_PROFILES.mainnet, { rabbyFound: true, account: DEPLOYER, chainId: 43113 }).ok).toBe(false);
  });
});

describe("Fuji test transaction through the page flow", () => {
  async function setup(options) {
    const chain = fujiChain(options);
    const entry = validateApprovedPlan(await fujiEntry(chain), "fuji");
    return { chain, entry, state: initialState(entry) };
  }
  const mine = (chain, state, overrides, views) => {
    const hash = chain.mine(state.steps[0].request, overrides);
    chain.probeViews(state.steps[0].request.predictedAddress, views);
    return hash;
  };

  it("is ready, hands Rabby the Fuji transaction, and is confirmed only after verification", async () => {
    const { chain, entry, state } = await setup();
    const ready = await readiness(chain, entry, state, 1);
    expect(ready.ready).toBe(true);
    expect(ready.checks[0].name).toBe("Chain is Avalanche Fuji testnet (43113)");
    const tx = await requestApproval(chain, entry, state, 1);
    expect(tx).toMatchObject({ from: DEPLOYER, chainId: "0xa869", nonce: "0x47", value: "0x0" });
    expect(tx).not.toHaveProperty("to");
    recordSubmitted(state, 1, mine(chain, state));
    expect(state.steps[0].status).toBe("submitted");
    await confirmStep(chain, entry, state, 1, { timeoutMs: 50 });
    expect(state.steps[0].status).toBe("confirmed");
    expect(state.steps[0].verified).toMatchObject({ label: PROBE_LABEL, creator: DEPLOYER, balanceWei: "0" });
    expect(nextAction(entry, state, { connected: true })).toMatch(/^Test passed.*Fuji.*proves nothing on mainnet/);
  });

  it("returns to prepared when the owner rejects in Rabby", async () => {
    const { chain, entry, state } = await setup();
    await requestApproval(chain, entry, state, 1);
    recordRejected(state, 1);
    expect(state.steps[0].status).toBe("prepared");
  });

  it("refuses a wrong chain, a stale plan, pending transactions and a funded-out deployer", async () => {
    const { entry } = await setup();
    const onMainnet = fakeChain({ chainId: 43114n, nonce: 71 });
    expect((await readiness(onMainnet, entry, initialState(entry), 1)).ready).toBe(false);
    await expect(requestApproval(onMainnet, entry, initialState(entry), 1)).rejects.toThrow(/chain 43114, not 43113/);
    const moved = fujiChain({ nonce: 72 });
    expect((await readiness(moved, entry, initialState(entry), 1)).checks.find((c) => /nonce/.test(c.name)).ok).toBe(false);
    await expect(requestApproval(moved, entry, initialState(entry), 1)).rejects.toThrow(/nonce is 72, not the reviewed 71/);
    await expect(requestApproval(fujiChain({ pendingNonce: 72 }), entry, initialState(entry), 1)).rejects.toThrow(/pending/);
    const empty = fujiChain({ balance: 0n });
    expect((await readiness(empty, entry, initialState(entry), 1)).ready).toBe(false);
  });

  it("refuses a duplicate request or a second hash for the same step", async () => {
    const { chain, entry, state } = await setup();
    await requestApproval(chain, entry, state, 1);
    await expect(requestApproval(chain, entry, state, 1)).rejects.toThrow(/awaiting-wallet/);
    const hash = mine(chain, state);
    recordSubmitted(state, 1, hash);
    recordSubmitted(state, 1, hash.toUpperCase().replace("0X", "0x"));
    expect(() => recordSubmitted(state, 1, `0x${"ab".repeat(32)}`)).toThrow(/already has transaction/);
    await expect(requestApproval(chain, entry, state, 1)).rejects.toThrow(/submitted/);
  });

  it("stops on an incorrect hash: another transaction, or a probe that does not match", async () => {
    for (const [overrides, views, message] of [
      [{ tx: { data: "0x6001" } }, undefined, /creation data hash/],
      [{ tx: { chainId: 43114n } }, undefined, /chainId 43114/],
      [{ status: 0 }, undefined, /receipt status 0/],
      [undefined, { label: `0x${"00".repeat(32)}` }, /mined probe does not match.*label/],
    ]) {
      const { chain, entry, state } = await setup();
      await requestApproval(chain, entry, state, 1);
      recordSubmitted(state, 1, mine(chain, state, overrides, views));
      await confirmStep(chain, entry, state, 1, { timeoutMs: 50 });
      expect(state.steps[0].status).toBe("failed");
      expect(state.steps[0].error).toMatch(message);
      expect(nextAction(entry, state, { connected: true })).toMatch(/^Stop\./);
      await expect(requestApproval(chain, entry, state, 1)).rejects.toThrow(/failed verification/);
    }
  });

  it("keeps a not-yet-mined hash submitted after a timeout, and re-verifies it after a reload", async () => {
    const { chain, entry, state } = await setup();
    await requestApproval(chain, entry, state, 1);
    const pending = `0x${"0".repeat(63)}1`;
    recordSubmitted(state, 1, pending);
    await confirmStep(chain, entry, state, 1, { timeoutMs: 20 });
    expect(state.steps[0]).toMatchObject({ status: "submitted", error: expect.stringMatching(/Not confirmed yet/) });
    expect(mine(chain, state)).toBe(pending);
    const reloaded = initialState(entry, { 1: pending });
    expect(reloaded.steps[0].status).toBe("submitted");
    await confirmStep(chain, entry, reloaded, 1, { timeoutMs: 50 });
    expect(reloaded.steps[0].status).toBe("confirmed");
  });
});

const PLAN_FILE = resolve(ROOT, "deploy/fuji/approved-plans/rabby-probe-fuji.json");
describe("committed Fuji test plan", () => {
  it("is valid for Fuji only, and its creation data is the probe compiled from this commit", () => {
    const entry = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
    expect(() => validateApprovedPlan(entry, "fuji")).not.toThrow();
    expect(() => validateApprovedPlan(entry)).toThrow(/Unknown plan kind/);
    expect(readdirSync(resolve(ROOT, "deploy/mainnet/approved-plans"))).not.toContain("rabby-probe-fuji.json");
    if (!existsSync(resolve(ROOT, PROBE_ARTIFACT_PATH)) && !process.env.CI) return;
    const artifact = JSON.parse(read(PROBE_ARTIFACT_PATH));
    expect(entry.plan.signingRequests[0].data).toBe(probeCreationData(artifact));
    expect(entry.plan.probe.initCodeHash).toBe(keccak256(artifact.bytecode.object));
    expect(entry.plan.probe.runtimeCodeHash).toBe(keccak256(artifact.deployedBytecode.object));
  });
});
