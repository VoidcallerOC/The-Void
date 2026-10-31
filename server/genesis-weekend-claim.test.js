import { Interface, getAddress, id } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "./api-http.js";
import { createGenesisWeekendClaimService, loadGenesisWeekendClaimConfig, loadWeekendSnapshot } from "./genesis-weekend-claim.js";
import { verifyWeekendProof } from "./genesis-weekend-merkle.js";
import { computeWeekendSnapshot, SNAPSHOT_FORMAT, SOURCE_BRIDGE, WEEKEND_RULE } from "./genesis-weekend-snapshot.js";

const CLAIM = getAddress("0x00000000000000000000000000000000000c1a1e");
const RELEASE = getAddress("0xF0C091A159DE16cF0F306b2B61d37685EC5A830e");
const SALE = getAddress("0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845");
const PRIORS = ["0x8512be04a4E54cd8551738165F9c05C3303187a0", "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363", "0xd70dBA7fF6419481d62D4689bDf271ad441766b8"].map(getAddress);
const CCHAIN_HOLDER = getAddress("0x00000000000000000000000000000000000000a1");
const GROTTO_ONLY = getAddress("0x626b1AeAdB9Fc0b465B40aDE4F4bBF0C01C9Db40");
const CLAIMANT = getAddress("0x6a86EfA012fEDA64b70112022487fEE22E67d2fb");
const STRANGER = getAddress("0x00000000000000000000000000000000000000ff");
const NOW = 1_793_500_000;
const CLOSE = 1_793_595_599;
const ISSUER_ROLE = id("ISSUER_ROLE");

function snapshotText() {
  const result = computeWeekendSnapshot({
    cchain: { block: 99_060_000, blockHash: `0x${"11".repeat(32)}`, timestamp: NOW - 7200, balances: { [CCHAIN_HOLDER]: { 0: 1 }, [CLAIMANT]: { 0: 1 }, [getAddress(SOURCE_BRIDGE)]: { 0: 2 } }, mintsMinusBurns: [4n, 0n, 0n, 0n] },
    grotto: { block: 151_791, blockHash: `0x${"22".repeat(32)}`, timestamp: NOW - 9000, nextBlockTimestamp: null, balances: { [GROTTO_ONLY]: { 0: 2 } }, mintsMinusBurns: [2n, 0n, 0n, 0n] },
    priorClaimants: [CLAIMANT], historicalClaimedSupply: 1n, historicalClaims: [{ wallet: CLAIMANT, transactionHash: "0x1", usedTokenId: 0 }], bridgeActivity: [],
  });
  expect(result.ok).toBe(true);
  return JSON.stringify({
    format: SNAPSHOT_FORMAT, eligibilityRule: WEEKEND_RULE, ok: true, merkleRoot: result.root, snapshotHash: result.snapshotHash, eligibleWallets: result.eligibleWallets,
    eligible: result.eligible, excluded: result.excluded, priorClaims: PRIORS, historicalClaimedSupply: "1",
    cchain: { block: 99_060_000, blockHash: `0x${"11".repeat(32)}` }, grotto: { block: 151_791, blockHash: `0x${"22".repeat(32)}` },
  });
}

const ENV = Object.freeze({
  GENESIS_CLAIM_MODE: "weekend", GENESIS_WEEKEND_SNAPSHOT: "snapshot.json", GENESIS_WEEKEND_CLAIM_CONTRACT: CLAIM,
  GENESIS_RELEASE_CONTRACT: RELEASE, GENESIS_PRIMARY_SALE: SALE, GENESIS_RELEASE_TOKEN_ID: "1",
});
const config = (text = snapshotText()) => loadGenesisWeekendClaimConfig(ENV, { readFile: () => text });

const claimIface = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)", "function snapshotHash() view returns (bytes32)", "function eligibleWallets() view returns (uint256)",
  "function snapshotCChainBlock() view returns (uint256)", "function snapshotGrottoBlock() view returns (uint256)", "function claimEnd() view returns (uint256)",
  "function claimStart() view returns (uint256)", "function baselineClaimedSupply() view returns (uint256)", "function claimedSupply() view returns (uint256)",
  "function active() view returns (bool)", "function paused() view returns (bool)", "function publicSaleStart() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)", "function ELIGIBILITY_RULE() view returns (bytes32)", "function GENESIS_CONTRACT() view returns (address)",
  "function priorClaimOne() view returns (address)", "function priorClaimTwo() view returns (address)", "function priorClaimThree() view returns (address)",
  "function hasClaimedAnywhere(address) view returns (bool)",
]);
const releaseIface = new Interface([
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
  "function ISSUER_ROLE() view returns (bytes32)", "function hasRole(bytes32 role, address account) view returns (bool)",
]);
const saleIface = new Interface(["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"]);

