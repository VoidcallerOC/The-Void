import { describe, expect, it } from "vitest";
import { Interface, ZeroHash, getAddress, getCreateAddress, keccak256 } from "ethers";
import { MAINNET_ARTIST_WALLET, MAINNET_DEPLOYER, MAINNET_FEE_RECIPIENT } from "./mainnet-signing-requests.mjs";
import { ELIGIBILITY_RULE, GENESIS_CONTRACT } from "../server/genesis-claim.js";
import {
  buildRecoveryPlan,
  preflightRecoveryDeployment,
  recoveryPlanInputs,
  recoverySigningPlan,
  validateRecoveryDeploymentEnv,
  verifyRecoveryDeployment,
} from "./deploy-genesis-claim-recovery.mjs";
import { KINDS } from "./mainnet-owner-signing.mjs";
import { bindPlan } from "./deployment-plan-binding.mjs";

const RELEASE = getAddress("0x2222222222222222222222222222222222222222");
const SALE = getAddress("0x3333333333333333333333333333333333333333");
const ADMIN = getAddress("0x7777777777777777777777777777777777777777");
const SIGNER = getAddress("0x5555555555555555555555555555555555555555");
const STRANGER = getAddress("0x8888888888888888888888888888888888888888");
const CLAIM_START = 1_793_113_200;
const CLAIM_END = CLAIM_START + 86_400;
const SALE_START = 1_793_019_600;
const SALE_END = 1_793_710_799;
const PRICE = 250_000_000_000_000_000n;
const NONCE = 15;
const PREDICTED = getCreateAddress({ from: MAINNET_DEPLOYER, nonce: NONCE });
const ARTIFACT = { abi: [{ type: "constructor", inputs: [{ type: "tuple" }, { type: "address[]" }] }], bytecode: { object: "0x6080" } };
const ENV = Object.freeze({
  AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
  GENESIS_CLAIM_PRIMARY_SALE: SALE,
  GENESIS_CLAIM_TOKEN_ID: "1",
  GENESIS_CLAIM_ADMIN: ADMIN,
  GENESIS_CLAIM_SIGNER_ADDRESS: SIGNER,
  GENESIS_CLAIM_START: String(CLAIM_START),
  GENESIS_PUBLIC_SALE_START: String(SALE_START),
  GENESIS_PUBLIC_SALE_END: String(SALE_END),
  GENESIS_BASELINE_CLAIMED_SUPPLY: "2",
  EXPECTED_DEPLOYER_NONCE: String(NONCE),
});
const RECOVERY_ABI = new Interface([
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)",
  "function publicAllocation() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function publicSaleStart() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function claimedSupply() view returns (uint256)",
  "function admin() view returns (address)",
  "function signer() view returns (address)",
  "function paused() view returns (bool)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
  "function hasClaimed(address claimant) view returns (bool)",
]);
const RELEASE_ABI = new Interface([
  "function owner() view returns (address)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
]);
const SALE_ABI = new Interface([
  "function releases() view returns (address)",
  "function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)",
]);
const ISSUER_ROLE = keccak256("0x4953535545525f524f4c45");
const PRIOR_CLAIMANT_ADDRESSES = ["0x6a86EfA012fEDA64b70112022487fEE22E67d2fb", "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174"];

const encoder = (iface, name, args) => iface.encodeFunctionResult(name, args);
const selectorOf = (iface, signature) => iface.getFunction(signature).selector;

