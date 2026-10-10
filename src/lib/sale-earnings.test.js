import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { WITHDRAW_CALLDATA, earningsTargets, explainWithdrawError, mapReleaseBindings, withdrawSaleProceeds } from "./sale-earnings.js";

const SALE = "0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3";
const CLONE = "0x1111111111111111111111111111111111111111";
const ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";

describe("sale earnings", () => {
  it("uses the withdraw() selector", () => {
    expect(WITHDRAW_CALLDATA).toBe("0x3ccfd60b");
  });

  it("maps catalog release bindings and drops rows without a sale", () => {
    expect(mapReleaseBindings([
      { release_id: "r1", chain_id: 43113, release_contract_address: CLONE, primary_sale_address: SALE.toLowerCase(), factory_address: "0xa5cba0f91cb0a81e0a9ce89a6722cbe4eec93505", artist_wallet: ARTIST },
      { release_id: "r2", chain_id: 43113, release_contract_address: CLONE, primary_sale_address: null },
    ])).toEqual([{ releaseId: "r1", chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: ethers.getAddress(SALE), factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", artistWallet: ethers.getAddress(ARTIST) }]);
  });

  it("keeps one target per sale contract, attaches edition token ids, and labels the factory", () => {
    const targets = earningsTargets({
      releases: [{ id: "r1", title: "One" }],
      releaseBindings: [{ releaseId: "r1", chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: SALE, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" }],
      editions: [
        { releaseId: "r1", chainId: 43113, tokenIds: ["1"], contractAddress: CLONE },
        { releaseId: "r1", chainId: 43113, tokenIds: ["2", "1"], contractAddress: CLONE },
        { releaseId: "r1", chainId: 43114, tokenIds: ["3"], contractAddress: CLONE },
      ],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ title: "One", primarySaleAddress: ethers.getAddress(SALE), tokenIds: ["1", "2"], factoryLabel: "Factory V2 (active)" });
  });

  it("does not send when the simulation reverts with NothingToWithdraw", async () => {
    const nothing = new ethers.Interface(["error NothingToWithdraw()"]).encodeErrorResult("NothingToWithdraw", []);
    const readProvider = { request: vi.fn(async () => { throw Object.assign(new Error("execution reverted"), { data: nothing }); }) };
    const walletProvider = { request: vi.fn(async ({ method }) => (method === "eth_chainId" ? "0xa869" : "0xhash")) };
    await expect(withdrawSaleProceeds({ walletProvider, readProvider, from: ARTIST, saleAddress: SALE })).rejects.toThrow("nothing to withdraw");
    expect(walletProvider.request.mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(false);
  });

  it("explains a wallet rejection", () => {
    expect(explainWithdrawError({ code: 4001 })).toBe("Withdrawal rejected in the wallet. Nothing was sent.");
  });
});
