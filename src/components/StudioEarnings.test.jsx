/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioEarnings } from "./StudioEarnings.jsx";
import { WITHDRAW_CALLDATA } from "../lib/sale-earnings.js";

// Observed on Fuji 2026-10-10: forgive-forget-28 after one 0.01 AVAX purchase.
const ARTIST = ethers.getAddress("0x284c09a7cc187e096cbbdc88d99defe6df32180a");
const PLATFORM = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const SALE_NEW = ethers.getAddress("0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3");
const CLONE_NEW = "0x1111111111111111111111111111111111111111";
const SALE_OLD = "0x2222222222222222222222222222222222222222";
const CLONE_OLD = "0x3333333333333333333333333333333333333333";
const OTHER_PAYOUT = "0x5555555555555555555555555555555555555555";
const ACTIVE_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const OLD_FACTORY = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505";
const HASH = `0x${"ab".repeat(32)}`;

const iface = new ethers.Interface(["function balances(address) view returns (uint256)", "function payoutOf(uint256) view returns (address)", "function withdraw()", "function releasesOf(address) view returns (address[])", "function primarySaleOf(address) view returns (address)"]);
const coder = ethers.AbiCoder.defaultAbiCoder();

function catalog({ oldPayoutToken = "9" } = {}) {
  return {
    releases: [{ id: "rel-ff", title: "Forgive & Forget 28" }, { id: "rel-old", title: "Old Factory Single" }],
    editions: [
      { id: "ed-ff", releaseId: "rel-ff", chainId: 43113, tokenIds: ["7"], contractAddress: CLONE_NEW, releaseContractAddress: CLONE_NEW, primarySaleAddress: "" },
      { id: "ed-old", releaseId: "rel-old", chainId: 43113, tokenIds: [oldPayoutToken], contractAddress: CLONE_OLD, releaseContractAddress: CLONE_OLD, primarySaleAddress: "" },
    ],
    releaseBindings: [
      { releaseId: "rel-ff", chainId: 43113, releaseContractAddress: CLONE_NEW, primarySaleAddress: SALE_NEW, factoryAddress: ACTIVE_FACTORY },
      { releaseId: "rel-old", chainId: 43113, releaseContractAddress: CLONE_OLD, primarySaleAddress: SALE_OLD, factoryAddress: OLD_FACTORY },
    ],
  };
}

function chain({ balances, payouts, factoryReleases = {}, log = [] }) {
  const readProvider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa869";
      if (method === "eth_getTransactionReceipt") {
        // The withdrawal clears the balance the receipt confirms.
        balances[`${SALE_NEW}:${ARTIST}`.toLowerCase()] = 0n;
        return { status: "0x1", blockNumber: "0x10" };
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data, from } = params[0];
      if (data === WITHDRAW_CALLDATA) { log.push(`simulate:${from}:${to}`); return "0x"; }
      const parsed = iface.parseTransaction({ data });
      if (parsed.name === "releasesOf") return coder.encode(["address[]"], [(factoryReleases[to.toLowerCase()] || []).map(([release]) => release)]);
      if (parsed.name === "primarySaleOf") return coder.encode(["address"], [Object.values(factoryReleases).flat().find(([release]) => release.toLowerCase() === parsed.args[0].toLowerCase())[1]]);
      if (parsed.name === "payoutOf") return coder.encode(["address"], [payouts[`${to}:${parsed.args[0]}`.toLowerCase()]]);
      if (parsed.name === "balances") return coder.encode(["uint256"], [balances[`${to}:${parsed.args[0]}`.toLowerCase()] ?? 0n]);
      throw new Error(`unexpected call ${parsed.name}`);
    }),
  };
  const walletProvider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa869";
      if (method === "eth_sendTransaction") { log.push(`send:${params[0].data}:${params[0].to}`); return HASH; }
      throw new Error(`unexpected wallet ${method}`);
    }),
  };
  return { readProvider, walletProvider, log };
}

