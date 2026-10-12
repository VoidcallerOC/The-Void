import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, getAddress, getCreateAddress, id } from "ethers";
import { FACTORY_ARTIFACT_PATH, IMPLEMENTATION_ARTIFACT_PATH, V5_REQUIRED_ERRORS, V5_SIGNATURES, assertRpcChainId, assertV5Artifact, broadcastDeployment, buildDryRunPlan, deploymentRecordPath, missingV5Selectors, run, validateDeploymentEnv } from "./deploy-release-factory-v3.mjs";

const KEY = `0x${"11".repeat(32)}`;
const DEPLOYER = new Wallet(KEY).address;
const TREASURY = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const FUJI = { DEPLOY_NETWORK: "fuji", AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc", DEPLOYER_PRIVATE_KEY: KEY, BROADCAST_DEPLOYMENT: "no" };
const MAINNET = { DEPLOY_NETWORK: "mainnet", AVALANCHE_MAINNET_RPC_URL: "https://api.avax.network/ext/bc/C/rpc", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, RELEASE_PLATFORM_RECIPIENT: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a", RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a", BROADCAST_DEPLOYMENT: "no" };
const v5Runtime = `0x${V5_SIGNATURES.map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
// getNetwork() always claims Fuji, like a staticNetwork provider; only eth_chainId reflects the node.
const NONCE = 61;
const provider = (chainId = 43113n, code = v5Runtime, { nonce = NONCE, pending = nonce } = {}) => ({ getNetwork: async () => ({ chainId: 43113n }), send: async (method) => { if (method !== "eth_chainId") throw new Error(`unexpected ${method}`); return `0x${chainId.toString(16)}`; }, getCode: async () => code, getTransactionCount: async (_address, tag) => (tag === "pending" ? pending : nonce) });
// A broadcast config: the reviewed dry run printed deployer nonce 61.
const BROADCAST_FUJI = { ...FUJI, EXPECTED_DEPLOYER_NONCE: String(NONCE) };
const replying = (reply) => ({ send: async () => reply });
const signer = (address = DEPLOYER) => ({ getAddress: async () => address });
// CREATE addresses for the deployer's next two nonces, as a real deployment would produce.
const FACTORY = getCreateAddress({ from: DEPLOYER, nonce: NONCE });
const MARKET = getCreateAddress({ from: DEPLOYER, nonce: NONCE + 1 });
const IMPL = getAddress("0x00000000000000000000000000000000000000f3");
const V5_ABI = [{ type: "error", name: "StandaloneEditionsExist", inputs: [] }];
const loadArtifacts = (runtime = v5Runtime, abi = V5_ABI) => async (path) => (path === IMPLEMENTATION_ARTIFACT_PATH ? { name: "implementation", abi, deployedBytecode: { object: runtime } } : { name: path === FACTORY_ARTIFACT_PATH ? "factory" : "marketplace" });
function fakeDeploy({ releaseVersion = 3n, from = DEPLOYER, factoryAddress = FACTORY } = {}) {
  const calls = [];
  const deploy = async (artifact, args, _wallet, overrides) => {
    calls.push({ artifact: artifact.name, args, overrides });
    if (artifact.name === "factory") return { address: factoryAddress, receipt: { hash: "0xf1", blockNumber: 1, from }, contract: { implementation: async () => IMPL, RELEASE_VERSION: async () => releaseVersion, PLATFORM_FEE_BPS: async () => 250n } };
    return { address: MARKET, receipt: { hash: "0xf2", blockNumber: 2, from }, contract: { registry: async () => FACTORY } };
  };
  return { calls, deploy };
}

describe("Factory V3 deployment preflight", () => {
  it("plans a dry run from the reviewed address alone and requires the key only to broadcast", () => {
    const { DEPLOYER_PRIVATE_KEY: _omitted, ...keyless } = FUJI;
    expect(validateDeploymentEnv({ ...keyless, EXPECTED_DEPLOYER_ADDRESS: DEPLOYER })).toMatchObject({ deployerAddress: DEPLOYER, deployerPrivateKey: null, broadcast: false });
    expect(() => validateDeploymentEnv(keyless)).toThrow(/EXPECTED_DEPLOYER_ADDRESS/);
    expect(() => validateDeploymentEnv({ ...keyless, EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "0", BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes" })).toThrow(/requires DEPLOYER_PRIVATE_KEY/);
  });

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
    expect(validateDeploymentEnv({ ...FUJI, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER, EXPECTED_DEPLOYER_NONCE: "61" }).broadcast).toBe(true);
    // Mainnet never reads a key or broadcasts from this script; the owner signs mainnet in Rabby.
    expect(() => validateDeploymentEnv({ ...MAINNET, BROADCAST_DEPLOYMENT: "yes", CONFIRM_MAINNET_DEPLOY: "yes" })).toThrow(/signed by the owner in Rabby/);
    expect(() => validateDeploymentEnv({ ...MAINNET, DEPLOYER_PRIVATE_KEY: KEY })).toThrow(/never reads a mainnet key/);
  });

  it("requires owner-named mainnet fee recipients and keeps the Fuji treasury fixed", () => {
    expect(validateDeploymentEnv(MAINNET)).toMatchObject({ network: "mainnet", chainId: 43114 });
    expect(() => validateDeploymentEnv({ ...MAINNET, RELEASE_PLATFORM_RECIPIENT: "" })).toThrow(/RELEASE_PLATFORM_RECIPIENT/);
    expect(() => validateDeploymentEnv({ ...FUJI, RELEASE_PLATFORM_RECIPIENT: "0x0000000000000000000000000000000000000011" })).toThrow(/existing permanent treasury/);
    expect(() => validateDeploymentEnv({ ...FUJI, RELEASE_PLATFORM_FEE_BPS: "500" })).toThrow(/exactly 250/);
    expect(() => validateDeploymentEnv({ ...FUJI, DEPLOY_NETWORK: "sepolia" })).toThrow(/DEPLOY_NETWORK/);
  });

  it("refuses a provider on a different chain than DEPLOY_NETWORK, asking the node with eth_chainId", async () => {
    await expect(run([], FUJI, { provider: provider(43114n), assertV5: async () => {} })).rejects.toThrow(/must be 43113/);
    await expect(run(["--dry-run"], FUJI, { provider: provider(1n), assertV5: async () => {} })).rejects.toThrow(/must be 43113/);
    await expect(run([], MAINNET, { provider: provider(43113n), assertV5: async () => {} })).rejects.toThrow(/must be 43114/);
  });

  it("accepts only an eth_chainId reply of 43113 for Fuji and fails closed otherwise", async () => {
    await expect(assertRpcChainId(replying("0xa869"), 43113)).resolves.toBe(43113n);
    await expect(assertRpcChainId(replying("0xA869"), 43113)).resolves.toBe(43113n);
    await expect(assertRpcChainId(replying("0xa86a"), 43113)).rejects.toThrow(/Refusing chain 43114/);
    for (const reply of [undefined, null, 43113, "", "0x", "43113", "0xfuji", { chainId: "0xa869" }]) {
      await expect(assertRpcChainId(replying(reply), 43113)).rejects.toThrow(/malformed eth_chainId/);
    }
  });

  it("fails closed when eth_chainId errors, without echoing the RPC URL or error text", async () => {
    const secretUrl = "https://user:secret-token@rpc.example/ext/bc/C/rpc";
    const failing = { send: async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${secretUrl}`), { code: "SERVER_ERROR" }); } };
    const error = await assertRpcChainId(failing, 43113).catch((caught) => caught);
    expect(error.message).toMatch(/eth_chainId failed on the configured RPC \(SERVER_ERROR\)/);
    expect(error.message).not.toMatch(/secret-token|rpc\.example|ECONNREFUSED/);
  });

  it("checks eth_chainId inside the broadcast path before any transaction", async () => {
    for (const bad of [provider(43114n), replying("0x"), { send: async () => { throw new Error("down"); } }]) {
      const { calls, deploy } = fakeDeploy();
      await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), bad, { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/eth_chainId|Refusing chain/);
      expect(calls).toEqual([]);
    }
  });

  it("records the address of the signer that sent both deployments and never the key", async () => {
    const { deploy } = fakeDeploy();
    const writeRecord = vi.fn();
    const logs = [];
    const record = await broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord, log: (value) => logs.push(value), wallet: signer() });
    expect(record.deployer).toBe(DEPLOYER);
    expect(record.factory.deployer).toBe(DEPLOYER);
    expect(writeRecord.mock.calls[0][1].deployer).toBe(DEPLOYER);
    const written = JSON.stringify({ record, logs });
    expect(written).not.toContain(KEY);
    expect(written.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
  });

  it("refuses a signer that is not the validated key's address before deploying", async () => {
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer(TREASURY) })).rejects.toThrow(/does not match the validated DEPLOYER_PRIVATE_KEY/);
    expect(calls).toEqual([]);
  });

  it("stops before the marketplace when the factory receipt was sent by another address", async () => {
    const { calls, deploy } = fakeDeploy({ from: TREASURY });
    const writeRecord = vi.fn();
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord, log: () => {}, wallet: signer() })).rejects.toThrow(/not sent by the validated deployer/);
    expect(calls.map((call) => call.artifact)).toEqual(["factory"]);
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it("refuses a V5 build without the D3 standalone-edition guard", async () => {
    expect(V5_SIGNATURES).toContain("hasStandaloneEditions()");
    const withoutGuard = `0x${V5_SIGNATURES.filter((signature) => signature !== "hasStandaloneEditions()").map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
    expect(missingV5Selectors(withoutGuard)).toEqual(["hasStandaloneEditions()"]);
    await expect(assertV5Artifact(loadArtifacts(withoutGuard))).rejects.toThrow(/lacks hasStandaloneEditions\(\)/);
    // The compiled artifact must also declare the StandaloneEditionsExist error.
    await expect(assertV5Artifact(loadArtifacts(v5Runtime, []))).rejects.toThrow(/lacks error StandaloneEditionsExist\(\)/);
    await expect(assertV5Artifact(loadArtifacts())).resolves.toBeUndefined();
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(43113n, withoutGuard), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/not the reviewed Factory V3/);
    expect(calls.map((call) => call.artifact)).toEqual(["factory"]);
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
    const record = await broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord, log: (value) => logs.push(value), wallet: signer() });
    expect(calls.map((call) => call.artifact)).toEqual(["factory", "marketplace"]);
    expect(calls[0].args).toEqual([TREASURY]);
    expect(calls[1].args).toEqual([TREASURY, 250, FACTORY]);
    expect(record).toMatchObject({ provenanceAtCreation: true, factory: { name: "VoidReleaseFactoryV3", releaseVersion: 3, implementationVersion: 5, implementationAddress: IMPL }, marketplace: { address: MARKET, factoryAddress: FACTORY } });
    expect(writeRecord).toHaveBeenCalledWith(deploymentRecordPath("fuji", FACTORY), record);
    expect(logs.find((entry) => entry.step === "ACTIVATION_NOT_PERFORMED").proposedManifestEntry).toMatchObject({ factoryAddress: FACTORY, releaseVersion: 3, provenanceAtCreation: true });
  });

  it("stops before the marketplace when the mined factory is not V3", async () => {
    const { calls, deploy } = fakeDeploy({ releaseVersion: 2n });
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/not the reviewed Factory V3/);
    expect(calls.map((call) => call.artifact)).toEqual(["factory"]);
  });

  it("requires the reviewed dry-run nonce for every broadcast and rejects a malformed one", () => {
    const confirmed = { ...FUJI, BROADCAST_DEPLOYMENT: "yes", CONFIRM_FUJI_DEPLOY: "yes", EXPECTED_DEPLOYER_ADDRESS: DEPLOYER };
    expect(() => validateDeploymentEnv(confirmed)).toThrow(/EXPECTED_DEPLOYER_NONCE/);
    expect(() => validateDeploymentEnv({ ...confirmed, EXPECTED_DEPLOYER_NONCE: "-1" })).toThrow(/non-negative whole number/);
    expect(() => validateDeploymentEnv({ ...confirmed, EXPECTED_DEPLOYER_NONCE: "6.1" })).toThrow(/non-negative whole number/);
    expect(validateDeploymentEnv({ ...confirmed, EXPECTED_DEPLOYER_NONCE: "61" })).toMatchObject({ broadcast: true, expectedDeployerNonce: 61 });
    // A dry run does not need it.
    expect(validateDeploymentEnv(FUJI).expectedDeployerNonce).toBeNull();
  });

  it("refuses to sign when the deployer nonce moved since the reviewed dry run (stale predicted addresses)", async () => {
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(43113n, v5Runtime, { nonce: 62 }), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/nonce is 62, not the reviewed 61: the predicted addresses are stale/);
    expect(calls).toEqual([]);
  });

  it("refuses to sign while the deployer has pending transactions", async () => {
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(43113n, v5Runtime, { nonce: 61, pending: 62 }), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/pending transactions/);
    expect(calls).toEqual([]);
  });

  it("refuses a broadcast config that carries no reviewed nonce, even if a caller skips validation", async () => {
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/reviewed \(missing\)/);
    expect(calls).toEqual([]);
  });

  it("pins both deployments to the verified nonces and logs the predicted addresses before signing", async () => {
    const { calls, deploy } = fakeDeploy();
    const logs = [];
    const record = await broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: (value) => logs.push(value), wallet: signer() });
    expect(calls.map((call) => call.overrides)).toEqual([{ nonce: 61 }, { nonce: 62 }]);
    expect(logs[0]).toEqual({ step: "BROADCAST_PREFLIGHT_PASSED", deployerNonce: 61, predictedFactoryAddress: FACTORY, predictedMarketplaceAddress: MARKET });
    expect(record.factory.address).toBe(FACTORY);
    expect(record.marketplace.address).toBe(MARKET);
  });

  it("stops before the marketplace when the factory was mined at an address other than the prediction", async () => {
    const { calls, deploy } = fakeDeploy({ factoryAddress: getAddress("0x00000000000000000000000000000000000000f9") });
    await expect(broadcastDeployment(validateDeploymentEnv(BROADCAST_FUJI), provider(), { load: loadArtifacts(), deploy, writeRecord: vi.fn(), log: () => {}, wallet: signer() })).rejects.toThrow(/not the predicted/);
    expect(calls.map((call) => call.artifact)).toEqual(["factory"]);
  });

  it("matches the compiled V5 artifact when Foundry output is present", () => {
    const path = resolve(import.meta.dirname, "..", IMPLEMENTATION_ARTIFACT_PATH);
    if (!existsSync(path)) return;
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    expect(missingV5Selectors(artifact.deployedBytecode.object)).toEqual([]);
    expect(artifact.abi.filter((item) => item.type === "error").map((item) => item.name)).toEqual(expect.arrayContaining(V5_REQUIRED_ERRORS));
  });
});
