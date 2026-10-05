import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { PRIMARY_SALE_ABI, collectReleaseEdition, readReleasePrimarySale } from "./primary-sale.js";

const RELEASE_A = ethers.getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const RELEASE_B = ethers.getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const SALE_A = "0x1111111111111111111111111111111111111111";
const SALE_B = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0x3333333333333333333333333333333333333333";
const saleInterface = new ethers.Interface(PRIMARY_SALE_ABI);

function provider() {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (request.method === "eth_chainId") return "0xa869";
      const data = request.params?.[0]?.data;
      const target = request.params?.[0]?.to;
      const parsed = saleInterface.parseTransaction({ data });
      if (parsed.name === "sales") return saleInterface.encodeFunctionResult("sales", [target === SALE_A ? 100n : 200n, 10n, 1n, 5n, 0n, 0n, false, true]);
      if (parsed.name === "walletPurchased") return saleInterface.encodeFunctionResult("walletPurchased", [target === SALE_A ? 1n : 2n]);
      throw new Error(`Unexpected ${parsed.name}`);
    },
  };
}

describe("contract-aware primary sale reads", () => {
  it("resolves equal token IDs against each selected release's dedicated sale", async () => {
    const wallet = provider();
    const assetA = { chainId: 43113, releaseContractAddress: RELEASE_A, primarySaleAddress: SALE_A, tokenId: "42" };
    const assetB = { chainId: 43113, releaseContractAddress: RELEASE_B, primarySaleAddress: SALE_B, tokenId: "42" };
    const a = await readReleasePrimarySale(wallet, assetA, ACCOUNT);
    const b = await readReleasePrimarySale(wallet, assetB, ACCOUNT);
    expect(a).toMatchObject({ address: SALE_A, releaseContractAddress: RELEASE_A, tokenId: 42n, priceWei: 100n, purchased: 1n });
    expect(b).toMatchObject({ address: SALE_B, releaseContractAddress: RELEASE_B, tokenId: 42n, priceWei: 200n, purchased: 2n });
    const saleTargets = wallet.calls.filter((call) => call.method === "eth_call").map((call) => call.params[0].to);
    expect(saleTargets).toEqual([SALE_A, SALE_A, SALE_B, SALE_B]);
  });

  it("fails closed instead of falling back to Fuji when a release tuple is missing", async () => {
    await expect(readReleasePrimarySale(provider(), { chainId: 43113, releaseContractAddress: RELEASE_A, tokenId: "42" }, ACCOUNT)).rejects.toThrow(/primarySaleAddress/);
  });

  it("simulates and sends only to the selected release's dedicated sale", async () => {
    const calls = [];
    const wallet = { request: async (request) => {
      calls.push(request);
      if (request.method === "eth_chainId") return "0xa869";
      if (request.method === "eth_call") return "0x";
      if (request.method === "eth_sendTransaction") return `0x${"12".repeat(32)}`;
      throw new Error("unexpected RPC method");
    } };
    await expect(collectReleaseEdition({ provider: wallet, from: ACCOUNT, releaseAsset: { chainId: 43113, releaseContractAddress: RELEASE_B, primarySaleAddress: SALE_B, tokenId: "42" }, qty: 1, priceWei: 3n })).resolves.toEqual({ hash: `0x${"12".repeat(32)}` });
    const saleCalls = calls.filter((call) => call.method === "eth_call" || call.method === "eth_sendTransaction");
    expect(saleCalls).toHaveLength(2);
    expect(saleCalls.every((call) => call.params[0].to === SALE_B)).toBe(true);
  });
});
