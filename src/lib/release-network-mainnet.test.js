import { afterEach, describe, expect, it, vi } from "vitest";

// Verified C-Chain release-per-contract infrastructure (config/mainnet-release-per-contract.json).
const MAINNET_FACTORY = "0x262B774cf9a1949170B58E2d57F6189980FE757b";
const MAINNET_MARKETPLACE = "0x0e77116142844478a55EEd2Ab79de9F93770F8f5";

// With VITE_RELEASE_NETWORK=mainnet the web build selects the mainnet manifests. Production mainnet
// FE must resolve AUTH_CHAIN_ID / RELEASE_DEPLOYMENT to C-Chain 43114 and the recorded factory +
// marketplace — never Fuji 43113.
describe("frontend release config with mainnet selected", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("selects C-Chain 43114 and the verified factory/marketplace addresses", async () => {
    vi.stubEnv("VITE_RELEASE_NETWORK", "mainnet");
    vi.stubEnv("RELEASE_NETWORK", "mainnet");
    vi.resetModules();
    const network = await import("../../config/release-network.js");
    expect(network.RELEASE_NETWORK).toBe("mainnet");
    expect(network.IS_MAINNET_RELEASE).toBe(true);
    expect(network.RELEASE_DEPLOYMENT.chainId).toBe(43114);
    expect(network.RELEASE_DEPLOYMENT.networkName).toBe("Avalanche C-Chain");
    expect(network.RELEASE_PER_CONTRACT).toMatchObject({
      chainId: 43114,
      deployed: true,
      factoryAddress: MAINNET_FACTORY,
      marketplaceAddress: MAINNET_MARKETPLACE,
      marketplaceFeeBps: 250,
    });
    expect(network.ACTIVE_RELEASE_PER_CONTRACT_DEPLOYMENTS).toEqual([
      expect.objectContaining({
        chainId: 43114,
        factoryAddress: MAINNET_FACTORY,
        marketplaceAddress: MAINNET_MARKETPLACE,
        active: true,
      }),
    ]);
    expect(network.releaseDeploymentForFactory(MAINNET_FACTORY)).toMatchObject({
      chainId: 43114,
      marketplaceAddress: MAINNET_MARKETPLACE,
    });
    expect(network.releaseDeploymentForMarketplace(MAINNET_MARKETPLACE)).toMatchObject({
      chainId: 43114,
      factoryAddress: MAINNET_FACTORY,
    });

    const release = await import("./fuji-release.js");
    expect(release.FUJI_RELEASE_CONFIG.chainId).toBe(43114);
    expect(release.FUJI_RELEASE_CONFIG.contractAddress).toBeNull();
    expect(release.RELEASE_FACTORY_CONFIG.chainId).toBe(43114);
    expect(release.RELEASE_FACTORY_CONFIG.factoryAddress).toBe(MAINNET_FACTORY);
    expect(release.RELEASE_FACTORY_CONFIG.marketplaceAddress).toBe(MAINNET_MARKETPLACE);
    expect(release.FUJI_RELEASE_FACTORY_V2_CONFIG).toBe(release.RELEASE_FACTORY_CONFIG);
    // Regression: the network-label source that Artist Studio, Studio earnings and the listing panel
    // interpolate into transaction/receipt/provisioning copy must read "Avalanche C-Chain" on a 43114
    // build — a mainnet transaction must never be labeled "Fuji".
    expect(release.FUJI_RELEASE_CONFIG.network).toBe("Avalanche C-Chain");
    expect(release.FUJI_RELEASE_FACTORY_V2_CONFIG.networkName).toBe("Avalanche C-Chain");
    expect(release.FUJI_RELEASE_CONFIG.network).not.toMatch(/fuji/i);
    const chain = await import("./release-chain.js");
    expect(chain.resolveChainDescriptor({ id: 43114 }).networkName).toBe("Avalanche C-Chain");
    // Buyer-path collect errors must name Avalanche C-Chain on a 43114 build, never "Fuji".
    const primarySale = await import("./primary-sale.js");
    expect(primarySale.explainCollectError({ message: "insufficient funds for gas" }).message).toContain("Avalanche C-Chain");
    expect(primarySale.explainCollectError({ message: "execution reverted: nope" }).message).toContain("Avalanche C-Chain");
    expect(primarySale.explainCollectError({ message: "insufficient funds" }).message).not.toMatch(/on Fuji\b/);
    expect(release.isCertifiedFujiEdition({ contractAddress: "", chainId: 43114 })).toBe(false);
    expect(release.isCertifiedFujiEdition({ chainId: 43114 })).toBe(false);
    await expect(release.simulateReleaseCall({ request: vi.fn() }, { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", data: "0x", chainId: 43113 })).rejects.toThrow(/Avalanche C-Chain/);
  });

  it("keeps the default (unset) web network on Fuji so alpha staging is unchanged", async () => {
    vi.stubEnv("VITE_RELEASE_NETWORK", "");
    vi.stubEnv("RELEASE_NETWORK", "");
    vi.resetModules();
    const network = await import("../../config/release-network.js");
    expect(network.RELEASE_NETWORK).toBe("fuji");
    expect(network.RELEASE_DEPLOYMENT.chainId).toBe(43113);
    expect(network.IS_MAINNET_RELEASE).toBe(false);
    // Genuinely Fuji surfaces must stay correct: the default build still labels its network "Avalanche
    // Fuji", and the chain descriptor maps 43113 to Fuji.
    const release = await import("./fuji-release.js");
    expect(release.FUJI_RELEASE_CONFIG.network).toBe("Avalanche Fuji");
    expect(release.FUJI_RELEASE_FACTORY_V2_CONFIG.networkName).toBe("Avalanche Fuji");
    const chain = await import("./release-chain.js");
    expect(chain.resolveChainDescriptor({ id: 43113 }).networkName).toBe("Avalanche Fuji");
    expect(chain.resolveChainDescriptor({ id: 43114 }).networkName).toBe("Avalanche C-Chain");
    // Genuinely Fuji build: buyer-path collect errors still read "Avalanche Fuji".
    const primarySale = await import("./primary-sale.js");
    expect(primarySale.explainCollectError({ message: "insufficient funds" }).message).toContain("Avalanche Fuji");
  });
});
