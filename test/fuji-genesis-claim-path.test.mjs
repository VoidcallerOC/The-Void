import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Interface, getAddress, getCreateAddress, id } from "ethers";
import { describe, expect, it } from "vitest";
import { validateApprovedPlan } from "../scripts/approved-plan.mjs";
import { CLAIM_INTERFACE, expectedClaimParameters } from "../scripts/claim-onchain-checks.mjs";
import { FUJI_CLAIM_ARTIST, FUJI_CLAIM_KIND, FUJI_GENESIS_VOUCHER_SIGNER, FORBIDDEN_PLACEHOLDER_SIGNER } from "../scripts/fuji-genesis-claim.mjs";
import { buildFujiClaimEntry } from "../scripts/fuji-genesis-claim-plan.mjs";
import { NETWORK_PROFILES, profileOfKind } from "../scripts/network-profiles.mjs";
import { bindPlan } from "../scripts/plan-binding-core.mjs";
import { GENESIS_CONTRACT } from "../server/genesis-claim.js";
import { confirmStep, initialState, nextAction, readiness, recordRejected, recordSubmitted, requestApproval } from "../src/owner-deploy/flow.js";
import { ARTIST, DEPLOYER, RECIPIENT, fakeChain } from "./helpers/mainnet-fake-chain.mjs";

// The Fuji Genesis claim deployment path: the claim is deployed by the Rabby deployer with the artist as
// admin and a PLACEHOLDER voucher signer. Fuji only, separate from every mainnet plan.
const ROOT = resolve(import.meta.dirname, "..");
const COMMIT = "2222222222222222222222222222222222222222";
const RELEASE = getAddress("0x2222222222222222222222222222222222222222");
const SALE = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN = 777n;
const NOW = 1_800_000_000;
const CLAIM_START = NOW + 3600;
const CLAIM_END = CLAIM_START + 300;
// The sale opens with the claims and closes 600 s after CLAIM_START (inclusive end).
const PUBLIC_END = CLAIM_START + 600 - 1;
const PRICE = 10_000_000_000_000_000n;
const NONCE = 72;
const PREDICTED = getCreateAddress({ from: DEPLOYER, nonce: NONCE });
const ARTIFACT = { abi: [{ type: "constructor", inputs: new Array(11).fill({ type: "uint256" }) }], bytecode: { object: "0x6080" }, deployedBytecode: { object: "0x6001" } };
const clone = (value) => JSON.parse(JSON.stringify(value));

