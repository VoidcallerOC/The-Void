// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaimPage } from "./ClaimPage.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { LEGACY_CHAIN_ID } from "../lib/legacy-genesis.js";

afterEach(cleanup);

const account = "0x1111111111111111111111111111111111111111";
const baseWallet = {
  wallets: [],
  account: null,
  chainId: null,
  connected: false,
  authenticated: false,
  authenticating: false,
  authenticationError: null,
  getProvider: () => null,
  connect: vi.fn(),
  authenticate: vi.fn(),
  disconnect: vi.fn(),
};

function renderClaim({ wallet = {}, eligibilityReader = vi.fn(async () => ({ eligible: false, ownedTokenIds: [] })) } = {}) {
  return render(
    <WalletCtx.Provider value={{ ...baseWallet, ...wallet }}>
      <ClaimPage eligibilityReader={eligibilityReader} />
    </WalletCtx.Provider>,
  );
}

describe("ClaimPage", () => {
  it("asks disconnected users to connect a wallet without requiring authentication", () => {
    renderClaim();

    expect(screen.getByRole("heading", { name: "ACCESS REQUIRED" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CONNECT" })).toBeTruthy();
    expect(screen.getByText("Connect a wallet to check access.")).toBeTruthy();
  });

  it("requires Avalanche C-Chain before reading eligibility", () => {
    const eligibilityReader = vi.fn();
    renderClaim({ wallet: { connected: true, account, chainId: 43113 }, eligibilityReader });

    expect(screen.getByRole("heading", { name: "WRONG NETWORK" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "SWITCH TO AVALANCHE C-CHAIN" })).toBeTruthy();
    expect(eligibilityReader).not.toHaveBeenCalled();
  });

  it("grants access only after an eligible on-chain result and leaves CLAIM disabled", async () => {
    const eligibilityReader = vi.fn(async () => ({ eligible: true, ownedTokenIds: [3] }));
    renderClaim({ wallet: { connected: true, account, chainId: LEGACY_CHAIN_ID }, eligibilityReader });

    expect(await screen.findByRole("heading", { name: "ACCESS GRANTED" })).toBeTruthy();
    const claimButton = screen.getByRole("button", { name: "CLAIM" });
    expect(claimButton.disabled).toBe(true);
    expect(screen.getByText("Claim action not configured · no transaction will be sent")).toBeTruthy();
    expect(eligibilityReader).toHaveBeenCalledWith(account);
  });

  it("denies access only after verified empty balances", async () => {
    renderClaim({
      wallet: { connected: true, account, chainId: LEGACY_CHAIN_ID },
      eligibilityReader: vi.fn(async () => ({ eligible: false, ownedTokenIds: [] })),
    });

    expect(await screen.findByRole("heading", { name: "ACCESS DENIED" })).toBeTruthy();
    expect(screen.getByText("This claim is reserved for holders of The-Void main collection editions 0–3.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "CLAIM" })).toBeNull();
  });

  it("shows an unavailable state on a failed ownership read instead of denying access", async () => {
    renderClaim({
      wallet: { connected: true, account, chainId: LEGACY_CHAIN_ID },
      eligibilityReader: vi.fn(async () => { throw Object.assign(new Error("RPC unavailable"), { code: "OWNERSHIP_READ_FAILED" }); }),
    });

    expect(await screen.findByRole("heading", { name: "OWNERSHIP CHECK UNAVAILABLE" })).toBeTruthy();
    expect(screen.getByText("A failed read is not a denial.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "CLAIM" })).toBeNull();
  });

  it("requests a C-Chain switch through the selected browser wallet", () => {
    const provider = { request: vi.fn(async () => null) };
    renderClaim({ wallet: { connected: true, account, chainId: 43113, getProvider: () => provider } });

    fireEvent.click(screen.getByRole("button", { name: "SWITCH TO AVALANCHE C-CHAIN" }));

    expect(provider.request).toHaveBeenCalledWith({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa86a" }] });
  });
});
