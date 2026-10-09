import { describe, expect, it } from "vitest";
import { keccak256 } from "ethers";
import fingerprints from "./data/legacy-sale-fingerprints.json" with { type: "json" };
import { normalizedRuntimeHash } from "./legacy-sale-bytecode-check.mjs";

describe("legacy sale bytecode check", () => {
  it("zeroes immutable ranges and strips CBOR metadata before hashing", () => {
    // 4 code bytes, 2-byte immutable at offset 1, 3-byte metadata + 2-byte length.
    const code = "0x11aabb22" + "a1b2c3" + "0003";
    expect(normalizedRuntimeHash(code, [[1, 2]])).toBe(keccak256("0x11000022"));
  });

  it("covers both pre-ownership-transfer sources under both candidate compilers, all with one storage layout", () => {
    expect(fingerprints.map((f) => `${f.sourceCommit}|${f.compiler.split(" ")[0]}`).sort()).toEqual([
      "66f4938|solc-0.8.24-opt200-cancun", "66f4938|solc-0.8.30-noopt-prague", "fd31295|solc-0.8.24-opt200-cancun", "fd31295|solc-0.8.30-noopt-prague",
    ]);
    for (const f of fingerprints) {
      expect(f.hasTransferOwnership).toBe(false);
      expect(f.storageLayout.map((s) => `${s.slot}:${s.label}`)).toEqual(["0:_status", "1:platformFeeBps", "2:owner", "3:sales", "4:walletPurchased", "5:balances"]);
      expect(f.saleStruct.map((m) => `${m.slot}:${m.offset}:${m.label}`)).toEqual(["0:0:priceWei", "1:0:maxSupply", "2:0:sold", "3:0:perWalletLimit", "4:0:startTime", "4:8:endTime", "4:16:paused", "4:17:configured"]);
    }
  });
});
