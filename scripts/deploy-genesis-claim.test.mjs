import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Interface, Wallet, ZeroHash, getAddress, getCreateAddress, id, keccak256 } from "ethers";
import { CLAIM_ARTIFACT_PATH, broadcastClaim, buildClaimRecord, buildPlan, mainnetSigningPlan, preflightClaimDeployment, run, validateClaimDeploymentEnv, verifyClaimDeployment } from "./deploy-genesis-claim.mjs";
import { ELIGIBILITY_RULE, ELIGIBILITY_RULE_TEXT, GENESIS_CONTRACT } from "../server/genesis-claim.js";
import mainnetReleaseManifest from "../config/mainnet-release-per-contract.json" with { type: "json" };
import { bindPlan } from "./plan-binding-core.mjs";

const KEY = `0x${"11".repeat(32)}`;
const DEPLOYER = new Wallet(KEY).address;
const RELEASE = getAddress("0x2222222222222222222222222222222222222222");
const SALE = getAddress("0x3333333333333333333333333333333333333333");
const ARTIST = getAddress("0x284C09a7CC187E096cbbdc88d99DEFE6df32180a");
const ADMIN = getAddress("0x7777777777777777777777777777777777777777");
const SIGNER = getAddress("0x5555555555555555555555555555555555555555");
const TOKEN = 123456789n;
const NOW = 1_800_000_000;
const CLAIM_START = NOW + 3600;
const CLAIM_END = CLAIM_START + 86_400;
// The sale opens with the claims at CLAIM_START and closes 7 days after it (inclusive end).
const PUBLIC_END = CLAIM_START + 7 * 86_400 - 1;
const PRICE = 250_000_000_000_000_000n;
const NONCE = 61;
const PREDICTED = getCreateAddress({ from: DEPLOYER, nonce: NONCE });
const ARTIFACT = { abi: [{ type: "constructor", inputs: new Array(11).fill({ type: "uint256" }) }], bytecode: { object: "0x6080" } };

const ENV = Object.freeze({
  DEPLOY_NETWORK: "fuji",
  AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
  GENESIS_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
  DEPLOYER_PRIVATE_KEY: KEY,
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
  GENESIS_CLAIM_PRIMARY_SALE: SALE,
  GENESIS_CLAIM_TOKEN_ID: TOKEN.toString(),
  GENESIS_CLAIM_START: String(CLAIM_START),
  GENESIS_PUBLIC_PRICE_WEI: PRICE.toString(),
  GENESIS_CLAIM_ADMIN: ADMIN,
  GENESIS_CLAIM_SIGNER_ADDRESS: SIGNER,
  BROADCAST_DEPLOYMENT: "no",
});
const BROADCAST = { ...ENV, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: String(NONCE) };

const release = new Interface([
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
  "function mintEndOf(uint256 tokenId) view returns (uint64)",
  "function ISSUER_ROLE() view returns (bytes32)",
]);
// The active mainnet release factory, as the planner reads it from config/mainnet-release-per-contract.json.
const ACTIVE_FACTORY = getAddress(mainnetReleaseManifest.factoryAddress);
const factory = new Interface([
  "function isRelease(address release) view returns (bool)",
  "function primarySaleOf(address release) view returns (address)",
]);
const sale = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);

/** A Fuji chain holding an open-edition token whose sale is the scheduled public phase. As a C-Chain stand-in
 * it also answers for the active mainnet factory, which created RELEASE paired with SALE unless overridden. */
function fuji({ chainId = 43113n, edition = {}, saleState = {}, bound = RELEASE, mintEnd = BigInt(PUBLIC_END), maxSupply = 0n, missingToken = false, constructorReverts = false, now = NOW, nonce = NONCE, pending = nonce, codeless = [], factoryReleases = [RELEASE], pairedSale = SALE } = {}) {
  const calls = [];
  const state = { priceWei: PRICE, maxSupply: 0n, sold: 0n, perWalletLimit: 0n, startTime: BigInt(CLAIM_START), endTime: BigInt(PUBLIC_END), paused: false, configured: true, ...saleState };
  return {
    calls,
    send: async (method) => { if (method !== "eth_chainId") throw new Error(`unexpected ${method}`); return `0x${chainId.toString(16)}`; },
    getCode: async (address) => (codeless.includes(getAddress(address)) || ![RELEASE, SALE, ACTIVE_FACTORY].includes(getAddress(address)) ? "0x" : "0x6001"),
    getBlock: async () => ({ number: 59_400_000, timestamp: now }),
    getTransactionCount: async (_address, tag) => (tag === "pending" ? pending : nonce),
    call: async ({ to, data, from }) => {
      calls.push({ to, from, data });
      if (!to) {
        if (constructorReverts) throw Object.assign(new Error("execution reverted"), { shortMessage: "execution reverted: PublicSaleSchedule" });
        return "0x";
      }
      if (getAddress(to) === RELEASE) {
        const fn = release.parseTransaction({ data }).name;
        if (missingToken && fn !== "ISSUER_ROLE") throw new Error("execution reverted: EditionNotFound");
        if (fn === "maxSupplyOf") return release.encodeFunctionResult(fn, [maxSupply]);
        if (fn === "mintEndOf") return release.encodeFunctionResult(fn, [mintEnd]);
        if (fn === "ISSUER_ROLE") return release.encodeFunctionResult(fn, [id("ISSUER_ROLE")]);
        const value = { releaseId: id("release"), editionId: id("edition"), artist: ARTIST, maxSupply, mintedSupply: 0n, metadataUri: "ipfs://x", exists: true, ...edition };
        return release.encodeFunctionResult(fn, [Object.values(value)]);
      }
      if (getAddress(to) === ACTIVE_FACTORY) {
        const parsed = factory.parseTransaction({ data });
        const [asked] = parsed.args;
        if (parsed.name === "isRelease") return factory.encodeFunctionResult("isRelease", [factoryReleases.map(getAddress).includes(getAddress(asked))]);
        return factory.encodeFunctionResult("primarySaleOf", [factoryReleases.map(getAddress).includes(getAddress(asked)) ? pairedSale : "0x0000000000000000000000000000000000000000"]);
      }
      if (getAddress(to) === SALE) {
        const fn = sale.parseTransaction({ data }).name;
        if (fn === "releases") return sale.encodeFunctionResult(fn, [bound]);
        return sale.encodeFunctionResult(fn, Object.values(state));
      }
      throw new Error(`unexpected call to ${to}`);
    },
  };
}
const cChain = ({ chainId = 43114n, genesisCode = "0x6080" } = {}) => ({
  send: async () => `0x${chainId.toString(16)}`,
  getCode: async (address) => (address.toLowerCase() === GENESIS_CONTRACT.toLowerCase() ? genesisCode : "0x"),
});
const preflight = (env = ENV, provider = fuji(), genesisProvider = cChain()) => preflightClaimDeployment(validateClaimDeploymentEnv(env), { provider, genesisProvider, artifact: ARTIFACT });

