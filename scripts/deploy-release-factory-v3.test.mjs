import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, getAddress, id } from "ethers";
import { FACTORY_ARTIFACT_PATH, IMPLEMENTATION_ARTIFACT_PATH, V5_SIGNATURES, assertV5Artifact, broadcastDeployment, buildDryRunPlan, deploymentRecordPath, missingV5Selectors, run, validateDeploymentEnv } from "./deploy-release-factory-v3.mjs";

const KEY = `0x${"11".repeat(32)}`;
const DEPLOYER = new Wallet(KEY).address;
const TREASURY = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const FUJI = { DEPLOY_NETWORK: "fuji", AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", DEPLOYER_PRIVATE_KEY: KEY, BROADCAST_DEPLOYMENT: "no" };
const MAINNET = { DEPLOY_NETWORK: "mainnet", AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc", DEPLOYER_PRIVATE_KEY: KEY, RELEASE_PLATFORM_RECIPIENT: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a", RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a", BROADCAST_DEPLOYMENT: "no" };
const v5Runtime = `0x${V5_SIGNATURES.map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
const provider = (chainId = 43113n, code = v5Runtime) => ({ getNetwork: async () => ({ chainId }), getCode: async () => code });
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const MARKET = getAddress("0x00000000000000000000000000000000000000f2");
const IMPL = getAddress("0x00000000000000000000000000000000000000f3");
const loadArtifacts = (runtime = v5Runtime) => async (path) => (path === IMPLEMENTATION_ARTIFACT_PATH ? { name: "implementation", deployedBytecode: { object: runtime } } : { name: path === FACTORY_ARTIFACT_PATH ? "factory" : "marketplace" });
function fakeDeploy({ releaseVersion = 3n } = {}) {
  const calls = [];
  const deploy = async (artifact, args) => {
    calls.push({ artifact: artifact.name, args });
    if (artifact.name === "factory") return { address: FACTORY, receipt: { hash: "0xf1", blockNumber: 1 }, contract: { implementation: async () => IMPL, RELEASE_VERSION: async () => releaseVersion, PLATFORM_FEE_BPS: async () => 250n } };
    return { address: MARKET, receipt: { hash: "0xf2", blockNumber: 2 }, contract: { registry: async () => FACTORY } };
  };
  return { calls, deploy };
}

describe("Factory V3 deployment preflight", () => {
  it("dry-runs by default on Fuji with the existing treasury and never broadcasts", async () => {
    const config = validateDeploymentEnv(FUJI);
    expect(config).toMatchObject({ network: "fuji", chainId: 43113, platformRecipient: TREASURY, broadcast: false });
    expect(buildDryRunPlan(config)).toMatchObject({ factory: { artifact: "out/VoidReleaseFactoryV3.sol/VoidReleaseFactoryV3.json" }, postDeployment: { activation: expect.stringMatching(/owner authorization/) } });
    const broadcast = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(run(["--dry-run"], FUJI, { provider: provider(), assertV5: async () => {}, broadcastDeployment: broadcast })).resolves.toMatchObject({ mode: "DRY_RUN" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("gates every broadcast on the network confirmation and the reviewed deployer", () => {
    expect(() => validateDeploymentEnv({ ...FUJI, BROADCAST_DEPLOYMENT: "yes" })).toThrow(/CONFIRM_FUJI_DEPLOY/);
    expect(() => validateDeploymentEnv({ ...FUJI, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes" })).toThrow(/EXPECTED_DEPLOYER_ADDRESS/);
    expect(() => validateDeploymentEnv({ ...FUJI, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: TREASURY })).toThrow(/does not belong/);
    expect(validateDeploymentEnv({ ...FUJI, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER }).broadcast).toBe(true);
    expect(() => validateDeploymentEnv({ ...MAINNET, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER })).toThrow(/CONFIRM_MAINNET_DEPLOY/);
  });

  it("requires owner-named mainnet fee recipients and keeps the Fuji treasury fixed", () => {
    expect(validateDeploymentEnv(MAINNET)).toMatchObject({ network: "mainnet", chainId: 43114 });
    expect(() => validateDeploymentEnv({ ...MAINNET, RELEASE_PLATFORM_RECIPIENT: "" })).toThrow(/RELEASE_PLATFORM_RECIPIENT/);
    expect(() => validateDeploymentEnv({ ...FUJI, RELEASE_PLATFORM_RECIPIENT: "0x0000000000000000000000000000000000000011" })).toThrow(/existing permanent treasury/);
    expect(() => validateDeploymentEnv({ ...FUJI, RELEASE_PLATFORM_FEE_BPS: "500" })).toThrow(/exactly 250/);
    expect(() => validateDeploymentEnv({ ...FUJI, DEPLOY_NETWORK: "sepolia" })).toThrow(/DEPLOY_NETWORK/);
  });

  it("refuses a provider on a different chain than DEPLOY_NETWORK", async () => {
    await expect(run([], FUJI, { provider: provider(43114n), assertV5: async () => {} })).rejects.toThrow(/expects 43113/);
    await expect(run([], MAINNET, { provider: provider(43113n), assertV5: async () => {} })).rejects.toThrow(/expects 43114/);
  });

  it("refuses an implementation that does not take provenance roots", async () => {
    expect(missingV5Selectors(v5Runtime)).toEqual([]);
    const v4Like = `0x63${id("createEdition(bytes32,bytes32,uint256,string,address,uint96)").slice(2, 10)}`;
    expect(missingV5Selectors(v4Like)).toEqual(V5_SIGNATURES);
    await expect(assertV5Artifact(loadArtifacts(v4Like))).rejects.toThrow(/lacks/);
  });

  it("deploys Factory V3 then its marketplace, verifies both, and only proposes the manifest change", async () => {
    const { calls, deploy } = fakeDeploy();
    const writeRecord = vi.fn();
    const logs = [];
    const record = await broadcastDeployment(validateDeploymentEnv(FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord, log: (value) => logs.push(value), wallet: {} });
    expect(calls.map((call) => call.artifact)).toEqual(["factory", "marketplace"]);
    expect(calls[0].args).toEqual([TREASURY]);
    expect(calls[1].args).toEqual([TREASURY, 250, FACTORY]);
    expect(record).toMatchObject({ provenanceAtCreation: true, factory: { name: "VoidReleaseFactoryV3", releaseVersion: 3, implementationVersion: 5, implementationAddress: IMPL }, marketplace: { address: MARKET, factoryAddress: FACTORY } });
    expect(writeRecord).toHaveBeenCalledWith(deploymentRecordPath("fuji", FACTORY), record);
    expect(logs.find((entry) => entry.step === "ACTIVATION_NOT_PERFORMED").proposedManifestEntry).toMatchObject({ factoryAddress: FACTORY, releaseVersion: 3, provenanceAtCreation: true });
  });

  it("stops before the marketplace when the mined factory is not V3", async () => {
    const { calls, deploy } = fakeDeploy({ releaseVersion: 2n });
    await expect(broadcastDeployment(validateDeploymentEnv(FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: {} })).rejects.toThrow(/not the reviewed Factory V3/);
    expect(calls.map((call) => call.artifact)).toEqual(["factory"]);
  });

  it("matches the compiled V5 artifact when Foundry output is present", () => {
    const path = resolve(import.meta.dirname, "..", IMPLEMENTATION_ARTIFACT_PATH);
    if (!existsSync(path)) return;
    expect(missingV5Selectors(JSON.parse(readFileSync(path, "utf8")).deployedBytecode.object)).toEqual([]);
  });
});
