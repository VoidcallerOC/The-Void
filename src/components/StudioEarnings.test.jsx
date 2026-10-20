/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ethers } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioEarnings } from "./StudioEarnings.jsx";
import { WITHDRAW_CALLDATA } from "../lib/sale-earnings.js";
import { haveSettledArtifact, settledRuntime } from "../lib/test-fixtures/settled-sale.js";

// Observed on Fuji 2026-10-10: forgive-forget-28 after one 0.01 AVAX purchase.
const ARTIST = ethers.getAddress("0x284c09a7cc187e096cbbdc88d99defe6df32180a");
const PLATFORM = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const SALE_NEW = ethers.getAddress("0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3");
const CLONE_NEW = "0x1111111111111111111111111111111111111111";
const SALE_OLD = "0x2222222222222222222222222222222222222222";
const CLONE_OLD = "0x3333333333333333333333333333333333333333";
const OTHER_PAYOUT = "0x5555555555555555555555555555555555555555";
const SALE_SET = "0x4444444444444444444444444444444444444444";
const ROGUE = "0x6666666666666666666666666666666666666666";
const LEGACY_CODE = `0x6080${"60".repeat(200)}a264697066735822${"11".repeat(32)}64736f6c63430008180033`;
const ACTIVE_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
const OLD_FACTORY = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505";
const HASH = `0x${"ab".repeat(32)}`;

const iface = new ethers.Interface(["function balances(address) view returns (uint256)", "function payoutOf(uint256) view returns (address)", "function withdraw()", "function releasesOf(address) view returns (address[])", "function primarySaleOf(address) view returns (address)", "function releases() view returns (address)", "function platformRecipient() view returns (address)", "function PLATFORM_FEE_BPS() view returns (uint256)", "function owner() view returns (address)", "function hasRole(bytes32,address) view returns (bool)", "function isRelease(address) view returns (bool)", "event Withdrawn(address indexed account, uint256 amount)"]);
const SALE_OF = { [CLONE_NEW.toLowerCase()]: SALE_NEW, [CLONE_OLD.toLowerCase()]: SALE_OLD };
const RELEASE_OF = { [SALE_NEW.toLowerCase()]: CLONE_NEW, [SALE_OLD.toLowerCase()]: CLONE_OLD, [SALE_SET.toLowerCase()]: CLONE_NEW };
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

function chain({ balances, payouts, factoryReleases = {}, log = [], bind = {}, omitWithdrawnEvent = false, receiptDelay = null, settled = {} }) {
  const readProvider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa869";
      if (method === "eth_getCode") return settled.codes?.[params[0].toLowerCase()] ?? LEGACY_CODE;
      if (method === "eth_getTransactionReceipt") {
        // The withdrawal clears the balance the receipt confirms.
        if (receiptDelay && !receiptDelay.released) return null;
        const key = `${SALE_NEW}:${ARTIST}`.toLowerCase();
        const amount = balances[key] ?? 0n;
        balances[key] = 0n;
        const logs = omitWithdrawnEvent ? [] : [{ address: SALE_NEW, topics: [iface.getEvent("Withdrawn").topicHash, coder.encode(["address"], [ARTIST])], data: coder.encode(["uint256"], [amount]) }];
        return { status: "0x1", blockNumber: "0x10", logs };
      }
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data, from } = params[0];
      if (data === WITHDRAW_CALLDATA) { log.push(`simulate:${from}:${to}`); return "0x"; }
      const parsed = iface.parseTransaction({ data });
      if (parsed.name === "releasesOf") return coder.encode(["address[]"], [(factoryReleases[to.toLowerCase()] || []).map(([release]) => release)]);
      if (parsed.name === "primarySaleOf") return coder.encode(["address"], [bind.primarySaleOf?.[parsed.args[0].toLowerCase()] ?? SALE_OF[parsed.args[0].toLowerCase()]]);
      if (parsed.name === "releases") return coder.encode(["address"], [bind.releases?.[to.toLowerCase()] ?? RELEASE_OF[to.toLowerCase()]]);
      if (parsed.name === "platformRecipient") return coder.encode(["address"], [settled.recipient?.[to.toLowerCase()] ?? PLATFORM]);
      if (parsed.name === "PLATFORM_FEE_BPS") return coder.encode(["uint256"], [settled.fee?.[to.toLowerCase()] ?? 250n]);
      if (parsed.name === "owner") { if (settled.owner?.[to.toLowerCase()]) return coder.encode(["address"], [settled.owner[to.toLowerCase()]]); throw Object.assign(new Error("execution reverted"), { code: 3 }); }
      if (parsed.name === "hasRole") return coder.encode(["bool"], [settled.issuer?.[parsed.args[1].toLowerCase()] ?? Boolean(settled.codes?.[parsed.args[1].toLowerCase()])]);
      if (parsed.name === "isRelease") return coder.encode(["bool"], [true]);
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

