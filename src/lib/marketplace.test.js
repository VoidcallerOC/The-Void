import { describe, expect, it, vi } from "vitest";

vi.mock("./web3.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, waitForReceipt: vi.fn(), switchChain: vi.fn() };
});

import { LISTING_CREATED_TOPIC, LISTING_STATUS, MARKETPLACE_SELECTORS, PURCHASE_STATE, assertCanonicalMarketplaceTarget, createListingRecord, encodeApproval, encodeBuy, encodeCreateListing, listingIdFromReceipt, requiredPayment, submitPurchase, transitionListing, validateListingDraft, validatePurchase, verifyPurchaseReceipt } from "./marketplace.js";
import { waitForReceipt } from "./web3.js";

const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x3333333333333333333333333333333333333333";
const contract = "0x2222222222222222222222222222222222222222";
const marketplace = "0x4444444444444444444444444444444444444444";
const canonical = Object.freeze({ address: marketplace, chainId: 43114, enabled: true });
const topic = "0x2b7afc2686848b44bb9d680f07613f88a940454a6a60984a092cd305a781e811";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const address = (value) => value.slice(2).padStart(64, "0");
function active(overrides = {}) { return createListingRecord({ listingId: "7", seller, chain: 43114, contract, tokenId: 1, amount: 10, price: "100", ...overrides }); }

describe("marketplace listing validation", () => {
  it("accepts a valid multi-unit native listing", () => expect(validateListingDraft({ seller, contract, tokenId: 1, amount: 2, price: "100" })).toBeNull());
  it("rejects invalid quantity, price, currency, and stale expiry", () => {
    expect(validateListingDraft({ seller, contract, tokenId: 1, amount: 0, price: "100" })).toMatch(/quantity/i);
    expect(validateListingDraft({ seller, contract, tokenId: 1, amount: 1, price: "0" })).toMatch(/price/i);
    expect(validateListingDraft({ seller, contract, tokenId: 1, amount: 1, price: "1", currency: "USDC" })).toMatch(/native/i);
    expect(validateListingDraft({ seller, contract, tokenId: 1, amount: 1, price: "1", expiresAt: 10, now: 11 })).toMatch(/future/i);
  });
  it("rejects values outside the contract’s uint256 bounds", () => {
    const max = ((1n << 256n) - 1n).toString();
    const overflow = (1n << 256n).toString();
    expect(validateListingDraft({ seller, contract, tokenId: overflow, amount: "1", price: "1" })).toMatch(/uint256/i);
    expect(validateListingDraft({ seller, contract, tokenId: max, amount: overflow, price: "1" })).toMatch(/quantity/i);
    expect(validateListingDraft({ seller, contract, tokenId: max, amount: "1", price: overflow })).toMatch(/uint256/i);
  });
});

describe("purchase validation and payment", () => {
  it("calculates native payment from unit price and quantity", () => expect(requiredPayment(active(), 3)).toBe("300"));
  it("rejects inactive, expired, and unavailable purchases", () => {
    expect(validatePurchase({ listing: active({ status: LISTING_STATUS.CANCELLED }), buyer, quantity: 1 })).toMatch(/active/i);
    expect(validatePurchase({ listing: active({ expiresAt: 100 }), buyer, quantity: 1, now: 101 })).toMatch(/expired/i);
    expect(validatePurchase({ listing: active(), buyer, quantity: 11 })).toMatch(/available/i);
  });
  it("accepts a partial purchase and rejects zero quantity", () => {
    expect(validatePurchase({ listing: active(), buyer, quantity: 3 })).toBeNull();
    expect(validatePurchase({ listing: active(), buyer, quantity: 0 })).toMatch(/positive/i);
  });
});

