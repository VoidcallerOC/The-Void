/** @vitest-environment jsdom */
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "./WalletContext.jsx";
import { useWallet } from "./wallet-context.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

vi.mock("./wallet-auth.js", () => ({
  authenticateWallet: vi.fn(async ({ chainId }) => ({ token: "session", wallet: "0x1111111111111111111111111111111111111111", chainId })),
  authorizationHeaders: (session) => (session ? { authorization: `Bearer ${session.token}` } : {}),
}));

vi.mock("./web3.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkOwnership: vi.fn(async () => ({ cchain: new Set(), grotto: new Set() })),
    checkCollectionOwnership: vi.fn(async () => ({ cchain: new Set(), grotto: new Set() })),
    checkOwnershipRecords: vi.fn(async () => []),
    checkCollectionOwnershipRecords: vi.fn(async () => []),
    choirIdentity: () => ({ witness: false, bearer: false, choir: false, crossed: false, firstCall: false, chapterICount: 0, marks: [] }),
  };
});

import { authenticateWallet } from "./wallet-auth.js";

function Probe({ onReady }) {
  const wallet = useWallet();
  React.useEffect(() => { onReady(wallet); }, [wallet, onReady]);
  return null;
}

function methodOrder(provider) {
  return provider.request.mock.calls.map(([call]) => call.method);
}

describe("WalletProvider connect chain targeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.ethereum;
  });

  it("fresh connect requests accounts before switch (Rabby Connect is not opened via switch)", async () => {
    let chain = "0x1";
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_accounts") return [];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    window.ethereum = provider;

    let api;
    render(React.createElement(WalletProvider, null, React.createElement(Probe, { onReady: (value) => { api = value; } })));
    await waitFor(() => expect(api?.connect).toBeTypeOf("function"));
    provider.request.mockClear();

    let result;
    await act(async () => { result = await api.connect(provider); });
    expect(result).toMatchObject({ ok: true });
    const order = methodOrder(provider);
    expect(order.indexOf("eth_requestAccounts")).toBeLessThan(order.indexOf("wallet_switchEthereumChain"));
    expect(authenticateWallet).toHaveBeenCalledWith(expect.objectContaining({ chainId: Number(RELEASE_DEPLOYMENT.chainId) }));
  });

  it("reconnect ensures chain before eth_requestAccounts when already permitted", async () => {
    let chain = "0x1";
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          return ["0x1111111111111111111111111111111111111111"];
        }
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    window.ethereum = provider;

    let api;
    render(React.createElement(WalletProvider, null, React.createElement(Probe, { onReady: (value) => { api = value; } })));
    await waitFor(() => expect(api?.connect).toBeTypeOf("function"));
    provider.request.mockClear();

    let result;
    await act(async () => { result = await api.connect(provider); });
    expect(result).toMatchObject({ ok: true });
    const order = methodOrder(provider);
    expect(order.indexOf("wallet_switchEthereumChain")).toBeLessThan(order.indexOf("eth_requestAccounts"));
  });

  it("does not authenticate when post-accounts switch is rejected", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_accounts") return [];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") {
          const error = new Error("User rejected the request.");
          error.code = 4001;
          throw error;
        }
        throw new Error(`unexpected ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    let api;
    render(React.createElement(WalletProvider, null, React.createElement(Probe, { onReady: (value) => { api = value; } })));
    await waitFor(() => expect(api?.connect).toBeTypeOf("function"));
    provider.request.mockClear();

    let result;
    await act(async () => { result = await api.connect(provider); });
    expect(result).toMatchObject({ code: "CHAIN_SWITCH_REJECTED" });
    expect(authenticateWallet).not.toHaveBeenCalled();
  });

  it("does not authenticate when eth_chainId stays on Ethereum after switch (Rabby no-op)", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_accounts") return [];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") return null;
        throw new Error(`unexpected ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    let api;
    render(React.createElement(WalletProvider, null, React.createElement(Probe, { onReady: (value) => { api = value; } })));
    await waitFor(() => expect(api?.connect).toBeTypeOf("function"));
    provider.request.mockClear();

    let result;
    await act(async () => { result = await api.connect(provider); });
    expect(result).toMatchObject({ code: "WRONG_CHAIN" });
    expect(authenticateWallet).not.toHaveBeenCalled();
  });
});