function setup({ balances = {}, payouts, factoryReleases, catalogValue = catalog(), account = ARTIST, chainOptions = {} } = {}) {
  const state = chain({
    balances: {
      [`${SALE_NEW}:${ARTIST}`.toLowerCase()]: ethers.parseEther("0.00975"),
      [`${SALE_NEW}:${PLATFORM}`.toLowerCase()]: ethers.parseEther("0.00025"),
      ...balances,
    },
    payouts: payouts || { [`${CLONE_NEW}:7`.toLowerCase()]: ARTIST, [`${CLONE_OLD}:9`.toLowerCase()]: ARTIST },
    factoryReleases,
    ...chainOptions,
  });
  const wallet = { account, getProvider: () => state.walletProvider };
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
    expect(within(ff).getByTestId(`confirmed-${SALE_NEW.toLowerCase()}`).textContent).toMatch(/0\.00975 AVAX was sent to your wallet/);
    expect(log).toEqual([`simulate:${ARTIST}:${SALE_NEW}`, `send:${WITHDRAW_CALLDATA}:${SALE_NEW}`]);
    expect(walletProvider.request.mock.calls.filter(([request]) => request.method === "eth_sendTransaction")).toHaveLength(1);
    await waitFor(() => expect(within(ff).getByText("0 AVAX")).toBeTruthy());
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).disabled).toBe(true);
  });

  it("disables Withdraw when the balance is zero and never sends", async () => {
    const { walletProvider } = setup();
    const old = await screen.findByRole("listitem", { name: "Earnings for Old Factory Single" });
    const button = within(old).getByRole("button", { name: "Withdraw from Old Factory Single" });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    // The wallet is only asked for its chain; no transaction is ever requested.
    expect(walletProvider.request.mock.calls.map(([request]) => request.method).filter((method) => method !== "eth_chainId")).toEqual([]);
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

  it("states what is available, what will be received and that the platform fee is not an artist claim", async () => {
    setup();
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByText("Available to withdraw")).toBeTruthy();
    expect(within(ff).getByTestId(`receive-${SALE_NEW.toLowerCase()}`).textContent).toMatch(/You will receive 0\.00975 AVAX \(native AVAX\)/);
    expect(screen.getByTestId("platform-fee-note").textContent).toMatch(/nothing for you to claim/);
    // The platform's own balance is never listed for an artist wallet.
    expect(screen.queryByText(new RegExp(PLATFORM, "i"))).toBeNull();
    expect(screen.queryByText("Platform balance")).toBeNull();
  });

  it("shows earned to date and derives already-withdrawn from it when the API reports earnings", async () => {
    const withEarnings = catalog();
    withEarnings.releaseBindings[0].artistEarnedWei = ethers.parseEther("0.03").toString();
    setup({ catalogValue: withEarnings });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByTestId(`earned-${SALE_NEW.toLowerCase()}`).textContent).toBe("0.03 AVAX");
    expect(within(ff).getByTestId(`withdrawn-${SALE_NEW.toLowerCase()}`).textContent).toBe("0.02025 AVAX");
    expect(within(ff).getByTestId(`withdrawn-derived-${SALE_NEW.toLowerCase()}`).textContent).toMatch(/Derived as earned minus what is still held/);
    // No earnings reported: nothing is invented for the other release.
    const old = screen.getByRole("listitem", { name: "Earnings for Old Factory Single" });
    expect(within(old).queryByText("Already withdrawn")).toBeNull();
    expect(within(old).getByText(/Earned-to-date history is not available/)).toBeTruthy();
  });

  it("shows a submitted state with the transaction link before the receipt arrives, then confirmation", async () => {
    const receiptDelay = { released: false };
    const { log } = setup({ chainOptions: { receiptDelay } });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    fireEvent.click(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }));
    const submitted = await within(ff).findByTestId(`submitted-${SALE_NEW.toLowerCase()}`);
    expect(submitted.textContent).toMatch(/Withdrawal submitted/);
    expect(within(submitted).getByText(HASH).getAttribute("href")).toBe(`https://testnet.snowtrace.io/tx/${HASH}`);
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).textContent).toBe("Confirming…");
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).disabled).toBe(true);
    expect(log.filter((entry) => entry.startsWith("send:"))).toHaveLength(1);
    receiptDelay.released = true;
    expect(await within(ff).findByTestId(`confirmed-${SALE_NEW.toLowerCase()}`, {}, { timeout: 8000 })).toBeTruthy();
  }, 15000);

  it("reports a wallet rejection and sends nothing", async () => {
    const { walletProvider, log } = setup();
    const original = walletProvider.request.getMockImplementation();
    walletProvider.request.mockImplementation(async (request) => {
      if (request.method === "eth_sendTransaction") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      return original(request);
    });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    fireEvent.click(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }));
    expect(await within(ff).findByText("Withdrawal rejected in the wallet. Nothing was sent.")).toBeTruthy();
    expect(log.some((entry) => entry.startsWith("send:"))).toBe(false);
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).disabled).toBe(false);
  });

  it("does not report success when a successful receipt carries no Withdrawn event", async () => {
    setup({ chainOptions: { omitWithdrawnEvent: true } });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    fireEvent.click(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }));
    expect(await within(ff).findByText(/no Withdrawn event from this sale for your wallet/)).toBeTruthy();
    expect(within(ff).queryByTestId(`confirmed-${SALE_NEW.toLowerCase()}`)).toBeNull();
  });

  it("blocks withdrawals and explains why when the wallet is on the wrong network", async () => {
    const state = chain({
      balances: { [`${SALE_NEW}:${ARTIST}`.toLowerCase()]: ethers.parseEther("0.00975") },
      payouts: { [`${CLONE_NEW}:7`.toLowerCase()]: ARTIST, [`${CLONE_OLD}:9`.toLowerCase()]: ARTIST },
    });
    const wrong = { account: ARTIST, getProvider: () => ({ request: async (request) => (request.method === "eth_chainId" ? "0x1" : state.walletProvider.request(request)) }) };
    render(<StudioEarnings catalog={catalog()} wallet={wrong} readProvider={state.readProvider} />);
    expect((await screen.findByTestId("wrong-network")).textContent).toMatch(/Your wallet is on chain 1\. Switch to .* \(chain 43113\)/);
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }).disabled).toBe(true);
    fireEvent.click(within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" }));
    expect(state.log.some((entry) => entry.startsWith("send:"))).toBe(false);
  });

  it("offers no withdraw to a wallet that is not the payout wallet", async () => {
    setup({ account: OTHER_PAYOUT });
    await screen.findByTestId("earnings-total");
    expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0 AVAX");
    expect(screen.queryAllByRole("button", { name: /Withdraw/ })).toHaveLength(0);
    expect((await screen.findAllByText(/Only 0x284C…180a can withdraw this/)).length).toBeGreaterThan(0);
  });

  it("disables withdrawal when the sale is not the release's registered sale", async () => {
    const { log } = setup({ chainOptions: { bind: { releases: { [SALE_NEW.toLowerCase()]: CLONE_OLD } } } });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect((await within(ff).findByTestId(`unverified-${SALE_NEW.toLowerCase()}`)).textContent).toMatch(/could not be verified on-chain/);
    expect(within(ff).queryByRole("button", { name: /Withdraw/ })).toBeNull();
    expect(log.some((entry) => entry.startsWith("send:"))).toBe(false);
  });

  it("prefers the indexer's confirmed withdrawn figure and does not label it derived", async () => {
    const withIndexed = catalog();
    withIndexed.releaseBindings[0].artistEarnedWei = ethers.parseEther("0.03").toString();
    withIndexed.releaseBindings[0].artistWithdrawnWei = ethers.parseEther("0.02").toString();
    setup({ catalogValue: withIndexed });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    expect(within(ff).getByTestId(`withdrawn-${SALE_NEW.toLowerCase()}`).textContent).toBe("0.02 AVAX");
    expect(within(ff).queryByTestId(`withdrawn-derived-${SALE_NEW.toLowerCase()}`)).toBeNull();
    expect(within(ff).getByText("Already withdrawn")).toBeTruthy();
  });

  it("never lists the platform fee recipient: a connected platform wallet sees no artist earnings or withdraw", async () => {
    setup({ account: PLATFORM });
    await screen.findByTestId("earnings-total");
    await waitFor(() => expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0 AVAX"));
    expect(screen.queryAllByRole("button", { name: /Withdraw/ })).toHaveLength(0);
    expect(screen.queryByText(new RegExp(PLATFORM, "i"))).toBeNull();
    expect(screen.queryByText("Platform balance")).toBeNull();
    // The 0.00025 credited to the platform is excluded: "held" is only the artist payout's 0.00975.
    expect(screen.getByTestId("earnings-total").textContent).toBe("0.00975 AVAX");
  });

  it("sends exactly one withdraw() on a double click and does not count a pending transaction as withdrawn", async () => {
    const receiptDelay = { released: false };
    const withIndexed = catalog();
    withIndexed.releaseBindings[0].artistEarnedWei = ethers.parseEther("0.00975").toString();
    withIndexed.releaseBindings[0].artistWithdrawnWei = "0";
    const { log } = setup({ catalogValue: withIndexed, chainOptions: { receiptDelay } });
    const ff = await screen.findByRole("listitem", { name: "Earnings for Forgive & Forget 28" });
    const button = within(ff).getByRole("button", { name: "Withdraw from Forgive & Forget 28" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await within(ff).findByTestId(`submitted-${SALE_NEW.toLowerCase()}`);
    expect(log.filter((entry) => entry.startsWith("send:"))).toHaveLength(1);
    expect(within(ff).getByTestId(`withdrawn-${SALE_NEW.toLowerCase()}`).textContent).toBe("0 AVAX");
    expect(within(ff).queryByTestId(`confirmed-${SALE_NEW.toLowerCase()}`)).toBeNull();
    receiptDelay.released = true;
    await within(ff).findByTestId(`confirmed-${SALE_NEW.toLowerCase()}`, {}, { timeout: 8000 });
    expect(within(ff).getByTestId(`withdrawn-${SALE_NEW.toLowerCase()}`).textContent).toBe("0.00975 AVAX");
    expect(log.filter((entry) => entry.startsWith("send:"))).toHaveLength(1);
  }, 15000);

  describe("secondary-sale royalties", () => {
    const TOKEN_A = "11";
    const TOKEN_B = "12";
    const royalties = () => ({ ...catalog(), secondaryRoyalties: [
      { chainId: 43113, tokenContractAddress: ethers.getAddress(CLONE_NEW), tokenId: TOKEN_A, royaltyWei: ethers.parseEther("0.0025").toString(), sales: 1 },
      { chainId: 43113, tokenContractAddress: ethers.getAddress(CLONE_NEW), tokenId: TOKEN_B, royaltyWei: ethers.parseEther("0.005").toString(), sales: 2 },
    ] });
    const payouts = { [`${CLONE_NEW}:7`.toLowerCase()]: ARTIST, [`${CLONE_OLD}:9`.toLowerCase()]: ARTIST, [`${CLONE_NEW}:${TOKEN_A}`.toLowerCase()]: ARTIST, [`${CLONE_NEW}:${TOKEN_B}`.toLowerCase()]: OTHER_PAYOUT };

    it("counts only tokens whose live payout is the connected wallet, never claimable, never in the primary totals", async () => {
      setup({ catalogValue: royalties(), payouts });
      expect(await screen.findByTestId("royalties-earned")).toBeTruthy();
      await waitFor(() => expect(screen.getByTestId("royalties-earned").textContent).toBe("0.0025 AVAX"));
      expect(screen.getByTestId("royalties-claimable").textContent).toBe("0 AVAX");
      expect(screen.getByTestId(`royalty-${CLONE_NEW}-${TOKEN_A}`)).toBeTruthy();
      expect(screen.queryByTestId(`royalty-${CLONE_NEW}-${TOKEN_B}`)).toBeNull();
      expect(screen.getByTestId("royalty-note").textContent).toMatch(/nothing to claim or withdraw/);
      // Primary figures are untouched by royalties.
      expect(screen.getByTestId("earnings-total").textContent).toBe("0.00975 AVAX");
      expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0.00975 AVAX");
    });

    it("shows the other payout wallet its own royalties only", async () => {
      setup({ catalogValue: royalties(), payouts, account: OTHER_PAYOUT });
      await waitFor(() => expect(screen.getByTestId("royalties-earned").textContent).toBe("0.005 AVAX"));
      expect(screen.queryByTestId(`royalty-${CLONE_NEW}-${TOKEN_A}`)).toBeNull();
      expect(screen.getByTestId(`royalty-${CLONE_NEW}-${TOKEN_B}`)).toBeTruthy();
    });

    it("says so when no royalties are recorded", async () => {
      setup({ payouts });
      await waitFor(() => expect(screen.getByTestId("royalties-earned").textContent).toBe("0 AVAX"));
      expect(screen.getByText(/No resale royalties are recorded for this wallet yet/)).toBeTruthy();
    });
  });

  describe.skipIf(!haveSettledArtifact)("a settled sale attached to the same release", () => {
    const withSettled = () => ({
      ...catalog(),
      releaseSales: [
        { chainId: 43113, releaseContractAddress: ethers.getAddress(CLONE_NEW), primarySaleAddress: SALE_NEW, artistEarnedWei: ethers.parseEther("0.00975").toString(), artistWithdrawnWei: "0", sales: 1 },
        { chainId: 43113, releaseContractAddress: ethers.getAddress(CLONE_NEW), primarySaleAddress: SALE_SET, artistEarnedWei: ethers.parseEther("0.0195").toString(), artistWithdrawnWei: ethers.parseEther("0.01").toString(), sales: 2 },
      ],
    });
    const settledCode = () => ({ [SALE_SET.toLowerCase()]: settledRuntime({ release: CLONE_NEW, platform: PLATFORM }) });
    const settledBalances = { [`${SALE_SET}:${ARTIST}`.toLowerCase()]: ethers.parseEther("0.0095"), [`${SALE_SET}:${PLATFORM}`.toLowerCase()]: 0n };

    it("shows the legacy and settled sales as separate cards with their own figures and platform lines", async () => {
      setup({ catalogValue: withSettled(), balances: settledBalances, chainOptions: { settled: { codes: settledCode() } } });
      const settledKey = SALE_SET.toLowerCase();
      const legacyKey = SALE_NEW.toLowerCase();
      expect((await screen.findByTestId(`earned-${settledKey}`)).textContent).toBe("0.0195 AVAX");
      expect(screen.getByTestId(`withdrawn-${settledKey}`).textContent).toBe("0.01 AVAX");
      expect(screen.getByTestId(`earned-${legacyKey}`).textContent).toBe("0.00975 AVAX");
      expect(screen.getByTestId(`withdrawn-${legacyKey}`).textContent).toBe("0 AVAX");
      expect(screen.getByTestId(`platform-line-${settledKey}`).textContent).toBe("Platform fee is paid to the platform wallet automatically in the same transaction.");
      expect(screen.getByTestId(`platform-line-${legacyKey}`).textContent).toBe("The platform fee credit in this contract belongs to the platform wallet; it is not part of your balance.");
      expect(screen.getByText("Settled sale")).toBeTruthy();
      // Both claimable balances count toward this wallet's withdrawable total, and nothing else does.
      await waitFor(() => expect(screen.getByTestId("earnings-withdrawable").textContent).toBe("0.01925 AVAX"));
      expect(screen.queryAllByRole("button", { name: /Withdraw from/ }).filter((button) => !button.disabled)).toHaveLength(2);
    });

    const refused = async (chainOptions, pattern) => {
      const { log } = setup({ catalogValue: withSettled(), balances: settledBalances, chainOptions });
      const warning = await screen.findByTestId(`unverified-${SALE_SET.toLowerCase()}`);
      expect(warning.textContent).toMatch(pattern);
      expect(within(warning.closest("li")).queryAllByRole("button", { name: /Withdraw/ })).toHaveLength(0);
      expect(log.some((entry) => entry.startsWith("send:"))).toBe(false);
    };
    it("refuses a settled sale that pays another recipient", () => refused({ settled: { codes: settledCode(), recipient: { [SALE_SET.toLowerCase()]: ROGUE } } }, /not the platform wallet/));
    it("refuses a settled sale the release has not authorized to mint", () => refused({ settled: { codes: settledCode(), issuer: { [SALE_SET.toLowerCase()]: false } } }, /no ISSUER_ROLE/));
    it("refuses a settled sale that has an owner", () => refused({ settled: { codes: settledCode(), owner: { [SALE_SET.toLowerCase()]: ROGUE } } }, /has an owner/));
    it("refuses a settled sale with a different fee", () => refused({ settled: { codes: settledCode(), fee: { [SALE_SET.toLowerCase()]: 0n } } }, /0 basis points, not 250/));
    it("refuses unknown code that the factory did not register", () => refused({ settled: {} }, /not the reviewed settled sale/));
  });
});
