import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { WITHDRAW_CALLDATA, earningsTargets, explainWithdrawError, formatEarnings, mapReleaseBindings, mapReleaseSales, mapSecondaryRoyalties, withdrawnFromReceipt, withdrawSaleProceeds } from "./sale-earnings.js";

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
    ])).toEqual([{ releaseId: "r1", chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: ethers.getAddress(SALE), factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", artistWallet: ethers.getAddress(ARTIST), artistEarnedWei: null, artistWithdrawnWei: null }]);
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

  it("keeps the indexer's earned-to-date only when it is a whole number", () => {
    const [row] = mapReleaseBindings([{ release_id: "r1", chain_id: 43114, release_contract_address: CLONE, primary_sale_address: SALE, artist_earned_wei: "243750000000000000" }]);
    expect(row.artistEarnedWei).toBe("243750000000000000");
    expect(mapReleaseBindings([{ release_id: "r1", chain_id: 43114, release_contract_address: CLONE, primary_sale_address: SALE, artist_earned_wei: "abc" }])[0].artistEarnedWei).toBeNull();
  });

  it("formats native AVAX without a trailing .0", () => {
    expect(formatEarnings(0n)).toBe("0 AVAX");
    expect(formatEarnings(243750000000000000n)).toBe("0.24375 AVAX");
    expect(formatEarnings(1000000000000000000n)).toBe("1 AVAX");
  });

  it("reads the withdrawn amount only from this sale's Withdrawn event for this wallet", () => {
    const iface = new ethers.Interface(["event Withdrawn(address indexed account, uint256 amount)"]);
    const encode = (account, amount) => iface.encodeEventLog("Withdrawn", [account, amount]);
    const good = { address: SALE, ...encode(ARTIST, 5n) };
    expect(withdrawnFromReceipt({ logs: [good] }, { saleAddress: SALE, account: ARTIST })).toBe(5n);
    expect(withdrawnFromReceipt({ logs: [{ ...good, address: CLONE }] }, { saleAddress: SALE, account: ARTIST })).toBeNull();
    expect(withdrawnFromReceipt({ logs: [{ address: SALE, ...encode("0x5555555555555555555555555555555555555555", 5n) }] }, { saleAddress: SALE, account: ARTIST })).toBeNull();
    expect(withdrawnFromReceipt({ logs: [] }, { saleAddress: SALE, account: ARTIST })).toBeNull();
  });

  it("maps release sales and secondary royalties, dropping malformed rows and inventing no figures", () => {
    const sales = mapReleaseSales([
      { release_contract_address: CLONE, sale_contract_address: SALE, chain_id: 43114, artist_earned_wei: "5", artist_withdrawn_wei: "2", sales: 3 },
      { release_contract_address: CLONE, sale_contract_address: null, chain_id: 43114 },
      { release_contract_address: CLONE, sale_contract_address: SALE, chain_id: 43114, artist_earned_wei: "x" },
    ]);
    expect(sales).toHaveLength(2);
    expect(sales[0]).toMatchObject({ chainId: 43114, primarySaleAddress: ethers.getAddress(SALE), artistEarnedWei: "5", artistWithdrawnWei: "2", sales: 3 });
    expect(sales[1]).toMatchObject({ artistEarnedWei: null, artistWithdrawnWei: null });
    expect(mapReleaseSales(undefined)).toEqual([]);
    const royalties = mapSecondaryRoyalties([
      { chain_id: 43114, token_contract_address: CLONE, token_id: "123", royalty_wei: "10", sales: 2 },
      { chain_id: 43114, token_contract_address: CLONE, token_id: "not-a-number", royalty_wei: "10" },
      { chain_id: 43114, token_contract_address: "nope", token_id: "1", royalty_wei: "10" },
    ]);
    expect(royalties).toEqual([{ chainId: 43114, tokenContractAddress: ethers.getAddress(CLONE), tokenId: "123", royaltyWei: "10", sales: 2 }]);
  });

  it("keeps two sales of one release as separate targets that share the release's token ids and factory", () => {
    const SECOND = "0x4444444444444444444444444444444444444444";
    const targets = earningsTargets({
      releaseBindings: [{ releaseId: "r1", chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: SALE, factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" }],
      releaseSales: [{ chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: SECOND, artistEarnedWei: "7", artistWithdrawnWei: "3", sales: 1 }, { chainId: 43113, releaseContractAddress: CLONE, primarySaleAddress: SALE, artistEarnedWei: "9", artistWithdrawnWei: null, sales: 2 }],
      editions: [{ releaseId: "r1", chainId: 43113, tokenIds: ["1"], contractAddress: CLONE, primarySaleAddress: SALE }],
    });
    expect(targets.map((target) => target.primarySaleAddress).sort()).toEqual([ethers.getAddress(SALE), ethers.getAddress(SECOND)].sort());
    const settled = targets.find((target) => target.primarySaleAddress === ethers.getAddress(SECOND));
    const legacy = targets.find((target) => target.primarySaleAddress === ethers.getAddress(SALE));
    expect(settled).toMatchObject({ artistEarnedWei: "7", artistWithdrawnWei: "3", tokenIds: ["1"], factoryAddress: "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8" });
    expect(legacy).toMatchObject({ artistEarnedWei: "9", artistWithdrawnWei: null, tokenIds: ["1"] });
  });
});
