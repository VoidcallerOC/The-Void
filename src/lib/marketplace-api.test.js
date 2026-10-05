import { describe, expect, it, vi } from "vitest";
import {
  classifyAuthoritativePurchaseTransaction,
  classifyAuthoritativeListingTransaction,
  classifyAuthoritativeCancellationTransaction,
  createAuthoritativePurchaseIntent,
  fetchAuthoritativeListing,
  fetchAuthoritativeMarketplaceTransaction,
  fetchIndexedListings,
  recordAuthoritativeTransactionSubmission,
} from "./marketplace-api.js";
import { PURCHASE_STATE } from "./marketplace.js";

const marketplace = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";
const transactionHash = `0x${"b".repeat(64)}`;
const listing = { id: "listing-uuid", listingId: "7" };
const listingRow = { id: "listing-uuid", listing_id: "7", seller_wallet: wallet, chain_id: 43114, marketplace_address: marketplace, token_contract_address: marketplace, token_id: "2", amount: "4", remaining_amount: "3", price_wei: "25", currency: "native", expires_at: null, status: "ACTIVE" };
const expectedPurchase = { chainId: 43113, transactionHash, buyer: wallet, marketplaceAddress: marketplace, listingId: "listing-uuid", quantity: 1, payment: "25" };
const transactionRow = (overrides = {}) => ({
  chain_id: "43113",
  transaction_hash: transactionHash,
  transaction_type: "PURCHASE",
  status: "RECONCILED",
  from_wallet: wallet,
  to_address: marketplace,
  value_wei: "25",
  purchases: [{ listingId: "listing-uuid", quantity: 1, status: "RECONCILED", salePriceWei: 25 }],
  ...overrides,
});

function response({ ok = true, data = {}, error = null } = {}) { return { ok, json: vi.fn().mockResolvedValue(ok ? { data } : { error }) }; }

