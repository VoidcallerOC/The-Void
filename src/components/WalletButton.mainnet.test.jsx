/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import mainnet from "../../config/mainnet-release.json" with { type: "json" };
import { WalletCtx } from "../lib/wallet-context.js";

// The production build (VITE_RELEASE_NETWORK=mainnet) selects Avalanche C-Chain 43114.
vi.mock("../../config/release-network.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, RELEASE_NETWORK: "mainnet", RELEASE_DEPLOYMENT: mainnet, IS_MAINNET_RELEASE: true };
});

const { WalletButton } = await import("./WalletButton.jsx");

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

describe("WalletButton on the mainnet build", () => {
  it("requires Avalanche C-Chain 43114 before connecting", () => {
    expect(mainnet.chainId).toBe(43114);
    renderButton({ connected: false, authenticated: false, authenticating: false, account: "", wallets: [], connect: vi.fn(), authenticate: vi.fn(), disconnect: vi.fn() });
    const button = screen.getByRole("button", { name: "Connect wallet" });
    expect(button.getAttribute("title")).toMatch(/Avalanche C-Chain \(43114\) required/);
    expect(button.getAttribute("title")).not.toMatch(/fuji/i);
  });

  it("offers the production Avalanche switch (wallet approval still required) and never Fuji", async () => {
    const ensureNetwork = vi.fn(async () => ({ error: "Switch to Avalanche C-Chain (43114) was rejected.", code: "CHAIN_SWITCH_REJECTED" }));
    renderButton({
      connected: true,
      authenticated: false,
      authenticating: false,
      needsNetworkSwitch: true,
      account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      chainId: 43113,
      authenticationError: "Avalanche C-Chain (43114) is required to use The Void. Ethereum is not supported.",
      wallets: [],
      connect: vi.fn(),
      authenticate: vi.fn(),
      ensureNetwork,
      disconnect: vi.fn(),
    });
    const button = screen.getByRole("button", { name: /Switch wallet to Avalanche C-Chain/i });
    expect(screen.getByText("SWITCH TO AVALANCHE")).toBeTruthy();
    expect(screen.queryByText(/FUJI/i)).toBeNull();
    expect(button.getAttribute("data-network-switch")).toBe("true");
    expect(button.getAttribute("title")).toMatch(/Avalanche C-Chain \(43114\) is required/);
    await fireEvent.click(button);
    expect(ensureNetwork).toHaveBeenCalledWith({ thenAuthenticate: true });
  });
});
