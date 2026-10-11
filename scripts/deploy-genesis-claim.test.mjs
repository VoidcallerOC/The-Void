import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Interface, Wallet, getAddress, getCreateAddress, id } from "ethers";
import { CLAIM_ARTIFACT_PATH, broadcastClaim, buildPlan, preflightClaimDeployment, run, validateClaimDeploymentEnv } from "./deploy-genesis-claim.mjs";
import { genesisEligibilityRule } from "../server/genesis-claim.js";

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
const PUBLIC_END = CLAIM_END + 7 * 86_400 - 1;
const PRICE = 250_000_000_000_000_000n;
const SNAPSHOT_BLOCK = 97_000_000;
const SNAPSHOT_HASH = `0x${"5a".repeat(32)}`;
const NONCE = 61;
const PREDICTED = getCreateAddress({ from: DEPLOYER, nonce: NONCE });
const ARTIFACT = { abi: [{ type: "constructor", inputs: new Array(12).fill({ type: "uint256" }) }], bytecode: { object: "0x6080" } };

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
  GENESIS_SNAPSHOT_BLOCK: String(SNAPSHOT_BLOCK),
  GENESIS_SNAPSHOT_BLOCK_HASH: SNAPSHOT_HASH,
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
const sale = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);

/** A Fuji chain holding an open-edition token whose sale is the scheduled public phase. */
function fuji({ chainId = 43113n, edition = {}, saleState = {}, bound = RELEASE, mintEnd = BigInt(PUBLIC_END), maxSupply = 0n, missingToken = false, constructorReverts = false, now = NOW, nonce = NONCE, pending = nonce, codeless = [] } = {}) {
  const calls = [];
  const state = { priceWei: PRICE, maxSupply: 0n, sold: 0n, perWalletLimit: 0n, startTime: BigInt(CLAIM_END), endTime: BigInt(PUBLIC_END), paused: false, configured: true, ...saleState };
  return {
    calls,
    send: async (method) => { if (method !== "eth_chainId") throw new Error(`unexpected ${method}`); return `0x${chainId.toString(16)}`; },
    getCode: async (address) => (codeless.includes(getAddress(address)) ? "0x" : "0x6001"),
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
      if (getAddress(to) === SALE) {
        const fn = sale.parseTransaction({ data }).name;
        if (fn === "releases") return sale.encodeFunctionResult(fn, [bound]);
        return sale.encodeFunctionResult(fn, Object.values(state));
      }
      throw new Error(`unexpected call to ${to}`);
    },
  };
}
const cChain = ({ chainId = 43114n, hash = SNAPSHOT_HASH } = {}) => ({
  send: async () => `0x${chainId.toString(16)}`,
  getBlock: async (number) => ({ number, hash }),
});
const preflight = (env = ENV, provider = fuji(), genesisProvider = cChain()) => preflightClaimDeployment(validateClaimDeploymentEnv(env), { provider, genesisProvider, artifact: ARTIFACT });

