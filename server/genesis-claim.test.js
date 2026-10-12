import { describe, expect, it, vi } from "vitest";
import { Interface, getAddress, id } from "ethers";
import { ApiError } from "./api-errors.js";
import { createApiHandler } from "./api-http.js";
import {
  createGenesisClaimService,
  ELIGIBILITY_RULE,
  ELIGIBILITY_RULE_TEXT,
  GENESIS_CONTRACT,
  GENESIS_CHAIN_ID,
  LEGACY_FUJI_SINGLETON,
  loadGenesisClaimConfig,
} from "./genesis-claim.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const SIGNER = "0x5555555555555555555555555555555555555555";
const TEST_SIGNATURE = `0x${"ab".repeat(65)}`;
const NOW = 1_800_000_000;
const CLAIM_START = NOW - 60;
const CLAIM_END = CLAIM_START + 86_400;
const PUBLIC_END = CLAIM_END + 7 * 86_400 - 1;
const PRICE = 250_000_000_000_000_000n; // 0.25 AVAX
const ISSUER_ROLE = id("ISSUER_ROLE");

const ENV = Object.freeze({
  GENESIS_CLAIM_ENABLED: "true",
  RELEASE_NETWORK: "fuji",
  GENESIS_RPC_URL: "https://c-chain.example/rpc",
  GENESIS_DESTINATION_RPC_URL: "https://fuji.example/rpc",
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
  GENESIS_CLAIM_PRIMARY_SALE: SALE,
  GENESIS_CLAIM_CONTRACT: CLAIM,
  GENESIS_CLAIM_TOKEN_ID: "987654321",
  GENESIS_CLAIM_ALLOCATION: "0",
  GENESIS_PUBLIC_MINT_ALLOCATION: "0",
  GENESIS_CLAIM_START: String(CLAIM_START),
  GENESIS_PUBLIC_PRICE_WEI: PRICE.toString(),
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
});

const genesisIface = new Interface(["function balanceOf(address account,uint256 id) view returns (uint256)"]);

/**
 * A C-Chain provider with live balances: `holdings` maps `${wallet}:${tokenId}` to a balance and can be
 * changed between calls to model transfers.
 */
function genesisChain(holdings = {}, { chainId = GENESIS_CHAIN_ID } = {}) {
  const calls = [];
  return {
    calls,
    holdings,
    getNetwork: vi.fn(async () => ({ chainId: BigInt(chainId) })),
    call: vi.fn(async ({ to, data, blockTag }) => {
      calls.push({ to, blockTag });
      const [wallet, tokenId] = genesisIface.decodeFunctionData("balanceOf", data);
      return genesisIface.encodeFunctionResult("balanceOf", [holdings[`${wallet.toLowerCase()}:${tokenId}`] || 0n]);
    }),
  };
}

function service({ eligible, alreadyClaimed = false, claimedSupply = 0n, env = {}, clock = NOW, ...overrides } = {}) {
  const signTypedData = vi.fn().mockResolvedValue(TEST_SIGNATURE);
  const bindingReader = vi.fn().mockResolvedValue(undefined);
  const claimStateReader = vi.fn().mockResolvedValue({ alreadyClaimed, claimedSupply });
  const instance = createGenesisClaimService({
    config: loadGenesisClaimConfig({ ...ENV, ...env }),
    signer: { signTypedData, address: SIGNER },
    ...(eligible ? { eligibilityReader: vi.fn().mockResolvedValue(eligible.map(String)) } : {}),
    bindingReader,
    claimStateReader,
    clock: () => clock,
    nonce: () => 987654321n,
    ...overrides,
  });
  return { instance, signTypedData, bindingReader, claimStateReader };
}

