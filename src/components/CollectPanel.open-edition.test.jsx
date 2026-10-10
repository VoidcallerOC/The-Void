// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CollectPanel } from "./CollectPanel.jsx";
import { WalletCtx } from "../lib/wallet-context.js";

const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
  paused: vi.fn(),
  primarySale: vi.fn(),
  collect: vi.fn(),
}));

vi.mock("../lib/release-asset.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleaseBalance: mocks.balance, readReleasePaused: mocks.paused };
});

vi.mock("../lib/primary-sale.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleasePrimarySale: mocks.primarySale, collectReleaseEdition: mocks.collect };
});

// forgive-forget-28 (Fuji, 2026-10-10): open edition on its own factory release contract and sale.
const RELEASE_CONTRACT = "0x4b2790791E2Ac123Cb012D33CC8F1ECbdc9b9bB0";
const SALE = "0xfb13eed6d3f1457937d845A06f33f2BC0c407Cc3";
const TOKEN_ID = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_S = BigInt(Math.floor(NOW / 1000));
const END = BigInt(Math.floor(Date.UTC(2026, 9, 31, 23, 59, 0) / 1000));

const edition = {
  id: "e-factory",
  releaseId: "r-factory",
  title: "forgive-forget-28",
  supply: "0",
  status: "available",
  chainId: 43113,
  contractAddress: RELEASE_CONTRACT,
  primarySaleAddress: SALE,
  tokenIds: [TOKEN_ID],
  includes: [],
};
const release = { id: "r-factory", title: "forgive-forget-28" };

function chainSale(overrides = {}) {
  const sale = { priceWei: 10n ** 16n, maxSupply: 0n, sold: 1n, perWalletLimit: 1n, startTime: 0n, endTime: END, paused: false, configured: true, purchased: 0n, ...overrides };
  const unlimited = sale.maxSupply === 0n;
  return { ...sale, unlimited, remaining: unlimited ? null : (sale.maxSupply > sale.sold ? sale.maxSupply - sale.sold : 0n), address: SALE };
}

const connected = {
  connected: true,
  authenticated: true,
  account: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  ownershipRecords: [],
  getProvider: () => ({ request: vi.fn() }),
  refreshOwnership: vi.fn(),
};

async function renderPanel({ wallet = connected, item = edition } = {}) {
  render(
    <MemoryRouter>
      <WalletCtx.Provider value={wallet}>
        <CollectPanel edition={item} release={release} variant="hero" />
      </WalletCtx.Provider>
    </MemoryRouter>,
  );
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.balance.mockResolvedValue(0n);
  mocks.paused.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CollectPanel open edition on a factory release", () => {
  it("open edition + live sale: enabled Collect that purchases from the edition's own sale and token", async () => {
    mocks.primarySale.mockResolvedValue(chainSale());
    mocks.collect.mockResolvedValue({ hash: "0x7aff87dd4dc89a38013501767fd94418fb0403bde620547454ac342ec25ad4dd" });
    await renderPanel();

    const button = screen.getByRole("button", { name: "Collect · 0.01 AVAX" });
    expect(button.disabled).toBe(false);
    expect(document.body.textContent).toContain("Open edition · until Oct 31, 2026, 11:59 PM UTC");
    expect(document.body.textContent).not.toMatch(/Not yet available|Supply is zero|No pressings remain/i);

    mocks.balance.mockResolvedValue(1n);
    await act(async () => { fireEvent.click(button); });
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    const [{ releaseAsset, priceWei, qty }] = mocks.collect.mock.calls[0];
    expect(releaseAsset).toMatchObject({ chainId: 43113, releaseContractAddress: RELEASE_CONTRACT, primarySaleAddress: SALE, tokenId: TOKEN_ID });
    expect(priceWei).toBe(10n ** 16n);
    expect(qty).toBe(1);
  });

  it("open edition after its end time: disabled 'Sale ended'", async () => {
    mocks.primarySale.mockResolvedValue(chainSale({ endTime: NOW_S - 60n }));
    await renderPanel();
    const button = screen.getByRole("button", { name: "Sale ended" });
    expect(button.disabled).toBe(true);
  });

  it("capped edition sold out: disabled 'Sold out'", async () => {
    mocks.primarySale.mockResolvedValue(chainSale({ maxSupply: 25n, sold: 25n }));
    await renderPanel({ item: { ...edition, supply: "25" } });
    const button = screen.getByRole("button", { name: "Sold out" });
    expect(button.disabled).toBe(true);
  });

  it("sale not started: disabled 'Starts <time>'", async () => {
    mocks.primarySale.mockResolvedValue(chainSale({ startTime: BigInt(Math.floor(Date.UTC(2026, 9, 12, 18, 0, 0) / 1000)) }));
    await renderPanel();
    const button = screen.getByRole("button", { name: "Starts Oct 12, 2026, 6:00 PM UTC" });
    expect(button.disabled).toBe(true);
  });

  it("without a wallet, the API's live sale state shows the Collect action instead of 'Not yet available'", async () => {
    mocks.primarySale.mockResolvedValue(null);
    const item = { ...edition, saleAvailability: "open", primarySale: { configured: true, paused: false, priceWei: "10000000000000000", maxSupply: "0", sold: "1", perWalletLimit: "1", startTime: "0", endTime: String(END) } };
    await renderPanel({ wallet: { connected: false, account: null, ownershipRecords: [] }, item });
    expect(screen.getByRole("button", { name: "Collect · 0.01 AVAX" })).toBeTruthy();
    expect(document.body.textContent).toContain("Open edition · until Oct 31, 2026, 11:59 PM UTC");
    expect(document.body.textContent).not.toMatch(/Not yet available|Supply is zero/i);
    // The public Fuji RPC read targets the edition's own sale and token.
    expect(mocks.primarySale).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ primarySaleAddress: SALE, tokenId: TOKEN_ID }), null);
  });
});
