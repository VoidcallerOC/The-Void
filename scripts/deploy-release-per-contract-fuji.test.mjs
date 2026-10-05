import { describe, expect, it } from "vitest";
import { FUJI_CHAIN_ID, buildDryRunPlan, run, validateDeploymentEnv } from "./deploy-release-per-contract-fuji.mjs";

const KEY = `0x${"11".repeat(32)}`;
const BASE = {
  DEPLOY_NETWORK: "fuji",
  AVALANCHE_FUJI_RPC_URL: "https://api.avax-test.network/ext/bc/C/rpc",
  DEPLOYER_PRIVATE_KEY: KEY,
  RELEASE_PLATFORM_RECIPIENT: "0x0000000000000000000000000000000000000011",
  RELEASE_PLATFORM_FEE_BPS: "250",
  RELEASE_SALE_OWNER: "0x0000000000000000000000000000000000000022",
  RELEASE_MARKETPLACE_FEE_RECIPIENT: "0x0000000000000000000000000000000000000033",
  BROADCAST_DEPLOYMENT: "no",
};

const provider = { getNetwork: async () => ({ chainId: BigInt(FUJI_CHAIN_ID) }) };

describe("release-per-contract Fuji deployment preflight", () => {
  it("validates the new architecture configuration and does not require broadcast confirmation for dry-run", () => {
    expect(validateDeploymentEnv(BASE)).toMatchObject({ network: "fuji", platformFeeBps: 250, broadcast: false });
    expect(buildDryRunPlan(validateDeploymentEnv(BASE))).toMatchObject({
      chainId: 43113,
      factory: { artifact: "out/VoidReleaseFactory.sol/VoidReleaseFactory.json" },
      marketplace: { artifact: "out/ReleaseMarketplaceV3.sol/ReleaseMarketplaceV3.json" },
    });
  });

  it("runs the default path as a dry-run without a transaction broadcaster", async () => {
    await expect(run(["--dry-run"], BASE, { provider })).resolves.toMatchObject({ mode: "DRY_RUN" });
  });

  it("requires explicit confirmation before any future broadcast", () => {
    expect(() => validateDeploymentEnv({ ...BASE, BROADCAST_DEPLOYMENT: "yes" })).toThrow(/CONFIRM_FUJI_DEPLOY/);
  });

  it("rejects C-Chain and every non-Fuji network", () => {
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOY_NETWORK: "mainnet" })).toThrow(/DEPLOY_NETWORK/);
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOY_NETWORK: "fuji", AVALANCHE_FUJI_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" })).not.toThrow();
  });

  it("rejects missing addresses, invalid fee BPS, and invalid deployer configuration", () => {
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_SALE_OWNER: "" })).toThrow(/RELEASE_SALE_OWNER/);
    expect(() => validateDeploymentEnv({ ...BASE, RELEASE_PLATFORM_FEE_BPS: "10001" })).toThrow(/FEE_BPS/);
    expect(() => validateDeploymentEnv({ ...BASE, DEPLOYER_PRIVATE_KEY: "not-a-key" })).toThrow(/DEPLOYER_PRIVATE_KEY/);
  });

  it("rejects a provider reporting any chain other than Fuji", async () => {
    await expect(run([], BASE, { provider: { getNetwork: async () => ({ chainId: 43114n }) } })).rejects.toThrow(/non-Fuji/);
  });
});
