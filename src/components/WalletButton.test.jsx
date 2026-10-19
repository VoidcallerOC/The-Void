/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { WalletButton } from "./WalletButton.jsx";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

// The default test build selects Fuji. Collector-facing builds (every `vite build`) are not the
// dev server, so the testnet switch is hidden; `dev` flips the developer-only control on.
const gate = vi.hoisted(() => ({ dev: false }));
vi.mock("../lib/release-chain.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    releaseNetworkSwitchAllowed: (deployment, options = {}) => actual.releaseNetworkSwitchAllowed(deployment, { dev: gate.dev, ...options }),
  };
});

afterEach(() => {
  cleanup();
  gate.dev = false;
});

function wrongChainWallet(ensureNetwork) {
  return {
    connected: true,
    authenticated: false,
    authenticating: false,
    needsNetworkSwitch: true,
    account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    chainId: 43114,
    authenticationError: `${RELEASE_DEPLOYMENT.networkName} (${RELEASE_DEPLOYMENT.chainId}) is required to use The Void. Ethereum is not supported.`,
    wallets: [],
    connect: vi.fn(),
    authenticate: vi.fn(),
    ensureNetwork,
    disconnect: vi.fn(),
  };
}

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

  it("shows a wrong-network notice, not a testnet switch, to collectors on the Fuji build", async () => {
    expect(RELEASE_DEPLOYMENT.chainId).toBe(43113);
    const ensureNetwork = vi.fn(async () => ({ ok: true }));
    renderButton(wrongChainWallet(ensureNetwork));
    const button = screen.getByRole("button", { name: /Wrong network/i });
    expect(screen.getByText("WRONG NETWORK")).toBeTruthy();
    expect(screen.queryByText(/SWITCH TO FUJI/i)).toBeNull();
    expect(screen.queryByText(/SWITCH/i)).toBeNull();
    expect(button.getAttribute("data-needs-network")).toBe("true");
    expect(button.getAttribute("data-network-switch")).toBe("false");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toMatch(/Avalanche Fuji \(43113\) is required to use The Void/);
    await fireEvent.click(button);
    expect(ensureNetwork).not.toHaveBeenCalled();
  });

  it("keeps the developer-only switch on the dev server without naming the testnet", async () => {
    gate.dev = true;
    const ensureNetwork = vi.fn(async () => ({ ok: true }));
    renderButton(wrongChainWallet(ensureNetwork));
    const button = screen.getByRole("button", { name: new RegExp(`Switch wallet to ${RELEASE_DEPLOYMENT.networkName}`, "i") });
    expect(screen.getByText("SWITCH NETWORK")).toBeTruthy();
    expect(screen.queryByText(/FUJI/i)).toBeNull();
    expect(button.getAttribute("data-network-switch")).toBe("true");
    await fireEvent.click(button);
    // The wallet still has to approve: ensureNetwork prompts wallet_switchEthereumChain and refuses auth on rejection.
    expect(ensureNetwork).toHaveBeenCalledWith({ thenAuthenticate: true });
  });
});
