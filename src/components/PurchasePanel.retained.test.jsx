/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// After the launch switch the manifest's active unified marketplace is new, and 0x75964 is retained for the listings it
// already holds (Genesis token 0 today). Its listing stays visible and is bought on 0x75964 itself. Nothing is broadcast.
const mocks = vi.hoisted(() => ({
  oldMarket: "0x75964C44cA586b13e98e7c30E74d2B4114f65b06",
  newMarket: "0x0F5930113Ec750d867741E05F302053472115eb2",
  genesis: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
  submitPurchase: vi.fn(),
  createIntent: vi.fn(),
  recordSubmission: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
}));

vi.mock("../../config/unified-marketplace.json", async (importOriginal) => {
  const actual = (await importOriginal()).default;
  return { default: { ...actual, marketplaceAddress: mocks.newMarket, deploymentBlock: 98400000, releaseFactoryAddress: "0xEa0c345cE84025b4e8462d145100dce1848254B4", retainedMarketplaces: [{ marketplaceAddress: mocks.oldMarket, deploymentBlock: 98161532, releaseFactoryAddress: "0xE744D58fA8138042f5f00a28d39f89081539C19B", legacyReleaseFactoryAddress: "0x262B774cf9a1949170B58E2d57F6189980FE757b" }] } };
});
vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.newMarket, chainId: 43114, enabled: true }), submitPurchase: mocks.submitPurchase };
});
vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createAuthoritativePurchaseIntent: mocks.createIntent, recordAuthoritativeTransactionSubmission: mocks.recordSubmission, fetchIndexedListings: mocks.fetchIndexedListings, fetchAuthoritativeMarketplaceTransaction: mocks.fetchAuthoritativeTransaction };
});

const { PurchasePanel } = await import("./PurchasePanel.jsx");
const { WalletCtx } = await import("../lib/wallet-context.js");

const buyer = "0x00000000000000000000000000000000000b0b02";
const genesisEdition = { id: "voidcaller-chapter-i", title: "Voidcaller Genesis", chainId: 43114, contractAddress: mocks.genesis, tokenIds: [0, 1, 2, 3] };
const retainedListing = { id: "listing-old-1", listingId: "1", chain: 43114, marketplace: mocks.oldMarket.toLowerCase(), tokenContract: mocks.genesis.toLowerCase(), contract: mocks.genesis.toLowerCase(), tokenId: "0", amount: "1", price: "250000000000000000", status: "ACTIVE", authority: "INDEXED" };
const flush = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchIndexedListings.mockImplementation(async ({ marketplaceAddress }) => (marketplaceAddress.toLowerCase() === mocks.oldMarket.toLowerCase() ? [retainedListing] : []));
  mocks.createIntent.mockResolvedValue({ state: "PENDING" });
  mocks.recordSubmission.mockResolvedValue({ state: "SUBMITTED" });
  mocks.fetchAuthoritativeTransaction.mockResolvedValue(null);
  mocks.submitPurchase.mockResolvedValue({ txHash: `0x${"c".repeat(64)}` });
});
afterEach(() => cleanup());

describe("a listing on a retained unified marketplace", () => {
  it("is shown alongside the active marketplace's and bought on its own marketplace", async () => {
    const wallet = { account: buyer, authenticated: true, authHeaders: {}, chainId: 43114, connected: true, getProvider: () => ({ request: vi.fn() }), refreshOwnership: vi.fn() };
    render(<WalletCtx.Provider value={wallet}><PurchasePanel edition={genesisEdition} /></WalletCtx.Provider>);
    await act(flush);
    const searched = mocks.fetchIndexedListings.mock.calls.map(([args]) => args.marketplaceAddress.toLowerCase());
    expect(searched).toEqual([mocks.newMarket.toLowerCase(), mocks.oldMarket.toLowerCase()]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "COLLECT EDITION" })); await flush(); });
    expect(mocks.createIntent).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddress: mocks.oldMarket }));
    const purchase = mocks.submitPurchase.mock.calls[0][0];
    expect(purchase.marketplace).toBe(mocks.oldMarket);
    expect(purchase.canonical.address).toBe(mocks.oldMarket);
    expect(purchase.listing).toMatchObject({ listingId: "1", tokenId: "0" });
  });
  it("renders one card when a server that ignores the marketplace filter returns the same listing for both marketplaces", async () => {
    const activeListing = { ...retainedListing, id: "listing-new-1", marketplace: mocks.newMarket.toLowerCase() };
    mocks.fetchIndexedListings.mockImplementation(async () => [activeListing]);
    const wallet = { account: buyer, authenticated: true, authHeaders: {}, chainId: 43114, connected: true, getProvider: () => ({ request: vi.fn() }), refreshOwnership: vi.fn() };
    render(<WalletCtx.Provider value={wallet}><PurchasePanel edition={genesisEdition} /></WalletCtx.Provider>);
    await act(flush);
    expect(mocks.fetchIndexedListings).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/Listing #1/)).toHaveLength(1);
  });

  it("keeps same-numbered listings from different marketplaces as separate cards", async () => {
    const activeListing = { ...retainedListing, id: "listing-new-1", marketplace: mocks.newMarket.toLowerCase() };
    mocks.fetchIndexedListings.mockImplementation(async ({ marketplaceAddress }) => [marketplaceAddress.toLowerCase() === mocks.oldMarket.toLowerCase() ? retainedListing : activeListing]);
    const wallet = { account: buyer, authenticated: true, authHeaders: {}, chainId: 43114, connected: true, getProvider: () => ({ request: vi.fn() }), refreshOwnership: vi.fn() };
    render(<WalletCtx.Provider value={wallet}><PurchasePanel edition={genesisEdition} /></WalletCtx.Provider>);
    await act(flush);
    expect(screen.getAllByText(/Listing #1/)).toHaveLength(2);
  });
});
