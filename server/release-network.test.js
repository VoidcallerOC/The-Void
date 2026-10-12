import { afterEach, describe, expect, it, vi } from "vitest";
import { loadIndexerConfig, productionChainId, withManifestReleaseDeployments } from "./config.js";
import { releaseDeploymentFor, releaseDeploymentForFactory, releasePerContractManifestFor, RELEASE_DEPLOYMENTS, RELEASE_PER_CONTRACT_DEPLOYMENTS } from "../config/release-network.js";

describe("release network selection", () => {
  it("defaults to Fuji and only accepts fuji or mainnet", () => {
    expect(productionChainId({})).toBe(43113);
    expect(productionChainId({ RELEASE_NETWORK: "fuji" })).toBe(43113);
    expect(productionChainId({ RELEASE_NETWORK: "mainnet" })).toBe(43114);
    expect(() => productionChainId({ RELEASE_NETWORK: "goerli" })).toThrow(/RELEASE_NETWORK/);
  });

  it("keeps production indexing on the selected chain only", () => {
    const contracts = JSON.stringify([{ chainId: 43114, address: "0x1111111111111111111111111111111111111111", contractType: "ERC1155", startBlock: 1 }]);
    const base = { NODE_ENV: "production", INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: contracts };
    expect(() => loadIndexerConfig({ ...base, INDEXER_CHAIN_ID: "43114" })).toThrow(/Avalanche Fuji \(43113\)/);
    expect(loadIndexerConfig({ ...base, RELEASE_NETWORK: "mainnet" }).chainId).toBe(43114);
    expect(() => loadIndexerConfig({ ...base, RELEASE_NETWORK: "mainnet", INDEXER_CHAIN_ID: "43113" })).toThrow(/C-Chain \(43114\)/);
  });

  it("selects mainnet without a legacy shared contract and refuses unknown networks", () => {
    expect(releaseDeploymentFor("fuji").chainId).toBe(43113);
    expect(RELEASE_DEPLOYMENTS.mainnet.chainId).toBe(43114);
    expect(releaseDeploymentFor("mainnet").contractAddress).toBeNull();
    expect(() => releaseDeploymentFor("ropsten")).toThrow(/Unknown release network/);
    expect(() => releasePerContractManifestFor("ropsten")).toThrow(/Unknown release network/);
  });

  it("keeps the mainnet release-per-contract manifest inert until its deployment is recorded", () => {
    const fuji = releasePerContractManifestFor("fuji");
    const mainnet = releasePerContractManifestFor("mainnet");
    expect(fuji.chainId).toBe(43113);
    expect(mainnet.chainId).toBe(43114);
    if (!mainnet.deployed) {
      expect(mainnet).toMatchObject({ factoryAddress: null, marketplaceAddress: null, provisioningEnabled: false, deploymentAuthorized: false });
      expect(RELEASE_PER_CONTRACT_DEPLOYMENTS.filter((deployment) => deployment.chainId === 43114)).toEqual([]);
    }
    // A Fuji factory is never treated as a mainnet deployment.
    expect(releaseDeploymentForFactory(fuji.factoryAddress).chainId).toBe(43113);
  });

  it("indexes only manifest deployments of the indexed chain", () => {
    const fujiAdded = withManifestReleaseDeployments([], { chainId: 43113 });
    expect(fujiAdded.length).toBeGreaterThan(0);
    expect(fujiAdded.every((contract) => contract.chainId === 43113)).toBe(true);
    if (!releasePerContractManifestFor("mainnet").deployed) expect(withManifestReleaseDeployments([], { chainId: 43114 })).toEqual([]);
  });
});

describe("module selection with RELEASE_NETWORK=mainnet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("loads the release config, studio service and provenance modules without the Fuji legacy contract", async () => {
    vi.stubEnv("RELEASE_NETWORK", "mainnet");
    vi.resetModules();
    const network = await import("../config/release-network.js");
    expect(network.RELEASE_NETWORK).toBe("mainnet");
    expect(network.IS_MAINNET_RELEASE).toBe(true);
    expect(network.RELEASE_PER_CONTRACT.chainId).toBe(43114);
    expect(network.ACTIVE_RELEASE_PER_CONTRACT_DEPLOYMENTS.every((deployment) => deployment.chainId === 43114)).toBe(true);
    const scope = await import("./fuji-contract-scope.js");
    expect(scope.CANONICAL_FUJI_RELEASE).toBe("");
    // The Fuji V1 address is the deployer's nonce-0 address; on mainnet it is not the Fuji V1 release.
    expect(scope.LEGACY_FUJI_V1_RELEASE).toBe("");
    expect(scope.isLegacyFujiV1Release("0x262B774cf9a1949170B58E2d57F6189980FE757b")).toBe(false);
    const studio = await import("./studio-service.js");
    expect(typeof studio.deriveStudioReleaseKey).toBe("function");
    const anchor = await import("./provenance-anchor.js");
    expect(anchor.loadProvenanceAnchorConfig({ RELEASE_NETWORK: "mainnet" })).toMatchObject({ enabled: false, chainId: 43114, network: "mainnet" });
  });
});
