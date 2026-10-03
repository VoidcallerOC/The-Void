import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { FUJI_RELEASE_CONFIG, sendFujiTransaction } from "./fuji-release.js";
import { createFujiPublicProvider, encodeConfigureSale, encodePurchase, explainCollectError, formatAvax, fujiPrimarySaleAddress, fujiReleaseIsV2, purchaseCost, simulateConfigureSale, validateSaleSupply } from "./primary-sale.js";

const CANONICAL_FUJI_V2_RELEASE = "0x82b26Da27136935454Bdf1e40801190B521b82e5";
const CANONICAL_FUJI_PRIMARY_SALE = "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1";

describe("Fuji ERC-1155 primary sale", () => {
  it("reads the certified V2 VoidPrimarySale from the Fuji release config", () => {
    expect(fujiReleaseIsV2()).toBe(true);
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe(CANONICAL_FUJI_V2_RELEASE);
    expect(FUJI_RELEASE_CONFIG.primarySaleAddress).toBe(CANONICAL_FUJI_PRIMARY_SALE);
    expect(fujiPrimarySaleAddress()).toBe(ethers.getAddress(CANONICAL_FUJI_PRIMARY_SALE));
    expect(fujiPrimarySaleAddress()).not.toBe("");
  });

  it("encodes configureSale, purchase, and the exact AVAX cost", () => {
    expect(encodePurchase(1n, 2).slice(0, 10)).toBe(ethers.id("purchase(uint256,uint256)").slice(0, 10));
    expect(encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n }).slice(0, 10)).toBe(ethers.id("configureSale(uint256,uint256,uint256,uint256,uint64,uint64,bool)").slice(0, 10));
    expect(purchaseCost("10000000000000000", 2)).toBe(20_000_000_000_000_000n);
    expect(formatAvax("10000000000000000")).toBe("0.01 AVAX");
  });

  it("blocks a sale supply above the authoritative edition supply before configureSale", () => {
    expect(() => validateSaleSupply(400, 25)).toThrow("Sale supply exceeds edition supply. This edition contains 25 copies. Set the sale supply to 25 or fewer.");
  });

  it("accepts sale supplies equal to or below the edition supply", () => {
    expect(validateSaleSupply(25, 25)).toBe(25n);
    expect(validateSaleSupply(20, 25)).toBe(20n);
  });

  it("keeps a capped edition from using a zero or oversized sale supply", () => {
    expect(() => validateSaleSupply(0, 25)).toThrow("Sale supply must be greater than zero.");
    expect(() => validateSaleSupply(400, 25)).toThrow(/exceeds edition supply/);
    expect(() => encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 0n, perWalletLimit: 1n })).toThrow("Sale supply must be greater than zero.");
    expect(() => encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 0n })).toThrow("Per-wallet limit must be between 1 and the sale supply.");
  });

  it("encodes an open-edition sale with no supply cap only when it has an end time", () => {
    const iface = new ethers.Interface([
      "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
    ]);
    expect(validateSaleSupply(0, 0)).toBe(0n);
    expect(validateSaleSupply("", 0)).toBe(0n);
    expect(validateSaleSupply(12, 0)).toBe(12n);
    expect(() => encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 0n, perWalletLimit: 0n, openEdition: true, endTime: 0 })).toThrow(/sale end time/);
    expect(() => encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 0n, perWalletLimit: 0n, openEdition: true, endTime: "" })).toThrow(/sale end time/);
    const encoded = encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: "", perWalletLimit: "", openEdition: true, endTime: "1790000000" });
    const [, price, supply, limit, , end] = iface.decodeFunctionData("configureSale", encoded);
    expect(price).toBe(10n);
    expect(supply).toBe(0n);
    expect(limit).toBe(0n);
    expect(end).toBe(1790000000n);
  });

  it("uses the public Fuji RPC for configureSale preflight with the exact sender, target, calldata, and zero value", async () => {
    const data = encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n });
    const calls = [];
    const publicProvider = createFujiPublicProvider({ fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      return { ok: true, json: async () => ({ result: request.method === "eth_chainId" ? "0xa869" : "0x" }) };
    } });
    await simulateConfigureSale(publicProvider, { from: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", data });
    expect(calls[1]).toMatchObject({ method: "eth_call", params: [{ from: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", to: ethers.getAddress(CANONICAL_FUJI_PRIMARY_SALE), data, value: "0x0", gas: "0x7a120" }, "latest"] });
  });

  it("surfaces a public-RPC simulation revert instead of hanging", async () => {
    const data = encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n });
    const publicProvider = createFujiPublicProvider({ fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === "eth_chainId") return { ok: true, json: async () => ({ result: "0xa869" }) };
      return { ok: true, json: async () => ({ error: { code: -32000, message: "execution reverted: unauthorized" } }) };
    } });
    await expect(simulateConfigureSale(publicProvider, { from: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", data })).rejects.toMatchObject({ code: "CONFIGURE_SALE_SIMULATION_REVERTED" });
  });

  it("surfaces a public-RPC timeout instead of leaving preflight pending", async () => {
    const data = encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n });
    const publicProvider = createFujiPublicProvider({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
    await expect(simulateConfigureSale(publicProvider, { from: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", data })).rejects.toMatchObject({ code: "FUJI_RPC_TIMEOUT" });
  });

  it("keeps eth_sendTransaction on the authenticated wallet provider", async () => {
    const walletCalls = [];
    const publicCalls = [];
    const walletProvider = { request: async (request) => {
      walletCalls.push(request);
      if (request.method === "eth_sendTransaction") return "0x01";
      throw new Error(`unexpected wallet provider method: ${request.method}`);
    } };
    const publicProvider = { request: async (request) => {
      publicCalls.push(request);
      return { status: "0x1", blockNumber: "0x1", logs: [] };
    } };
    await sendFujiTransaction({ provider: walletProvider, receiptProvider: publicProvider, assumeFujiChain: true, from: "0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174", to: CANONICAL_FUJI_PRIMARY_SALE, data: "0x1234" });
    expect(walletCalls.map(({ method }) => method)).toEqual(["eth_sendTransaction"]);
    expect(publicCalls[0].method).toBe("eth_getTransactionReceipt");
  });

  it("configures a sale from a human-readable 6:00am start without a BigInt error", () => {
    // Production regression: entering "6:00am" in the sale form threw
    // "Cannot convert 6:00am to a BigInt". It must now encode cleanly.
    const iface = new ethers.Interface([
      "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
    ]);
    let encoded;
    expect(() => {
      encoded = encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n, startTime: "6:00am", endTime: "11:59pm" });
    }).not.toThrow();
    const [tokenId, price, supply, limit, start, end, paused] = iface.decodeFunctionData("configureSale", encoded);
    const today = new Date();
    const expectedStart = BigInt(Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 6, 0, 0, 0).getTime() / 1000));
    const expectedEnd = BigInt(Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 0, 0).getTime() / 1000));
    expect(tokenId).toBe(1n);
    expect(price).toBe(10n);
    expect(supply).toBe(4n);
    expect(limit).toBe(2n);
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);
    expect(paused).toBe(false);
  });

  it("still accepts numeric unix-second timestamps and an unset (blank) time", () => {
    const iface = new ethers.Interface([
      "function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)",
    ]);
    const encoded = encodeConfigureSale({ tokenId: 2n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n, startTime: "1790000000", endTime: "" });
    const [, , , , start, end] = iface.decodeFunctionData("configureSale", encoded);
    expect(start).toBe(1790000000n);
    expect(end).toBe(0n);
  });

  it("surfaces a clear error for an unparseable sale time rather than a BigInt exception", () => {
    expect(() => encodeConfigureSale({ tokenId: 1n, priceWei: 10n, maxSupply: 4n, perWalletLimit: 2n, startTime: "not-a-time" }))
      .toThrow(/valid sale time/);
  });

  it("explains rejected transactions, the wrong network, and a sold-out sale", () => {
    expect(explainCollectError({ code: 4001 })).toMatchObject({ state: "rejected" });
    expect(explainCollectError(new Error("Switch your wallet to Avalanche Fuji (chain 43113)."))).toMatchObject({ state: "wrong-network" });
    const soldOut = new ethers.Interface(["error SoldOut(uint256 tokenId, uint256 remaining, uint256 requested)"]).encodeErrorResult("SoldOut", [1, 0, 1]);
    expect(explainCollectError({ data: soldOut })).toMatchObject({ state: "sold-out", message: "This release is sold out." });
  });

  it("names release-contract reverts from purchase instead of hiding them", () => {
    const release = new ethers.Interface(["error AccessDenied(bytes32 role, address account)", "error EditionNotFound(uint256 tokenId)"]);
    const denied = release.encodeErrorResult("AccessDenied", [ethers.id("ISSUER_ROLE"), "0xcc26cd6D6dc25654652D1FBB64dB5F61E20F60F1"]);
    expect(explainCollectError({ data: denied })).toMatchObject({ state: "unauthorized-sale" });
    expect(explainCollectError({ data: release.encodeErrorResult("EditionNotFound", [1n]) })).toMatchObject({ state: "not-created" });
    expect(explainCollectError(new Error("execution reverted"))).toMatchObject({ state: "reverted" });
    expect(explainCollectError(new Error("insufficient funds for gas * price + value"))).toMatchObject({ state: "insufficient-funds" });
  });
});
