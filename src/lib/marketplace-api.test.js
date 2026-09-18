import { describe, expect, it, vi } from "vitest";
import { createAuthoritativePurchaseIntent, fetchAuthoritativeListing, fetchIndexedListings, recordAuthoritativeTransactionSubmission } from "./marketplace-api.js";

const marketplace = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const wallet = "0x1111111111111111111111111111111111111111";
const transactionHash = `0x${"b".repeat(64)}`;
const listing = { id: "listing-uuid", listingId: "7" };
const listingRow = { id: "listing-uuid", listing_id: "7", seller_wallet: wallet, chain_id: 43114, marketplace_address: marketplace, token_contract_address: marketplace, token_id: "2", amount: "4", remaining_amount: "3", price_wei: "25", currency: "native", expires_at: null, status: "ACTIVE" };

function response({ ok = true, data = {}, error = null } = {}) { return { ok, json: vi.fn().mockResolvedValue(ok ? { data } : { error }) }; }

describe("authoritative marketplace API client", () => {
  it("loads listing state exclusively from the indexed API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: listingRow }));
    await expect(fetchAuthoritativeListing({ chainId: 43114, marketplaceAddress: marketplace, listingId: 7, fetchImpl })).resolves.toMatchObject({ id: "listing-uuid", listingId: "7", amount: "3", price: "25", authority: "INDEXED" });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/listings/43114/${marketplace}/7`, expect.objectContaining({ method: "GET" }));
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

  it("creates pending purchase intents and records only submitted transaction references", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ data: { state: "PENDING" } }));
    await createAuthoritativePurchaseIntent({ listing, wallet, quantity: 2, marketplaceAddress: marketplace, authHeaders: { authorization: "Bearer token" }, fetchImpl });
    expect(fetchImpl).toHaveBeenLastCalledWith("/api/purchases/intents", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer token" }) }));

    await recordAuthoritativeTransactionSubmission({ transactionHash, chainId: 43114, wallet, marketplaceAddress: marketplace, listingId: listing.id, type: "PURCHASE", authHeaders: { authorization: "Bearer token" }, fetchImpl });
    expect(fetchImpl).toHaveBeenLastCalledWith("/api/purchases/submitted", expect.objectContaining({ method: "POST", body: expect.stringContaining(transactionHash) }));
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toMatchObject({ listingId: "listing-uuid", buyerWallet: wallet });
  });

  it("surfaces backend rejection rather than inferring a browser-local state", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: false, error: { code: "LISTING_NOT_FOUND", message: "The indexed listing was not found." } }));
    await expect(fetchAuthoritativeListing({ chainId: 43114, marketplaceAddress: marketplace, listingId: 7, fetchImpl })).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });
});