/** A C-Chain stand-in holding the live-shaped release, sale and edition, and an optional recovery contract at PREDICTED. */
function chain({ nonce = NONCE, pending = nonce, mintedSupply = 3n, sold = 1n, price = PRICE, owner = MAINNET_ARTIST_WALLET, admins = { [getAddress(MAINNET_ARTIST_WALLET)]: true }, onchain = {}, claimed = PRIOR_CLAIMANT_ADDRESSES, contractCode = "0x" } = {}) {
  const edition = { releaseId: ZeroHash, editionId: ZeroHash, artist: MAINNET_ARTIST_WALLET, maxSupply: 0n, mintedSupply, metadataUri: "ipfs://x", exists: true };
  const saleState = { priceWei: price, maxSupply: 0n, sold, perWalletLimit: 3n, startTime: BigInt(SALE_START), endTime: BigInt(SALE_END), paused: false, configured: true };
  const handlers = new Map([
    [selectorOf(RELEASE_ABI, "edition(uint256)"), () => encoder(RELEASE_ABI, "edition", [edition])],
    [selectorOf(SALE_ABI, "sales(uint256)"), () => encoder(SALE_ABI, "sales", [saleState.priceWei, saleState.maxSupply, saleState.sold, saleState.perWalletLimit, saleState.startTime, saleState.endTime, saleState.paused, saleState.configured])],
    [selectorOf(SALE_ABI, "releases()"), () => encoder(SALE_ABI, "releases", [RELEASE])],
    [selectorOf(RELEASE_ABI, "ISSUER_ROLE()"), () => encoder(RELEASE_ABI, "ISSUER_ROLE", [ISSUER_ROLE])],
    [selectorOf(RELEASE_ABI, "owner()"), () => encoder(RELEASE_ABI, "owner", [owner])],
  ]);
  const roleHandler = (data) => {
    const { role, account } = RELEASE_ABI.decodeFunctionData("hasRole", data);
    if (role === ZeroHash) return encoder(RELEASE_ABI, "hasRole", [Boolean(admins[getAddress(account)])]);
    return encoder(RELEASE_ABI, "hasRole", [false]);
  };
  for (const [name, value] of Object.entries(onchain)) handlers.set(selectorOf(RECOVERY_ABI, name), () => encoder(RECOVERY_ABI, name, [value]));
  const claimedSet = new Set(claimed.map((value) => getAddress(value)));
  handlers.set(selectorOf(RECOVERY_ABI, "hasClaimed(address)"), (data) => {
    console.error("HASCLAIMED_DATA:", JSON.stringify(data), typeof data);
    const { claimant } = RECOVERY_ABI.decodeFunctionData("hasClaimed", data);
    return encoder(RECOVERY_ABI, "hasClaimed", [claimedSet.has(getAddress(claimant))]);
  });
  return {
    getNetwork: async () => ({ chainId: 43114n }),
    getTransactionCount: async (_address, block) => (block === "pending" ? pending : nonce),
    call: async ({ to, data }) => {
      if (!data) { console.error("CALL_WITH_NULL_DATA to=", to, new Error().stack); throw new Error("null data"); }
      const selector = data.slice(0, 10).toLowerCase();
      if (getAddress(to) === RELEASE) {
        if (selector === selectorOf(RELEASE_ABI, "hasRole(bytes32,address)")) return roleHandler(data);
        if (!handlers.has(selector)) throw new Error(`unexpected RELEASE call ${selector}`);
        return handlers.get(selector)();
      }
      if (getAddress(to) === SALE) {
        if (!handlers.has(selector)) throw new Error(`unexpected SALE call ${selector}`);
        return handlers.get(selector)();
      }
      if (getAddress(to) === PREDICTED && contractCode !== "0x") {
        if (!handlers.has(selector)) throw new Error(`unexpected RECOVERY call ${selector}`);
        return handlers.get(selector)(data);
      }
      throw new Error(`call to unknown address ${to}`);
    },
    getCode: async (address) => (getAddress(address) === PREDICTED ? contractCode : "0x6001"),
    estimateGas: async () => 1_900_000n,
    getBalance: async () => 100_000_000_000_000_000n,
    getFeeData: async () => ({ maxFeePerGas: 2_500_000_000n, gasPrice: 2_500_000_000n }),
    send: async (method) => {
      if (method !== "eth_chainId") throw new Error(`unexpected ${method}`);
      return "0xa86a";
    },
  };
}

async function planFor(provider, env = ENV) {
  const config = validateRecoveryDeploymentEnv(env);
  const facts = await preflightRecoveryDeployment(config, { provider });
  const plan = buildRecoveryPlan(config, facts);
  return { config, facts, plan, signed: await recoverySigningPlan(config, facts, plan, { provider, artifact: ARTIFACT }) };
}

