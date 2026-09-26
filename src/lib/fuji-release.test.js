import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, FUJI_RELEASE_ABI, assertFujiAddress, assertFujiTransactionTarget, assertProvenanceAnchorTarget, encodeCreateFujiEdition, encodeFujiMint, fujiSlug, fujiTokenId, isCertifiedFujiEdition, isFujiEditionNotFoundError, readFujiEdition } from "./fuji-release.js";

describe("certified Fuji VoidRelease1155 integration", () => {
  it("uses a valid certified Fuji release configuration", () => {
    expect(FUJI_RELEASE_CONFIG.chainId).toBe(43113);
    expect(ethers.isAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe(true);
    expect(FUJI_RELEASE_ABI.join(" ")).toContain("createEdition");
    if (FUJI_RELEASE_CONFIG.contractName === "VoidRelease1155V2") {
      expect(ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress)).not.toBe(ethers.ZeroAddress);
      expect(ethers.isAddress(FUJI_RELEASE_CONFIG.primarySaleAddress)).toBe(true);
      const expectedV2Address = globalThis.process?.env?.EXPECTED_FUJI_V2_RELEASE_ADDRESS;
      if (expectedV2Address) expect(FUJI_RELEASE_CONFIG.contractAddress.toLowerCase()).toBe(expectedV2Address.toLowerCase());
    } else {
      expect(FUJI_RELEASE_CONFIG.contractName).toBe("VoidRelease1155");
      expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
    }
  });

  it("derives token IDs with abi.encode-compatible hashing", () => {
    const release = "fuji-test-release-001";
    const edition = "fuji-test-edition-001";
    const expected = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", ethers.encodeBytes32String(release), ethers.encodeBytes32String(edition)])));
    expect(fujiTokenId(release, edition)).toBe(expected === 0n ? 1n : expected);
  });

  it("encodes createEdition and mint for the certified contract path", () => {
    const edition = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: 10, metadataUri: "ipfs://test" });
    expect(edition.data.slice(0, 10)).toBe(ethers.id("createEdition(bytes32,bytes32,uint256,string)").slice(0, 10));
    const mint = encodeFujiMint({ to: "0x0000000000000000000000000000000000000001", tokenId: edition.tokenId, amount: 1 });
    expect(mint.slice(0, 10)).toBe(ethers.id("mint(address,uint256,uint256,bytes)").slice(0, 10));
    const withRoyalty = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: 10, metadataUri: "ipfs://test", payout: "0x0000000000000000000000000000000000000001", royaltyBps: 500 });
    expect(withRoyalty.data.slice(0, 10)).toBe(ethers.id("createEdition(bytes32,bytes32,uint256,string,address,uint96)").slice(0, 10));
    expect(withRoyalty.tokenId).toBe(edition.tokenId);
  });

  it("decodes every field from the deployed Edition struct return", async () => {
    const releaseId = ethers.encodeBytes32String("fuji-release");
    const editionId = ethers.encodeBytes32String("chapter-one");
    const artist = "0x00000000000000000000000000000000000000A1";
    const metadataUri = "ipfs://QmFujiEditionMetadata";
    const editionIface = new ethers.Interface([
      "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))",
    ]);
    const result = editionIface.encodeFunctionResult("edition", [[releaseId, editionId, artist, 25n, 7n, metadataUri, true]]);
    const provider = {
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa869";
        if (method === "eth_call") return result;
        throw new Error(`unexpected provider method: ${method}`);
      },
    };

    await expect(readFujiEdition(provider, 123n)).resolves.toEqual({
      releaseId,
      editionId,
      artist: ethers.getAddress(artist),
      maxSupply: 25n,
      mintedSupply: 7n,
      metadataUri,
      exists: true,
    });
  });

  it("rejects arbitrary contract injection", () => {
    expect(() => assertFujiAddress("0x0000000000000000000000000000000000000001")).toThrow(/certified Fuji/);
    expect(assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe(FUJI_RELEASE_CONFIG.contractAddress);
    expect(assertFujiTransactionTarget(FUJI_RELEASE_CONFIG.contractAddress)).toBe(ethers.getAddress(FUJI_RELEASE_CONFIG.contractAddress));
    expect(() => assertFujiTransactionTarget("0x0000000000000000000000000000000000000001")).toThrow(/primary sale/);
    expect(() => assertProvenanceAnchorTarget(FUJI_RELEASE_CONFIG.contractAddress)).toThrow(/release contract/);
    expect(assertProvenanceAnchorTarget("0x3333333333333333333333333333333333333333")).toBe("0x3333333333333333333333333333333333333333");
  });

  it("recognizes only the expected missing-edition provider failures", () => {
    expect(isFujiEditionNotFoundError(new Error("RPC Request failed: execution reverted"))).toBe(true);
    expect(isFujiEditionNotFoundError(new Error("wallet disconnected"))).toBe(false);
  });

  it("accepts Fuji-safe slugs and rejects oversize identifiers", () => {
    expect(fujiSlug("Chapter I — The Repair")).toBe("chapter-i-the-repair");
    expect(() => fujiSlug("this-identifier-is-definitely-too-long-for-bytes32")).toThrow(/31/);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 })).toBe(true);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43114 })).toBe(false);
  });
});
