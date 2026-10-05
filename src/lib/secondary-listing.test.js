import { describe, expect, it, vi } from "vitest";
import { getAddress, Interface } from "ethers";
import { FUJI_RELEASE_PER_CONTRACT } from "../../config/release-network.js";
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
const marketplaceAddress = FUJI_RELEASE_PER_CONTRACT.marketplaceAddress;
const factoryAddress = FUJI_RELEASE_PER_CONTRACT.factoryAddress;
const releaseContractAddress = "0x82b26da27136935454bdf1e40801190b521b82e5";
const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const tokenId = "987654321012345678901234567890123456789";

function providerFor({ chainId = 43113, isRelease = true, balance = 2n, approved = false, feeBps = 250n, royaltyBps = 500n } = {}) {
  const calls = [];
  const provider = {
    calls,
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return `0x${BigInt(chainId).toString(16)}`;
      if (method !== "eth_call") throw new Error(`Unexpected RPC method: ${method}`);
      const [request] = params;
      calls.push(request.to.toLowerCase());
      const target = request.to.toLowerCase();
      if (target === marketplaceAddress.toLowerCase()) {
        const parsed = MARKET.parseTransaction({ data: request.data });
        const values = {
          registry: [factoryAddress],
          platformFeeBps: [feeBps],
          deploymentChainId: [BigInt(FUJI_RELEASE_PER_CONTRACT.chainId)],
        }[parsed.name];
        return MARKET.encodeFunctionResult(parsed.name, values);
      }
      if (target === factoryAddress.toLowerCase()) return FACTORY.encodeFunctionResult("isRelease", [isRelease]);
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
  marketplaceChainId: FUJI_RELEASE_PER_CONTRACT.chainId,
  releaseContractAddress,
  tokenId,
  seller,
};

describe("release-per-contract secondary listing verification", () => {
  it("accepts a registered factory clone and returns on-chain ownership, approval, fee and royalty", async () => {
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
  });

  it("refuses C-Chain/mainnet before making any contract read", async () => {
    const provider = providerFor({ chainId: 43114 });

    await expect(readReleaseListingContext({ ...baseInput, provider })).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a release contract that is not registered by the canonical factory", async () => {
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

  it("excludes the legacy shared Fuji release contract from the owner-listing candidate path", () => {
    expect(isReleasePerContractCandidate({
      chainId: FUJI_RELEASE_CONFIG.chainId,
      contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
      primarySaleAddress: "0x8b743f91940a267899986d2e99b4375e1d87c321",
      tokenIds: ["1"],
    })).toBe(false);
    expect(isReleasePerContractCandidate({ chainId: 43114, contractAddress: releaseContractAddress, primarySaleAddress: seller, tokenIds: [tokenId] })).toBe(false);
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
