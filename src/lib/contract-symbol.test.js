import { describe, expect, it } from "vitest";
import { normalizeContractSymbol, preparedParametersAreCurrent, symbolFieldState } from "./contract-symbol.js";

describe("normalizeContractSymbol", () => {
  it("uppercases, strips everything but letters and digits, and caps at 11", () => {
    expect(normalizeContractSymbol("forgive & forget!")).toBe("FORGIVEFORG");
    expect(normalizeContractSymbol("fnf-1")).toBe("FNF1");
    expect(normalizeContractSymbol("ABCDEFGHIJKLMNOP")).toHaveLength(11);
    expect(normalizeContractSymbol(undefined)).toBe("");
  });
});

describe("symbolFieldState", () => {
  const prepared = { symbol: "FORGIVEFORG", authorizationDigest: "0xaa" };

  it("keeps an undeployed draft's symbol editable and not stale when it matches the prepared one", () => {
    expect(symbolFieldState({ input: "FORGIVEFORG", provisioning: prepared, provisioningState: "PENDING" })).toMatchObject({ locked: false, stale: false, displayed: "FORGIVEFORG" });
  });

  it("is editable before any preparation exists", () => {
    expect(symbolFieldState({ input: "FNF", provisioning: null, provisioningState: "NOT_STARTED" })).toMatchObject({ locked: false, stale: false, displayed: "FNF" });
  });

  it("marks a prepared request stale as soon as the symbol is edited, until it is re-prepared", () => {
    expect(symbolFieldState({ input: "fnf", provisioning: prepared, provisioningState: "PENDING" })).toMatchObject({ locked: false, stale: true });
    expect(symbolFieldState({ input: "FNF", provisioning: { ...prepared, symbol: "FNF" }, provisioningState: "PENDING" }).stale).toBe(false);
  });

  it("stays editable while a transaction is only submitted or reconciling", () => {
    for (const state of ["SUBMITTED", "RECONCILING", "PENDING", "FAILED"]) {
      expect(symbolFieldState({ input: "X", provisioning: prepared, provisioningState: state }).locked).toBe(false);
    }
  });

  it("locks only after confirmed on-chain creation and shows the deployed contract's symbol, not the draft value", () => {
    const state = symbolFieldState({ input: "EDITEDLATER", provisioning: prepared, provisioningState: "CONFIRMED", onChainSymbol: "FORGIVEFORG" });
    expect(state).toMatchObject({ locked: true, stale: false, displayed: "FORGIVEFORG" });
  });
});

describe("preparedParametersAreCurrent", () => {
  it("accepts only an identical authorization digest", () => {
    expect(preparedParametersAreCurrent({ authorizationDigest: "0xAB" }, { authorizationDigest: "0xab" })).toBe(true);
    expect(preparedParametersAreCurrent({ authorizationDigest: "0xab" }, { authorizationDigest: "0xcd" })).toBe(false);
    expect(preparedParametersAreCurrent({}, {})).toBe(false);
    expect(preparedParametersAreCurrent(null, { authorizationDigest: "0xab" })).toBe(false);
  });
});