describe("Genesis claim deployment: environment", () => {
  it("dry-runs by default on Fuji with an uncapped open-edition configuration", () => {
    expect(validateClaimDeploymentEnv(ENV)).toMatchObject({ chainId: 43113, broadcast: false, allocation: 0n, publicAllocation: 0n, claimEnd: BigInt(CLAIM_END), publicSaleStart: BigInt(CLAIM_START), publicSaleEnd: BigInt(PUBLIC_END), expectOpenEdition: true });
  });

  it.each([
    [{ DEPLOY_NETWORK: "devnet" }, /exactly "fuji" or "mainnet"/],
    [{ GENESIS_CLAIM_WINDOW_SECONDS: "30" }, /at least 60 seconds/],
    // Claims must close while the sale is still open: a claim window as long as the public window is refused.
    [{ GENESIS_CLAIM_WINDOW_SECONDS: "600", GENESIS_PUBLIC_WINDOW_SECONDS: "600" }, /before the public sale ends/i],
    [{ GENESIS_CLAIM_RELEASE_CONTRACT: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6" }, /legacy Fuji V2 singleton/],
    [{ GENESIS_CLAIM_PRIMARY_SALE: RELEASE }, /must differ/],
    [{ GENESIS_PUBLIC_PRICE_WEI: "0" }, /GENESIS_PUBLIC_PRICE_WEI must be a positive/],
    [{ GENESIS_CLAIM_SIGNER_ADDRESS: "" }, /GENESIS_CLAIM_SIGNER_ADDRESS is required/],
    [{ AVALANCHE_FUJI_RPC_URL: "https://user:pass@rpc.example" }, /without embedded credentials/],
  ])("refuses %o", (override, message) => {
    expect(() => validateClaimDeploymentEnv({ ...ENV, ...override })).toThrow(message);
  });

  it("requires the typed confirmation, the reviewed deployer and the reviewed nonce to broadcast", () => {
    expect(() => validateClaimDeploymentEnv({ ...BROADCAST, CONFIRM_FUJI_DEPLOY: "" })).toThrow(/CONFIRM_FUJI_DEPLOY=yes/);
    expect(() => validateClaimDeploymentEnv({ ...BROADCAST, EXPECTED_DEPLOYER_ADDRESS: "" })).toThrow(/EXPECTED_DEPLOYER_ADDRESS/);
    expect(() => validateClaimDeploymentEnv({ ...BROADCAST, EXPECTED_DEPLOYER_ADDRESS: ADMIN })).toThrow(/does not belong/);
    expect(() => validateClaimDeploymentEnv({ ...BROADCAST, EXPECTED_DEPLOYER_NONCE: "" })).toThrow(/EXPECTED_DEPLOYER_NONCE/);
    expect(validateClaimDeploymentEnv(BROADCAST)).toMatchObject({ broadcast: true, expectedDeployerNonce: NONCE });
  });
});

describe("Genesis claim deployment: environment schedule", () => {
  const FUJI_TEST = { ...ENV, GENESIS_CLAIM_WINDOW_SECONDS: "300", GENESIS_PUBLIC_WINDOW_SECONDS: "600", GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" };
  const RABBY_DEPLOYER = "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174";
  const { DEPLOYER_PRIVATE_KEY: _fujiKey, ...KEYLESS } = ENV;
  const MAINNET = { ...KEYLESS, DEPLOY_NETWORK: "mainnet", AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc", EXPECTED_DEPLOYER_ADDRESS: RABBY_DEPLOYER, GENESIS_PUBLIC_SALE_END: String(PUBLIC_END), GENESIS_EXPECT_PER_WALLET_LIMIT: "0" };
  // 2026-10-23 8:00:00 PM to 2026-10-31 11:59:59 PM America/New_York (EDT, UTC-4).
  const HALLOWEEN = { ...MAINNET, GENESIS_CLAIM_START: "1792800000", GENESIS_PUBLIC_SALE_END: "1793505599", GENESIS_EXPECT_PER_WALLET_LIMIT: "3" };

  it("accepts an accelerated Fuji schedule at the Fuji price", () => {
    expect(validateClaimDeploymentEnv(FUJI_TEST)).toMatchObject({ network: "fuji", chainId: 43113, claimWindow: 300n, publicWindow: 600n, claimEnd: BigInt(CLAIM_START + 300), publicSaleStart: BigInt(CLAIM_START), publicSaleEnd: BigInt(CLAIM_START + 599), publicPriceWei: 10_000_000_000_000_000n });
  });

  it("accepts mainnet only with 24 hours, a policy public window and 0.25 AVAX", () => {
    expect(validateClaimDeploymentEnv(MAINNET)).toMatchObject({ network: "mainnet", chainId: 43114, claimWindow: 86_400n, publicWindow: 604_800n, publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE });
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_WINDOW_SECONDS: "300" })).toThrow(/24-hour/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_PUBLIC_SALE_END: String(CLAIM_START + 599) })).toThrow(/whole hours between 7 and 14 days/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" })).toThrow(/0.25 AVAX/);
  });

  it("plans the Halloween schedule from its explicit end: 24-hour claim, sale through Oct 31 11:59:59 PM ET", () => {
    expect(validateClaimDeploymentEnv(HALLOWEEN)).toMatchObject({
      claimStart: 1_792_800_000n, claimWindow: 86_400n, claimEnd: 1_792_886_400n,
      publicSaleStart: 1_792_800_000n, publicWindow: 705_600n, publicSaleEnd: 1_793_505_599n, expectedPerWalletLimit: 3n,
    });
    expect(validateClaimDeploymentEnv({ ...HALLOWEEN, GENESIS_PUBLIC_WINDOW_SECONDS: "705600" })).toMatchObject({ publicWindow: 705_600n });
  });

  it.each([
    ["no explicit sale end", { GENESIS_PUBLIC_SALE_END: "" }, /GENESIS_PUBLIC_SALE_END is required on mainnet/],
    ["an end one second early", { GENESIS_PUBLIC_SALE_END: "1793505598" }, /whole hours between 7 and 14 days/],
    ["an end one second late", { GENESIS_PUBLIC_SALE_END: "1793505600" }, /whole hours between 7 and 14 days/],
    ["an end before the start", { GENESIS_PUBLIC_SALE_END: "1792799999" }, /must be after GENESIS_CLAIM_START/],
    ["an end a year out", { GENESIS_PUBLIC_SALE_END: String(1_792_800_000 + 365 * 86_400 - 1) }, /whole hours between 7 and 14 days/],
    ["a window that disagrees with the end", { GENESIS_PUBLIC_WINDOW_SECONDS: "604800" }, /does not match GENESIS_PUBLIC_SALE_END/],
    ["a malformed per-wallet limit", { GENESIS_EXPECT_PER_WALLET_LIMIT: "three" }, /GENESIS_EXPECT_PER_WALLET_LIMIT must be/],
    ["no per-wallet limit", { GENESIS_EXPECT_PER_WALLET_LIMIT: "" }, /GENESIS_EXPECT_PER_WALLET_LIMIT is required on mainnet/],
  ])("refuses the Halloween mainnet plan with %s", (_label, override, message) => {
    expect(() => validateClaimDeploymentEnv({ ...HALLOWEEN, ...override })).toThrow(message);
  });

  it("plans mainnet only for the defined deployer, never with a key and never as a broadcast", () => {
    expect(validateClaimDeploymentEnv(MAINNET)).toMatchObject({ deployerAddress: RABBY_DEPLOYER, deployerPrivateKey: null, broadcast: false });
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, EXPECTED_DEPLOYER_ADDRESS: "" })).toThrow(/EXPECTED_DEPLOYER_ADDRESS is required/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, EXPECTED_DEPLOYER_ADDRESS: DEPLOYER })).toThrow(/defined mainnet deployer/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, DEPLOYER_PRIVATE_KEY: KEY })).toThrow(/never reads a private key/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, MAINNET_DEPLOYER_PRIVATE_KEY: KEY })).toThrow(/never reads a private key/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, BROADCAST_DEPLOYMENT: "yes", CONFIRM_MAINNET_DEPLOY: "yes", EXPECTED_DEPLOYER_NONCE: "2" })).toThrow(/signs the planned transaction in Rabby/);
  });

  it("keeps the fee recipient, voucher signer, claim admin, artist and deployer separate on mainnet", () => {
    const NANO = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_ADMIN: NANO })).toThrow(/passive wallet/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_SIGNER_ADDRESS: NANO })).toThrow(/passive wallet/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_SIGNER_ADDRESS: ADMIN })).toThrow(/not the claim admin/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_SIGNER_ADDRESS: ARTIST })).toThrow(/not the artist wallet/);
    expect(validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_ADMIN: ARTIST })).toMatchObject({ admin: ARTIST, signer: SIGNER });
    // The deployer may also be the voucher signer (custody trade-off documented in OWNER-SIGNING.md), but never the admin.
    expect(validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_ADMIN: ARTIST, GENESIS_CLAIM_SIGNER_ADDRESS: RABBY_DEPLOYER })).toMatchObject({ admin: ARTIST, signer: RABBY_DEPLOYER, deployerAddress: RABBY_DEPLOYER });
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_ADMIN: RABBY_DEPLOYER })).toThrow(/claim admin may not be the deployer/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_ADMIN: RABBY_DEPLOYER, GENESIS_CLAIM_SIGNER_ADDRESS: RABBY_DEPLOYER })).toThrow(/not the claim admin/);
    // Fuji keeps its existing rules.
    expect(validateClaimDeploymentEnv({ ...ENV, GENESIS_CLAIM_SIGNER_ADDRESS: ADMIN })).toMatchObject({ network: "fuji" });
  });

  it("never broadcasts a mainnet claim through the Fuji broadcast path", async () => {
    await expect(broadcastClaim({ network: "mainnet" }, {}, {}, { artifact: ARTIFACT })).rejects.toThrow(/Only Fuji/);
  });

  it("checks the accelerated sale schedule against the chain", async () => {
    const provider = fuji({ saleState: { priceWei: 10_000_000_000_000_000n, startTime: BigInt(CLAIM_START), endTime: BigInt(CLAIM_START + 599) }, mintEnd: 0n });
    const facts = await preflight(FUJI_TEST, provider);
    expect(buildPlan(validateClaimDeploymentEnv(FUJI_TEST), facts).schedule).toMatchObject({ claimWindowSeconds: "300", claimEnd: String(CLAIM_START + 300), publicWindowSeconds: "600", publicSaleStart: String(CLAIM_START), publicSaleOpens: String(CLAIM_START), publicSaleEnd: String(CLAIM_START + 599), publicPriceWei: "10000000000000000", sale: `configureSale(tokenId, 10000000000000000, 0, 0, ${CLAIM_START}, ${CLAIM_START + 599}, false)` });
    await expect(preflight(FUJI_TEST, fuji({ mintEnd: 0n }))).rejects.toThrow(/priceWei/);
  });
});

