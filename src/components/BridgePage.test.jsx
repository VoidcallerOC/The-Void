/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WalletCtx } from "../lib/wallet-context.js";
import { BridgePage } from "./BridgePage.jsx";

vi.mock("../lib/web3.js", async () => {
  const actual = await vi.importActual("../lib/web3.js");
  return { ...actual, fetchAllMetadata: vi.fn().mockResolvedValue([]) };
});

afterEach(() => cleanup());

function wallet(overrides = {}) {
  return {
    connected: false, account: null, chainId: null, owned: {}, ownershipRecords: [], wallets: [],
    authenticated: false, authenticating: false, authenticationError: null, needsNetworkSwitch: false,
    getProvider: () => null, connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn(), refreshOwnership: vi.fn(),
    ...overrides,
  };
}

describe("Studio bridge route", () => {
  it("renders the ported bridge surface and uses the shared wallet context", async () => {
    render(<MemoryRouter initialEntries={["/bridge"]}><WalletCtx.Provider value={wallet()}><Routes><Route path="/bridge" element={<BridgePage />} /></Routes></WalletCtx.Provider></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "CROSS THE VEIL" })).toBeTruthy();
    expect(screen.getByText("Connect your wallet to bridge relics.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});
