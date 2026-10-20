/** @vitest-environment jsdom */
// Controlled-environment acceptance for the artist Earnings view against a LOCAL FORK of Avalanche
// C-Chain (chain 43114). Nothing here touches mainnet: reads and the withdraw transaction go to an
// anvil fork (`anvil --fork-url https://api.avax.network/ext/bc/C/rpc --chain-id 43114
// --auto-impersonate`), and the artist wallet is impersonated on that fork only.
//
//   MAINNET_FORK_RPC=http://127.0.0.1:8545 npx vitest run src/components/StudioEarnings.mainnet-fork.test.jsx
//
// Skipped when MAINNET_FORK_RPC is unset so CI without a fork stays green.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 10000 });
const FORK = globalThis.process?.env?.MAINNET_FORK_RPC || "";
const ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const PLATFORM = "0xb65c575cae01574296fab6e620b9a15cc0121ce4";
const SALE = "0x6ae84a51f100f10f0535a514555043ae9edf9aa3";
const RELEASE = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103";
const FACTORY = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
const TOKEN_ID = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const STRANGER = "0x00000000000000000000000000000000000000a1";

async function rpc(method, params = []) {
  const response = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
  return body.result;
}

// What GET /studio/catalog returns for the artist (Supabase rows, 2026-10-20).
const apiCatalog = () => ({
  releases: [{ id: "release-83611741-c9ee-4487-a438-b6fa844762e6", title: "Forgive & Forget" }],
  editions: [{ id: "edition-6e35101c-4987-4695-ac96-d83061ef2673", releaseId: "release-83611741-c9ee-4487-a438-b6fa844762e6", chainId: 43114, tokenIds: [TOKEN_ID], contractAddress: RELEASE, releaseContractAddress: RELEASE, primarySaleAddress: SALE, factoryAddress: FACTORY }],
  releaseBindings: [{ releaseId: "release-83611741-c9ee-4487-a438-b6fa844762e6", chainId: 43114, releaseContractAddress: RELEASE, primarySaleAddress: SALE, factoryAddress: FACTORY, artistWallet: ARTIST, artistEarnedWei: "243750000000000000" }],
});

function walletFor(account, { chainId = "0xa86a", reject = false } = {}) {
  const provider = {
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") { if (chainId !== "0xa86a") throw Object.assign(new Error("not switchable"), { code: 4902 }); return null; }
      if (method === "eth_sendTransaction") {
        if (reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return rpc("eth_sendTransaction", params);
      }
      return rpc(method, params);
    },
  };
  return { account, getProvider: () => provider };
}

