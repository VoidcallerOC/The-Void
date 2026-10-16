/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { WalletButton } from "./WalletButton.jsx";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";
import { releaseNetworkSwitchLabel } from "../lib/release-chain.js";

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
      needsNetworkSwitch: false,
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
          needsNetworkSwitch: false,
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

  it("surfaces a release-network switch CTA when the wallet is on the wrong chain", async () => {
    const ensureNetwork = vi.fn(async () => ({ ok: true }));
    renderButton({
      connected: true,
      authenticated: false,
      authenticating: false,
      needsNetworkSwitch: true,
      account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      chainId: 1,
      authenticationError: `${RELEASE_DEPLOYMENT.networkName} (${RELEASE_DEPLOYMENT.chainId}) is required to use The Void. Ethereum is not supported.`,
      wallets: [],
      connect: vi.fn(),
      authenticate: vi.fn(),
      ensureNetwork,
      disconnect: vi.fn(),
    });
    const button = screen.getByRole("button", { name: new RegExp(`Switch wallet to ${RELEASE_DEPLOYMENT.networkName}`, "i") });
    expect(screen.getByText(releaseNetworkSwitchLabel(RELEASE_DEPLOYMENT))).toBeTruthy();
    expect(button.getAttribute("data-needs-network")).toBe("true");
    await fireEvent.click(button);
    expect(ensureNetwork).toHaveBeenCalledWith({ thenAuthenticate: true });
  });
});
