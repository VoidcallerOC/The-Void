import { describe, expect, it } from "vitest";
import { loadIndexerConfig, productionChainId } from "./config.js";
import { releaseDeploymentFor, RELEASE_DEPLOYMENTS } from "../config/release-network.js";

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

  it("refuses mainnet until the mainnet contracts are recorded", () => {
    expect(releaseDeploymentFor("fuji").chainId).toBe(43113);
    expect(RELEASE_DEPLOYMENTS.mainnet.chainId).toBe(43114);
    if (!RELEASE_DEPLOYMENTS.mainnet.deployed) expect(() => releaseDeploymentFor("mainnet")).toThrow(/not deployed/);
    expect(() => releaseDeploymentFor("ropsten")).toThrow(/Unknown release network/);
  });
});
