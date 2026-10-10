import { describe, expect, it, vi } from "vitest";
import { getAddress, Interface } from "ethers";
import { FUJI_RELEASE_PER_CONTRACT, FUJI_RELEASE_PER_CONTRACT_V2 } from "../../config/release-network.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { calculateListingEconomics, isReleasePerContractCandidate, readReleaseListingContext } from "./secondary-listing.js";

const MARKET = new Interface([
  "function registry() view returns (address)",
  "function platformFeeBps() view returns (uint256)",
  "function deploymentChainId() view returns (uint256)",
]);
const FACTORY = new Interface(["function isRelease(address releaseContract) view returns (bool)"]);
const RELEASE = new Interface([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function royaltyBpsOf(uint256 tokenId) view returns (uint96)",
]);
const marketplaceAddress = FUJI_RELEASE_PER_CONTRACT_V2.marketplaceAddress;
const factoryAddress = FUJI_RELEASE_PER_CONTRACT_V2.factoryAddress;
const legacyMarketplaceAddress = FUJI_RELEASE_PER_CONTRACT.marketplaceAddress;
const legacyFactoryAddress = FUJI_RELEASE_PER_CONTRACT.factoryAddress;
const releaseContractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const tokenId = "987654321012345678901234567890123456789";

function providerFor({
  chainId = 43113,
  isRelease = true,
  balance = 2n,
  approved = false,
  feeBps = BigInt(FUJI_RELEASE_PER_CONTRACT_V2.marketplaceFeeBps),
  royaltyBps = 500n,
  registry = factoryAddress,
  marketTarget = marketplaceAddress,
  factoryTarget = factoryAddress,
} = {}) {
  const calls = [];
  const provider = {
    calls,
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return `0x${BigInt(chainId).toString(16)}`;
      if (method !== "eth_call") throw new Error(`Unexpected RPC method: ${method}`);
      const [request] = params;
      calls.push(request.to.toLowerCase());
      const target = request.to.toLowerCase();
      if (target === marketTarget.toLowerCase()) {
        const parsed = MARKET.parseTransaction({ data: request.data });
        const values = {
          registry: [registry],
          platformFeeBps: [feeBps],
          deploymentChainId: [BigInt(FUJI_RELEASE_PER_CONTRACT_V2.chainId)],
        }[parsed.name];
        return MARKET.encodeFunctionResult(parsed.name, values);
      }
      if (target === factoryTarget.toLowerCase()) return FACTORY.encodeFunctionResult("isRelease", [isRelease]);
      if (target === releaseContractAddress.toLowerCase()) {
        const parsed = RELEASE.parseTransaction({ data: request.data });
        const values = {
          balanceOf: [balance],
          isApprovedForAll: [approved],
          royaltyBpsOf: [royaltyBps],
        }[parsed.name];
        return RELEASE.encodeFunctionResult(parsed.name, values);
      }
      throw new Error("Unexpected contract target.");
    }),
  };
  return provider;
}

const baseInput = {
  marketplaceAddress,
  marketplaceChainId: FUJI_RELEASE_PER_CONTRACT_V2.chainId,
  releaseContractAddress,
  tokenId,
  seller,
};

