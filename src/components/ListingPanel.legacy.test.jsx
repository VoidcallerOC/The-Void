// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Interface } from "ethers";
import { MemoryRouter } from "react-router-dom";
import { ListingPanel } from "./ListingPanel.jsx";
import { WalletCtx } from "../lib/wallet-context.js";

const mocks = vi.hoisted(() => ({
  legacyMarket: "0x00000000000000000000000000000000000a11ce",
  v4Market: "0x42B740aA92A6F48380F6D97AD91e332a7921a744",
  genesis: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
  seller: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  transactionHash: `0x${"b".repeat(64)}`,
  readContext: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeListing: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
  recordSubmission: vi.fn(),
  submitApproval: vi.fn(),
  submitListing: vi.fn(),
}));

// An active legacy-collection deployment on the test network (Fuji, 43113) so the real panel logic runs end to end.
vi.mock("../../config/legacy-collection-marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  const active = Object.freeze({
    ...actual.LEGACY_COLLECTION_MARKETPLACE,
    chainId: 43113,
    deployed: true,
    marketplaceAddress: mocks.legacyMarket,
    deploymentBlock: 1,
    ownerAddress: "0x1111111111111111111111111111111111111111",
  });
  return {
    ...actual,
    LEGACY_COLLECTION_MARKETPLACE: active,
    isLegacyMarketplace: (address, config = active) => actual.isLegacyMarketplace(address, config),
    legacyCollectionFor: (asset, config = active) => actual.legacyCollectionFor(asset, config),
    legacyMarketplaceActive: (config = active) => actual.legacyMarketplaceActive(config),
  };
});

vi.mock("../lib/secondary-listing.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleaseListingContext: mocks.readContext };
});

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.v4Market, chainId: 43113, enabled: true }),
    submitApproval: mocks.submitApproval,
    submitListing: mocks.submitListing,
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

const edition = { id: "genesis-0", title: "Enough", chainId: 43113, contractAddress: mocks.genesis.toLowerCase(), tokenIds: ["0"] };
const listingInterface = new Interface(["event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt)"]);
const flushPromises = async () => { for (let index = 0; index < 16; index += 1) await Promise.resolve(); };
const contextFor = (royaltyBps) => ({ balance: "2", approved: true, marketplaceFeeBps: "250", royaltyBps, factoryAddress: null, marketplaceAddress: mocks.legacyMarket, releaseContractAddress: mocks.genesis, tokenId: "0", seller: mocks.seller, chainId: 43113 });

function setup() {
  const wallet = {
    account: mocks.seller, authenticated: true, authHeaders: { authorization: "Bearer test" }, chainId: 43113, connected: true,
    provider: { request: vi.fn() }, getProvider: () => ({ request: vi.fn() }), authenticate: vi.fn().mockResolvedValue({ ok: true }),
  };
  return render(<MemoryRouter><WalletCtx.Provider value={wallet}><ListingPanel edition={edition} /></WalletCtx.Provider></MemoryRouter>);
}

async function enterPrice(price) {
  await act(async () => { await flushPromises(); });
  fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: price } });
  fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
  await act(async () => { await flushPromises(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.readContext.mockResolvedValue(contextFor("500"));
  mocks.fetchIndexedListings.mockResolvedValue([]);
  mocks.recordSubmission.mockResolvedValue({ state: "PENDING" });
  mocks.fetchAuthoritativeTransaction.mockResolvedValue({ chain_id: "43113", transaction_hash: mocks.transactionHash, transaction_type: "LISTING_CREATE", status: "PENDING", from_wallet: mocks.seller, to_address: mocks.legacyMarket });
  mocks.submitListing.mockImplementation(async () => {
    const event = listingInterface.encodeEventLog(listingInterface.getEvent("ListingCreated"), ["7", mocks.seller, mocks.genesis, "0", "1", "1000000000000000000", 0]);
    return { status: "0x1", transactionHash: mocks.transactionHash, from: mocks.seller, to: mocks.legacyMarket, logs: [{ address: mocks.legacyMarket, ...event }] };
  });
});

afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Genesis listing on the legacy marketplace: the seller's minimum payout", () => {
  it("shows the exact minimum the seller accepts, explains what happens if the royalty rises, and signs exactly that floor", async () => {
    setup();
    await enterPrice("1");

    expect(screen.getByRole("group", { name: "Listing review" })).toBeTruthy();
    expect(screen.getByText(/MARKETPLACE FEE · 2.5%/)).toBeTruthy();
    expect(screen.getByText(/ARTIST ROYALTY · 5%/)).toBeTruthy();
    expect(screen.getByText(/ESTIMATED SELLER PROCEEDS · 92.5%/)).toBeTruthy();
    expect(screen.getByText("MINIMUM YOU WILL ACCEPT")).toBeTruthy();
    const note = screen.getByRole("note");
    expect(note.textContent).toMatch(/never receive less than 0\.925 AVAX per edition/i);
    expect(note.textContent).toMatch(/no tolerance added/i);
    expect(note.textContent).toMatch(/purchase fails and nothing moves/i);

    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(mocks.submitListing).toHaveBeenCalledOnce();
    expect(mocks.submitListing.mock.calls[0][0]).toMatchObject({ marketplace: mocks.legacyMarket, tokenId: "0", price: "1000000000000000000", minSellerProceedsPerUnit: "925000000000000000" });
  });

  it("refuses to sign anything if the royalty changed between review and confirmation", async () => {
    setup();
    await enterPrice("1");
    mocks.readContext.mockResolvedValue(contextFor("700")); // collection admin raised the royalty while the seller was reviewing
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await act(async () => { await flushPromises(); });

    expect(mocks.submitListing).not.toHaveBeenCalled();
    expect(screen.getByText(/royalty changed from 5% to 7% since you reviewed this listing\. Nothing was sent/)).toBeTruthy();
  });

  it("refuses a price so low that no protective minimum exists, before anything can be sent", async () => {
    setup();
    await enterPrice("0.000000000000000001"); // 1 wei: the exact-rate share rounds to 0
    expect(screen.getByText(/too low to set a protective minimum payout/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Listing review" })).toBeNull();
    expect(mocks.submitListing).not.toHaveBeenCalled();
  });
});
