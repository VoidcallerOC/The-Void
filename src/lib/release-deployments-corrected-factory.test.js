import { describe, expect, it, vi } from "vitest";

// Hypothetical activation of the corrected (settled) factory on mainnet: the production factory and its marketplace
// move to historicalDeployments and the corrected factory with its own ReleaseMarketplaceV4 becomes active. The
// CORRECTED_* addresses are placeholders; nothing here is deployed. The production entries are the live ones.
const PRODUCTION_FACTORY = "0x262B774cf9a1949170B58E2d57F6189980FE757b";
const PRODUCTION_MARKET = "0x0e77116142844478a55EEd2Ab79de9F93770F8f5";
const PRODUCTION_IMPLEMENTATION = "0x8064238e8385093c9fFC8aB10F92a8DC1f2A9006";
const CORRECTED_FACTORY = "0x00000000000000000000000000000000000c0FfE";
const CORRECTED_MARKET = "0x000000000000000000000000000000000000bEEF";
const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";

vi.mock("../../config/mainnet-release-per-contract.json", async (importOriginal) => {
  const live = (await importOriginal()).default;
  return {
    default: {
      ...live,
      factoryAddress: CORRECTED_FACTORY,
      implementationAddress: "0x000000000000000000000000000000000000dEaD",
      marketplaceAddress: CORRECTED_MARKET,
      factoryDeploymentBlock: 99000000,
      marketplaceDeploymentBlock: 99000010,
      source: "VoidReleaseFactoryV2RoyaltySettled",
      historicalDeployments: [{
        factoryAddress: live.factoryAddress,
        implementationAddress: live.implementationAddress,
        marketplaceAddress: live.marketplaceAddress,
        factoryDeploymentBlock: live.factoryDeploymentBlock,
        marketplaceDeploymentBlock: live.marketplaceDeploymentBlock,
        releaseVersion: live.releaseVersion,
        albumCapable: live.albumCapable,
      }],
    },
  };
});

const { RELEASE_PER_CONTRACT_DEPLOYMENTS, releaseDeploymentForFactory, releaseDeploymentForMarketplace } = await import("../../config/release-network.js");
const { marketplaceConfigForEdition } = await import("./marketplace.js");
const { withManifestReleaseDeployments } = await import("../../server/config.js");

const base = Object.freeze({ address: PRODUCTION_MARKET, chainId: 43114, enabled: true, feeBps: "250" });
const mainnet = () => RELEASE_PER_CONTRACT_DEPLOYMENTS.filter((item) => item.chainId === 43114);

describe("mainnet with the corrected factory active and the production factory historical", () => {
  it("keeps both factory/marketplace pairs, the corrected one active", () => {
    expect(mainnet().map((item) => [item.factoryAddress, item.marketplaceAddress, item.active])).toEqual([
      [CORRECTED_FACTORY, CORRECTED_MARKET, true],
      [PRODUCTION_FACTORY, PRODUCTION_MARKET, false],
    ]);
    expect(releaseDeploymentForFactory(PRODUCTION_FACTORY.toLowerCase())).toMatchObject({ marketplaceAddress: PRODUCTION_MARKET, implementationAddress: PRODUCTION_IMPLEMENTATION, factoryDeploymentBlock: 97619965 });
    expect(releaseDeploymentForMarketplace(CORRECTED_MARKET)).toMatchObject({ factoryAddress: CORRECTED_FACTORY });
  });

  it("routes every edition to the marketplace of the factory that created it, whichever marketplace is configured", () => {
    for (const configured of [base, { ...base, address: CORRECTED_MARKET }]) {
      expect(marketplaceConfigForEdition({ factoryAddress: PRODUCTION_FACTORY }, configured).address).toBe(PRODUCTION_MARKET);
      expect(marketplaceConfigForEdition({ factoryAddress: CORRECTED_FACTORY.toLowerCase() }, configured).address).toBe(CORRECTED_MARKET);
    }
  });

  it("gives Genesis no factory marketplace routing (unchanged: it is not a factory release)", () => {
    const genesis = { chainId: 43114, contractAddress: GENESIS, tokenIds: ["0"] };
    expect(marketplaceConfigForEdition(genesis, base)).toBe(base);
    expect(releaseDeploymentForFactory(GENESIS)).toBeNull();
    expect(releaseDeploymentForMarketplace(GENESIS)).toBeNull();
  });

  it("indexes both factories and both marketplaces", () => {
    const indexed = withManifestReleaseDeployments([], { chainId: 43114 });
    expect(indexed.map((item) => [item.address, item.contractType, item.startBlock])).toEqual([
      [CORRECTED_FACTORY.toLowerCase(), "RELEASE_FACTORY", 99000000],
      [CORRECTED_MARKET.toLowerCase(), "MARKETPLACE", 99000010],
      [PRODUCTION_FACTORY.toLowerCase(), "RELEASE_FACTORY", 97619965],
      [PRODUCTION_MARKET.toLowerCase(), "MARKETPLACE", 97619978],
    ]);
  });
});
