// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Interface } from "ethers";
import { MemoryRouter } from "react-router-dom";
import { ListingPanel } from "./ListingPanel.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { FUJI_RELEASE_PER_CONTRACT } from "../../config/release-network.js";

const mocks = vi.hoisted(() => ({
  market: "0x228734C7a6325f7B6F570EBCAc80239495fdedf0",
  seller: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  contract: "0x82b26da27136935454bdf1e40801190b521b82e5",
  sale: "0x8b743f91940a267899986d2e99b4375e1d87c321",
  transactionHash: `0x${"b".repeat(64)}`,
  readContext: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeListing: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
  recordSubmission: vi.fn(),
  submitApproval: vi.fn(),
  submitListing: vi.fn(),
  submitCancel: vi.fn(),
}));

vi.mock("../lib/secondary-listing.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleaseListingContext: mocks.readContext };
});

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.market, chainId: 43113, enabled: true }),
    submitApproval: mocks.submitApproval,
    submitListing: mocks.submitListing,
    submitCancel: mocks.submitCancel,
  };
});

vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchIndexedListings: mocks.fetchIndexedListings,
    fetchAuthoritativeListing: mocks.fetchAuthoritativeListing,
    fetchAuthoritativeMarketplaceTransaction: mocks.fetchAuthoritativeTransaction,
    recordAuthoritativeTransactionSubmission: mocks.recordSubmission,
  };
});

const edition = {
  id: "factory-release-edition",
  title: "Factory release edition",
  chainId: 43113,
  contractAddress: mocks.contract,
  primarySaleAddress: mocks.sale,
  tokenIds: ["987654321012345678901234567890123456789"],
};
const tokenId = edition.tokenIds[0];
const listingInterface = new Interface([
  "event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt)",
]);
const cancellationInterface = new Interface(["event ListingCancelled(uint256 indexed listingId)"]);
const activeListing = {
  id: "indexed-listing-uuid",
  listingId: "7",
  seller: mocks.seller,
  chain: 43113,
  marketplace: mocks.market,
  tokenContract: mocks.contract,
  contract: mocks.contract,
  tokenId,
  amount: "1",
  initialAmount: "1",
  price: "1000000000000000000",
  status: "ACTIVE",
  authority: "INDEXED",
};
const confirmedTransaction = {
  chain_id: "43113",
  transaction_hash: mocks.transactionHash,
  transaction_type: "LISTING_CREATE",
  status: "CONFIRMED",
  from_wallet: mocks.seller,
  to_address: mocks.market,
};
const flushPromises = async () => {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};

function listingReceipt({ id = "7", seller = mocks.seller, contract = mocks.contract, token = tokenId, amount = "1", price = "1000000000000000000", expiry = 0 } = {}) {
  const event = listingInterface.encodeEventLog(listingInterface.getEvent("ListingCreated"), [id, seller, contract, token, amount, price, expiry]);
  return {
    status: "0x1",
    transactionHash: mocks.transactionHash,
    from: mocks.seller,
    to: mocks.market,
    logs: [{ address: mocks.market, ...event }],
  };
}

function cancellationReceipt(id = "7") {
  const event = cancellationInterface.encodeEventLog(cancellationInterface.getEvent("ListingCancelled"), [id]);
  return {
    status: "0x1",
    transactionHash: `0x${"c".repeat(64)}`,
    from: mocks.seller,
    to: mocks.market,
    logs: [{ address: mocks.market, ...event }],
  };
}