describe("recovery deployment: environment", () => {
  it("parses the reviewed inputs onto the fixed mainnet deployer with zero allocations", () => {
    const config = validateRecoveryDeploymentEnv(ENV);
    expect(config.deployerAddress).toBe(MAINNET_DEPLOYER);
    expect(config.allocation).toBe(0n);
    expect(config.publicAllocation).toBe(0n);
    expect(config.claimWindow).toBe(86400n);
    expect(config.claimEnd).toBe(BigInt(CLAIM_END));
    expect(config.priorClaimants).toHaveLength(2);
    expect(config.expectedDeployerNonce).toBe(15n);
  });
  it("refuses missing or malformed inputs", () => {
    expect(() => validateRecoveryDeploymentEnv({ ...ENV, GENESIS_CLAIM_START: undefined })).toThrow(/GENESIS_CLAIM_START/);
    expect(() => validateRecoveryDeploymentEnv({ ...ENV, EXPECTED_DEPLOYER_NONCE: "fifteen" })).toThrow(/EXPECTED_DEPLOYER_NONCE/);
    expect(() => validateRecoveryDeploymentEnv({ ...ENV, GENESIS_CLAIM_ADMIN: "not-an-address" })).toThrow();
  });
});

describe("recovery deployment: read-only preflight", () => {
  it("predicts the CREATE address from the live nonce and passes the live-shaped checks", async () => {
    const { facts } = await planFor(chain());
    expect(facts.predictedRecovery).toBe(PREDICTED);
    expect(facts.deployerNonce).toBe(NONCE);
    const [cfg, prior] = facts.args;
    expect(cfg.allocation).toBe(0n);
    expect(cfg.baselineClaimedSupply).toBe(2n);
    expect(prior).toHaveLength(2);
  });
  it("refuses a broken supply invariant", async () => {
    await expect(planFor(chain({ mintedSupply: 4n }))).rejects.toThrow(/Supply invariant/);
  });
  it("refuses a sale price that is not the configured public price", async () => {
    await expect(planFor(chain({ price: 1n }))).rejects.toThrow(/price/);
  });
  it("refuses a release the artist wallet does not own", async () => {
    await expect(planFor(chain({ owner: STRANGER }))).rejects.toThrow(/not the artist wallet/);
  });
  it("refuses a deployer holding DEFAULT_ADMIN_ROLE on the release", async () => {
    await expect(planFor(chain({ admins: { [getAddress(MAINNET_ARTIST_WALLET)]: true, [getAddress(MAINNET_DEPLOYER)]: true } }))).rejects.toThrow(/deployer must hold no release authority/);
  });
});

describe("recovery deployment: plan and plan inputs", () => {
  it("states the zero-allocation semantics explicitly and prepares the issuer grant calldata", async () => {
    const { plan } = await planFor(chain());
    expect(plan.supply.meaning).toMatch(/uncapped/);
    expect(plan.supply.claimAllocation).toBe("0");
    expect(plan.supply.publicAllocation).toBe("0");
    expect(plan.followUps.issuerGrant.role).toBe(ISSUER_ROLE);
    expect(plan.followUps.issuerGrant.from).toBe(getAddress(MAINNET_ARTIST_WALLET));
    const { role, account } = RELEASE_ABI.decodeFunctionData("grantRole", plan.followUps.issuerGrant.data);
    expect(role).toBe(ISSUER_ROLE);
    expect(account).toBe(PREDICTED);
    expect(plan.eligibility.rule).toBe(ELIGIBILITY_RULE);
    expect(plan.eligibility.genesisContract).toBe(GENESIS_CONTRACT);
  });
  it("round-trips planInputs into the same configuration", async () => {
    const { config, signed } = await planFor(chain());
    const parsed = validateRecoveryDeploymentEnv(signed.planInputs);
    expect(parsed.deployerAddress).toBe(config.deployerAddress);
    expect(parsed.claimStart).toBe(config.claimStart);
    expect(parsed.baselineClaimedSupply).toBe(config.baselineClaimedSupply);
    expect(parsed.releaseContract).toBe(config.releaseContract);
  });
});