describe("authoritative marketplace API client", () => {
  it("loads listing state exclusively from the indexed API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: listingRow }));
    await expect(fetchAuthoritativeListing({ chainId: 43114, marketplaceAddress: marketplace, listingId: 7, fetchImpl })).resolves.toMatchObject({ id: "listing-uuid", listingId: "7", amount: "3", price: "25", authority: "INDEXED" });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/listings/43114/${marketplace}/7`, expect.objectContaining({ method: "GET" }));
  });

  it("loads the existing authoritative transaction-status endpoint and forwards cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: transactionRow() }));
    await expect(fetchAuthoritativeMarketplaceTransaction({ chainId: 43113, transactionHash, fetchImpl, signal: controller.signal })).resolves.toMatchObject({ status: "RECONCILED", transaction_type: "PURCHASE" });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/marketplace/transactions/43113/${transactionHash}`, expect.objectContaining({ method: "GET", signal: controller.signal }));
  });

  it("loads edition-scoped listings from the index and never fabricates rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: [listingRow] }));
    const rows = await fetchIndexedListings({ chainId: 43114, tokenContractAddress: marketplace, tokenId: "2", fetchImpl });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ listingId: "7", tokenId: "2", authority: "INDEXED" });
    expect(fetchImpl.mock.calls[0][0]).toContain("/api/listings?");
    expect(fetchImpl.mock.calls[0][0]).toContain("tokenContractAddress=");
    const emptyFetch = vi.fn().mockResolvedValue(response({ data: [] }));
    await expect(fetchIndexedListings({ chainId: 43113, fetchImpl: emptyFetch })).resolves.toEqual([]);
  });

  it("supports owner-scoped listing reads for the seller management flow", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: [listingRow] }));
    await fetchIndexedListings({ chainId: 43113, marketplaceAddress: marketplace, tokenContractAddress: marketplace, tokenId: "2", sellerWallet: wallet, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toContain(`sellerWallet=${wallet}`);
  });

  it("creates pending purchase intents and records only submitted transaction references", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: { state: "PENDING" } }));
    await createAuthoritativePurchaseIntent({ listing, wallet, quantity: 2, marketplaceAddress: marketplace, authHeaders: { authorization: "Bearer token" }, fetchImpl });
    expect(fetchImpl).toHaveBeenLastCalledWith("/api/purchases/intents", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer token" }) }));

    await recordAuthoritativeTransactionSubmission({ transactionHash, chainId: 43114, wallet, marketplaceAddress: marketplace, listingId: listing.id, type: "PURCHASE", authHeaders: { authorization: "Bearer token" }, fetchImpl });
    expect(fetchImpl).toHaveBeenLastCalledWith("/api/purchases/submitted", expect.objectContaining({ method: "POST", body: expect.stringContaining(transactionHash) }));
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toMatchObject({ listingId: "listing-uuid", buyerWallet: wallet });
  });

  it("keeps PENDING while the backend has no indexed settlement and confirms only a matching reconciled purchase", () => {
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ status: "SUBMITTED", purchases: [] }), expectedPurchase)).toBeNull();
    expect(classifyAuthoritativePurchaseTransaction(transactionRow(), expectedPurchase)).toEqual({ state: PURCHASE_STATE.CONFIRMED, message: "The authoritative marketplace index confirmed the purchase settlement." });
  });

  it("does not confirm a terminal transaction without a matching authoritative purchase row", () => {
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ purchases: [] }), expectedPurchase)).toMatchObject({ state: PURCHASE_STATE.RECONCILIATION_REQUIRED });
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ purchases: [{ listingId: "other-listing", quantity: 1, status: "RECONCILED" }] }), expectedPurchase)).toMatchObject({ state: PURCHASE_STATE.RECONCILIATION_REQUIRED });
  });

  it("maps backend terminal failures to existing actionable purchase states", () => {
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ status: "REVERTED", purchases: [] }), expectedPurchase)).toMatchObject({ state: PURCHASE_STATE.REVERTED });
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ status: "REORGED", purchases: [] }), expectedPurchase)).toMatchObject({ state: PURCHASE_STATE.RECONCILIATION_REQUIRED });
    expect(classifyAuthoritativePurchaseTransaction(transactionRow({ status: "EXPIRED", purchases: [] }), expectedPurchase)).toMatchObject({ state: PURCHASE_STATE.EXPIRED });
  });

  it("confirms a listing only when the submitted transaction and indexed release identity match", () => {
    const expectedListing = { chainId: 43113, transactionHash, seller: wallet, marketplaceAddress: marketplace, listingId: "7", contract: marketplace, tokenId: "2", amount: "4", price: "25" };
    const transaction = transactionRow({ transaction_type: "LISTING_CREATE", status: "CONFIRMED", from_wallet: wallet, to_address: marketplace });
    const indexed = { ...listingRow, listingId: "7", seller: wallet, chain: 43113, marketplace, tokenContract: marketplace, contract: marketplace, tokenId: "2", amount: "3", initialAmount: "4", price: "25", status: "ACTIVE", authority: "INDEXED" };

    expect(classifyAuthoritativeListingTransaction({ ...transaction, status: "SUBMITTED" }, indexed, expectedListing)).toBeNull();
    expect(classifyAuthoritativeListingTransaction(transaction, indexed, expectedListing)).toMatchObject({ state: "LISTED", listing: indexed });
    expect(classifyAuthoritativeListingTransaction(transaction, { ...indexed, tokenContract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, expectedListing)).toMatchObject({ state: "RECONCILIATION_REQUIRED" });
  });

  it("confirms cancellation only for the exact seller, original listing and indexed CANCELLED state", () => {
    const expectedCancel = { chainId: 43113, transactionHash, seller: wallet, marketplaceAddress: marketplace, listingId: "7", contract: marketplace, tokenId: "2", amount: "3", initialAmount: "4", exactRemainingAmount: true, price: "25" };
    const transaction = transactionRow({ transaction_type: "LISTING_CANCEL", status: "FINALIZED", from_wallet: wallet, to_address: marketplace });
    const cancelled = { ...listingRow, listingId: "7", seller: wallet, chain: 43113, marketplace, tokenContract: marketplace, contract: marketplace, tokenId: "2", amount: "3", initialAmount: "4", price: "25", status: "CANCELLED", authority: "INDEXED" };

    expect(classifyAuthoritativeCancellationTransaction(transaction, cancelled, expectedCancel)).toMatchObject({ state: "CANCELLED", listing: cancelled });
    expect(classifyAuthoritativeCancellationTransaction(transaction, { ...cancelled, seller: "0x2222222222222222222222222222222222222222" }, expectedCancel)).toMatchObject({ state: "RECONCILIATION_REQUIRED" });
    expect(classifyAuthoritativeCancellationTransaction({ ...transaction, status: "REVERTED" }, null, expectedCancel)).toMatchObject({ state: "REVERTED" });
  });

  it("surfaces backend rejection rather than inferring a browser-local state", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: false, error: { code: "LISTING_NOT_FOUND", message: "The indexed listing was not found." } }));
    await expect(fetchAuthoritativeListing({ chainId: 43114, marketplaceAddress: marketplace, listingId: 7, fetchImpl })).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });
});