function setup({ walletOverrides = {} } = {}) {
  const wallet = {
    account: mocks.seller,
    authenticated: true,
    authHeaders: { authorization: "Bearer test" },
    chainId: 43113,
    connected: true,
    provider: { request: vi.fn() },
    getProvider: () => ({ request: vi.fn() }),
    authenticate: vi.fn().mockResolvedValue({ ok: true }),
    ...walletOverrides,
  };
  const view = render(<MemoryRouter><WalletCtx.Provider value={wallet}><ListingPanel edition={edition} /></WalletCtx.Provider></MemoryRouter>);
  return { ...view, wallet };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.readContext.mockResolvedValue({
    balance: "2",
    approved: true,
    marketplaceFeeBps: "250",
    royaltyBps: "250",
    factoryAddress: FUJI_RELEASE_PER_CONTRACT.factoryAddress,
    marketplaceAddress: mocks.market,
    releaseContractAddress: mocks.contract,
    tokenId,
    seller: mocks.seller,
    chainId: 43113,
  });
  mocks.fetchIndexedListings.mockResolvedValue([]);
  mocks.fetchAuthoritativeListing.mockResolvedValue(activeListing);
  mocks.fetchAuthoritativeTransaction.mockResolvedValue(confirmedTransaction);
  mocks.recordSubmission.mockResolvedValue({ state: "PENDING" });
  mocks.submitApproval.mockResolvedValue({ status: "0x1" });
  mocks.submitListing.mockImplementation(async () => listingReceipt());
  mocks.submitCancel.mockImplementation(async () => cancellationReceipt());
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function makeReady() {
  await act(async () => { await flushPromises(); });
  expect(screen.getByRole("button", { name: "REVIEW LISTING" })).toBeTruthy();
}

async function reviewListing() {
  fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
  await act(async () => { await flushPromises(); });
  expect(screen.getByRole("group", { name: "Listing review" })).toBeTruthy();
}

describe("release-per-contract secondary listing flow", () => {
  it("requires the on-chain review, verifies the exact ListingCreated event, and shows listed only after the index confirms it", async () => {
    setup();
    await makeReady();
    await reviewListing();

    expect(screen.getByText(/MARKETPLACE FEE · 2.5%/)).toBeTruthy();
    expect(screen.getByText(/ARTIST ROYALTY · 2.5%/)).toBeTruthy();
    expect(screen.getByText(/ESTIMATED SELLER PROCEEDS · 95%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(mocks.submitApproval).not.toHaveBeenCalled();
    expect(mocks.submitListing).toHaveBeenCalledOnce();
    expect(mocks.submitListing.mock.calls[0][0]).toMatchObject({ tokenId, amount: "1", price: "1000000000000000000" });
    expect(mocks.recordSubmission).toHaveBeenCalledOnce();
    expect(screen.getByText("LISTED · INDEX CONFIRMED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "CANCEL LISTING" })).toBeTruthy();
  });

  it("does not call the edition listed until the authoritative index confirms the transaction", async () => {
    mocks.fetchAuthoritativeTransaction.mockResolvedValue({ ...confirmedTransaction, status: "PENDING" });
    setup();
    await makeReady();
    await reviewListing();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(screen.getByText(/PENDING INDEX CONFIRMATION/)).toBeTruthy();
    expect(screen.queryByText("LISTED · INDEX CONFIRMED")).toBeNull();
    expect(mocks.fetchAuthoritativeTransaction).toHaveBeenCalled();
  });

  it("does not block this owner because another seller lists the same ERC-1155 token", async () => {
    mocks.fetchIndexedListings.mockResolvedValue([{ ...activeListing, seller: "0x2222222222222222222222222222222222222222" }]);
    setup();
    await makeReady();

    expect(mocks.fetchIndexedListings).toHaveBeenCalledWith(expect.objectContaining({ sellerWallet: mocks.seller, tokenContractAddress: mocks.contract, tokenId }));
    expect(screen.getByRole("button", { name: "REVIEW LISTING" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "CANCEL LISTING" })).toBeNull();
  });

  it("keeps the seller’s cancellation control when the listed balance has since reached zero", async () => {
    mocks.readContext.mockResolvedValue({ balance: "0", approved: false, marketplaceFeeBps: "250", royaltyBps: "250" });
    mocks.fetchIndexedListings.mockResolvedValue([activeListing]);
    setup();
    await act(async () => { await flushPromises(); });

    expect(screen.getByText("LISTED · INDEX CONFIRMED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "CANCEL LISTING" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
    expect(screen.getByText(/already listed/i)).toBeTruthy();
  });

  it("denies a new listing when ownership is verified as zero and no owner listing exists", async () => {
    mocks.readContext.mockResolvedValue({ balance: "0", approved: false, marketplaceFeeBps: "250", royaltyBps: "250" });
    setup();
    await act(async () => { await flushPromises(); });

    expect(screen.getByText("This wallet does not currently own this edition. New listings are unavailable. Ownership is read directly from this edition’s Fuji release contract. A failed chain read is never treated as a zero balance.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });

  it("requests marketplace approval first when the on-chain operator approval is absent", async () => {
    mocks.readContext.mockResolvedValueOnce({ balance: "2", approved: false, marketplaceFeeBps: "250", royaltyBps: "250" })
      .mockResolvedValueOnce({ balance: "2", approved: false, marketplaceFeeBps: "250", royaltyBps: "250" })
      .mockResolvedValue({ balance: "2", approved: true, marketplaceFeeBps: "250", royaltyBps: "250" });
    setup();
    await makeReady();
    await reviewListing();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(mocks.submitApproval).toHaveBeenCalledOnce();
    expect(mocks.submitListing).toHaveBeenCalledOnce();
  });

  it("cancels only the exact indexed seller listing and returns to the form after indexed cancellation", async () => {
    const cancelledListing = { ...activeListing, status: "CANCELLED" };
    const cancelledTransaction = {
      chain_id: "43113",
      transaction_hash: `0x${"c".repeat(64)}`,
      transaction_type: "LISTING_CANCEL",
      status: "CONFIRMED",
      from_wallet: mocks.seller,
      to_address: mocks.market,
    };
    mocks.fetchAuthoritativeListing
      .mockResolvedValueOnce(activeListing)
      .mockResolvedValueOnce(activeListing)
      .mockResolvedValue(cancelledListing);
    mocks.fetchAuthoritativeTransaction
      .mockResolvedValueOnce(confirmedTransaction)
      .mockResolvedValue(cancelledTransaction);
    setup();
    await makeReady();
    await reviewListing();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });
    expect(screen.getByText("LISTED · INDEX CONFIRMED")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "CANCEL LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(mocks.submitCancel).toHaveBeenCalledOnce();
    expect(mocks.recordSubmission).toHaveBeenCalledTimes(2);
    expect(mocks.recordSubmission.mock.calls.at(-1)[0]).toMatchObject({ type: "LISTING_CANCEL" });
    expect(screen.getByText("The authoritative marketplace index confirmed cancellation.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "REVIEW LISTING" })).toBeTruthy();
  });

  it("shows the wrong-network state and sends no reads or transactions on mainnet", async () => {
    setup({ walletOverrides: { chainId: 43114 } });
    await act(async () => { await flushPromises(); });

    expect(screen.getByText("Switch to Avalanche Fuji (43113) before listing this release.")).toBeTruthy();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(mocks.submitListing).not.toHaveBeenCalled();
  });

  it("stops when a successful wallet receipt does not match the exact release token", async () => {
    mocks.submitListing.mockImplementation(async () => listingReceipt({ token: "999" }));
    setup();
    await makeReady();
    await reviewListing();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(screen.getByText(/Listing receipt verification failed for tokenId/)).toBeTruthy();
    expect(screen.getByText(/Do not resubmit/)).toBeTruthy();
    expect(mocks.recordSubmission).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });

  it("does not register or retry a verified event receipt that lacks a usable transaction hash", async () => {
    const receipt = listingReceipt();
    delete receipt.transactionHash;
    mocks.submitListing.mockResolvedValue(receipt);
    setup();
    await makeReady();
    await reviewListing();
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(screen.getByText(/did not include a usable transaction hash/i)).toBeTruthy();
    expect(screen.getByText(/Do not resubmit/)).toBeTruthy();
    expect(mocks.recordSubmission).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });
});
