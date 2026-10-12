import { afterEach, describe, expect, it, vi } from "vitest";

// With VITE_RELEASE_NETWORK=mainnet the web build selects the mainnet manifests. Before the mainnet
// deployment is recorded there is no legacy shared contract and no factory: nothing may match an
// empty address, and release calls refuse any chain but C-Chain.
describe("frontend release config with mainnet selected", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("selects the mainnet factory config and never matches an empty legacy contract", async () => {
    vi.stubEnv("VITE_RELEASE_NETWORK", "mainnet");
    vi.stubEnv("RELEASE_NETWORK", "mainnet");
    vi.resetModules();
    const release = await import("./fuji-release.js");
    expect(release.FUJI_RELEASE_CONFIG.chainId).toBe(43114);
    expect(release.FUJI_RELEASE_CONFIG.contractAddress).toBeNull();
    expect(release.RELEASE_FACTORY_CONFIG.chainId).toBe(43114);
    expect(release.FUJI_RELEASE_FACTORY_V2_CONFIG).toBe(release.RELEASE_FACTORY_CONFIG);
    expect(release.isCertifiedFujiEdition({ contractAddress: "", chainId: 43114 })).toBe(false);
    expect(release.isCertifiedFujiEdition({ chainId: 43114 })).toBe(false);
    await expect(release.simulateReleaseCall({ request: vi.fn() }, { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", data: "0x", chainId: 43113 })).rejects.toThrow(/Avalanche C-Chain/);
    const earnings = await import("./sale-earnings.js");
    expect(typeof earnings.discoverFactoryBindings).toBe("function");
  });
});
