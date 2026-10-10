import { describe, expect, it } from "vitest";
import { FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS, releaseDeploymentForFactory, releaseDeploymentForMarketplace } from "../../config/release-network.js";
import { marketplaceConfigForEdition } from "./marketplace.js";
import { releaseBindingFor } from "./claim-state.js";

const NEW_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const NEW_MARKET = "0xa464edb22C4959943334DB07001e3ba63989C898";
const OLD_FACTORY = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505";
const OLD_MARKET = "0x42B740aA92A6F48380F6D97AD91e332a7921a744";
const base = Object.freeze({ address: OLD_MARKET, chainId: 43113, enabled: true, feeBps: "250" });

describe("release deployments", () => {
  it("lists the album-capable deployment first and keeps the pre-album one as history", () => {
    expect(FUJI_RELEASE_PER_CONTRACT_V2_DEPLOYMENTS.map((item) => [item.factoryAddress, item.marketplaceAddress, item.albumCapable, item.active])).toEqual([
      [NEW_FACTORY, NEW_MARKET, true, true],
      [OLD_FACTORY, OLD_MARKET, false, false],
    ]);
    expect(releaseDeploymentForFactory(NEW_FACTORY.toLowerCase())).toMatchObject({ marketplaceAddress: NEW_MARKET, factoryDeploymentBlock: 59269207, marketplaceDeploymentBlock: 59269210 });
    expect(releaseDeploymentForMarketplace(OLD_MARKET.toLowerCase())).toMatchObject({ factoryAddress: OLD_FACTORY });
    expect(releaseDeploymentForFactory("0x0000000000000000000000000000000000000001")).toBeNull();
    expect(releaseDeploymentForFactory("")).toBeNull();
  });

  it("routes each edition to the marketplace of the factory that created it", () => {
    expect(marketplaceConfigForEdition({ factoryAddress: NEW_FACTORY }, base).address).toBe(NEW_MARKET);
    expect(marketplaceConfigForEdition({ factoryAddress: OLD_FACTORY }, base).address).toBe(OLD_MARKET);
    // No recorded factory, an unknown factory, a disabled surface, another chain, or a non-release
    // marketplace keep the configured marketplace untouched.
    expect(marketplaceConfigForEdition({}, base)).toBe(base);
    expect(marketplaceConfigForEdition({ factoryAddress: "0x8291a4f1936c1c5c6d8917b0966c80757cd5c265" }, base)).toBe(base);
    expect(marketplaceConfigForEdition({ factoryAddress: NEW_FACTORY }, { ...base, enabled: false }).address).toBe(OLD_MARKET);
    expect(marketplaceConfigForEdition({ factoryAddress: NEW_FACTORY }, { ...base, chainId: 43114 }).address).toBe(OLD_MARKET);
    expect(marketplaceConfigForEdition({ factoryAddress: NEW_FACTORY }, { ...base, address: "0x982b28352fd612fe934c5e1ad8fea399689190d2" }).address).toBe("0x982b28352fd612fe934c5e1ad8fea399689190d2");
  });

  it("keeps clones of the historical factory claimable alongside new album-capable clones", () => {
    const edition = (factoryAddress) => ({ factoryAddress, chainId: 43113, releaseContractAddress: "0x1aaf66f0aba020321e63d684186886a3178a9bfc", primarySaleAddress: "0x1cbcde64e29473ed4d40185c2e5a7745b338b996", tokenIds: ["1"], publicationArchitecture: "release-per-contract" });
    expect(releaseBindingFor(edition(OLD_FACTORY)).valid).toBe(true);
    expect(releaseBindingFor(edition(NEW_FACTORY)).valid).toBe(true);
    expect(releaseBindingFor(edition("0x8291a4f1936c1c5c6d8917b0966c80757cd5c265")).valid).toBe(false);
  });
});
