// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// After the launch switch 0x75964 is a retained unified marketplace: the seller's existing Genesis listing there is found
// (so no duplicate is offered on the new active marketplace) and is cancelled on 0x75964 itself. Nothing is broadcast.
const mocks = vi.hoisted(() => ({
  oldMarket: "0x75964C44cA586b13e98e7c30E74d2B4114f65b06",
  newMarket: "0x0F5930113Ec750d867741E05F302053472115eb2",
  genesis: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
  seller: "0x00000000000000000000000000000000000b0b01",
  readContext: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeListing: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
  recordSubmission: vi.fn(),
  submitCancel: vi.fn(),
  verifyCancelReceipt: vi.fn(),
}));

vi.mock("../../config/unified-marketplace.json", async (importOriginal) => {
  const actual = (await importOriginal()).default;
  return { default: { ...actual, marketplaceAddress: mocks.newMarket, deploymentBlock: 98400000, releaseFactoryAddress: "0xEa0c345cE84025b4e8462d145100dce1848254B4", retainedMarketplaces: [{ marketplaceAddress: mocks.oldMarket, deploymentBlock: 98161532, releaseFactoryAddress: "0xE744D58fA8138042f5f00a28d39f89081539C19B", legacyReleaseFactoryAddress: "0x262B774cf9a1949170B58E2d57F6189980FE757b" }] } };
});
vi.mock("../../config/release-network.js", async (importOriginal) => {
  const actual = await importOriginal();
  // The switched release manifest records the new marketplace as the active factory's.
  return { ...actual, releaseDeploymentForMarketplace: (address) => (String(address).toLowerCase() === mocks.newMarket.toLowerCase() ? { chainId: 43114, marketplaceAddress: mocks.newMarket, factoryAddress: "0xEa0c345cE84025b4e8462d145100dce1848254B4" } : actual.releaseDeploymentForMarketplace(address)) };
});
vi.mock("../lib/secondary-listing.js", async (importOriginal) => ({ ...(await importOriginal()), readReleaseListingContext: mocks.readContext }));
vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.newMarket, chainId: 43114, enabled: true }), submitCancel: mocks.submitCancel, verifyCancelReceipt: mocks.verifyCancelReceipt };
});
vi.mock("../lib/marketplace-api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchIndexedListings: mocks.fetchIndexedListings,
  fetchAuthoritativeListing: mocks.fetchAuthoritativeListing,
  fetchAuthoritativeMarketplaceTransaction: mocks.fetchAuthoritativeTransaction,
  recordAuthoritativeTransactionSubmission: mocks.recordSubmission,
}));

let ListingPanel;
let WalletCtx;
beforeAll(async () => {
  vi.stubEnv("VITE_RELEASE_NETWORK", "mainnet");
  vi.stubEnv("RELEASE_NETWORK", "mainnet");
  vi.resetModules();
  ({ ListingPanel } = await import("./ListingPanel.jsx"));
  ({ WalletCtx } = await import("../lib/wallet-context.js"));
});

const edition = { id: "voidcaller-chapter-i", title: "Voidcaller Genesis", chainId: 43114, contractAddress: mocks.genesis, tokenIds: [0] };
const retainedListing = { id: "listing-old-1", listingId: "1", chain: 43114, marketplace: mocks.oldMarket.toLowerCase(), tokenContract: mocks.genesis.toLowerCase(), seller: mocks.seller, tokenId: "0", amount: "1", initialAmount: "1", price: "250000000000000000", status: "ACTIVE", authority: "INDEXED" };
const cancelHash = `0x${"d".repeat(64)}`;
const flush = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readContext.mockResolvedValue({ balance: "0", approved: true, assetClass: "GENESIS", marketplaceFeeBps: "0", royaltyBps: "500", royaltyReceiver: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a", factoryAddress: null, marketplaceAddress: mocks.newMarket, releaseContractAddress: mocks.genesis, tokenId: "0", seller: mocks.seller, chainId: 43114 });
  mocks.fetchIndexedListings.mockImplementation(async ({ marketplaceAddress }) => (marketplaceAddress.toLowerCase() === mocks.oldMarket.toLowerCase() ? [retainedListing] : []));
  mocks.fetchAuthoritativeListing.mockResolvedValue(retainedListing);
  mocks.fetchAuthoritativeTransaction.mockResolvedValue(null);
  mocks.recordSubmission.mockResolvedValue({ state: "SUBMITTED" });
  mocks.submitCancel.mockResolvedValue({ transactionHash: cancelHash, status: "0x1", logs: [] });
  mocks.verifyCancelReceipt.mockReturnValue(undefined);
});
afterEach(() => cleanup());

describe("an existing listing on a retained unified marketplace", () => {
  it("is found as the seller's listing and cancelled on its own marketplace", async () => {
    const wallet = { account: mocks.seller, authenticated: true, authHeaders: {}, chainId: 43114, connected: true, getProvider: () => ({ request: vi.fn() }) };
    render(<WalletCtx.Provider value={wallet}><MemoryRouter><ListingPanel edition={edition} /></MemoryRouter></WalletCtx.Provider>);
    await act(flush);
    expect(mocks.readContext).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddress: mocks.newMarket }));
    expect(mocks.fetchIndexedListings.mock.calls.map(([args]) => args.marketplaceAddress.toLowerCase())).toEqual([mocks.newMarket.toLowerCase(), mocks.oldMarket.toLowerCase()]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "CANCEL LISTING" })); await flush(); });
    expect(mocks.fetchAuthoritativeListing).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddress: mocks.oldMarket }));
    expect(mocks.submitCancel).toHaveBeenCalledWith(expect.objectContaining({ marketplace: mocks.oldMarket, listingId: "1" }));
    expect(mocks.verifyCancelReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ marketplace: mocks.oldMarket }));
    expect(mocks.recordSubmission).toHaveBeenCalledWith(expect.objectContaining({ marketplaceAddress: mocks.oldMarket, type: "LISTING_CANCEL" }));
  });
});