describe("Genesis claim deployment: environment", () => {
  it("dry-runs by default on Fuji with an uncapped open-edition configuration", () => {
    expect(validateClaimDeploymentEnv(ENV)).toMatchObject({ chainId: 43113, broadcast: false, allocation: 0n, publicAllocation: 0n, claimEnd: BigInt(CLAIM_END), publicSaleEnd: BigInt(PUBLIC_END), expectOpenEdition: true });
  });

  it.each([
    [{ DEPLOY_NETWORK: "devnet" }, /exactly "fuji" or "mainnet"/],
    [{ GENESIS_CLAIM_WINDOW_SECONDS: "30" }, /at least 60 seconds/],
    [{ GENESIS_CLAIM_RELEASE_CONTRACT: "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6" }, /legacy Fuji V2 singleton/],
    [{ GENESIS_CLAIM_PRIMARY_SALE: RELEASE }, /must differ/],
    [{ GENESIS_PUBLIC_PRICE_WEI: "0" }, /GENESIS_PUBLIC_PRICE_WEI must be a positive/],
    [{ GENESIS_SNAPSHOT_BLOCK_HASH: "0x12" }, /32-byte block hash/],
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
  const MAINNET = { ...ENV, DEPLOY_NETWORK: "mainnet", AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" };

  it("accepts an accelerated Fuji schedule at the Fuji price", () => {
    expect(validateClaimDeploymentEnv(FUJI_TEST)).toMatchObject({ network: "fuji", chainId: 43113, claimWindow: 300n, publicWindow: 600n, claimEnd: BigInt(CLAIM_START + 300), publicSaleEnd: BigInt(CLAIM_START + 899), publicPriceWei: 10_000_000_000_000_000n });
  });

  it("accepts mainnet only with 24 hours, 7 days and 0.25 AVAX", () => {
    expect(validateClaimDeploymentEnv(MAINNET)).toMatchObject({ network: "mainnet", chainId: 43114, claimWindow: 86_400n, publicWindow: 604_800n, publicPriceWei: PRICE });
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_CLAIM_WINDOW_SECONDS: "300" })).toThrow(/24-hour/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_PUBLIC_WINDOW_SECONDS: "600" })).toThrow(/7-day/);
    expect(() => validateClaimDeploymentEnv({ ...MAINNET, GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" })).toThrow(/0.25 AVAX/);
  });

  it("needs the mainnet confirmation, not the Fuji one, to broadcast on mainnet", () => {
    const broadcast = { ...MAINNET, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "0" };
    expect(() => validateClaimDeploymentEnv(broadcast)).toThrow(/CONFIRM_MAINNET_DEPLOY=yes/);
    expect(validateClaimDeploymentEnv({ ...broadcast, CONFIRM_MAINNET_DEPLOY: "yes" })).toMatchObject({ broadcast: true });
  });

  it("checks the accelerated sale schedule against the chain", async () => {
    const provider = fuji({ saleState: { priceWei: 10_000_000_000_000_000n, startTime: BigInt(CLAIM_START + 300), endTime: BigInt(CLAIM_START + 899) }, mintEnd: 0n });
    const facts = await preflight(FUJI_TEST, provider);
    expect(buildPlan(validateClaimDeploymentEnv(FUJI_TEST), facts).schedule).toMatchObject({ claimWindowSeconds: "300", publicWindowSeconds: "600", publicSaleOpens: String(CLAIM_START + 300), publicSaleEnd: String(CLAIM_START + 899), publicPriceWei: "10000000000000000" });
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
    const rule = genesisEligibilityRule({ snapshotBlock: SNAPSHOT_BLOCK, snapshotBlockHash: SNAPSHOT_HASH }).rule;
    const encoded = AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32", "address", "address"], [RELEASE, SALE, TOKEN, 0n, 0n, BigInt(CLAIM_START), 86_400n, 604_800n, PRICE, rule, ADMIN, SIGNER]);
    expect(simulation.data).toBe(`0x6080${encoded.slice(2)}`);
  });

  it.each([
    ["Fuji RPC on another chain", { provider: fuji({ chainId: 43114n }) }, /eth_chainId must be 43113/],
    ["C-Chain RPC on another chain", { genesisProvider: cChain({ chainId: 43113n }) }, /eth_chainId must be 43114/],
    ["a different snapshot block hash", { genesisProvider: cChain({ hash: `0x${"00".repeat(32)}` }) }, /snapshot hash/],
    ["a release without code", { provider: fuji({ codeless: [RELEASE] }) }, /release .* has no code/],
    ["a token that does not exist", { provider: fuji({ missingToken: true }) }, /does not exist/],
    ["a capped edition", { provider: fuji({ maxSupply: 100n }) }, /capped edition/],
    ["a mint deadline that is not the public end", { provider: fuji({ mintEnd: BigInt(PUBLIC_END + 1) }) }, /mint deadline/],
    ["a sale bound to another release", { provider: fuji({ bound: SALE }) }, /sells release/],
    ["an unconfigured sale", { provider: fuji({ saleState: { configured: false } }) }, /not configured/],
    ["a different price", { provider: fuji({ saleState: { priceWei: PRICE - 1n } }) }, /priceWei/],
    ["an invented sale cap", { provider: fuji({ saleState: { maxSupply: 1000n } }) }, /maxSupply/],
    ["a public start before the claim ends", { provider: fuji({ saleState: { startTime: BigInt(CLAIM_END - 1) } }) }, /startTime/],
    ["a public end that is not seven days later", { provider: fuji({ saleState: { endTime: BigInt(PUBLIC_END + 1) } }) }, /endTime/],
    ["mints outside the sale", { provider: fuji({ edition: { mintedSupply: 2n } }) }, /another mint path/],
    ["a claim start too close to now", { provider: fuji({ now: CLAIM_START - 60 }) }, /choose a later start/],
    ["a reverting constructor simulation", { provider: fuji({ constructorReverts: true }) }, /constructor reverted/],
  ])("refuses %s", async (_label, { provider = fuji(), genesisProvider = cChain() }, message) => {
    await expect(preflight(ENV, provider, genesisProvider)).rejects.toThrow(message);
  });

  it("prints a plan with the schedule, snapshot and the follow-ups it does not perform", async () => {
    const config = validateClaimDeploymentEnv(ENV);
    const plan = buildPlan(config, await preflight());
    expect(plan).toMatchObject({
      predictedClaimAddress: PREDICTED,
      schedule: { claimStart: String(CLAIM_START), claimEnd: String(CLAIM_END), publicSaleOpens: String(CLAIM_END), publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString() },
      supply: { claimAllocation: "0", publicAllocation: "0", meaning: expect.stringMatching(/uncapped/) },
      snapshot: { chainId: 43114, block: String(SNAPSHOT_BLOCK), blockHash: SNAPSHOT_HASH },
      followUps: { issuerGrant: { from: ARTIST, to: RELEASE, note: expect.stringMatching(/never does/) }, apiConfiguration: { GENESIS_CLAIM_CONTRACT: PREDICTED, note: expect.stringMatching(/owner authorization/) } },
    });
    expect(JSON.stringify(plan)).not.toContain(KEY.slice(2));
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
  it.skipIf(!existsSync(path))("has the scheduled twelve-argument constructor and the phase getters", () => {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    const constructor = artifact.abi.find((item) => item.type === "constructor");
    expect(constructor.inputs.map((input) => input.name)).toEqual(["releaseContract_", "primarySale_", "tokenId_", "allocation_", "publicAllocation_", "claimStart_", "claimWindow_", "publicWindow_", "publicPriceWei_", "eligibilityRule_", "admin_", "signer_"]);
    const names = new Set(artifact.abi.filter((item) => item.type === "function").map((item) => item.name));
    for (const name of ["claimStart", "claimEnd", "claimWindow", "publicWindow", "publicSaleEnd", "publicPriceWei", "ELIGIBILITY_RULE", "PRODUCTION_CLAIM_WINDOW", "PRODUCTION_PUBLIC_WINDOW", "PRODUCTION_PUBLIC_PRICE_WEI", "MINIMUM_TEST_WINDOW"]) expect(names.has(name)).toBe(true);
  });
});