describe("Genesis claim deployment: read-only preflight", () => {
  it("verifies the target and simulates the constructor from the deployer", async () => {
    const provider = fuji();
    const facts = await preflight(ENV, provider);
    expect(facts).toMatchObject({ deployerNonce: NONCE, predictedClaim: PREDICTED, edition: { maxSupply: 0n, mintedSupply: 0n, artist: ARTIST, mintEnd: BigInt(PUBLIC_END) } });
    const simulation = provider.calls.find((call) => !call.to);
    expect(simulation.from).toBe(DEPLOYER);
    const encoded = AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "address"], [RELEASE, SALE, TOKEN, 0n, 0n, BigInt(CLAIM_START), 86_400n, 604_800n, PRICE, ADMIN, SIGNER]);
    expect(simulation.data).toBe(`0x6080${encoded.slice(2)}`);
  });

  it.each([
    ["Fuji RPC on another chain", { provider: fuji({ chainId: 43114n }) }, /eth_chainId must be 43113/],
    ["C-Chain RPC on another chain", { genesisProvider: cChain({ chainId: 43113n }) }, /eth_chainId must be 43114/],
    ["a Genesis collection without code on C-Chain", { genesisProvider: cChain({ genesisCode: "0x" }) }, /live ownership cannot be verified/],
    ["a release without code", { provider: fuji({ codeless: [RELEASE] }) }, /release .* has no code/],
    ["a token that does not exist", { provider: fuji({ missingToken: true }) }, /does not exist/],
    ["a capped edition", { provider: fuji({ maxSupply: 100n }) }, /capped edition/],
    ["a mint deadline that is not the public end", { provider: fuji({ mintEnd: BigInt(PUBLIC_END + 1) }) }, /mint deadline/],
    ["a sale bound to another release", { provider: fuji({ bound: SALE }) }, /sells release/],
    ["an unconfigured sale", { provider: fuji({ saleState: { configured: false } }) }, /not configured/],
    ["a different price", { provider: fuji({ saleState: { priceWei: PRICE - 1n } }) }, /priceWei/],
    ["an invented sale cap", { provider: fuji({ saleState: { maxSupply: 1000n } }) }, /maxSupply/],
    ["a public start after the claims open", { provider: fuji({ saleState: { startTime: BigInt(CLAIM_START + 1) } }) }, /startTime/],
    ["a public start at the old claim-end handover", { provider: fuji({ saleState: { startTime: BigInt(CLAIM_END) } }) }, /startTime/],
    ["a public end one second after the planned end", { provider: fuji({ saleState: { endTime: BigInt(PUBLIC_END + 1) } }) }, /endTime/],
    ["mints outside the sale", { provider: fuji({ edition: { mintedSupply: 2n } }) }, /another mint path/],
    ["a claim start too close to now", { provider: fuji({ now: CLAIM_START - 60 }) }, /choose a later start/],
    ["a past claim start that is not the live sale start", { provider: fuji({ now: CLAIM_START + 60, saleState: { startTime: BigInt(CLAIM_START - 3600) } }) }, /startTime/],
    ["a late deployment after the claim window closed", { provider: fuji({ now: CLAIM_END }) }, /window has expired/],
    ["a late deployment too close to the claim end", { provider: fuji({ now: CLAIM_END - 599 }) }, /window has expired/],
    ["a reverting constructor simulation", { provider: fuji({ constructorReverts: true }) }, /constructor reverted/],
    ["a paused sale", { provider: fuji({ saleState: { paused: true } }) }, /paused/],
  ])("refuses %s", async (_label, { provider = fuji(), genesisProvider = cChain() }, message) => {
    await expect(preflight(ENV, provider, genesisProvider)).rejects.toThrow(message);
  });

  it("binds a late deployment to the live sale start without moving the schedule", async () => {
    for (const now of [CLAIM_START, CLAIM_START + 3600, CLAIM_END - 600]) {
      const facts = await preflight(ENV, fuji({ now }));
      expect(facts.args.slice(5, 7)).toEqual([BigInt(CLAIM_START), 86_400n]);
      expect(buildPlan(validateClaimDeploymentEnv(ENV), facts).schedule).toMatchObject({ claimStart: String(CLAIM_START), claimEnd: String(CLAIM_END), publicSaleEnd: String(PUBLIC_END) });
    }
    // A future start inside the lead time still fails; one at the lead time passes.
    await expect(preflight(ENV, fuji({ now: CLAIM_START - 599 }))).rejects.toThrow(/choose a later start/);
    await expect(preflight(ENV, fuji({ now: CLAIM_START - 600 }))).resolves.toMatchObject({ predictedClaim: PREDICTED });
  });

  it("checks the sale's paid per-wallet limit when the plan names one", async () => {
    const limited = { ...ENV, GENESIS_EXPECT_PER_WALLET_LIMIT: "3" };
    await expect(preflight(limited, fuji({ saleState: { perWalletLimit: 3n } }))).resolves.toMatchObject({ sale: { perWalletLimit: 3n } });
    await expect(preflight(limited, fuji({ saleState: { perWalletLimit: 0n } }))).rejects.toThrow(/perWalletLimit is 0, expected 3/);
    await expect(preflight(limited, fuji({ saleState: { perWalletLimit: 4n } }))).rejects.toThrow(/perWalletLimit is 4, expected 3/);
  });

  it("checks the active mainnet factory only on mainnet, never for a Fuji plan", async () => {
    const provider = fuji();
    const facts = await preflight(ENV, provider);
    expect(facts.releaseFactory).toBeUndefined();
    expect(provider.calls.filter((call) => call.to && getAddress(call.to) === ACTIVE_FACTORY)).toEqual([]);
  });

  it("prints a plan with the schedule, live eligibility and the follow-ups it does not perform", async () => {
    const config = validateClaimDeploymentEnv(ENV);
    const plan = buildPlan(config, await preflight());
    expect(plan).toMatchObject({
      predictedClaimAddress: PREDICTED,
      schedule: { claimStart: String(CLAIM_START), claimEnd: String(CLAIM_END), publicSaleStart: String(CLAIM_START), publicSaleOpens: String(CLAIM_START), publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString() },
      supply: { claimAllocation: "0", publicAllocation: "0", meaning: expect.stringMatching(/uncapped/) },
      eligibility: { chainId: 43114, genesisContract: GENESIS_CONTRACT, source: expect.stringMatching(/live/), ruleText: ELIGIBILITY_RULE_TEXT, rule: ELIGIBILITY_RULE },
      followUps: { issuerGrant: { from: ARTIST, to: RELEASE, note: expect.stringMatching(/never does/) }, apiConfiguration: { GENESIS_CLAIM_CONTRACT: PREDICTED, note: expect.stringMatching(/owner authorization/) } },
    });
    expect(JSON.stringify(plan)).not.toContain(KEY.slice(2));
    expect(JSON.stringify(plan)).not.toMatch(/snapshot/i);
  });

  it("dry-run mode never deploys", async () => {
    const broadcast = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await run([], ENV, { provider: fuji(), genesisProvider: cChain(), artifact: ARTIFACT, broadcastClaim: broadcast });
    expect(result.mode).toBe("DRY_RUN");
    expect(broadcast).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("No transaction was broadcast.");
    log.mockRestore();
  });
});

