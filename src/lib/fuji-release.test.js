import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, FUJI_RELEASE_ABI, assertFujiAddress, encodeCreateFujiEdition, encodeFujiMint, fujiSlug, fujiTokenId, isCertifiedFujiEdition } from "./fuji-release.js";

describe("certified Fuji VoidRelease1155 integration", () => {
  it("uses the certified address and chain", () => {
    expect(FUJI_RELEASE_CONFIG.chainId).toBe(43113);
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x262B774cf9a1949170B58E2d57F6189980FE757b");
    expect(FUJI_RELEASE_ABI.join(" ")).toContain("createEdition");
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
  });

  it("rejects arbitrary contract injection", () => {
    expect(() => assertFujiAddress("0x0000000000000000000000000000000000000001")).toThrow(/certified Fuji/);
    expect(assertFujiAddress(FUJI_RELEASE_CONFIG.contractAddress)).toBe(FUJI_RELEASE_CONFIG.contractAddress);
  });

  it("accepts Fuji-safe slugs and rejects oversize identifiers", () => {
    expect(fujiSlug("Chapter I — The Repair")).toBe("chapter-i-the-repair");
    expect(() => fujiSlug("this-identifier-is-definitely-too-long-for-bytes32")).toThrow(/31/);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43113 })).toBe(true);
    expect(isCertifiedFujiEdition({ contractAddress: FUJI_RELEASE_CONFIG.contractAddress, chainId: 43114 })).toBe(false);
  });
});
