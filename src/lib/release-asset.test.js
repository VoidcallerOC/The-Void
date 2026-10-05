import { describe, expect, it } from "vitest";
import { assertReleaseProvider, releaseAssetIdentity } from "./release-asset.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SALE_A = "0x1111111111111111111111111111111111111111";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SALE_B = "0x2222222222222222222222222222222222222222";

describe("release asset identity", () => {
  it("keeps equal token IDs distinct when release or sale addresses differ", () => {
    const assetA = releaseAssetIdentity({ chainId: 43113, releaseContractAddress: A, primarySaleAddress: SALE_A, tokenId: "7" });
    const assetB = releaseAssetIdentity({ chainId: 43113, releaseContractAddress: B, primarySaleAddress: SALE_B, tokenId: "7" });
    expect(assetA.tokenId).toBe(assetB.tokenId);
    expect(assetA.releaseContractAddress).not.toBe(assetB.releaseContractAddress);
    expect(assetA.primarySaleAddress).not.toBe(assetB.primarySaleAddress);
  });

  it("fails closed for incomplete or malformed release identities", () => {
    expect(() => releaseAssetIdentity({ chainId: 43113, releaseContractAddress: A, tokenId: "7" })).toThrow(/primarySaleAddress/);
    expect(() => releaseAssetIdentity({ chainId: 43113, releaseContractAddress: "0x0", primarySaleAddress: SALE_A, tokenId: "7" })).toThrow(/releaseContractAddress/);
    expect(() => releaseAssetIdentity({ chainId: 43113, releaseContractAddress: A, primarySaleAddress: SALE_A, tokenId: "-1" })).toThrow(/tokenId/);
  });

  it("requires the wallet provider to be on the selected release chain", async () => {
    await expect(assertReleaseProvider({ request: async () => "0xa869" }, 43113)).resolves.toBeUndefined();
    await expect(assertReleaseProvider({ request: async () => "0xa86a" }, 43113)).rejects.toMatchObject({ code: "CHAIN_MISMATCH", expectedChainId: 43113, currentChainId: 43114 });
  });
});
