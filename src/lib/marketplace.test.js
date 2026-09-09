import { describe, expect, it } from "vitest";
import { LISTING_STATUS, PURCHASE_STATE, createListingRecord, encodeApproval, encodeBuy, encodeCreateListing, requiredPayment, transitionListing, validateListingDraft, validatePurchase, verifyPurchaseReceipt } from "./marketplace.js";

const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x3333333333333333333333333333333333333333";
const contract = "0x2222222222222222222222222222222222222222";
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
    expect(encodeBuy(7, 3).startsWith("0x4f2c5a5e")).toBe(true);
    expect(encodeBuy(7, 3).match(/.{1,64}/g)).toHaveLength(3);
  });
  it("verifies buyer, seller, token, quantity, and total payment from settlement", () => {
    const listing = active();
    const data = `0x${address(contract)}${word(1)}${word(3)}${word(300)}`;
    const receipt = { status: "0x1", to: "0x4444444444444444444444444444444444444444", logs: [{ topics: [topic, `0x${word(7)}`, `0x${address(buyer)}`, `0x${address(seller)}`], data }] };
    expect(verifyPurchaseReceipt(receipt, { listing, buyer, marketplace: receipt.to, quantity: 3 })).toMatchObject({ listingId: "7", buyer, seller, tokenId: "1", amount: "3", price: "300" });
    expect(() => verifyPurchaseReceipt(receipt, { listing, buyer: seller, marketplace: receipt.to, quantity: 3 })).toThrow(/buyer/i);
  });
  it("supports ACTIVE to SOLD, CANCELLED, and EXPIRED", () => {
    expect(transitionListing(active(), LISTING_STATUS.SOLD).status).toBe("SOLD");
    expect(transitionListing(active(), LISTING_STATUS.CANCELLED).status).toBe("CANCELLED");
    expect(transitionListing(active(), LISTING_STATUS.EXPIRED).status).toBe("EXPIRED");
  });
  it("exposes the explicit purchase state machine", () => expect([PURCHASE_STATE.READY, PURCHASE_STATE.WALLET_CONFIRMATION, PURCHASE_STATE.SUBMITTED, PURCHASE_STATE.PENDING, PURCHASE_STATE.CONFIRMED]).toHaveLength(5));
  it("rejects duplicate terminal transitions", () => expect(() => transitionListing(active({ status: LISTING_STATUS.CANCELLED }), LISTING_STATUS.ACTIVE)).toThrow(/Cannot transition/));
});
