import { describe, expect, it } from "vitest";
import { Wallet, getAddress, getCreateAddress, id } from "ethers";
import { ALBUM_SIGNATURES } from "./deploy-release-per-contract-fuji.mjs";
import { DeploymentError, FEE_RECIPIENT, MAINNET_CHAIN_ID, broadcastDeployment, buildDryRunPlan, deploymentRecordPath, run, validateDeploymentEnv } from "./deploy-release-per-contract-mainnet.mjs";

const KEY = `0x${"22".repeat(32)}`;
const DEPLOYER = new Wallet(KEY).address;
const RECIPIENT = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const ARTIST = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const BASE = { DEPLOY_NETWORK: "mainnet", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER };
const BROADCAST = { ...BASE, DEPLOYER_PRIVATE_KEY: KEY, EXPECTED_DEPLOYER_NONCE: "0", RELEASE_PLATFORM_RECIPIENT: RECIPIENT, RECIPIENT_VERIFIED_ON_DEVICE: RECIPIENT, BROADCAST_DEPLOYMENT: "yes", CONFIRM_MAINNET_DEPLOY: "yes" };
const albumRuntime = `0x${ALBUM_SIGNATURES.map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
const CONSTRUCTORS = {
  Factory: [{ type: "constructor", inputs: [{ name: "platformRecipient_", type: "address" }], stateMutability: "nonpayable" }],
  Marketplace: [{ type: "constructor", inputs: [{ name: "feeRecipient_", type: "address" }, { name: "platformFeeBps_", type: "uint256" }, { name: "releaseFactory_", type: "address" }], stateMutability: "nonpayable" }],
};
const artifacts = async (path) => ({
  abi: path.includes("Factory") ? CONSTRUCTORS.Factory : path.includes("Marketplace") ? CONSTRUCTORS.Marketplace : [],
  bytecode: { object: "0x6000" },
  deployedBytecode: { object: path.includes("VoidRelease1155V4") ? albumRuntime : "0x6000" },
});

function fakeProvider({ chainId = MAINNET_CHAIN_ID, nonce = 0, pendingNonce = nonce, balance = 10n ** 18n, code = {} } = {}) {
  return {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getTransactionCount: async (_address, tag) => (tag === "pending" ? pendingNonce : nonce),
    getBalance: async () => balance,
    getCode: async (target) => code[getAddress(target)] ?? "0x",
    getFeeData: async () => ({ maxFeePerGas: 10_000_000_000n }),
    estimateGas: async () => 1_000_000n,
  };
}

describe("release-per-contract mainnet deployment preflight", () => {
  it("plans a dry run from the deployer address alone and reports the missing recipient as BLOCKED", async () => {
    const plan = await buildDryRunPlan(validateDeploymentEnv(BASE), fakeProvider(), { load: artifacts });
    expect(plan).toMatchObject({ mode: "DRY_RUN", chainId: 43114, broadcasted: false, readyToBroadcast: false });
    expect(plan.transactions[0]).toMatchObject({ contract: "VoidReleaseFactoryV2", predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 0 }), sealedInBytecode: { PLATFORM_FEE_BPS: 250 } });
    expect(plan.transactions[1]).toMatchObject({ contract: "ReleaseMarketplaceV3", predictedAddress: getCreateAddress({ from: DEPLOYER, nonce: 1 }), constructor: { platformFeeBps: 250, releaseFactory: plan.transactions[0].predictedAddress } });
    expect(plan.transactions[0].predictedImplementation).toBe(getCreateAddress({ from: plan.transactions[0].predictedAddress, nonce: 1 }));
    expect(plan.checks.find((item) => item.check === "platformRecipient verified")).toMatchObject({ status: "BLOCKED" });
  });

  it("refuses Fuji and every other chain", async () => {
    await expect(buildDryRunPlan(validateDeploymentEnv(BASE), fakeProvider({ chainId: 43113 }), { load: artifacts })).rejects.toThrow(/Expected Avalanche C-Chain 43114/);
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOY_NETWORK: "fuji" })).toThrow(/mainnet/);
  });

  it("accepts only the recorded Nano S Plus for both fees and refuses the artist, the deployer, any other address, a split, and any fee other than 250 bps", () => {
    expect(FEE_RECIPIENT).toBe(getAddress(RECIPIENT));
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: ARTIST })).toThrow(/artist wallet/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: "0x00000000000000000000000000000000000000A1" })).toThrow(/Nano S Plus recorded/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: DEPLOYER })).toThrow(/deployer/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: RECIPIENT, RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x00000000000000000000000000000000000000A2" })).toThrow(/one recipient/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_FEE_BPS: "500" })).toThrow(/exactly 250/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_MARKETPLACE_FEE_BPS: "0" })).toThrow(/exactly 250/);
    expect(validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: RECIPIENT }).marketplaceFeeRecipient).toBe(getAddress(RECIPIENT));
  });

  it("requires every broadcast gate, including the recipient re-typed from the device screen", () => {
    expect(validateDeploymentEnv(BROADCAST)).toMatchObject({ broadcast: true, platformRecipient: getAddress(RECIPIENT) });
    for (const [field, pattern] of [["CONFIRM_MAINNET_DEPLOY", /CONFIRM_MAINNET_DEPLOY/], ["DEPLOYER_PRIVATE_KEY", /DEPLOYER_PRIVATE_KEY/], ["EXPECTED_DEPLOYER_NONCE", /EXPECTED_DEPLOYER_NONCE/], ["RELEASE_PLATFORM_RECIPIENT", /RELEASE_PLATFORM_RECIPIENT/], ["RECIPIENT_VERIFIED_ON_DEVICE", /RECIPIENT_VERIFIED_ON_DEVICE/]]) {
      expect(() => validateDeploymentEnv({ ...BROADCAST, [field]: "" }), field).toThrow(pattern);
    }
    expect(() => validateDeploymentEnv({ ...BROADCAST, RECIPIENT_VERIFIED_ON_DEVICE: "0x00000000000000000000000000000000000000A2" })).toThrow(/equal RELEASE_PLATFORM_RECIPIENT/);
    expect(() => validateDeploymentEnv({ ...BROADCAST, EXPECTED_DEPLOYER_ADDRESS: RECIPIENT })).toThrow(/does not belong/);
  });

  it("is not ready when the nonce moved, a transaction is pending, a predicted address has code, or funding is short", async () => {
    const config = validateDeploymentEnv(BROADCAST);
    const predicted = getCreateAddress({ from: DEPLOYER, nonce: 0 });
    for (const provider of [fakeProvider({ nonce: 1 }), fakeProvider({ pendingNonce: 1 }), fakeProvider({ code: { [predicted]: "0x60" } }), fakeProvider({ balance: 0n }), fakeProvider({ code: { [getAddress(RECIPIENT)]: "0x60" } })]) {
      expect((await buildDryRunPlan(config, provider, { load: artifacts })).readyToBroadcast).toBe(false);
    }
    expect((await buildDryRunPlan(config, fakeProvider(), { load: artifacts })).readyToBroadcast).toBe(true);
  });

  it("never broadcasts in the default path and refuses a broadcast whose plan is not ready", async () => {
    const plan = await run(["--dry-run"], BASE, { provider: fakeProvider(), buildDryRunPlan: (config, provider) => buildDryRunPlan(config, provider, { load: artifacts }), broadcastDeployment: () => { throw new Error("must not broadcast"); } });
    expect(plan).toMatchObject({ mode: "DRY_RUN", broadcasted: false });
    await expect(run([], BROADCAST, { provider: fakeProvider({ balance: 0n }), buildDryRunPlan: (config, provider) => buildDryRunPlan(config, provider, { load: artifacts }) })).rejects.toThrow(DeploymentError);
    await expect(run(["--dry-run"], BROADCAST, { provider: fakeProvider() })).rejects.toThrow(/--dry-run cannot be combined/);
  });

  it("stops before the marketplace when the mined factory differs from the reviewed plan", async () => {
    const config = validateDeploymentEnv(BROADCAST);
    const plan = await buildDryRunPlan(config, fakeProvider(), { load: artifacts });
    const calls = [];
    const deploy = async (artifact, args) => {
      calls.push(args);
      return { address: getAddress("0x00000000000000000000000000000000000000F1"), receipt: { hash: "0x1", blockNumber: 1 }, contract: {} };
    };
    await expect(broadcastDeployment(config, fakeProvider(), plan, { load: artifacts, deploy, log: () => {}, signer: {} })).rejects.toThrow(/not the reviewed/);
    expect(calls).toHaveLength(1);
  });

  it("verifies every immutable after mining and writes a mainnet record", async () => {
    const config = validateDeploymentEnv(BROADCAST);
    const plan = await buildDryRunPlan(config, fakeProvider(), { load: artifacts });
    const [factoryStep, marketplaceStep] = plan.transactions;
    const deploy = async (_artifact, args) => (args.length === 1
      ? { address: factoryStep.predictedAddress, receipt: { hash: "0xf1", blockNumber: 10 }, contract: { implementation: async () => factoryStep.predictedImplementation, platformRecipient: async () => RECIPIENT, PLATFORM_FEE_BPS: async () => 250n, RELEASE_VERSION: async () => 2n } }
      : { address: marketplaceStep.predictedAddress, receipt: { hash: "0xf2", blockNumber: 11 }, contract: { registry: async () => factoryStep.predictedAddress, feeRecipient: async () => RECIPIENT, platformFeeBps: async () => 250n, deploymentChainId: async () => 43114n } });
    const written = [];
    const provider = { ...fakeProvider(), getCode: async () => albumRuntime };
    const record = await broadcastDeployment(config, provider, plan, { load: artifacts, deploy, log: () => {}, signer: {}, writeRecord: async (path, value) => written.push({ path, value }) });
    expect(record).toMatchObject({ network: "mainnet", chainId: 43114, factory: { address: factoryStep.predictedAddress, platformRecipient: getAddress(RECIPIENT), platformFeeBps: 250 }, marketplace: { address: marketplaceStep.predictedAddress, feeBps: 250, factoryAddress: factoryStep.predictedAddress } });
    expect(written[0].path).toBe(deploymentRecordPath(factoryStep.predictedAddress));
    expect(written[0].path).toMatch(/^deployments\/release-per-contract-mainnet-0x/);
  });
});
