/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PurchasePanel } from "./PurchasePanel.jsx";
import { PURCHASE_STATE } from "../lib/marketplace.js";
import { WalletCtx } from "../lib/wallet-context.js";

const mocks = vi.hoisted(() => ({
  address: "0x982b28352fd612fe934c5e1ad8fea399689190d2",
  submitPurchase: vi.fn(),
  createIntent: vi.fn(),
  recordSubmission: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeListing: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
}));

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.address, chainId: 43113, enabled: true }),
    submitPurchase: mocks.submitPurchase,
  };
});

vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAuthoritativePurchaseIntent: mocks.createIntent,
    recordAuthoritativeTransactionSubmission: mocks.recordSubmission,
    fetchIndexedListings: mocks.fetchIndexedListings,
    fetchAuthoritativeListing: mocks.fetchAuthoritativeListing,
    fetchAuthoritativeMarketplaceTransaction: mocks.fetchAuthoritativeTransaction,
  };
});

const buyer = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const indexedMarketplace = "0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b";
const tokenContract = "0x82b26da27136935454bdf1e40801190b521b82e5";
const transactionHash = `0x${"a".repeat(64)}`;
const edition = { id: "edition-1", title: "Test edition", chainId: 43113, contractAddress: tokenContract, tokenIds: ["42"] };
const activeListing = {
  id: "listing-uuid",
  listingId: "1",
  chain: 43113,
  marketplace: indexedMarketplace,
  tokenContract,
  contract: tokenContract,
  tokenId: "42",
  amount: "1",
  price: "10000000000000000",
  status: "ACTIVE",
  authority: "INDEXED",
};
const soldListing = { ...activeListing, amount: "0", status: "SOLD" };
const indexedTransaction = (overrides = {}) => ({
  chain_id: "43113",
  transaction_hash: transactionHash,
  transaction_type: "PURCHASE",
  status: "SUBMITTED",
  from_wallet: buyer,
  to_address: indexedMarketplace,
  value_wei: "10000000000000000",
  purchases: [],
  ...overrides,
});

const flushPromises = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function setup() {
  const wallet = {
    account: buyer,
    authenticated: true,
    authHeaders: { authorization: "Bearer test" },
    chainId: 43113,
    connected: true,
    getProvider: () => ({ request: vi.fn() }),
    refreshOwnership: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(<WalletCtx.Provider value={wallet}><PurchasePanel edition={edition} /></WalletCtx.Provider>);
  return { ...view, wallet };
}

async function clickCollect() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "COLLECT EDITION" }));
    await flushPromises();
  });
}

function progressStep(label, container) {
  return [...container.querySelectorAll('[aria-live="polite"] span')].find((element) => element.textContent.trim().endsWith(label));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.createIntent.mockResolvedValue({ state: "PENDING" });
  mocks.recordSubmission.mockResolvedValue({ state: "SUBMITTED" });
  mocks.fetchIndexedListings.mockResolvedValue([activeListing]);
  mocks.fetchAuthoritativeListing.mockResolvedValue(soldListing);
  mocks.fetchAuthoritativeTransaction.mockResolvedValue(indexedTransaction());
  mocks.submitPurchase.mockImplementation(async ({ onState }) => {
    onState(PURCHASE_STATE.WALLET_CONFIRMATION);
    onState(PURCHASE_STATE.SUBMITTED);
    onState(PURCHASE_STATE.PENDING);
    onState(PURCHASE_STATE.OBSERVED);
    return { txHash: transactionHash };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("PurchasePanel authoritative settlement polling", () => {
  it("enters PENDING, polls without remount, confirms from the index, refreshes data, and stops polling", async () => {
    mocks.fetchIndexedListings.mockResolvedValueOnce([activeListing]).mockResolvedValueOnce([]);
    mocks.fetchAuthoritativeTransaction
      .mockResolvedValueOnce(indexedTransaction())
      .mockResolvedValueOnce(indexedTransaction({
        status: "RECONCILED",
        purchases: [{ listingId: activeListing.id, quantity: 1, status: "RECONCILED" }],
      }));
    const { container, wallet } = setup();
    await act(async () => { await flushPromises(); });
    await clickCollect();

    expect(mocks.createIntent).toHaveBeenCalledOnce();
    expect(mocks.createIntent.mock.calls[0][0].marketplaceAddress).toBe(indexedMarketplace);
    expect(mocks.submitPurchase).toHaveBeenCalledOnce();
    expect(mocks.submitPurchase.mock.calls[0][0].marketplace).toBe(indexedMarketplace);
    expect(mocks.recordSubmission).toHaveBeenCalledOnce();
    expect(mocks.recordSubmission.mock.calls[0][0].marketplaceAddress).toBe(indexedMarketplace);
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledOnce();
    expect(progressStep("PENDING", container).style.color).toBe("var(--vc-crimson)");
    expect(progressStep("CONFIRMED", container).style.color).not.toBe("var(--vc-crimson)");
    expect(screen.getByText(/Waiting for the authoritative index/)).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); await flushPromises(); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledTimes(2);
    expect(progressStep("CONFIRMED", container).style.color).toBe("var(--vc-crimson)");
    expect(screen.getByText(/Purchase confirmed by the marketplace index/)).not.toBeNull();
    expect(screen.getByText(/AVAILABLE 0/)).not.toBeNull();
    expect(screen.getByText("No active indexed listings for this edition.")).not.toBeNull();
    expect(mocks.fetchAuthoritativeListing).toHaveBeenCalledOnce();
    expect(wallet.refreshOwnership).toHaveBeenCalledWith(buyer);

    await act(async () => { await vi.advanceTimersByTimeAsync(60000); await flushPromises(); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not confirm from the wallet receipt alone while the backend remains pending", async () => {
    mocks.fetchAuthoritativeTransaction.mockResolvedValue(indexedTransaction({ status: "PENDING", purchases: [] }));
    const { container } = setup();
    await act(async () => { await flushPromises(); });
    await clickCollect();

    expect(progressStep("PENDING", container).style.color).toBe("var(--vc-crimson)");
    expect(progressStep("CONFIRMED", container).style.color).not.toBe("var(--vc-crimson)");
    expect(screen.getByText(/Waiting for the authoritative index/)).not.toBeNull();
  });

  it("stops polling on an authoritative terminal failure and never shows CONFIRMED", async () => {
    mocks.fetchAuthoritativeTransaction.mockResolvedValue(indexedTransaction({ status: "REVERTED", purchases: [] }));
    const { container } = setup();
    await act(async () => { await flushPromises(); });
    await clickCollect();

    expect(screen.getByText(/REVERTED: The purchase transaction reverted on-chain/)).not.toBeNull();
    expect(progressStep("CONFIRMED", container).style.color).not.toBe("var(--vc-crimson)");
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); await flushPromises(); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledOnce();
  });

  it("clears the scheduled polling timer on unmount", async () => {
    mocks.fetchAuthoritativeTransaction.mockResolvedValue(indexedTransaction());
    const view = setup();
    await act(async () => { await flushPromises(); });
    await clickCollect();
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledOnce();

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight status request on unmount", async () => {
    let requestSignal;
    let call = 0;
    mocks.fetchAuthoritativeTransaction.mockImplementation(({ signal }) => {
      call += 1;
      requestSignal = signal;
      if (call === 1) return Promise.resolve(indexedTransaction());
      return new Promise(() => {});
    });
    const view = setup();
    await act(async () => { await flushPromises(); });
    await clickCollect();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); await flushPromises(); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledTimes(2);
    expect(requestSignal.aborted).toBe(false);

    view.unmount();
    expect(requestSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalledTimes(2);
  });
});
