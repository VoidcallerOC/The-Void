import { describe, expect, it, vi } from "vitest";
import { Interface, getAddress } from "ethers";
import { resolveCatalogSaleBinding, verifyReleaseSaleBinding } from "./release-sale-binding.js";

// Real Fuji deployment named in the sale-resolution defect.
const RELEASE = getAddress("0xe87410e9a2c703b6bb696d4bfb5f268d3c5bcf65");
const SALE = getAddress("0x83afb5e26ccc60c724e67123d0518781f77c257b");
const FACTORY_V2 = getAddress("0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8");
const FACTORY_HISTORICAL = getAddress("0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505");
const OTHER = getAddress("0x9999999999999999999999999999999999999999");
const edition = { releaseId: "ff", contractAddress: RELEASE.toLowerCase(), chainId: 43113 };
const row = (o = {}) => ({ releaseId: "ff", chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE, factoryAddress: FACTORY_V2, ...o });

describe("resolveCatalogSaleBinding", () => {
  it("resolves the sale from the release binding when the edition row has none", () => {
    expect(resolveCatalogSaleBinding({ releaseBindings: [row()] }, { releaseId: "ff", edition, chainId: 43113 })).toEqual({ chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE, factoryAddress: FACTORY_V2 });
  });
  it("prefers consistent edition fields", () => {
    expect(resolveCatalogSaleBinding({}, { releaseId: "ff", edition: { ...edition, primarySaleAddress: SALE, factoryAddress: FACTORY_V2 }, chainId: 43113 })?.primarySaleAddress).toBe(SALE);
  });
  it.each([
    ["no binding", {}, edition],
    ["binding for another release", { releaseBindings: [row({ releaseId: "other" })] }, edition],
    ["binding for another clone", { releaseBindings: [row({ releaseContractAddress: OTHER })] }, edition],
    ["binding on another chain", { releaseBindings: [row({ chainId: 1 })] }, edition],
    ["edition on another chain", { releaseBindings: [row()] }, { ...edition, chainId: 1 }],
    ["conflicting sales", { releaseBindings: [row()] }, { ...edition, primarySaleAddress: OTHER }],
    ["zero sale", { releaseBindings: [row({ primarySaleAddress: "0x0000000000000000000000000000000000000000" })] }, edition],
  ])("fails closed: %s", (_name, catalog, ed) => {
    expect(resolveCatalogSaleBinding(catalog, { releaseId: "ff", edition: ed, chainId: 43113 })).toBeNull();
  });
});

describe("verifyReleaseSaleBinding", () => {
  const factoryIface = new Interface(["function primarySaleOf(address) view returns (address)"]);
  const saleIface = new Interface(["function releases() view returns (address)"]);
  const provider = ({ factorySale = SALE, saleRelease = RELEASE } = {}) => ({
    request: vi.fn(async ({ params: [{ data }] }) => (data.startsWith(saleIface.getFunction("releases").selector)
      ? saleIface.encodeFunctionResult("releases", [saleRelease])
      : factoryIface.encodeFunctionResult("primarySaleOf", [factorySale]))),
  });
  const binding = { chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE, factoryAddress: FACTORY_V2 };

  it("accepts the exact Fuji release, V2 factory and dedicated sale", async () => {
    await expect(verifyReleaseSaleBinding(provider(), binding)).resolves.toEqual(binding);
  });
  it("accepts a historical recorded factory", async () => {
    await expect(verifyReleaseSaleBinding(provider(), { ...binding, factoryAddress: FACTORY_HISTORICAL })).resolves.toBeTruthy();
  });
  it("rejects a factory that reports a different sale", async () => {
    await expect(verifyReleaseSaleBinding(provider({ factorySale: OTHER }), binding)).rejects.toThrow(/Factory does not report/);
  });
  it("rejects a sale that points at a different release", async () => {
    await expect(verifyReleaseSaleBinding(provider({ saleRelease: OTHER }), binding)).rejects.toThrow(/does not belong/);
  });
  it("rejects an unrecorded factory and missing fields without any RPC", async () => {
    const p = provider();
    await expect(verifyReleaseSaleBinding(p, { ...binding, factoryAddress: OTHER })).rejects.toThrow(/not a recorded deployment/);
    await expect(verifyReleaseSaleBinding(p, { ...binding, factoryAddress: "" })).rejects.toThrow(/must all be recorded/);
    expect(p.request).not.toHaveBeenCalled();
  });
});
