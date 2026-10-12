import { describe, expect, it } from "vitest";
import { Interface, getAddress } from "ethers";
import { GenesisLedgerError, decodeGenesisTransfers, replayUsedUnits, unitToUse, unusedUnits } from "./genesis-claim-ledger.js";

const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const C = getAddress("0x3333333333333333333333333333333333333333");
const ZERO = "0x0000000000000000000000000000000000000000";
const events = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
const t = (block, from, to, id, amount, logIndex = 0) => ({ block, logIndex, from, to, id: String(id), amount: BigInt(amount) });
const units = (used, wallet) => Object.fromEntries([...(used.get(wallet) ?? new Map())].map(([id, value]) => [id, value]));

describe("decodeGenesisTransfers", () => {
  it("decodes single and batch transfers and ignores token IDs outside 0-3", () => {
    const single = { ...events.encodeEventLog("TransferSingle", [A, A, B, 3n, 2n]), blockNumber: 10, index: 1 };
    const batch = { ...events.encodeEventLog("TransferBatch", [A, A, C, [0n, 1n, 9n], [1n, 4n, 7n]]), blockNumber: 11, index: 0 };
    expect(decodeGenesisTransfers([single, batch])).toEqual([
      t(10, A, B, 3, 2, 1),
      t(11, A, C, 0, 1, 0),
      t(11, A, C, 1, 4, 0),
    ]);
  });

  it("refuses a log that is not a Genesis transfer", () => {
    expect(() => decodeGenesisTransfers([{ topics: [`0x${"ab".repeat(32)}`], data: "0x", blockNumber: 1, index: 0 }])).toThrow();
  });
});

describe("replayUsedUnits", () => {
  it("marks exactly one unit used per claim and leaves the wallet's other units unused", () => {
    const used = replayUsedUnits({ reservations: [{ wallet: A, block: 5, usedTokenId: "0" }], transfers: [], throughBlock: 9 });
    expect(units(used, A)).toEqual({ 0: 1n });
    expect(unusedUnits(A, { 0: "4", 1: "2", 3: "21" }, used)).toEqual({ 0: 3n, 1: 2n, 2: 0n, 3: 21n });
  });

  it("picks the lowest token ID that still has an unused unit", () => {
    expect(unitToUse({ 0: 0n, 1: 2n, 2: 0n, 3: 21n })).toBe("1");
    expect(unitToUse({ 0: 0n, 1: 0n, 2: 0n, 3: 0n })).toBeNull();
  });

  it("refuses a reservation outside token IDs 0-3", () => {
    expect(() => replayUsedUnits({ reservations: [{ wallet: A, block: 1, usedTokenId: "7" }], transfers: [], throughBlock: 1 })).toThrow(GenesisLedgerError);
  });

  it("applies transfers in the claim block before the claim, and later ones after it", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 5, usedTokenId: "0" }],
      transfers: [t(5, B, A, 0, 1), t(6, A, B, 0, 1)],
      throughBlock: 6,
    });
    expect(units(used, A)["0"]).toBe(0n);
    expect(units(used, B)["0"]).toBe(1n);
  });

  it("moves the used unit first: one buyer receives it, the next receives an unused unit", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 1, usedTokenId: "3" }],
      transfers: [t(2, A, B, 3, 1), t(3, A, C, 3, 1)],
      throughBlock: 3,
    });
    expect(unusedUnits(B, { 3: "1" }, used)["3"]).toBe(0n);
    expect(unusedUnits(C, { 3: "1" }, used)["3"]).toBe(1n);
    expect(unusedUnits(A, { 3: "2" }, used)["3"]).toBe(2n);
  });

  it("carries the used unit inside a multi-unit transfer and leaves the rest of it unused", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 1, usedTokenId: "0" }],
      transfers: [t(2, A, B, 0, 3)],
      throughBlock: 2,
    });
    expect(unusedUnits(B, { 0: "3" }, used)["0"]).toBe(2n);
  });

  it("follows a used unit through several wallets in log order within a block", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 1, usedTokenId: "1" }],
      transfers: [t(4, B, C, 1, 1, 7), t(4, A, B, 1, 1, 3)],
      throughBlock: 4,
    });
    expect(units(used, C)["1"]).toBe(1n);
    expect(units(used, B)["1"]).toBe(0n);
  });

  it("drops used units that are burned and ignores transfers after the head", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 1, usedTokenId: "0" }],
      transfers: [t(2, A, ZERO, 0, 1), t(9, A, B, 0, 1)],
      throughBlock: 5,
    });
    expect(units(used, A)["0"]).toBe(0n);
    expect(used.get(B)).toBeUndefined();
  });

  it("adds a receiver's own claim on top of a used unit it received", () => {
    const used = replayUsedUnits({
      reservations: [{ wallet: A, block: 1, usedTokenId: "0" }, { wallet: B, block: 3, usedTokenId: "0" }],
      transfers: [t(2, A, B, 0, 1)],
      throughBlock: 3,
    });
    expect(units(used, B)["0"]).toBe(2n);
  });
});

describe("unusedUnits", () => {
  it("subtracts used units from the live balance", () => {
    const used = new Map([[A, new Map([["0", 1n]])]]);
    expect(unusedUnits(A, { 0: "3", 2: "1" }, used)).toEqual({ 0: 2n, 1: 0n, 2: 1n, 3: 0n });
  });

  it("fails closed when the ledger shows more used units than the wallet holds", () => {
    const used = new Map([[A, new Map([["0", 2n]])]]);
    expect(() => unusedUnits(A, { 0: "1" }, used)).toThrow(GenesisLedgerError);
  });
});
