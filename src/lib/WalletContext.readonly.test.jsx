// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WalletProvider } from "./WalletContext.jsx";
import { useWallet } from "./wallet-context.js";

afterEach(cleanup);

const account = "0x1111111111111111111111111111111111111111";

function ReadOnlyConnectProbe({ provider }) {
  const wallet = useWallet();
  const [result, setResult] = useState(null);
  return (
    <>
      <button type="button" onClick={async () => setResult(await wallet.connect(provider, { authenticate: false }))}>
        connect read only
      </button>
      <output>{wallet.connected ? "connected" : "disconnected"} · {wallet.authenticated ? "authenticated" : "unauthenticated"}</output>
      {result && <output>{result.ok ? "connection ready" : result.error}</output>}
    </>
  );
}

describe("WalletProvider read-only connection", () => {
  it("connects an account without requesting wallet authentication", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_requestAccounts") return [account];
        if (method === "eth_chainId") return "0xa86a";
        throw new Error(`Unexpected request ${method}`);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const ownershipReader = vi.fn(async () => ({ cchain: new Set(), grotto: new Set() }));
    const ownershipRecordsReader = vi.fn(async () => []);

    render(
      <WalletProvider ownershipReader={ownershipReader} ownershipRecordsReader={ownershipRecordsReader}>
        <ReadOnlyConnectProbe provider={provider} />
      </WalletProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "connect read only" }));

    expect(await screen.findByText("connected · unauthenticated")).toBeTruthy();
    expect(screen.getByText("connection ready")).toBeTruthy();
    expect(provider.request.mock.calls.map(([request]) => request.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
  });
});
