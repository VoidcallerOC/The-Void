import { describe, expect, it } from "vitest";
import {
  loadPrimaryPurchaseEvidence,
  normalizePrimaryPurchaseEvidence,
  savePrimaryPurchaseEvidence,
} from "./primary-purchase-evidence.js";

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("primary purchase evidence", () => {
  it("persists and recovers the canonical purchase fields", () => {
    const store = fakeStorage();
    const input = {
      transactionHash: `0x${"A".repeat(64)}`,
      tokenId: "123",
      editionId: "edition-1",
      quantity: 1,
      priceWei: "10000000000000000",
      purchaser: "0xABCD",
    };
    expect(savePrimaryPurchaseEvidence(input, store)).toMatchObject({
      transactionHash: `0x${"a".repeat(64)}`,
      tokenId: "123",
      editionId: "edition-1",
      quantity: "1",
      priceWei: "10000000000000000",
      purchaser: "0xabcd",
    });
    expect(loadPrimaryPurchaseEvidence({ editionId: "edition-1", tokenId: 123, purchaser: "0xabcd" }, store)).toMatchObject({
      transactionHash: `0x${"a".repeat(64)}`,
      tokenId: "123",
      editionId: "edition-1",
    });
  });

  it("rejects incomplete evidence", () => {
    expect(normalizePrimaryPurchaseEvidence({ transactionHash: "0x1" })).toBeNull();
  });
});
