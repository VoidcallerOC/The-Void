import { describe, expect, it } from "vitest";
import { canAccessExperience, getCollectorLibrary, mergeOwnershipRecords, normalizeOwnershipRecords } from "./collection.js";
import { createExperience } from "../domain/models.js";
import { VOIDCALLER_CATALOG } from "../data.js";

const contract = "0xD1B4367DD9F235F9EE61878019D66E31511E98EE";
const wallet = "0x1111111111111111111111111111111111111111";
const record = (tokenId, amount = 1, overrides = {}) => ({ wallet, contract, tokenId, amount, chain: { key: "cchain", id: 43114 }, updatedAt: 1, ...overrides });

describe("collector ownership model", () => {
  it("normalizes, filters zero balances, and merges repeated indexer rows", () => {
    const rows = mergeOwnershipRecords(normalizeOwnershipRecords([record(0, 1), record(0, 2), record(1, 0)]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wallet: wallet.toLowerCase(), contract: contract.toLowerCase(), tokenId: "0", amount: 3 });
  });
  it("builds releases, artists, editions, quantities, and experiences", () => {
    const library = getCollectorLibrary(VOIDCALLER_CATALOG, [record(0, 2), record(1, 1)]);
    expect(library.artists.map((item) => item.id)).toEqual(["voidcaller"]);
    expect(library.releases.map((item) => item.id)).toEqual(["voidcaller-self-titled"]);
    expect(library.editions[0].quantity).toBe(3);
    expect(library.experiences[0].id).toBe("voidcaller-full-ep");
  });
  it("supports multiple contracts and chains without conflating balances", () => {
    const other = record(0, 5, { contract: "0x2222222222222222222222222222222222222222", chain: { key: "other", id: 999 } });
    const library = getCollectorLibrary(VOIDCALLER_CATALOG, [other]);
    expect(library.editions).toHaveLength(0);
    expect(mergeOwnershipRecords([record(0, 1), other])).toHaveLength(2);
  });
  it("requires current ownership for gated experiences", () => {
    const experience = createExperience({ id: "x", title: "Full Album", requirements: [{ contract, tokenIds: [0, 1] }] });
    expect(canAccessExperience(experience, [record(0, 1)])).toBe(true);
    expect(canAccessExperience(experience, [record(9, 1)])).toBe(false);
  });
});