describe("FactoryV2 → ReleaseMarketplaceV3 secondary listing verification", () => {
  it("pins the Studio FactoryV2 and ReleaseMarketplaceV3 Fuji addresses at 250 bps", () => {
    // Active: the album-capable deployment (run 38054831224). Historical: the 2026-10-05 pre-album pair.
    expect(factoryAddress).toBe("0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8");
    expect(marketplaceAddress).toBe("0xa464edb22C4959943334DB07001e3ba63989C898");
    expect(FUJI_RELEASE_PER_CONTRACT_V2.historicalDeployments).toEqual([expect.objectContaining({ factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", marketplaceAddress: "0x42B740aA92A6F48380F6D97AD91e332a7921a744", albumCapable: false })]);
    expect(FUJI_RELEASE_PER_CONTRACT_V2.marketplaceFeeBps).toBe(250);
    expect(FUJI_RELEASE_PER_CONTRACT_V2.source).toBe("VoidReleaseFactoryV2");
    expect(factoryAddress.toLowerCase()).not.toBe(legacyFactoryAddress.toLowerCase());
    expect(marketplaceAddress.toLowerCase()).not.toBe(legacyMarketplaceAddress.toLowerCase());
  });

  it("verifies a historical clone against its own factory when it lists on the historical marketplace", async () => {
    const [historical] = FUJI_RELEASE_PER_CONTRACT_V2.historicalDeployments;
    const provider = providerFor({ registry: historical.factoryAddress, marketTarget: historical.marketplaceAddress, factoryTarget: historical.factoryAddress });
    const result = await readReleaseListingContext({ ...baseInput, marketplaceAddress: historical.marketplaceAddress, provider });
    expect(result).toMatchObject({ factoryAddress: getAddress(historical.factoryAddress), marketplaceAddress: getAddress(historical.marketplaceAddress) });
    expect(provider.calls).toContain(historical.factoryAddress.toLowerCase());
    expect(provider.calls).not.toContain(factoryAddress.toLowerCase());
    // A marketplace whose registry is the other deployment's factory is refused.
    const crossed = providerFor({ registry: factoryAddress, marketTarget: historical.marketplaceAddress, factoryTarget: historical.factoryAddress });
    await expect(readReleaseListingContext({ ...baseInput, marketplaceAddress: historical.marketplaceAddress, provider: crossed })).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
  });

  it("accepts a FactoryV2-registered V4 clone and returns on-chain ownership, approval, fee and royalty", async () => {
    const provider = providerFor();
    const result = await readReleaseListingContext({ ...baseInput, provider });

    expect(result).toMatchObject({
      balance: "2",
      approved: false,
      marketplaceFeeBps: "250",
      royaltyBps: "500",
      factoryAddress,
      marketplaceAddress,
      releaseContractAddress: getAddress(releaseContractAddress),
      tokenId,
      seller: getAddress(seller),
      chainId: 43113,
    });
    expect(provider.calls).toContain(factoryAddress.toLowerCase());
    expect(provider.calls).toContain(releaseContractAddress.toLowerCase());
    expect(provider.calls).not.toContain(legacyFactoryAddress.toLowerCase());
  });

  it("refuses the legacy Factory V1 marketplace address before any ownership read", async () => {
    const provider = providerFor({ marketTarget: legacyMarketplaceAddress, factoryTarget: legacyFactoryAddress, registry: legacyFactoryAddress });

    await expect(readReleaseListingContext({
      ...baseInput,
      marketplaceAddress: legacyMarketplaceAddress,
      provider,
    })).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a marketplace that reports a fee other than the locked 250 bps", async () => {
    const provider = providerFor({ feeBps: 500n });

    await expect(readReleaseListingContext({ ...baseInput, provider })).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    expect(provider.calls).not.toContain(releaseContractAddress.toLowerCase());
  });

  it("refuses C-Chain/mainnet before making any contract read", async () => {
    const provider = providerFor({ chainId: 43114 });

    await expect(readReleaseListingContext({ ...baseInput, provider })).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a release contract that is not registered by FactoryV2", async () => {
    const provider = providerFor({ isRelease: false });

    await expect(readReleaseListingContext({ ...baseInput, provider })).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
    expect(provider.calls).not.toContain(releaseContractAddress.toLowerCase());
  });

  it("returns a verified zero balance while distinguishing it from read failure", async () => {
    const provider = providerFor({ balance: 0n });

    await expect(readReleaseListingContext({ ...baseInput, provider })).resolves.toMatchObject({ balance: "0" });
    const failedProvider = { request: vi.fn(async ({ method }) => method === "eth_chainId" ? "0xa869" : Promise.reject(new Error("RPC unavailable"))) };
    await expect(readReleaseListingContext({ ...baseInput, provider: failedProvider })).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
  });

  it("excludes the legacy shared Fuji release contract and mainnet from the owner-listing candidate path", () => {
    expect(isReleasePerContractCandidate({
      chainId: FUJI_RELEASE_CONFIG.chainId,
      contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
      primarySaleAddress: "0x8b743f91940a267899986d2e99b4375e1d87c321",
      tokenIds: ["1"],
    })).toBe(false);
    expect(isReleasePerContractCandidate({ chainId: 43114, contractAddress: releaseContractAddress, primarySaleAddress: seller, tokenIds: [tokenId] })).toBe(false);
    expect(isReleasePerContractCandidate({
      chainId: FUJI_RELEASE_PER_CONTRACT_V2.chainId,
      contractAddress: releaseContractAddress,
      primarySaleAddress: seller,
      tokenIds: [tokenId],
    })).toBe(true);
  });

  it("calculates seller proceeds with the live fee and per-edition royalty, including integer rounding", () => {
    expect(calculateListingEconomics({
      priceWei: "1000000000000000000",
      amount: "2",
      marketplaceFeeBps: "250",
      royaltyBps: "250",
    })).toEqual({
      grossWei: "2000000000000000000",
      marketplaceFeeWei: "50000000000000000",
      royaltyWei: "50000000000000000",
      sellerProceedsWei: "1900000000000000000",
      sellerProceedsBps: "9500",
    });
    expect(calculateListingEconomics({ priceWei: "1", amount: "1", marketplaceFeeBps: "9999", royaltyBps: "2" })).toBeNull();
  });
});
