import { describe, expect, it } from "vitest";
import { getAddress, id } from "ethers";
import { ALBUM_SIGNATURES, FUJI_CHAIN_ID, assertAlbumCapableArtifact, broadcastDeployment, buildDryRunPlan, deploymentRecordPath, missingAlbumSelectors, run, validateDeploymentEnv } from "./deploy-release-per-contract-fuji.mjs";

const KEY = `0x${"11".repeat(32)}`;
const BASE = {
  DEPLOY_NETWORK: "fuji",
  AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
  DEPLOYER_PRIVATE_KEY: KEY,
  RELEASE_PLATFORM_RECIPIENT: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4",
  RELEASE_PLATFORM_FEE_BPS: "250",
  RELEASE_MARKETPLACE_FEE_RECIPIENT: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4",
  BROADCAST_DEPLOYMENT: "no",
};

const provider = { getNetwork: async () => ({ chainId: BigInt(FUJI_CHAIN_ID) }) };
const assertAlbumCapable = async () => {};
const albumRuntime = `0x${ALBUM_SIGNATURES.map((signature) => `63${id(signature).slice(2, 10)}`).join("")}`;
const FACTORY = "0x00000000000000000000000000000000000000F1";
const MARKET = "0x00000000000000000000000000000000000000F2";
const IMPL = "0x00000000000000000000000000000000000000F3";
function fakeDeploy() {
  const calls = [];
  const deploy = async (artifact, args) => {
    calls.push({ artifact: artifact.name, args });
    if (artifact.name === "factory") return { address: FACTORY, receipt: { hash: "0xf1", blockNumber: 1 }, contract: { implementation: async () => IMPL } };
    return { address: MARKET, receipt: { hash: "0xf2", blockNumber: 2 }, contract: { registry: async () => FACTORY } };
  };
  return { calls, deploy };
}
const loadArtifacts = (runtime = albumRuntime) => async (path) => (path.includes("VoidRelease1155V4")
  ? { name: "implementation", deployedBytecode: { object: runtime } }
  : { name: path.includes("Factory") ? "factory" : "marketplace" });

describe("release-per-contract Fuji deployment preflight", () => {
  it("validates the new architecture configuration and does not require broadcast confirmation for dry-run", () => {
    expect(validateDeploymentEnv(BASE)).toMatchObject({ network: "fuji", platformFeeBps: 250, broadcast: false });
    expect(buildDryRunPlan(validateDeploymentEnv(BASE))).toMatchObject({
      chainId: 43113,
      factory: { artifact: "out/VoidReleaseFactoryV2.sol/VoidReleaseFactoryV2.json" },
      marketplace: { artifact: "out/ReleaseMarketplaceV3.sol/ReleaseMarketplaceV3.json" },
    });
  });

  it("runs the default path as a dry-run without a transaction broadcaster", async () => {
    await expect(run(["--dry-run"], BASE, { provider, assertAlbumCapable })).resolves.toMatchObject({ mode: "DRY_RUN" });
  });

  it("requires explicit confirmation before any future broadcast", () => {
    expect(() => validateDeploymentEnv({ ...BASE, BROADCAST_DEPLOYMENT: "yes" })).toThrow(/CONFIRM_FUJI_DEPLOY/);
  });

  it("rejects C-Chain and every non-Fuji network", () => {
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOY_NETWORK: "mainnet" })).toThrow(/DEPLOY_NETWORK/);
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOY_NETWORK: "fuji", AVALANCHE_FUJI_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" })).not.toThrow();
  });

  it("rejects missing addresses, invalid fee BPS, and invalid deployer configuration", () => {
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_FEE_BPS: "10001" })).toThrow(/exactly 250/);
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOYER_PRIVATE_KEY: "not-a-key" })).toThrow(/DEPLOYER_PRIVATE_KEY/);
  });

  it("rejects a changed permanent Fuji treasury", () => {
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_RECIPIENT: "0x0000000000000000000000000000000000000011" })).toThrow(/existing permanent treasury/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x0000000000000000000000000000000000000033" })).toThrow(/existing permanent treasury/);
  });

  it("rejects a provider reporting any chain other than Fuji", async () => {
    await expect(run([], BASE, { provider: { getNetwork: async () => ({ chainId: 43114n }) }, assertAlbumCapable })).rejects.toThrow(/non-Fuji/);
  });

  it("refuses to plan or broadcast when the compiled implementation lacks album functions", async () => {
    expect(missingAlbumSelectors(albumRuntime)).toEqual([]);
    expect(missingAlbumSelectors("0x63deadbeef")).toEqual(ALBUM_SIGNATURES);
    await expect(assertAlbumCapableArtifact(loadArtifacts("0x"))).rejects.toThrow(/lacks album functions/);
    await expect(run(["--dry-run"], BASE, { provider, assertAlbumCapable: () => assertAlbumCapableArtifact(loadArtifacts("0x")) })).rejects.toThrow(/lacks album functions/);
  });

  it("does not deploy anything when the album guard fails during broadcast", async () => {
    const { calls, deploy } = fakeDeploy();
    await expect(broadcastDeployment(validateDeploymentEnv(BASE), provider, { load: loadArtifacts("0x"), deploy, writeRecord: async () => {}, log: () => {}, wallet: {} })).rejects.toThrow(/lacks album functions/);
    expect(calls).toEqual([]);
  });

  it("logs each mined address immediately and writes a per-factory record without overwriting the existing one", async () => {
    const { calls, deploy } = fakeDeploy();
    const logs = [];
    const writes = [];
    const record = await broadcastDeployment(validateDeploymentEnv(BASE), provider, { load: loadArtifacts(), deploy, writeRecord: async (path, value) => writes.push({ path, value }), log: (value) => logs.push(value), wallet: {} });
    expect(calls.map((call) => call.artifact)).toEqual(["factory", "marketplace"]);
    expect(calls[1].args).toEqual(["0xb65C575CaE01574296Fab6E620B9A15cC0121ce4", 250, getAddress(FACTORY)]);
    expect(logs.map((entry) => entry.step)).toEqual(["FACTORY_MINED", "MARKETPLACE_MINED", "RECORD"]);
    expect(writes[0].path).toBe(deploymentRecordPath(FACTORY));
    expect(writes[0].path).not.toBe("deployments/release-per-contract-fuji.json");
    expect(record).toMatchObject({ factory: { address: getAddress(FACTORY), implementationAddress: getAddress(IMPL), implementationAlbumCapable: true }, marketplace: { address: getAddress(MARKET), factoryAddress: getAddress(FACTORY) } });
  });

  it("keeps the mined record in the log when writing the record file fails", async () => {
    const { deploy } = fakeDeploy();
    const logs = [];
    await expect(broadcastDeployment(validateDeploymentEnv(BASE), provider, { load: loadArtifacts(), deploy, writeRecord: async () => { throw new Error("EEXIST"); }, log: (value) => logs.push(value), wallet: {} })).resolves.toMatchObject({ factory: { address: getAddress(FACTORY) } });
    expect(logs.find((entry) => entry.step === "RECORD").record.marketplace.address).toBe(getAddress(MARKET));
    expect(logs.at(-1)).toMatchObject({ step: "RECORD_WRITE_FAILED" });
  });
});