describe("Genesis claim deployment: broadcast guards", () => {
  const config = () => validateClaimDeploymentEnv(BROADCAST);
  it("refuses a moved or pending deployer nonce before signing anything", async () => {
    for (const provider of [fuji({ nonce: NONCE + 1 }), fuji({ pending: NONCE + 1 })]) {
      const facts = await preflightClaimDeployment(config(), { provider, genesisProvider: cChain(), artifact: ARTIFACT });
      const wallet = { getAddress: async () => DEPLOYER, sendTransaction: vi.fn() };
      await expect(broadcastClaim(config(), provider, facts, { artifact: ARTIFACT, wallet, log: () => {} })).rejects.toThrow(/nothing was broadcast/);
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("refuses a signer that is not the validated deployer", async () => {
    const provider = fuji();
    const facts = await preflightClaimDeployment(config(), { provider, genesisProvider: cChain(), artifact: ARTIFACT });
    await expect(broadcastClaim(config(), provider, facts, { artifact: ARTIFACT, wallet: { getAddress: async () => ADMIN }, log: () => {} })).rejects.toThrow(/does not match/);
  });
});

describe("compiled GenesisHolderClaim artifact", () => {
  const path = resolve(process.cwd(), CLAIM_ARTIFACT_PATH);
  it.skipIf(!existsSync(path))("has the scheduled eleven-argument constructor and the phase getters", () => {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    const constructor = artifact.abi.find((item) => item.type === "constructor");
    expect(constructor.inputs.map((input) => input.name)).toEqual(["releaseContract_", "primarySale_", "tokenId_", "allocation_", "publicAllocation_", "claimStart_", "claimWindow_", "publicWindow_", "publicPriceWei_", "admin_", "signer_"]);
    const names = new Set(artifact.abi.filter((item) => item.type === "function").map((item) => item.name));
    for (const name of ["claimStart", "claimEnd", "claimWindow", "publicWindow", "publicSaleStart", "publicSaleEnd", "publicPriceWei", "ELIGIBILITY_RULE", "PRODUCTION_CLAIM_WINDOW", "PRODUCTION_MIN_PUBLIC_WINDOW", "PRODUCTION_MAX_PUBLIC_WINDOW", "PRODUCTION_PUBLIC_WINDOW_STEP", "PRODUCTION_PUBLIC_PRICE_WEI", "GENESIS_MAX_TOKEN_ID", "CLAIM_QUANTITY", "MINIMUM_TEST_WINDOW"]) expect(names.has(name)).toBe(true);
  });
});

describe("Genesis claim on mainnet: owner-signed in Rabby, verified from chain", () => {
  const RABBY_DEPLOYER = getAddress("0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174");
  const NANO = getAddress("0xb65C575CaE01574296Fab6E620B9A15cC0121ce4");
  const { DEPLOYER_PRIVATE_KEY: _unused, ...KEYLESS_ENV } = ENV;
  const MAINNET_ENV = { ...KEYLESS_ENV, DEPLOY_NETWORK: "mainnet", AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc", EXPECTED_DEPLOYER_ADDRESS: RABBY_DEPLOYER, EXPECTED_DEPLOYER_NONCE: "2", GENESIS_CLAIM_ADMIN: ARTIST, GENESIS_PUBLIC_SALE_END: String(PUBLIC_END), GENESIS_EXPECT_PER_WALLET_LIMIT: "0" };
  const roles = new Interface(["function owner() view returns (address)", "function hasRole(bytes32 role,address account) view returns (bool)"]);
  const claimViews = new Interface(["releaseContract", "primarySale", "admin", "signer"].map((name) => `function ${name}() view returns (address)`).concat(["tokenId", "allocation", "publicAllocation", "claimStart", "claimWindow", "publicWindow", "claimEnd", "publicSaleStart", "publicSaleEnd", "publicPriceWei"].map((name) => `function ${name}() view returns (uint256)`), ["function ELIGIBILITY_RULE() view returns (bytes32)", "function paused() view returns (bool)"]));

  /** C-Chain holding the artist's release; owner and DEFAULT_ADMIN_ROLE holders are configurable. */
  function cchain({ owner = ARTIST, admins = [ARTIST], issuers = [], factoryReleases, pairedSale, codeless, balance = 10n ** 18n, feeData = { maxFeePerGas: 25_000_000_000n }, pending } = {}) {
    const base = fuji({ chainId: 43114n, nonce: 2, pending, factoryReleases, pairedSale, codeless });
    const state = { txs: {}, claim: null, claimValues: {} };
    return {
      ...base,
      state,
      estimateGas: async () => 2_000_000n,
      getBalance: async () => balance,
      getFeeData: async () => feeData,
      // The predicted address is empty until the claim is mined; afterwards it carries runtime code.
      getCode: async (address) => (state.claim && getAddress(address) === state.claim ? "0x6001" : base.getCode(address)),
      getTransactionReceipt: async (hash) => state.txs[hash]?.receipt ?? null,
      getTransaction: async (hash) => state.txs[hash]?.tx ?? null,
      call: async (tx) => {
        if (tx.to && getAddress(tx.to) === RELEASE) {
          const selector = tx.data.slice(0, 10);
          if (selector === roles.getFunction("owner").selector) return roles.encodeFunctionResult("owner", [owner]);
          if (selector === roles.getFunction("hasRole").selector) {
            const [role, account] = roles.decodeFunctionData("hasRole", tx.data);
            const holders = role === ZeroHash ? admins : issuers;
            return roles.encodeFunctionResult("hasRole", [holders.map(getAddress).includes(getAddress(account))]);
          }
        }
        if (tx.to && state.claim && getAddress(tx.to) === state.claim) {
          const fn = claimViews.parseTransaction({ data: tx.data }).name;
          return claimViews.encodeFunctionResult(fn, [fn === "paused" ? false : state.claimValues[fn]]);
        }
        return base.call(tx);
      },
      mine(request, plan, { tx: txOverrides = {}, values = {} } = {}) {
        const hash = `0x${"c".repeat(64)}`;
        state.txs[hash] = { tx: { hash, chainId: 43114n, from: request.from, nonce: request.nonce, to: null, value: 0n, data: request.data, ...txOverrides }, receipt: { hash, status: 1, blockNumber: 77, gasUsed: 1n, contractAddress: request.predictedAddress } };
        state.claim = getAddress(request.predictedAddress);
        state.claimValues = {
          releaseContract: plan.target.releaseContract, primarySale: plan.target.primarySale, tokenId: plan.target.tokenId, allocation: plan.supply.claimAllocation, publicAllocation: plan.supply.publicAllocation,
          claimStart: plan.schedule.claimStart, claimWindow: plan.schedule.claimWindowSeconds, publicWindow: plan.schedule.publicWindowSeconds, claimEnd: plan.schedule.claimEnd, publicSaleStart: plan.schedule.publicSaleStart, publicSaleEnd: plan.schedule.publicSaleEnd,
          publicPriceWei: plan.schedule.publicPriceWei, ELIGIBILITY_RULE: plan.eligibility.rule, admin: plan.roles.admin, signer: plan.roles.signer, ...values,
        };
        return hash;
      },
    };
  }

  async function mainnetPlan(chain = cchain()) {
    const config = validateClaimDeploymentEnv(MAINNET_ENV);
    const facts = await preflightClaimDeployment(config, { provider: chain, genesisProvider: cChain(), artifact: ARTIFACT });
    return mainnetSigningPlan(config, facts, buildPlan(config, facts), { provider: chain, artifact: ARTIFACT });
  }

  it("plans only a release the active mainnet factory created, with the sale it paired", async () => {
    expect(ACTIVE_FACTORY).toBe(getAddress("0xEa0c345cE84025b4e8462d145100dce1848254B4"));
    const plan = await mainnetPlan();
    expect(plan.target).toMatchObject({ releaseContract: RELEASE, primarySale: SALE, releaseFactory: ACTIVE_FACTORY });
    // A release from a historical factory (or any other contract) is not in the active factory's registry.
    await expect(mainnetPlan(cchain({ factoryReleases: [] }))).rejects.toThrow(/not created by the active mainnet release factory 0xEa0c345cE84025b4e8462d145100dce1848254B4/);
    // The sale must be the one the factory paired with the release, even if it claims to sell that release.
    await expect(mainnetPlan(cchain({ pairedSale: ADMIN }))).rejects.toThrow(/pairs release .* with sale 0x7777777777777777777777777777777777777777, not 0x3333333333333333333333333333333333333333/);
    await expect(mainnetPlan(cchain({ codeless: [ACTIVE_FACTORY] }))).rejects.toThrow(/active mainnet release factory .* has no code/);
  });

  it("carries the exact unsigned creation transaction from the defined deployer and its re-plan inputs", async () => {
    const plan = await mainnetPlan();
    const data = `0x6080${AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "address"], [RELEASE, SALE, TOKEN, 0, 0, CLAIM_START, 86_400, 604_800, PRICE, ARTIST, SIGNER]).slice(2)}`;
    expect(plan.signingRequests).toEqual([{ step: 1, contract: "GenesisHolderClaim", chainId: 43114, from: RABBY_DEPLOYER, to: null, nonce: 2, value: "0", data: data.toLowerCase(), dataHash: keccak256(data), gasLimit: "2400000", predictedAddress: getCreateAddress({ from: RABBY_DEPLOYER, nonce: 2 }) }]);
    expect(plan).toMatchObject({ readyToSign: true, deployer: RABBY_DEPLOYER, predictedClaimAddress: getCreateAddress({ from: RABBY_DEPLOYER, nonce: 2 }) });
    expect(plan.planInputs).toMatchObject({ DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: RABBY_DEPLOYER, EXPECTED_DEPLOYER_NONCE: "2", GENESIS_CLAIM_START: String(CLAIM_START), GENESIS_CLAIM_ADMIN: ARTIST, GENESIS_CLAIM_SIGNER_ADDRESS: SIGNER });
    expect(JSON.stringify(plan)).not.toMatch(/PRIVATE_KEY"\s*:\s*"0x|privateKey|mnemonic/i);
  });

  it("gates signing on live readiness: pending transactions, the reviewed nonce and an empty predicted address", async () => {
    const ready = await mainnetPlan();
    expect(ready.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "no pending deployer transactions", status: "PASS", value: { nonce: 2, pendingNonce: 2 } }),
      expect.objectContaining({ check: "nonce matches EXPECTED_DEPLOYER_NONCE", status: "PASS", value: 2 }),
      expect.objectContaining({ check: "predicted claim address is empty", status: "PASS", value: ready.predictedClaimAddress }),
    ]));
    const pending = await mainnetPlan(cchain({ pending: 3 }));
    expect(pending.readyToSign).toBe(false);
    expect(pending.checks.find((item) => /pending/.test(item.check))).toMatchObject({ status: "FAIL", value: { nonce: 2, pendingNonce: 3 } });
    const occupied = cchain();
    const emptyCode = occupied.getCode;
    occupied.getCode = async (address) => (getAddress(address) === getCreateAddress({ from: RABBY_DEPLOYER, nonce: 2 }) ? "0x6002" : emptyCode(address));
    const taken = await mainnetPlan(occupied);
    expect(taken.readyToSign).toBe(false);
    expect(taken.checks.find((item) => /predicted claim address/.test(item.check))).toMatchObject({ status: "FAIL" });
    // A plan made without a reviewed nonce is still ready: the binding carries the live nonce it was planned at.
    const config = validateClaimDeploymentEnv({ ...MAINNET_ENV, EXPECTED_DEPLOYER_NONCE: "" });
    const chain = cchain();
    const facts = await preflightClaimDeployment(config, { provider: chain, genesisProvider: cChain(), artifact: ARTIFACT });
    const unreviewed = await mainnetSigningPlan(config, facts, buildPlan(config, facts), { provider: chain, artifact: ARTIFACT });
    expect(unreviewed.readyToSign).toBe(true);
    expect(unreviewed.checks.find((item) => /EXPECTED_DEPLOYER_NONCE/.test(item.check))).toMatchObject({ status: "NOT PROVIDED" });
  });

  it("gates signing on funding: gasLimit × live maxFeePerGas with 50% headroom, failing closed without fee data", async () => {
    // gasLimit 2,400,000 × 25 gwei × 1.5 = 0.09 AVAX against a 1 AVAX balance.
    const funded = await mainnetPlan();
    expect(funded.readyToSign).toBe(true);
    expect(funded.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "fee data available for the funding requirement", status: "PASS" }),
      expect.objectContaining({ check: "deployer funded with 50% headroom over gasLimit × maxFeePerGas", status: "PASS", value: { balanceAvax: "1.0", requiredAvax: "0.09", gasLimit: "2400000", maxFeePerGasWei: "25000000000" } }),
    ]));
    expect(funded.funding).toEqual({ balanceWei: "1000000000000000000", balanceAvax: "1.0", gasLimit: "2400000", maxFeePerGasWei: "25000000000", requiredWei: "90000000000000000", requiredAvax: "0.09", headroomPercent: 150, funded: true });
    // One wei short of the requirement is not funded.
    const short = await mainnetPlan(cchain({ balance: 90_000_000_000_000_000n - 1n }));
    expect(short.readyToSign).toBe(false);
    expect(short.checks.find((item) => /funded/.test(item.check))).toMatchObject({ status: "FAIL", reason: expect.stringMatching(/Fund the deployer 0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174 with at least 0\.09 AVAX \(it holds 0\.089999999999999999\)/) });
    expect(short.funding.funded).toBe(false);
    expect(await mainnetPlan(cchain({ balance: 90_000_000_000_000_000n }))).toMatchObject({ readyToSign: true });
    // Legacy fee data (gasPrice only) is accepted; missing, zero or malformed fee data fails closed.
    expect(await mainnetPlan(cchain({ feeData: { gasPrice: 25_000_000_000n } }))).toMatchObject({ readyToSign: true, funding: { requiredAvax: "0.09" } });
    for (const feeData of [null, {}, { maxFeePerGas: 0n }, { maxFeePerGas: null, gasPrice: null }, { maxFeePerGas: "not-a-number" }]) {
      const blind = await mainnetPlan(cchain({ feeData }));
      expect(blind.readyToSign).toBe(false);
      expect(blind.checks.find((item) => /fee data/.test(item.check))).toMatchObject({ status: "FAIL", reason: expect.stringMatching(/no usable maxFeePerGas or gasPrice/) });
      expect(blind.checks.some((item) => /funded/.test(item.check))).toBe(false);
      expect(blind.funding).toMatchObject({ requiredWei: null, requiredAvax: null, funded: false });
    }
    const failing = cchain(); failing.getFeeData = async () => { throw new Error("rpc down"); };
    expect(await mainnetPlan(failing)).toMatchObject({ readyToSign: false, funding: { funded: false, requiredAvax: null } });
    const silent = cchain(); silent.getFeeData = async () => undefined;
    expect(await mainnetPlan(silent)).toMatchObject({ readyToSign: false, funding: { funded: false, requiredAvax: null } });
  });

  it("keeps funding and readiness out of the plan binding: funded or not, the same plan binds identically", async () => {
    const commit = "a".repeat(40);
    const funded = { mode: "DRY_RUN", ...(await mainnetPlan()) };
    const short = { mode: "DRY_RUN", ...(await mainnetPlan(cchain({ balance: 0n }))) };
    const blind = { mode: "DRY_RUN", ...(await mainnetPlan(cchain({ feeData: null }))) };
    expect(funded.readyToSign).toBe(true);
    expect(short.readyToSign).toBe(false);
    expect(bindPlan("genesis-claim-mainnet", short, commit).digest).toBe(bindPlan("genesis-claim-mainnet", funded, commit).digest);
    expect(bindPlan("genesis-claim-mainnet", blind, commit).digest).toBe(bindPlan("genesis-claim-mainnet", funded, commit).digest);
    expect(Object.keys(bindPlan("genesis-claim-mainnet", funded, commit).fields)).not.toEqual(expect.arrayContaining(["checks", "funding", "readyToSign"]));
  });

  it("prepares the ISSUER_ROLE grant for the release's verified admin, the artist wallet, never the deployer", async () => {
    const plan = await mainnetPlan();
    expect(plan.followUps.issuerGrant).toMatchObject({ from: ARTIST, to: RELEASE, authority: "DEFAULT_ADMIN_ROLE on the release, verified on chain" });
    expect(plan.followUps.issuerGrant.data).toBe(new Interface(["function grantRole(bytes32 role,address account)"]).encodeFunctionData("grantRole", [id("ISSUER_ROLE"), plan.predictedClaimAddress]));
    await expect(mainnetPlan(cchain({ owner: RABBY_DEPLOYER, admins: [RABBY_DEPLOYER] }))).rejects.toThrow(/Releases are created by the artist, never the deployer/);
    await expect(mainnetPlan(cchain({ admins: [] }))).rejects.toThrow(/does not hold DEFAULT_ADMIN_ROLE/);
    await expect(mainnetPlan(cchain({ admins: [ARTIST, RABBY_DEPLOYER] }))).rejects.toThrow(/deployer must hold no release authority/);
    await expect(mainnetPlan(cchain({ admins: [ARTIST, NANO] }))).rejects.toThrow(/fee recipient holds DEFAULT_ADMIN_ROLE/);
  });

  it("verifies the mined claim against the reviewed plan and reports the separate grant as pending", async () => {
    const chain = cchain();
    const plan = await mainnetPlan(chain);
    const verified = await verifyClaimDeployment(chain, plan, chain.mine(plan.signingRequests[0], plan));
    expect(verified).toMatchObject({ address: plan.predictedClaimAddress, issuerGrant: "PENDING (artist operation)" });
    expect(buildClaimRecord(plan, verified, { sourceCommit: "a".repeat(40) })).toMatchObject({ signedBy: { deployer: RABBY_DEPLOYER }, claim: { address: plan.predictedClaimAddress }, issuerGrant: { status: "PENDING (artist operation)", from: ARTIST } });
  });

  it("refuses a mined claim with another signer, admin or schedule, or from another account", async () => {
    for (const [overrides, message] of [
      [{ values: { signer: ADMIN } }, /signer/],
      [{ values: { admin: SIGNER } }, /admin/],
      [{ values: { claimStart: String(CLAIM_START + 1) } }, /claimStart/],
      [{ tx: { from: ARTIST } }, /sender/],
      [{ tx: { data: "0x6080" } }, /creation data hash/],
      [{ tx: { chainId: 43113n } }, /chainId 43113/],
    ]) {
      const chain = cchain();
      const plan = await mainnetPlan(chain);
      await expect(verifyClaimDeployment(chain, plan, chain.mine(plan.signingRequests[0], plan, overrides))).rejects.toThrow(message);
    }
  });
});