describe("Genesis eligibility from live C-Chain ownership", () => {
  it.each([0, 1, 2, 3])("accepts a wallet that currently holds Genesis token %i", async (tokenId) => {
    const chain = genesisChain({ [`${WALLET}:${tokenId}`]: 1n });
    const { instance } = service({ genesisProvider: chain });
    await expect(instance.checkEligibility(WALLET)).resolves.toEqual({ eligible: true, eligibleTokenIds: [String(tokenId)] });
    expect(chain.calls).toHaveLength(4);
    expect(chain.calls.every((call) => call.blockTag === "latest" && call.to === GENESIS_CONTRACT)).toBe(true);
  });

  it("denies a wallet that holds no Genesis token now", async () => {
    const { instance, signTypedData } = service({ genesisProvider: genesisChain() });
    await expect(instance.checkEligibility(WALLET)).resolves.toEqual({ eligible: false, eligibleTokenIds: [] });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("follows the current owner: eligibility moves with the Genesis token", async () => {
    const SECOND = "0x6666666666666666666666666666666666666666";
    const chain = genesisChain({ [`${WALLET}:1`]: 1n });
    const { instance } = service({ genesisProvider: chain });
    await expect(instance.checkEligibility(WALLET)).resolves.toMatchObject({ eligible: true });
    await expect(instance.checkEligibility(SECOND)).resolves.toMatchObject({ eligible: false });
    chain.holdings[`${WALLET}:1`] = 0n;
    chain.holdings[`${SECOND}:1`] = 1n;
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    await expect(instance.issueVoucher(SECOND)).resolves.toMatchObject({ voucher: { claimant: getAddress(SECOND) } });
  });

  it("refuses a wallet that already claimed even while it still holds Genesis", async () => {
    const { instance, signTypedData } = service({ genesisProvider: genesisChain({ [`${WALLET}:0`]: 4n }), alreadyClaimed: true });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("fails closed on a provider that is not C-Chain, or on a failed or malformed balance read", async () => {
    const holder = { [`${WALLET}:0`]: 1n };
    const failing = { ...genesisChain(holder), call: vi.fn().mockRejectedValue(new Error("rpc offline")) };
    const malformed = { ...genesisChain(holder), call: vi.fn().mockResolvedValue("0x") };
    for (const chain of [genesisChain(holder, { chainId: 43113 }), failing, malformed]) {
      const { instance, signTypedData } = service({ genesisProvider: chain });
      await expect(instance.checkEligibility(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
      await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
      expect(signTypedData).not.toHaveBeenCalled();
    }
  });

  it("reports an RPC failure as eligibility-unavailable, not as ineligible", async () => {
    const { instance } = service({ eligibilityReader: vi.fn().mockRejectedValue(new Error("rpc offline")) });
    await expect(instance.checkEligibility(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
  });

  it("names the contract's live-ownership rule and needs no snapshot configuration", () => {
    expect(ELIGIBILITY_RULE_TEXT).toBe("the-void:genesis-eligibility:v1:balanceOf(wallet,0)>0|balanceOf(wallet,1)>0|balanceOf(wallet,2)>0|balanceOf(wallet,3)>0");
    expect(ELIGIBILITY_RULE).toBe(id(ELIGIBILITY_RULE_TEXT));
    expect(loadGenesisClaimConfig(ENV)).not.toHaveProperty("snapshotBlock");
  });
});

describe("Genesis claim vouchers", () => {
  it("issues one quantity-one voucher bound to the live-ownership rule, target and claim window", async () => {
    const { instance, signTypedData } = service({ eligible: [0, 2, 3] });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher).toMatchObject({
      claimant: getAddress(WALLET),
      genesisContract: GENESIS_CONTRACT,
      genesisChainId: GENESIS_CHAIN_ID,
      eligibilityRule: ELIGIBILITY_RULE,
      destinationChainId: 43113,
      releaseContract: getAddress(RELEASE),
      tokenId: "987654321",
      quantity: "1",
      allocation: "0",
      nonce: "987654321",
      deadline: String(NOW + 300),
    });
    expect(issued.signature).toBe(TEST_SIGNATURE);
    expect(issued.target).toMatchObject({
      claimContract: getAddress(CLAIM),
      allocation: "0",
      publicAllocation: "0",
      claimStart: String(CLAIM_START),
      claimEnd: String(CLAIM_END),
      publicSaleEnd: String(PUBLIC_END),
      publicPriceWei: PRICE.toString(),
      eligibility: "live",
    });
    expect(issued.target).not.toHaveProperty("privateKey");
    expect(signTypedData.mock.calls[0][0]).toEqual({ name: "The Void Genesis Holder Claim", version: "1", chainId: 43113, verifyingContract: getAddress(CLAIM) });
    expect(signTypedData.mock.calls[0][1].ClaimVoucher).toHaveLength(11);
  });

  it("refuses vouchers before the window opens and from the second it closes", async () => {
    for (const [clock, code] of [[CLAIM_START - 1, "CLAIM_NOT_OPEN"], [CLAIM_END, "CLAIM_WINDOW_CLOSED"], [CLAIM_END + 1, "CLAIM_WINDOW_CLOSED"]]) {
      const { instance, signTypedData } = service({ eligible: [1], clock });
      await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code });
      expect(signTypedData).not.toHaveBeenCalled();
    }
    const { instance } = service({ eligible: [1], clock: CLAIM_START });
    await expect(instance.issueVoucher(WALLET)).resolves.toMatchObject({ voucher: { claimant: getAddress(WALLET) } });
  });

  it("issues distinct 256-bit random nonces by default", async () => {
    const instance = createGenesisClaimService({
      config: loadGenesisClaimConfig(ENV), signer: { signTypedData: vi.fn().mockResolvedValue(TEST_SIGNATURE), address: SIGNER },
      eligibilityReader: vi.fn().mockResolvedValue(["0"]), bindingReader: vi.fn().mockResolvedValue(undefined),
      claimStateReader: vi.fn().mockResolvedValue({ alreadyClaimed: false, claimedSupply: 0n }), clock: () => NOW,
    });
    const [first, second] = await Promise.all([instance.issueVoucher(WALLET), instance.issueVoucher(WALLET)]);
    for (const { voucher } of [first, second]) {
      expect(voucher.nonce).toMatch(/^[0-9]+$/);
      expect(BigInt(voucher.nonce) < 2n ** 256n).toBe(true);
    }
    expect(first.voucher.nonce).not.toBe(second.voucher.nonce);
  });

  it("never issues a voucher that outlives the claim window", async () => {
    const { instance } = service({ eligible: [2], clock: CLAIM_END - 10 });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher.deadline).toBe(String(CLAIM_END - 1));
  });

  it("rejects already-claimed wallets on the destination contract", async () => {
    const { instance, signTypedData } = service({ eligible: [1], alreadyClaimed: true });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("has no allocation cap on an open edition, but still enforces a finite one when configured", async () => {
    const open = service({ eligible: [0], claimedSupply: 10_000n });
    await expect(open.instance.issueVoucher(WALLET)).resolves.toMatchObject({ voucher: { allocation: "0" } });
    const finite = service({ eligible: [0], claimedSupply: 25n, env: { GENESIS_CLAIM_ALLOCATION: "25" } });
    await expect(finite.instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "CLAIM_ALLOCATION_EXHAUSTED" });
  });

  it("fails closed if live contract bindings do not match the configured target", async () => {
    const { instance, signTypedData } = service({
      eligible: [3],
      bindingReader: vi.fn().mockRejectedValue(new ApiError(503, "CLAIM_BINDING_MISMATCH", "The claim target differs.")),
    });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ code: "CLAIM_BINDING_MISMATCH", status: 503 });
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

const claimIface = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)", "function publicAllocation() view returns (uint256)", "function destinationChainId() view returns (uint256)",
  "function claimStart() view returns (uint256)", "function claimEnd() view returns (uint256)", "function publicSaleEnd() view returns (uint256)",
  "function claimWindow() view returns (uint256)", "function publicWindow() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)", "function GENESIS_CONTRACT() view returns (address)", "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)", "function signer() view returns (address)", "function claimedSupply() view returns (uint256)",
]);
const releaseIface = new Interface([
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
]);
const saleIface = new Interface(["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"]);

/** A Fuji provider holding a deployed claim, its open-edition release and its scheduled sale. */
function fujiChain(drift = {}) {
  const claimValues = {
    releaseContract: RELEASE, primarySale: SALE, tokenId: 987654321n, allocation: 0n, publicAllocation: 0n, destinationChainId: 43113n,
    claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE,
    claimWindow: 86_400n, publicWindow: 604_800n,
    GENESIS_CONTRACT, GENESIS_CHAIN_ID: 43114n,
    ELIGIBILITY_RULE,
    signer: SIGNER, claimedSupply: 3n, ...drift.claim,
  };
  const sale = { priceWei: PRICE, maxSupply: 0n, sold: 4n, perWalletLimit: 0n, startTime: BigInt(CLAIM_END), endTime: BigInt(PUBLIC_END), paused: false, configured: true, ...drift.sale };
  const minted = drift.minted ?? 7n;
  return {
    getNetwork: async () => ({ chainId: 43113n }),
    call: async ({ to, data }) => {
      if (getAddress(to) === getAddress(CLAIM)) { const fn = claimIface.parseTransaction({ data }).name; return claimIface.encodeFunctionResult(fn, [claimValues[fn]]); }
      if (getAddress(to) === getAddress(RELEASE)) {
        const fn = releaseIface.parseTransaction({ data }).name;
        if (fn === "maxSupplyOf") return releaseIface.encodeFunctionResult(fn, [drift.maxSupply ?? 0n]);
        if (fn === "ISSUER_ROLE") return releaseIface.encodeFunctionResult(fn, [ISSUER_ROLE]);
        if (fn === "hasRole") {
          const [role, account] = releaseIface.decodeFunctionData(fn, data);
          return releaseIface.encodeFunctionResult(fn, [role === ISSUER_ROLE && getAddress(account) === getAddress(CLAIM) && drift.claimIsIssuer !== false]);
        }
        return releaseIface.encodeFunctionResult(fn, [[`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, WALLET, drift.maxSupply ?? 0n, minted, "ipfs://x", true]]);
      }
      if (getAddress(to) === getAddress(SALE)) return saleIface.encodeFunctionResult("sales", Object.values(sale));
      throw new Error(`unexpected call to ${to}`);
    },
  };
}

describe("live claim binding verification", () => {
  const bindings = (chain) => createGenesisClaimService({ config: loadGenesisClaimConfig(ENV), destinationProvider: chain, genesisProvider: genesisChain(), signer: { address: SIGNER, signTypedData: vi.fn() }, clock: () => NOW });

  it("accepts an uncapped open edition whose sale is exactly the scheduled public phase", async () => {
    await expect(bindings(fujiChain()).verifyContractBindings()).resolves.toBeUndefined();
  });

  it.each([
    ["a different sale price", { sale: { priceWei: PRICE - 1n } }],
    ["a public start before the claim window ends", { sale: { startTime: BigInt(CLAIM_END - 1) } }],
    ["a public end after seven days", { sale: { endTime: BigInt(PUBLIC_END + 1) } }],
    ["an invented sale cap", { sale: { maxSupply: 100n } }],
    ["an unconfigured sale", { sale: { configured: false } }],
    ["supply accounting drift", { minted: 8n }],
    ["a different claim start", { claim: { claimStart: BigInt(CLAIM_START + 1) } }],
    ["a claim deployed with a different window", { claim: { claimWindow: 300n } }],
    ["a different eligibility rule", { claim: { ELIGIBILITY_RULE: `0x${"99".repeat(32)}` } }],
    ["a different signer", { claim: { signer: WALLET } }],
    ["a different release", { claim: { releaseContract: SALE } }],
    ["a claim contract the artist has not granted ISSUER_ROLE", { claimIsIssuer: false }],
  ])("fails closed on %s", async (_label, drift) => {
    await expect(bindings(fujiChain(drift)).verifyContractBindings()).rejects.toMatchObject({ status: 503, code: "CLAIM_BINDING_MISMATCH" });
  });
});

describe("GET /api/claims/config with the real claim service", () => {
  const responseDouble = () => ({ status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const requestDouble = () => ({ method: "GET", url: "/api/claims/config", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} });
  const handlerFor = (chain) => createApiHandler({ service: {}, genesisClaim: createGenesisClaimService({ config: loadGenesisClaimConfig(ENV), destinationProvider: chain, genesisProvider: genesisChain(), signer: { address: SIGNER, signTypedData: vi.fn() }, clock: () => NOW }) });

  it("returns 200 with the exact validated target and no secret", async () => {
    const response = responseDouble();
    await handlerFor(fujiChain())(requestDouble(), response);
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body).data;
    expect(data).toMatchObject({ enabled: true, destinationChainId: 43113, releaseContract: getAddress(RELEASE), primarySale: getAddress(SALE), claimContract: getAddress(CLAIM), tokenId: "987654321", allocation: "0", publicAllocation: "0", claimEnd: String(CLAIM_END), publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString(), eligibility: "live" });
    expect(response.body).not.toContain("11".repeat(32));
  });

  it("returns 503 when the deployed claim or sale does not match the configured target", async () => {
    const response = responseDouble();
    await handlerFor(fujiChain({ sale: { priceWei: 1n } }))(requestDouble(), response);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe("CLAIM_BINDING_MISMATCH");
  });
});

describe("environment schedule and price", () => {
  const MAINNET = { ...ENV, RELEASE_NETWORK: "mainnet", GENESIS_DESTINATION_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" };

  it("lets Fuji run an accelerated 5-minute claim and 10-minute public sale at 0.01 AVAX", () => {
    const loaded = loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_WINDOW_SECONDS: "300", GENESIS_PUBLIC_WINDOW_SECONDS: "600", GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" });
    expect(loaded).toMatchObject({ destinationChainId: 43113, claimWindow: 300n, publicWindow: 600n, claimEnd: BigInt(CLAIM_START + 300), publicSaleEnd: BigInt(CLAIM_START + 899), publicPriceWei: 10_000_000_000_000_000n });
  });

  it("defaults to the production 24 hours and 7 days when no windows are set", () => {
    expect(loadGenesisClaimConfig(ENV)).toMatchObject({ claimWindow: 86_400n, publicWindow: 604_800n });
  });

  it("refuses Fuji windows under one minute", () => {
    expect(() => loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_WINDOW_SECONDS: "59" })).toThrow(/at least 60 seconds/);
  });

  it("loads mainnet only with the production schedule and 0.25 AVAX", () => {
    expect(loadGenesisClaimConfig(MAINNET)).toMatchObject({ destinationChainId: 43114, claimWindow: 86_400n, publicWindow: 604_800n, publicPriceWei: PRICE });
  });

  it.each([
    ["an accelerated claim window", { GENESIS_CLAIM_WINDOW_SECONDS: "300" }, /24-hour/],
    ["an accelerated public window", { GENESIS_PUBLIC_WINDOW_SECONDS: "600" }, /7-day/],
    ["the Fuji test price", { GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" }, /0.25 AVAX/],
  ])("refuses mainnet with %s", (_label, override, message) => {
    expect(() => loadGenesisClaimConfig({ ...MAINNET, ...override })).toThrow(message);
  });
});

describe("Genesis claim configuration", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "false" })).toBeNull();
    expect(() => loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "true" })).toThrow(/GENESIS_CLAIM_RELEASE_CONTRACT/);
  });

  it("loads an uncapped open-edition target with its fixed schedule and the live-ownership rule", () => {
    const loaded = loadGenesisClaimConfig(ENV);
    expect(loaded).toMatchObject({ allocation: 0n, publicAllocation: 0n, claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE, eligibilityRule: ELIGIBILITY_RULE });
  });

  it("ignores obsolete snapshot settings", () => {
    const loaded = loadGenesisClaimConfig({ ...ENV, GENESIS_SNAPSHOT_BLOCK: "1", GENESIS_SNAPSHOT_BLOCK_HASH: "0x1234" });
    expect(loaded).not.toHaveProperty("snapshotBlock");
    expect(loaded.eligibilityRule).toBe(ELIGIBILITY_RULE);
  });

  it.each([
    ["GENESIS_CLAIM_START", "", /GENESIS_CLAIM_START must be a positive integer/],
    ["GENESIS_PUBLIC_PRICE_WEI", "0", /GENESIS_PUBLIC_PRICE_WEI must be a positive integer/],
    ["GENESIS_CLAIM_ALLOCATION", "-1", /non-negative integer/],
    ["GENESIS_PUBLIC_MINT_ALLOCATION", "1.5", /non-negative integer/],
    ["GENESIS_CLAIM_TOKEN_ID", "not-a-number", /non-negative integer/],
    ["GENESIS_CLAIM_RELEASE_CONTRACT", LEGACY_FUJI_SINGLETON, /legacy Fuji V2 singleton/],
    ["GENESIS_CLAIM_SIGNER_PRIVATE_KEY", "0x1234", /server-side 32-byte hex secret/],
  ])("rejects a missing or malformed %s", (name, value, message) => {
    expect(() => loadGenesisClaimConfig({ ...ENV, [name]: value })).toThrow(message);
  });
});