describe("recovery deployment: signing gates", () => {
  it("passes every readiness gate on the live-shaped chain and binds the creation data", async () => {
    const { signed } = await planFor(chain());
    expect(signed.readyToSign).toBe(true);
    expect(signed.signingRequests).toHaveLength(1);
    const request = signed.signingRequests[0];
    expect(request.to).toBeNull();
    expect(request.nonce).toBe(NONCE);
    expect(request.predictedAddress).toBe(PREDICTED);
    expect(request.dataHash).toBe(keccak256(request.data));
    expect(signed.checks.every((check) => check.status === "PASS")).toBe(true);
  });
  it("refuses to be ready when the deployer has a pending transaction", async () => {
    const { signed } = await planFor(chain({ pending: NONCE + 1 }));
    expect(signed.readyToSign).toBe(false);
    expect(signed.checks.find((check) => /pending/.test(check.check)).status).toBe("FAIL");
  });
  it("refuses to be ready when the predicted address already has code", async () => {
    const { signed } = await planFor(chain({ contractCode: "0x6001" }));
    expect(signed.readyToSign).toBe(false);
    expect(signed.checks.find((check) => /empty/.test(check.check)).status).toBe("FAIL");
  });
});

describe("recovery deployment: verification from chain", () => {
  const mined = { step: 1, contract: "GenesisHolderClaimRecovery", address: PREDICTED, transaction: `0x${"ab".repeat(32)}`, block: 98_700_000, gasUsed: "1881995", runtimeCodeHash: keccak256("0x6001") };
  function verifyingProvider(signed, { claimed = PRIOR_CLAIMANT_ADDRESSES, onchain } = {}) {
    const state = chain({ contractCode: "0x6001", claimed, onchain });
    const request = signed.signingRequests[0];
    return {
      ...state,
      getTransactionReceipt: async (hash) => (hash === mined.transaction ? { status: 1, hash: mined.transaction, blockNumber: mined.block, contractAddress: PREDICTED, gasUsed: 1_881_995n } : null),
      getTransaction: async (hash) => (hash === mined.transaction ? { chainId: 43114n, from: MAINNET_DEPLOYER, nonce: request.nonce, to: null, value: 0n, data: request.data } : null),
    };
  }
  const matchingOnchain = {
    releaseContract: RELEASE, primarySale: SALE, tokenId: 1n, allocation: 0n, publicAllocation: 0n,
    claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleStart: BigInt(SALE_START),
    publicSaleEnd: BigInt(SALE_END), publicPriceWei: PRICE, claimedSupply: 2n, admin: ADMIN, signer: SIGNER,
    paused: false, ELIGIBILITY_RULE: ELIGIBILITY_RULE,
  };
  it("verifies the mined recovery contract against the reviewed plan", async () => {
    const { signed } = await planFor(chain());
    const verified = await verifyRecoveryDeployment(verifyingProvider(signed, { onchain: matchingOnchain }), signed, mined.transaction, { timeoutMs: 100 });
    expect(verified.address).toBe(PREDICTED);
    expect(verified.issuerGrant).toMatch(/PENDING/);
  });
  it("fails when the mined claimStart differs from the plan", async () => {
    const { signed } = await planFor(chain());
    await expect(verifyRecoveryDeployment(verifyingProvider(signed, { onchain: { ...matchingOnchain, claimStart: BigInt(CLAIM_START + 1) } }), signed, mined.transaction, { timeoutMs: 100 })).rejects.toThrow(/claimStart/);
  });
  it("fails when a prior claimant is not seeded as claimed", async () => {
    const { signed } = await planFor(chain());
    await expect(verifyRecoveryDeployment(verifyingProvider(signed, { claimed: [], onchain: matchingOnchain }), signed, mined.transaction, { timeoutMs: 100 })).rejects.toThrow(/seeded/);
  });
});

describe("owner signing tool: genesis-recovery-mainnet kind", () => {
  it("is registered, ready-gated, and binds a plan to the commit", async () => {
    const spec = KINDS["genesis-recovery-mainnet"];
    expect(spec.title).toMatch(/GenesisHolderClaimRecovery/);
    expect(spec.needsDeviceConfirmation).toBe(false);
    expect(spec.ready({ readyToSign: true })).toBe(true);
    expect(spec.ready({ readyToSign: false })).toBe(false);
    const { signed } = await planFor(chain());
    const digest = bindPlan("genesis-recovery-mainnet", { mode: "DRY_RUN", ...signed }, "f0e9f68e422167480de63b9434fb503b05198bcb");
    expect(typeof digest.digest).toBe("string");
    expect(digest.digest).toBe(bindPlan("genesis-recovery-mainnet", { mode: "DRY_RUN", ...signed }, "f0e9f68e422167480de63b9434fb503b05198bcb").digest);
  });
});