function setup({ balances = {}, payouts, factoryReleases, catalogValue = catalog() } = {}) {
  const state = chain({
    balances: {
      [`${SALE_NEW}:${ARTIST}`.toLowerCase()]: ethers.parseEther("0.00975"),
      [`${SALE_NEW}:${PLATFORM}`.toLowerCase()]: ethers.parseEther("0.00025"),
      ...balances,
    },
    payouts: payouts || { [`${CLONE_NEW}:7`.toLowerCase()]: ARTIST, [`${CLONE_OLD}:9`.toLowerCase()]: ARTIST },
    factoryReleases,
  });
  const wallet = { account: ARTIST, getProvider: () => state.walletProvider };
  render(<StudioEarnings catalog={catalogValue} wallet={wallet} readProvider={state.readProvider} />);
  return state;
}

afterEach(cleanup);

describe("Studio earnings", () => {
  it("renders the total and a per-release breakdown from live balance reads on both factories", async () => {
    setup({ balances: { [`${SALE_OLD}:${ARTIST}`.toLowerCase()]: ethers.parseEther("0.5") } });
    expect(await screen.findByTestId("earnings-total")).toHaveProperty("textContent", "0.50975 AVAX");
    expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0.50975 AVAX");
    const ff = screen.getByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByText("0.00975 AVAX")).toBeTruthy();
    expect(within(ff).getByText("Factory V2 (active)")).toBeTruthy();
    expect(within(ff).getByText(SALE_NEW)).toBeTruthy();
    const old = screen.getByRole("listitem", { name: "Earnings for Old Factory Single" });
    expect(within(old).getByText("0.5 AVAX")).toBeTruthy();
    expect(within(old).getByText("Factory V2 (historical)")).toBeTruthy();
  });

  it("simulates withdraw() and then sends exactly one withdraw() to that sale, showing the tx and refreshed balance", async () => {
    const { walletProvider, log } = setup();
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    fireEvent.click(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }));
    expect(await within(ff).findByText(HASH)).toBeTruthy();
    expect(within(ff).getByText(HASH).getAttribute("href")).toBe(`https://testnet.snowtrace.io/tx/${HASH}`);
    expect(log).toEqual([`simulate:${ARTIST}:${SALE_NEW}`, `send:${WITHDRAW_CALLDATA}:${SALE_NEW}`]);
    expect(walletProvider.request.mock.calls.filter(([request]) => request.method === "eth_sendTransaction")).toHaveLength(1);
    await waitFor(() => expect(within(ff).getByText("0.0 AVAX")).toBeTruthy());
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).disabled).toBe(true);
  });

  it("disables Withdraw when the balance is zero and never sends", async () => {
    const { walletProvider } = setup();
    const old = await screen.findByRole("listitem", { name: "Earnings for Old Factory Single" });
    const button = within(old).getByRole("button", { name: "Withdraw from Old Factory Single" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("finds sale contracts from the factories when the API returns no release bindings", async () => {
    const { releaseBindings, ...withoutBindings } = catalog();
    expect(releaseBindings).toHaveLength(2);
    setup({
      catalogValue: withoutBindings,
      factoryReleases: { [ACTIVE_FACTORY.toLowerCase()]: [[CLONE_NEW, SALE_NEW]], [OLD_FACTORY.toLowerCase()]: [[CLONE_OLD, SALE_OLD]] },
    });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByText("0.00975 AVAX")).toBeTruthy();
    expect(within(ff).getByText("Factory V2 (active)")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Earnings for Old Factory Single" })).toBeTruthy();
  });

  it("names the payout wallet when it is not the connected wallet and offers no withdraw", async () => {
    setup({
      payouts: { [`${CLONE_NEW}:7`.toLowerCase()]: ARTIST, [`${CLONE_OLD}:9`.toLowerCase()]: OTHER_PAYOUT },
      balances: { [`${SALE_OLD}:${OTHER_PAYOUT}`.toLowerCase()]: ethers.parseEther("0.2") },
    });
    const old = await screen.findByRole("listitem", { name: "Earnings for Old Factory Single" });
    expect(within(old).getByText(/Only 0x5555…5555 can withdraw this/)).toBeTruthy();
    expect(within(old).queryByRole("button", { name: /Withdraw/ })).toBeNull();
    expect(screen.getByTestId("earnings-total").textContent).toBe("0.20975 AVAX");
    expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0.00975 AVAX");
  });
});
