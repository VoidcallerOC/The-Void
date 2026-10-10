import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ApiService } from "./api-service.js";
import { canonicalMetadata } from "./metadata-storage.js";
import { createPrimarySaleStateReader } from "./primary-sale-state.js";

const SALE = "0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3";
const RELEASE = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
const TOKEN_ID = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const END = Math.floor(Date.UTC(2026, 9, 31, 23, 59, 0) / 1000);
const OPEN_SALE = { configured: true, paused: false, priceWei: "10000000000000000", maxSupply: "0", sold: "1", perWalletLimit: "1", startTime: "0", endTime: String(END) };

const factoryRow = { id: "e-factory", release_id: "r-factory", title: "forgive-forget-28", supply: "0", status: "PUBLISHED", chain_id: "43113", contract_address: RELEASE, release_contract_address: RELEASE, primary_sale_address: SALE.toLowerCase(), token_id: TOKEN_ID };
const sharedRow = { id: "e-shared", release_id: "r-shared", title: "Fuji Rehearsal A", supply: "25", status: "PUBLISHED", chain_id: "43113", contract_address: "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6", token_id: "9" };

function api(rows, readSale) {
  const db = { query: vi.fn().mockResolvedValue({ rows }) };
  const saleStateReader = readSale ? { readSale: vi.fn(readSale) } : null;
  return { saleStateReader, instance: new ApiService({ db, repository: {}, saleStateReader, now: () => NOW, logger: { info() {}, error() {}, warn() {} } }) };
}

describe("public edition availability", () => {
  it("open edition + live sale is served as open with the sale tuple", async () => {
    const { instance, saleStateReader } = api([factoryRow], async () => OPEN_SALE);
    const edition = await instance.getEdition({ id: "e-factory" });
    expect(edition).toMatchObject({
      supply: "0",
      primary_sale_address: SALE.toLowerCase(),
      primary_availability: "open",
      open_edition: true,
      primary_sale: { configured: true, paused: false, price_wei: "10000000000000000", max_supply: "0", sold: "1", per_wallet_limit: "1", start_time: "0", end_time: String(END) },
    });
    expect(saleStateReader.readSale).toHaveBeenCalledWith({ chainId: "43113", saleAddress: SALE.toLowerCase(), tokenId: TOKEN_ID });
  });

  it("open edition past its end time is ended", async () => {
    const { instance } = api([factoryRow], async () => ({ ...OPEN_SALE, endTime: String(Math.floor(NOW / 1000) - 60) }));
    await expect(instance.getEdition({ id: "e-factory" })).resolves.toMatchObject({ primary_availability: "ended" });
  });

  it("capped edition with its sale cap reached is sold out", async () => {
    const { instance } = api([{ ...factoryRow, supply: "25" }], async () => ({ ...OPEN_SALE, maxSupply: "25", sold: "25" }));
    await expect(instance.listEditions({})).resolves.toEqual([expect.objectContaining({ primary_availability: "sold-out", open_edition: false })]);
  });

  it("sale that has not started is not-started", async () => {
    const { instance } = api([factoryRow], async () => ({ ...OPEN_SALE, startTime: String(Math.floor(NOW / 1000) + 3600) }));
    await expect(instance.getEdition({ id: "e-factory" })).resolves.toMatchObject({ primary_availability: "not-started" });
  });

  it("leaves shared-contract editions untouched and survives a failed sale read", async () => {
    const { instance, saleStateReader } = api([sharedRow, factoryRow], async () => { throw new Error("rpc down"); });
    const editions = await instance.listEditions({});
    expect(saleStateReader.readSale).toHaveBeenCalledTimes(1);
    expect(editions[0]).not.toHaveProperty("primary_availability");
    expect(editions[1]).toMatchObject({ id: "e-factory", supply: "0" });
    expect(editions[1]).not.toHaveProperty("primary_availability");
  });

  it("serves editions exactly as before when no sale reader is configured", async () => {
    const { instance } = api([factoryRow], null);
    const edition = await instance.getEdition({ id: "e-factory" });
    expect(edition).not.toHaveProperty("primary_sale");
    expect(edition).not.toHaveProperty("primary_availability");
  });
});

describe("primary sale state reader", () => {
  const iface = new Interface(["function sales(uint256) view returns (uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused, bool configured)"]);

  it("decodes sales(tokenId) from the edition's own sale contract and caches it", async () => {
    const result = iface.encodeFunctionResult("sales", [10n ** 16n, 0n, 1n, 1n, 0n, BigInt(END), false, true]);
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.params[0].to).toBe(SALE);
      expect(iface.decodeFunctionData("sales", body.params[0].data)[0]).toBe(BigInt(TOKEN_ID));
      return { ok: true, json: async () => ({ result }) };
    });
    const reader = createPrimarySaleStateReader({ url: "https://rpc.example", chainId: 43113, fetchImpl, now: () => NOW });
    const sale = await reader.readSale({ chainId: "43113", saleAddress: SALE.toLowerCase(), tokenId: TOKEN_ID });
    expect(sale).toEqual(OPEN_SALE);
    await reader.readSale({ chainId: 43113, saleAddress: SALE, tokenId: TOKEN_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not read sales on another chain", async () => {
    const fetchImpl = vi.fn();
    const reader = createPrimarySaleStateReader({ url: "https://rpc.example", chainId: 43113, fetchImpl });
    await expect(reader.readSale({ chainId: 43114, saleAddress: SALE, tokenId: TOKEN_ID })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("token metadata supply attribute", () => {
  const release = { title: "forgive-forget-28", description: "Single" };
  const supplyOf = (supply) => canonicalMetadata({ release, edition: { title: "forgive-forget-28", supply }, artist: { name: "Voidcaller" } }).metadata.attributes.find((item) => item.trait_type === "Supply").value;

  it("reads 'Open edition' for supply 0 or blank, and the number for a capped edition", () => {
    expect(supplyOf("0")).toBe("Open edition");
    expect(supplyOf(0)).toBe("Open edition");
    expect(supplyOf(null)).toBe("Open edition");
    expect(supplyOf("25")).toBe("25");
  });
});
