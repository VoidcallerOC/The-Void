/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { WalletButton } from "./WalletButton.jsx";

afterEach(() => {
  cleanup();
});

function renderButton(wallet) {
  return render(
    <WalletCtx.Provider value={wallet}>
      <WalletButton />
    </WalletCtx.Provider>,
  );
}

describe("WalletButton accessible name", () => {
  it("names the disconnected control Connect wallet", () => {
    renderButton({
      connected: false,
      authenticated: false,
      authenticating: false,
      account: "",
      wallets: [],
      connect: vi.fn(),
      authenticate: vi.fn(),
      disconnect: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.getByText("CONNECT")).toBeTruthy();
  });

  it("names authenticate and disconnect states without changing visible labels", () => {
    const { rerender } = renderButton({
      connected: true,
      authenticated: false,
      authenticating: false,
      account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      authenticationError: null,
      wallets: [],
      connect: vi.fn(),
      authenticate: vi.fn(),
      disconnect: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Authenticate wallet" })).toBeTruthy();
    expect(screen.getByText("AUTH REQUIRED")).toBeTruthy();

    rerender(
      <WalletCtx.Provider
        value={{
          connected: true,
          authenticated: true,
          authenticating: false,
          account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          wallets: [],
          connect: vi.fn(),
          authenticate: vi.fn(),
          disconnect: vi.fn(),
        }}
      >
        <WalletButton />
      </WalletCtx.Provider>,
    );
    expect(screen.getByRole("button", { name: /Disconnect wallet/i })).toBeTruthy();
  });
});