describe("marketplace ABI, receipt verification, and lifecycle", () => {
  it("encodes approval, listing, and quantity-aware purchase calls", () => {
    expect(encodeApproval(contract).startsWith("0xa22cb465")).toBe(true);
    expect(encodeCreateListing({ contract, seller, tokenId: 1, amount: 2, price: "100", expiresAt: 0 }).match(/.{1,64}/g)).toHaveLength(7);
    expect(MARKETPLACE_SELECTORS.buy).toBe("0xd6febde8");
    expect(encodeBuy(7, 3).startsWith("0xd6febde8")).toBe(true);
    expect(encodeBuy(7, 3).match(/.{1,64}/g)).toHaveLength(3);
  });
  it("uses the deployed contract event topic for listing IDs", () => {
    expect(LISTING_CREATED_TOPIC).toBe("0xd805c12164ca2f60bbd92cc6343c957e7813dff1eb56a4c62519c3222cd6bd19");
    expect(listingIdFromReceipt({ logs: [{ topics: [LISTING_CREATED_TOPIC, `0x${word(7)}`] }] })).toBe("7");
  });
  it("verifies buyer, seller, token, quantity, and total payment from settlement", () => {
    const listing = active();
    const data = `0x${address(contract)}${word(1)}${word(3)}${word(300)}`;
    const receipt = { status: "0x1", to: marketplace, logs: [{ topics: [topic, `0x${word(7)}`, `0x${address(buyer)}`, `0x${address(seller)}`], data }] };
    expect(verifyPurchaseReceipt(receipt, { listing, buyer, marketplace, quantity: 3 })).toMatchObject({ listingId: "7", buyer, seller, tokenId: "1", amount: "3", price: "300" });
    expect(() => verifyPurchaseReceipt(receipt, { listing, buyer: seller, marketplace, quantity: 3 })).toThrow(/buyer/i);
  });
  it("does not emit CONFIRMED from a successful local wallet receipt", async () => {
    const listing = active();
    const receipt = {
      status: "0x1",
      to: marketplace,
      logs: [{ topics: [topic, `0x${word(7)}`, `0x${address(buyer)}`, `0x${address(seller)}`], data: `0x${address(contract)}${word(1)}${word(1)}${word(100)}` }],
    };
    waitForReceipt.mockResolvedValueOnce(receipt);
    const onState = vi.fn();
    const provider = { request: vi.fn(async ({ method }) => (method === "eth_chainId" ? "0xa86a" : `0x${"c".repeat(64)}`)) };
    await submitPurchase({ provider, buyer, marketplace, listing, quantity: 1, chain: { id: 43114, key: "avalanche" }, chainId: 43114, onState, canonical });
    expect(onState.mock.calls.map(([state]) => state)).toEqual([PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.OBSERVED]);
    expect(onState).not.toHaveBeenCalledWith(PURCHASE_STATE.CONFIRMED);
  });
  it("supports ACTIVE to SOLD, CANCELLED, and EXPIRED", () => {
    expect(transitionListing(active(), LISTING_STATUS.SOLD).status).toBe("SOLD");
    expect(transitionListing(active(), LISTING_STATUS.CANCELLED).status).toBe("CANCELLED");
    expect(transitionListing(active(), LISTING_STATUS.EXPIRED).status).toBe("EXPIRED");
  });
  it("exposes the explicit purchase state machine", () => expect([PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.CONFIRMED]).toHaveLength(5));
  it("rejects duplicate terminal transitions", () => expect(() => transitionListing(active({ status: LISTING_STATUS.CANCELLED }), LISTING_STATUS.ACTIVE)).toThrow(/Cannot transition/));
});

describe("canonical marketplace purchase target", () => {
  const foreign = "0x5555555555555555555555555555555555555555";
  const payingProvider = (chainHex = "0xa86a") => ({ request: vi.fn(async ({ method }) => (method === "eth_chainId" ? chainHex : `0x${"c".repeat(64)}`)) });
  it("accepts only the configured marketplace on its configured chain", () => {
    expect(assertCanonicalMarketplaceTarget({ marketplace: marketplace.toUpperCase().replace("0X", "0x"), chainId: 43114, config: canonical })).toBe(marketplace);
    expect(() => assertCanonicalMarketplaceTarget({ marketplace: foreign, chainId: 43114, config: canonical })).toThrow(/verified marketplace/);
    expect(() => assertCanonicalMarketplaceTarget({ marketplace, chainId: 43113, config: canonical })).toThrow(/marketplace network/);
    expect(() => assertCanonicalMarketplaceTarget({ marketplace, chainId: 43114, config: { address: "", chainId: 0, enabled: false } })).toThrow(/not configured/);
  });
  it("never sends value to a marketplace address that differs from the configured one", async () => {
    const provider = payingProvider();
    await expect(submitPurchase({ provider, buyer, marketplace: foreign, listing: active(), quantity: 1, chain: { id: 43114, key: "avalanche" }, chainId: 43114, canonical })).rejects.toMatchObject({ code: "MARKETPLACE_TARGET_MISMATCH" });
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("refuses to send when the wallet is still on another chain after switching", async () => {
    const provider = payingProvider("0xa869");
    await expect(submitPurchase({ provider, buyer, marketplace, listing: active(), quantity: 1, chain: { id: 43114, key: "avalanche" }, chainId: 43113, canonical })).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    expect(provider.request.mock.calls.map(([call]) => call.method)).not.toContain("eth_sendTransaction");
  });
});