function chain(loaded, drift = {}) {
  const calls = { count: 0 };
  const values = {
    releaseContract: RELEASE, primarySale: SALE, tokenId: 1n, merkleRoot: loaded.snapshot.merkleRoot, snapshotHash: loaded.snapshot.snapshotHash,
    eligibleWallets: BigInt(loaded.snapshot.eligibleWallets), snapshotCChainBlock: 99_060_000n, snapshotGrottoBlock: 151_791n, claimEnd: BigInt(CLOSE),
    claimStart: BigInt(NOW - 60), baselineClaimedSupply: 1n, claimedSupply: 1n, active: true, paused: false, publicSaleStart: 1_793_019_600n,
    publicPriceWei: 250_000_000_000_000_000n, ELIGIBILITY_RULE: WEEKEND_RULE, GENESIS_CONTRACT: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
    priorClaimOne: PRIORS[0], priorClaimTwo: PRIORS[1], priorClaimThree: PRIORS[2], ...drift.claim,
  };
  const claimed = new Set([CLAIMANT, ...(drift.claimed || [])].map((wallet) => wallet.toLowerCase()));
  return {
    calls,
    getNetwork: async () => ({ chainId: drift.chainId ?? 43114n }),
    call: async ({ to, data }) => {
      calls.count += 1;
      if (getAddress(to) === CLAIM) {
        const fn = claimIface.parseTransaction({ data });
        if (fn.name === "hasClaimedAnywhere") return claimIface.encodeFunctionResult(fn.name, [claimed.has(fn.args[0].toLowerCase())]);
        return claimIface.encodeFunctionResult(fn.name, [values[fn.name]]);
      }
      if (getAddress(to) === RELEASE) {
        const fn = releaseIface.parseTransaction({ data });
        if (fn.name === "ISSUER_ROLE") return releaseIface.encodeFunctionResult(fn.name, [ISSUER_ROLE]);
        if (fn.name === "hasRole") return releaseIface.encodeFunctionResult(fn.name, [drift.issuer !== false]);
        return releaseIface.encodeFunctionResult(fn.name, [[`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, RELEASE, 0n, drift.minted ?? 2n, "ipfs://x", true]]);
      }
      if (getAddress(to) === SALE) return saleIface.encodeFunctionResult("sales", [250_000_000_000_000_000n, 0n, drift.sold ?? 1n, 3n, 1_793_019_600n, 1_794_315_540n, false, true]);
      throw new Error(`unexpected call to ${to}`);
    },
  };
}

function service(drift = {}, { now = NOW } = {}) {
  const loaded = config();
  const provider = chain(loaded, drift);
  return { provider, instance: createGenesisWeekendClaimService({ config: loaded, provider, clock: () => now, logger: { warn: vi.fn() } }) };
}

describe("weekend snapshot loading", () => {
  it("loads a passing snapshot and refuses tampered lists, roots, hashes and rules", () => {
    const text = snapshotText();
    expect(loadWeekendSnapshot(text).tree.size).toBe(2);
    const parsed = JSON.parse(text);
    expect(() => loadWeekendSnapshot(JSON.stringify({ ...parsed, eligible: [...parsed.eligible, { wallet: STRANGER, sources: ["c-chain"] }] }))).toThrow(/miscounts|root/);
    expect(() => loadWeekendSnapshot(JSON.stringify({ ...parsed, merkleRoot: `0x${"00".repeat(32)}` }))).toThrow(/root/);
    expect(() => loadWeekendSnapshot(JSON.stringify({ ...parsed, snapshotHash: `0x${"00".repeat(32)}` }))).toThrow(/hash/);
    expect(() => loadWeekendSnapshot(JSON.stringify({ ...parsed, eligibilityRule: id("other") }))).toThrow(/rule/);
    expect(() => loadWeekendSnapshot(JSON.stringify({ ...parsed, ok: false }))).toThrow(/passing/);
  });

  it("is off unless GENESIS_CLAIM_MODE=weekend, and requires the configured contracts", () => {
    expect(loadGenesisWeekendClaimConfig({}, { readFile: () => snapshotText() })).toBeNull();
    expect(() => loadGenesisWeekendClaimConfig({ ...ENV, GENESIS_WEEKEND_CLAIM_CONTRACT: "" }, { readFile: () => snapshotText() })).toThrow(/GENESIS_WEEKEND_CLAIM_CONTRACT/);
  });
});

describe("weekend claim config binding", () => {
  it("publishes the verified live state, including the live paid-sale end", async () => {
    const verified = await service().instance.verifyConfigBindings();
    expect(verified.publicConfig).toMatchObject({ mode: "weekend-merkle", claimContract: CLAIM, active: true, paused: false, claimEnd: String(CLOSE), claimStart: String(NOW - 60), publicSaleEnd: "1794315540", claimedSupply: "1", allocation: "0", publicAllocation: "0" });
  });

  it.each([
    ["an unaccounted mint (supply invariant)", { minted: 3n }],
    ["a different root", { claim: { merkleRoot: `0x${"ab".repeat(32)}` } }],
    ["a different snapshot hash", { claim: { snapshotHash: `0x${"ab".repeat(32)}` } }],
    ["a different historical baseline", { claim: { baselineClaimedSupply: 2n } }],
    ["a different prior claim contract", { claim: { priorClaimTwo: STRANGER } }],
    ["a different release", { claim: { releaseContract: STRANGER } }],
    ["a different eligibility rule", { claim: { ELIGIBILITY_RULE: id("x") } }],
    ["no ISSUER_ROLE while claims can be made", { issuer: false }],
    ["the wrong chain", { chainId: 43113n }],
  ])("fails closed with 503 on %s", async (_label, drift) => {
    await expect(service(drift).instance.verifyConfigBindings()).rejects.toMatchObject({ status: 503, code: "CLAIM_BINDING_MISMATCH" });
  });

  it("keeps the supply invariant across paid sales and claims, and accepts a revoked role after claimEnd", async () => {
    await expect(service({ sold: 2n, minted: 4n, claim: { claimedSupply: 2n } }).instance.verifyConfigBindings()).resolves.toBeTruthy();
    await expect(service({ issuer: false }, { now: CLOSE }).instance.verifyConfigBindings()).resolves.toBeTruthy();
  });

  it("serves /api/claims/config through the API handler, sharing one chain read across concurrent requests", async () => {
    const { instance, provider } = service();
    const handler = createApiHandler({ service: {}, genesisClaim: instance });
    const responses = await Promise.all(Array.from({ length: 5 }, async () => {
      const response = { status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
      await handler({ method: "GET", url: "/api/claims/config", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} }, response);
      return response;
    }));
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200, 200]);
    expect(JSON.parse(responses[0].body).data).toMatchObject({ mode: "weekend-merkle", active: true });
    const callsPerRead = provider.calls.count;
    await instance.verifyConfigBindings();
    expect(provider.calls.count).toBe(callsPerRead);
  });
});

describe("weekend claim eligibility", () => {
  it("returns a valid proof for a C-Chain holder and for a Grotto-only holder", async () => {
    const { instance } = service();
    const loaded = config();
    for (const [wallet, sources] of [[CCHAIN_HOLDER, ["c-chain"]], [GROTTO_ONLY, ["grotto"]]]) {
      const result = await instance.checkEligibility(wallet);
      expect(result).toMatchObject({ eligible: true, wallet, sources, claimContract: CLAIM, active: true, paused: false });
      expect(verifyWeekendProof(loaded.snapshot.merkleRoot, wallet, result.proof)).toBe(true);
    }
  });

  it("reports a prior or weekend claimant as already claimed, and a stranger as not in the snapshot", async () => {
    const { instance } = service({ claimed: [GROTTO_ONLY] });
    await expect(instance.checkEligibility(CLAIMANT)).resolves.toMatchObject({ eligible: false, reason: "ALREADY_CLAIMED" });
    await expect(instance.checkEligibility(GROTTO_ONLY)).resolves.toMatchObject({ eligible: false, reason: "ALREADY_CLAIMED" });
    await expect(instance.checkEligibility(STRANGER)).resolves.toMatchObject({ eligible: false, reason: "NOT_IN_SNAPSHOT" });
  });

  it("returns 409 CLAIM_WINDOW_CLOSED at and after claimEnd, and 400 for a bad wallet", async () => {
    await expect(service({}, { now: CLOSE }).instance.checkEligibility(CCHAIN_HOLDER)).rejects.toMatchObject({ status: 409, code: "CLAIM_WINDOW_CLOSED" });
    await expect(service().instance.checkEligibility("0x123")).rejects.toMatchObject({ status: 400, code: "INVALID_WALLET" });
  });

  it("issues no signed vouchers: the voucher routes return 409 CLAIM_WINDOW_CLOSED", () => {
    const { instance } = service();
    expect(() => instance.issueVoucher(CCHAIN_HOLDER)).toThrow(expect.objectContaining({ status: 409, code: "CLAIM_WINDOW_CLOSED" }));
    expect(() => instance.issueEarlyAccessVoucher(CCHAIN_HOLDER)).toThrow(expect.objectContaining({ status: 409, code: "CLAIM_WINDOW_CLOSED" }));
  });
});