describe.skipIf(!FORK)("Studio Earnings against a local mainnet fork", () => {
  let StudioEarnings;
  let snapshot;
  beforeAll(async () => {
    vi.stubEnv("VITE_RELEASE_NETWORK", "mainnet");
    vi.stubEnv("RELEASE_NETWORK", "mainnet");
    vi.resetModules();
    ({ StudioEarnings } = await import("./StudioEarnings.jsx"));
    expect(Number.parseInt(await rpc("eth_chainId"), 16)).toBe(43114);
  });
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(async () => { snapshot = await rpc("evm_snapshot"); });
  afterEach(async () => { cleanup(); await rpc("evm_revert", [snapshot]); });

  const readProvider = () => ({ request: ({ method, params }) => rpc(method, params) });
  const balanceOf = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));

  it("fork precondition: the sale holds the purchase and credits are intact", async () => {
    expect(await balanceOf(SALE)).toBeGreaterThanOrEqual(250000000000000000n);
  });

  it("shows the artist 0.24375 AVAX, never the platform share, then withdraws it and verifies the receipt", async () => {
    const before = await balanceOf(ARTIST);
    const wallet = walletFor(ARTIST);
    render(<StudioEarnings catalog={apiCatalog()} wallet={wallet} readProvider={readProvider()} />);
    const withdrawable = await screen.findByTestId("earnings-withdrawable");
    await waitFor(() => expect(withdrawable.textContent).toBe("0.24375 AVAX"));
    expect(screen.getByTestId(`earned-${SALE}`).textContent).toBe("0.24375 AVAX");
    expect(screen.getByTestId(`withdrawn-${SALE}`).textContent).toBe("0 AVAX");
    expect(screen.getByTestId(`receive-${SALE}`).textContent).toMatch(/You will receive 0\.24375 AVAX \(native AVAX\)/);
    expect(screen.getByTestId("platform-fee-note")).toBeTruthy();
    expect(screen.queryByText(new RegExp(PLATFORM, "i"))).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Withdraw from Forgive & Forget/i }));
    const confirmed = await screen.findByTestId(`confirmed-${SALE}`);
    expect(confirmed.textContent).toMatch(/0\.24375 AVAX was sent to your wallet/);
    expect(confirmed.querySelector("a").getAttribute("href")).toMatch(/^https:\/\/snowtrace\.io\/tx\/0x[0-9a-f]{64}$/);
    // Gas is paid from the payout wallet, so the net gain is 0.24375 minus a little gas.
    const gained = (await balanceOf(ARTIST)) - before;
    expect(gained).toBeGreaterThan(243750000000000000n - 1000000000000000n);
    expect(gained).toBeLessThanOrEqual(243750000000000000n);
    // Refreshed view: nothing left to withdraw, all of it recorded as withdrawn.
    await waitFor(() => expect(screen.getByTestId(`withdrawn-${SALE}`).textContent).toBe("0.24375 AVAX"));
    expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0 AVAX");
    expect(screen.getByRole("button", { name: /Withdraw from Forgive & Forget/i }).disabled).toBe(true);
    // The platform's credited share is untouched and still held for it.
    const owed = await rpc("eth_call", [{ to: SALE, data: `0x27e235e3${PLATFORM.slice(2).padStart(64, "0")}` }, "latest"]);
    expect(BigInt(owed)).toBe(6250000000000000n);
    expect(await balanceOf(SALE)).toBe(6250000000000000n);
  });

  it("does not offer a withdrawal when the wallet is on another chain", async () => {
    render(<StudioEarnings catalog={apiCatalog()} wallet={walletFor(ARTIST, { chainId: "0xa869" })} readProvider={readProvider()} />);
    expect((await screen.findByTestId("wrong-network")).textContent).toMatch(/Your wallet is on chain 43113\. Switch to Avalanche C-Chain \(chain 43114\)/);
    const button = await screen.findByRole("button", { name: /Withdraw from Forgive & Forget/i });
    expect(button.disabled).toBe(true);
    expect(await balanceOf(SALE)).toBe(250000000000000000n);
  });

  it("leaves funds untouched when the wallet rejects the transaction", async () => {
    render(<StudioEarnings catalog={apiCatalog()} wallet={walletFor(ARTIST, { reject: true })} readProvider={readProvider()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Withdraw from Forgive & Forget/i }));
    await screen.findByText("Withdrawal rejected in the wallet. Nothing was sent.");
    expect(await balanceOf(SALE)).toBe(250000000000000000n);
  });

  it("refuses to enable withdrawal for a sale that is not the release's registered sale", async () => {
    const wrongBinding = apiCatalog();
    wrongBinding.releaseBindings[0].primarySaleAddress = "0x0e77116142844478a55eed2ab79de9f93770f8f5"; // the marketplace, not the sale
    wrongBinding.editions[0].primarySaleAddress = wrongBinding.releaseBindings[0].primarySaleAddress;
    render(<StudioEarnings catalog={wrongBinding} wallet={walletFor(ARTIST)} readProvider={readProvider()} />);
    const bogus = wrongBinding.releaseBindings[0].primarySaleAddress;
    const warning = await screen.findByTestId(`unverified-${bogus}`);
    expect(warning.textContent).toMatch(/could not be verified on-chain/);
    const card = warning.closest("li");
    expect(within(card).queryAllByRole("button", { name: /Withdraw/i })).toHaveLength(0);
  });

  it("finds the sale from the factory alone when the API catalog is empty", async () => {
    render(<StudioEarnings catalog={{ releases: [], editions: [], releaseBindings: [] }} wallet={walletFor(ARTIST)} readProvider={readProvider()} />);
    const withdrawable = await screen.findByTestId("earnings-withdrawable");
    await waitFor(() => expect(withdrawable.textContent).toBe("0.24375 AVAX"));
  });

  it("a stranger wallet sees no withdraw action for the artist's balance", async () => {
    render(<StudioEarnings catalog={apiCatalog()} wallet={walletFor(STRANGER)} readProvider={readProvider()} />);
    await screen.findByTestId("earnings-total");
    await waitFor(() => expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0 AVAX"));
    expect(screen.queryByRole("button", { name: /Withdraw from/i })).toBeNull();
  });
});