const release = new Interface([
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
  "function mintEndOf(uint256 tokenId) view returns (uint64)", "function ISSUER_ROLE() view returns (bytes32)", "function owner() view returns (address)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const sale = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);

/** Fuji with the artist's open-edition release and its scheduled sale; the deployer sits at nonce 72. */
function fuji({ now = NOW, owner = ARTIST, adminHolders = [ARTIST], maxSupply = 0n, saleStart = CLAIM_START, constructorReverts = false, chainId = 43113n, nonce = NONCE, pendingNonce, balance } = {}) {
  const chain = fakeChain({ chainId, nonce, pendingNonce, balance, code: { [RELEASE]: "0x6001", [SALE]: "0x6001" } });
  const base = chain.call;
  chain.call = async (tx) => {
    if (!tx.to) { if (constructorReverts) throw Object.assign(new Error("reverted"), { shortMessage: "execution reverted: PublicSaleSchedule" }); return "0x"; }
    return base(tx);
  };
  chain.getBlock = async () => ({ number: 59_400_000, timestamp: now });
  const holders = adminHolders.map(getAddress);
  chain.state.views[RELEASE] = (data) => {
    const fn = release.parseTransaction({ data }).name;
    if (fn === "maxSupplyOf") return release.encodeFunctionResult(fn, [maxSupply]);
    if (fn === "mintEndOf") return release.encodeFunctionResult(fn, [BigInt(PUBLIC_END)]);
    if (fn === "ISSUER_ROLE") return release.encodeFunctionResult(fn, [id("ISSUER_ROLE")]);
    if (fn === "owner") return release.encodeFunctionResult(fn, [owner]);
    if (fn === "hasRole") { const [, account] = release.decodeFunctionData("hasRole", data); return release.encodeFunctionResult(fn, [holders.includes(getAddress(account))]); }
    return release.encodeFunctionResult(fn, [[id("release"), id("edition"), ARTIST, maxSupply, 0n, "ipfs://x", true]]);
  };
  chain.state.views[SALE] = (data) => {
    const fn = sale.parseTransaction({ data }).name;
    if (fn === "releases") return sale.encodeFunctionResult(fn, [RELEASE]);
    return sale.encodeFunctionResult(fn, [PRICE, 0n, 0n, 0n, BigInt(saleStart), BigInt(PUBLIC_END), false, true]);
  };
  return chain;
}
const cChain = () => ({ send: async () => "0xa86a", getCode: async (address) => (address.toLowerCase() === GENESIS_CONTRACT.toLowerCase() ? "0x6080" : "0x") });
const build = (chain = fuji(), overrides = {}) => buildFujiClaimEntry({ release: RELEASE, sale: SALE, token: TOKEN, claimStart: CLAIM_START, commit: COMMIT, provider: chain, genesisProvider: cChain(), artifact: ARTIFACT, ...overrides });

/** The claim as it exists once Rabby's transaction is mined: views answer from the plan, with overrides. */
function claimViews(chain, plan, overrides = {}) {
  const values = { ...expectedClaimParameters(plan), paused: false, ...overrides };
  chain.state.views[getAddress(plan.predictedClaimAddress)] = (data) => { const fn = CLAIM_INTERFACE.parseTransaction({ data }).name; return CLAIM_INTERFACE.encodeFunctionResult(fn, [values[fn]]); };
}
const mainnetPlan = JSON.parse(readFileSync(resolve(ROOT, "deploy/mainnet/approved-plans/release-per-contract-mainnet.json"), "utf8"));

describe("Fuji claim plan", () => {
  it("is one zero-value claim creation from the Rabby deployer, with the artist as admin and the dedicated Genesis voucher signer", async () => {
    const { plan, kind } = await build();
    expect(kind).toBe(FUJI_CLAIM_KIND);
    const [request] = plan.signingRequests;
    expect(request).toMatchObject({ chainId: 43113, from: DEPLOYER, to: null, nonce: NONCE, value: "0", predictedAddress: PREDICTED });
    expect(plan).toMatchObject({ network: "fuji", chainId: 43113, deployer: DEPLOYER, predictedClaimAddress: PREDICTED });
    expect(plan.roles).toEqual({ admin: FUJI_CLAIM_ARTIST, signer: FUJI_GENESIS_VOUCHER_SIGNER });
    expect(plan.supply).toMatchObject({ claimAllocation: "0", publicAllocation: "0" });
    expect(plan.followUps.issuerGrant.from).toBe(ARTIST);
    expect(plan.schedule).toMatchObject({ claimStart: String(CLAIM_START), claimWindowSeconds: "300", claimEnd: String(CLAIM_END), publicSaleStart: String(CLAIM_START), publicWindowSeconds: "600", publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString() });
    expect(BigInt(plan.cost.maxCostWei)).toBe(BigInt(request.gasLimit) * 10_000_000_000n);
    // The deployer and artist stay separate; neither the Nano nor the placeholder holds any role.
    expect(new Set([DEPLOYER, ARTIST, RECIPIENT, FUJI_GENESIS_VOUCHER_SIGNER]).size).toBe(4);
    expect(plan.roles.admin).not.toBe(DEPLOYER);
  });

  it.each([
    ["a release the deployer owns", () => fuji({ owner: DEPLOYER, adminHolders: [DEPLOYER] }), /not the artist wallet/],
    ["a release whose owner lacks the admin role", () => fuji({ adminHolders: [] }), /does not hold DEFAULT_ADMIN_ROLE/],
    ["a release the deployer also administers", () => fuji({ adminHolders: [ARTIST, DEPLOYER] }), /deployer holds DEFAULT_ADMIN_ROLE/],
    ["a release the Nano administers", () => fuji({ adminHolders: [ARTIST, RECIPIENT] }), /fee recipient holds DEFAULT_ADMIN_ROLE/],
    ["a capped edition", () => fuji({ maxSupply: 10n }), /capped edition/],
    ["a sale that does not open with the claims", () => fuji({ saleStart: CLAIM_START + 1 }), /Sale startTime/],
    ["a sale that only opens when claims close", () => fuji({ saleStart: CLAIM_END }), /Sale startTime/],
    ["a claim start under ten minutes ahead", () => fuji({ now: CLAIM_START - 599 }), /less than 600 seconds/],
    ["a constructor that reverts", () => fuji({ constructorReverts: true }), /constructor reverted/],
    ["another chain", () => fuji({ chainId: 43114n }), /chain|Refusing|43114/i],
    ["pending deployer transactions", () => fuji({ pendingNonce: NONCE + 1 }), /pending/],
  ])("is never planned for %s", async (_name, chain, message) => {
    await expect(build(chain())).rejects.toThrow(message);
  });
});

describe("chain separation, both directions", () => {
  it("the Fuji validator accepts only the Fuji claim plan, and the mainnet validator refuses it", async () => {
    const entry = await build();
    expect(() => validateApprovedPlan(entry, "fuji")).not.toThrow();
    expect(() => validateApprovedPlan(entry)).toThrow(/Unknown plan kind genesis-claim-fuji for Avalanche C-Chain/);
    expect(profileOfKind(FUJI_CLAIM_KIND)).toBe(NETWORK_PROFILES.fuji);
    expect(NETWORK_PROFILES.mainnet.kinds).not.toContain(FUJI_CLAIM_KIND);
    expect(() => validateApprovedPlan(mainnetPlan, "fuji")).toThrow(/Unknown plan kind/);
  });

  it("a Fuji claim plan relabelled as mainnet, or moved to chain 43114, does not bind or validate", async () => {
    const entry = await build();
    expect(() => bindPlan("genesis-claim-mainnet", entry.plan, COMMIT)).toThrow(/Not a C-Chain mainnet/);
    expect(() => bindPlan("release-per-contract-mainnet", entry.plan, COMMIT)).toThrow(/Not a C-Chain mainnet/);
    const moved = clone(entry);
    moved.plan.network = "mainnet";
    moved.plan.chainId = 43114;
    moved.plan.signingRequests[0].chainId = 43114;
    expect(() => validateApprovedPlan(moved, "fuji")).toThrow(/Not a Fuji dry-run plan/);
    const request = clone(entry);
    request.plan.signingRequests[0].chainId = 43114;
    expect(() => bindPlan(FUJI_CLAIM_KIND, request.plan, COMMIT)).toThrow(/on chain 43113/);
    expect(bindPlan(FUJI_CLAIM_KIND, entry.plan, COMMIT).digest).not.toBe(bindPlan("genesis-claim-mainnet", { ...clone(entry.plan), network: "mainnet", chainId: 43114, signingRequests: entry.plan.signingRequests.map((r) => ({ ...r, chainId: 43114 })) }, COMMIT).digest);
  });

  it("refuses a claim plan changed after approval, or with another admin, a real signer, a cap or a foreign grant", async () => {
    const original = await build();
    const rebound = (mutate) => { const copy = clone(original); mutate(copy); copy.binding = bindPlan(FUJI_CLAIM_KIND, copy.plan, COMMIT); return copy; };
    const cases = [
      [(e) => { e.plan.signingRequests[0].data = `${e.plan.signingRequests[0].data}00`; }, /does not hash/, false],
      [(e) => { e.plan.schedule.claimStart = "1"; }, /changed after approval/, false],
      [(e) => { e.plan.roles.admin = DEPLOYER; }, /admin must be the artist wallet/, true],
      [(e) => { e.plan.roles.signer = getAddress("0x5555555555555555555555555555555555555555"); }, /must deploy the dedicated voucher signer/, true],
      [(e) => { e.plan.supply.claimAllocation = "10"; }, /uncapped open edition/, true],
      [(e) => { e.plan.followUps.issuerGrant.from = DEPLOYER; }, /grant must come from the artist/, true],
    ];
    for (const [mutate, message, rebind] of cases) {
      const copy = rebind ? rebound(mutate) : (() => { const c = clone(original); mutate(c); return c; })();
      expect(() => validateApprovedPlan(copy, "fuji")).toThrow(message);
    }
  });
});

describe("dedicated voucher signer", () => {
  it("is 0x3C7c…4E47: distinct from the deployer, artist and fee recipient, and never the dead placeholder", () => {
    expect(FUJI_GENESIS_VOUCHER_SIGNER).toBe("0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47");
    expect(FORBIDDEN_PLACEHOLDER_SIGNER).toBe("0x000000000000000000000000000000000000dEaD");
    expect(FUJI_GENESIS_VOUCHER_SIGNER).not.toBe(FORBIDDEN_PLACEHOLDER_SIGNER);
    for (const wallet of [DEPLOYER, ARTIST, RECIPIENT]) expect(wallet).not.toBe(FUJI_GENESIS_VOUCHER_SIGNER);
  });
});

describe("Fuji claim deployment through the page flow", () => {
  async function setup(options) {
    const chain = fuji(options);
    const entry = validateApprovedPlan(await build(chain), "fuji");
    return { chain, entry, state: initialState(entry) };
  }
  const mine = (chain, entry, state, overrides = {}, views = {}) => {
    const hash = chain.mine(state.steps[0].request, overrides);
    claimViews(chain, entry.plan, views);
    return hash;
  };

  it("is ready, hands Rabby the Fuji creation, and is confirmed only after the claim is read back", async () => {
    const { chain, entry, state } = await setup();
    const ready = await readiness(chain, entry, state, 1);
    expect(ready.ready).toBe(true);
    expect(ready.checks.map((c) => c.name)).toEqual(expect.arrayContaining([expect.stringMatching(/Claim start is at least 120s ahead/), expect.stringMatching(/constructor simulation passes/)]));
    const tx = await requestApproval(chain, entry, state, 1);
    expect(tx).toMatchObject({ from: DEPLOYER, chainId: "0xa869", nonce: "0x48", value: "0x0" });
    expect(tx).not.toHaveProperty("to");
    recordSubmitted(state, 1, mine(chain, entry, state));
    await confirmStep(chain, entry, state, 1, { timeoutMs: 50 });
    expect(state.steps[0].status).toBe("confirmed");
    expect(state.steps[0].verified).toMatchObject({ address: PREDICTED, admin: ARTIST, signer: FUJI_GENESIS_VOUCHER_SIGNER, paused: false, issuerGrant: "PENDING (artist operation)" });
    expect(nextAction(entry, state, { connected: true })).toMatch(/NOT usable yet.*dedicated.*0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47/);
  });

  it("goes stale instead of wasting gas: too close to the claim start, a failing constructor, a moved nonce, another chain", async () => {
    const { entry } = await setup();
    const check = async (chain, pattern) => {
      const ready = await readiness(chain, entry, initialState(entry), 1);
      expect(ready.ready).toBe(false);
      expect(ready.checks.filter((c) => !c.ok).map((c) => c.name).join(";")).toMatch(pattern);
    };
    await check(fuji({ now: CLAIM_START - 60 }), /Claim start is at least 120s/);
    await check(fuji({ constructorReverts: true }), /constructor simulation/);
    await check(fuji({ nonce: NONCE + 1 }), /nonce/);
    await check(fuji({ chainId: 43114n }), /Chain is Avalanche Fuji/);
    await expect(requestApproval(fuji({ chainId: 43114n }), entry, initialState(entry), 1)).rejects.toThrow(/chain 43114, not 43113/);
  });

  it("returns to prepared when the owner rejects, and refuses a duplicate or second hash", async () => {
    const { chain, entry, state } = await setup();
    await requestApproval(chain, entry, state, 1);
    recordRejected(state, 1);
    expect(state.steps[0].status).toBe("prepared");
    await requestApproval(chain, entry, state, 1);
    await expect(requestApproval(chain, entry, state, 1)).rejects.toThrow(/awaiting-wallet/);
    recordSubmitted(state, 1, mine(chain, entry, state));
    expect(() => recordSubmitted(state, 1, `0x${"ab".repeat(32)}`)).toThrow(/already has transaction/);
  });

  it("stops when the mined claim differs from the plan: another signer, admin, schedule, or already paused", async () => {
    const wrong = getAddress("0x5555555555555555555555555555555555555555");
    for (const [views, pattern] of [[{ signer: wrong }, /signer/], [{ admin: DEPLOYER }, /admin/], [{ claimStart: String(CLAIM_START + 1) }, /claimStart/], [{ publicPriceWei: "1" }, /publicPriceWei/], [{ tokenId: "778" }, /tokenId/]]) {
      const { chain, entry, state } = await setup();
      await requestApproval(chain, entry, state, 1);
      recordSubmitted(state, 1, mine(chain, entry, state, {}, views));
      await confirmStep(chain, entry, state, 1, { timeoutMs: 50 });
      expect(state.steps[0].status).toBe("failed");
      expect(state.steps[0].error).toMatch(pattern);
      expect(nextAction(entry, state, { connected: true })).toMatch(/^Stop\./);
    }
  });

  it("stops on a mined transaction that is not the reviewed creation", async () => {
    for (const overrides of [{ tx: { data: "0x6080" } }, { tx: { chainId: 43114n } }, { status: 0 }, { tx: { from: ARTIST } }]) {
      const { chain, entry, state } = await setup();
      await requestApproval(chain, entry, state, 1);
      recordSubmitted(state, 1, mine(chain, entry, state, overrides));
      await confirmStep(chain, entry, state, 1, { timeoutMs: 50 });
      expect(state.steps[0].status).toBe("failed");
    }
  });

  it("keeps a not-yet-mined hash submitted, and re-verifies it after a reload", async () => {
    const { chain, entry, state } = await setup();
    await requestApproval(chain, entry, state, 1);
    const pending = `0x${"0".repeat(63)}1`;
    recordSubmitted(state, 1, pending);
    await confirmStep(chain, entry, state, 1, { timeoutMs: 20 });
    expect(state.steps[0]).toMatchObject({ status: "submitted", error: expect.stringMatching(/Not confirmed yet/) });
    expect(mine(chain, entry, state)).toBe(pending);
    const reloaded = initialState(entry, { 1: pending });
    await confirmStep(chain, entry, reloaded, 1, { timeoutMs: 50 });
    expect(reloaded.steps[0].status).toBe("confirmed");
  });
});

describe("the Fuji page serves claim plans without any key", () => {
  const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
  it("shows the dedicated signer and the deferred steps, and the generator refuses any private key", () => {
    expect(read("src/owner-deploy/page.js")).toMatch(/dedicated Genesis voucher signer/);
    expect(read("src/owner-deploy/page.js")).toMatch(/ISSUER_ROLE grant to the claim, the server signing secret, the Render configuration and activation/);
    expect(read("scripts/fuji-genesis-claim-plan.mjs")).toMatch(/assertNoPrivateKeyInEnv\(process\.env, "Fuji claim planning"\)/);
    expect(read("scripts/fuji-genesis-claim-plan.mjs")).not.toMatch(/new Wallet|sendTransaction|signTransaction/);
  });
});

const PLAN_FILE = resolve(ROOT, "deploy/fuji/approved-plans/genesis-claim-fuji.json");
describe.runIf(existsSync(PLAN_FILE))("committed Fuji claim plan", () => {
  it("is valid for Fuji only", () => {
    const entry = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
    expect(() => validateApprovedPlan(entry, "fuji")).not.toThrow();
    expect(() => validateApprovedPlan(entry)).toThrow(/Unknown plan kind/);
  });
});
