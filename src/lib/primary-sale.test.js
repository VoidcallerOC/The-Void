import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { encodeConfigureSale, encodePurchase, explainCollectError, formatAvax, fujiPrimarySaleAddress, fujiReleaseIsV2, purchaseCost } from "./primary-sale.js";

describe("Fuji ERC-1155 primary sale", () => {
  it("stays unconfigured until the deploy script writes a sale address", () => {
    expect(fujiPrimarySaleAddress()).toBe("");
    expect(fujiReleaseIsV2()).toBe(false);
  });

  it("encodes configureSale, purchase, and the exact AVAX cost", () => {
    expect(encodePurchase(1n, 2).slice(0, 10)).toBe(ethers.id("purchase(uint256,uint256)").slice(0, 10));
    expect(encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n }).slice(0, 10)).toBe(ethers.id("configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)").slice(0, 10));
    expect(purchaseCost("10000000000000000", 2)).toBe(20_000_000_000_000_000n);
    expect(formatAvax("10000000000000000")).toBe("0.01 AVAX");
  });

  it("explains rejected transactions, the wrong network, and a sold-out sale", () => {
    expect(explainCollectError({ code: 4001 })).toMatchObject({ state: "rejected" });
    expect(explainCollectError(new Error("Switch your wallet to Avalanche Fuji (chain 43113)."))).toMatchObject({ state: "wrong-network" });
    const soldOut = new ethers.Interface(["error SoldOut(uint256 tokenId, uint256 remaining, uint256 requested)"]).encodeErrorResult("SoldOut", [1, 0, 1]);
    expect(explainCollectError({ data: soldOut })).toMatchObject({ state: "sold-out", message: "This release is sold out." });
  });
});
