import { describe, expect, it, vi } from "vitest";
import { IndexerStore } from "./indexer-store.js";

const marketplace = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"1".repeat(64)}`;
const blockHash = `0x${"2".repeat(64)}`;
const base = { chainId: 43114, marketplaceAddress: marketplace, transactionHash, blockNumber: 100, blockHash, logIndex: 4 };

function poolWith(results) {
  const client = { query: vi.fn() };
  for (const result of results) client.query.mockResolvedValueOnce(result);
  client.release = vi.fn();
  return { client, pool: { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } };
}

function created(overrides = {}) { return { ...base, eventType: "ListingCreated", listingId: "7", sellerWallet: seller, tokenContractAddress: token, tokenId: "12", amount: "4", remainingAmount: "4", priceWei: "25", expiresAt: null, ...overrides }; }
function sold(overrides = {}) { return { ...base, eventType: "ListingSold", listingId: "7", buyerWallet: buyer, sellerWallet: seller, tokenContractAddress: token, tokenId: "12", quantity: "2", salePriceWei: "50", platformFeeWei: "5", royaltyWei: "3", ...overrides }; }
const listing = { id: "listing-uuid", seller_wallet: seller, token_contract_address: token, token_id: "12", amount: "4", remaining_amount: "4", price_wei: "25", currency: "native", status: "ACTIVE" };

describe("marketplace event projection storage", () => {
  it("projects a created event only after registered marketplace and token validation", async () => {
    const { pool, client } = poolWith([
      {}, { rows: [{ id: "projection" }] }, { rows: [{ id: "marketplace-contract" }] }, { rows: [{ id: "token-contract" }] }, { rows: [{ id: "listing-uuid", status: "ACTIVE" }] }, {}, {}, {},
    ]);
    const result = await new IndexerStore(pool).applyMarketplaceEvent(created());
    expect(result).toMatchObject({ duplicate: false, state: "ACTIVE" });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("marketplace_event_projections"), [43114, marketplace, transactionHash, 4, "7", "ListingCreated"]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("contract_type='MARKETPLACE'"), [43114, marketplace]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("contract_type='ERC1155'"), [43114, token]);
  });

  it("treats replayed events as idempotent and makes no lifecycle write", async () => {
    const { pool, client } = poolWith([{}, { rows: [] }, {}]);
    await expect(new IndexerStore(pool).applyMarketplaceEvent(created())).resolves.toEqual({ duplicate: true });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("projects partial and terminal sales with verified quantity, price, fees, and identity", async () => {
    const { pool, client } = poolWith([
      {}, { rows: [{ id: "projection" }] }, { rows: [{ id: "marketplace-contract" }] }, { rows: [listing] }, { rows: [{ ...listing, remaining_amount: "2", status: "ACTIVE" }] }, { rows: [{ id: "transaction-uuid" }] }, { rows: [{ id: "purchase-uuid", status: "CONFIRMED" }] }, {}, {},
    ]);
    const result = await new IndexerStore(pool).applyMarketplaceEvent(sold());
    expect(result).toMatchObject({ state: "ACTIVE", listing: { remaining_amount: "2" }, purchase: { status: "CONFIRMED" } });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE listings SET remaining_amount"), ["listing-uuid", "2", "ACTIVE"]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO purchases"), expect.arrayContaining(["2", "50", "5", "3"]));
  });

  it("rejects oversold quantities and incorrect prices without persisting a purchase", async () => {
    const { pool, client } = poolWith([{}, { rows: [{ id: "projection" }] }, { rows: [{ id: "marketplace-contract" }] }, { rows: [listing] }, {}]);
    await expect(new IndexerStore(pool).applyMarketplaceEvent(sold({ quantity: "5", salePriceWei: "125" }))).rejects.toThrow(/quantity or price/i);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO purchases"))).toBe(false);
  });

  it("projects cancelled and sold terminal listings without reopening them", async () => {
    const cancelled = { ...base, eventType: "ListingCancelled", listingId: "7" };
    const cancelStore = poolWith([{}, { rows: [{ id: "projection" }] }, { rows: [{ id: "marketplace-contract" }] }, { rows: [listing] }, { rows: [{ ...listing, status: "CANCELLED" }] }, {}, {}, {}]);
    await expect(new IndexerStore(cancelStore.pool).applyMarketplaceEvent(cancelled)).resolves.toMatchObject({ state: "CANCELLED" });

    const soldStore = poolWith([{}, { rows: [{ id: "projection" }] }, { rows: [{ id: "marketplace-contract" }] }, { rows: [{ ...listing, remaining_amount: "4" }] }, { rows: [{ ...listing, remaining_amount: "0", status: "SOLD" }] }, { rows: [{ id: "transaction-uuid" }] }, { rows: [{ id: "purchase-uuid" }] }, {}, {}]);
    await expect(new IndexerStore(soldStore.pool).applyMarketplaceEvent(sold({ quantity: "4", salePriceWei: "100" }))).resolves.toMatchObject({ state: "SOLD" });
  });

  it("rebuilds derived ownership and marketplace state only from canonical events after a reorg", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const canonicalEvent = created();
    const db = { connect: vi.fn().mockResolvedValue(client), query: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ event_data: canonicalEvent }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) };
    const store = new IndexerStore(db);
    const replay = vi.spyOn(store, "applyMarketplaceEvent").mockResolvedValue({ state: "ACTIVE" });
    await expect(store.rebuildDerivedState({ chainId: 43114 })).resolves.toEqual({ chainId: 43114, replayedMarketplaceEvents: 1, replayedPrimaryPurchases: 0 });
    expect(client.query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([expect.stringContaining("DELETE FROM ownership_snapshots"), expect.stringContaining("DELETE FROM purchases"), expect.stringContaining("DELETE FROM primary_purchases"), expect.stringContaining("DELETE FROM listings"), expect.stringContaining("DELETE FROM marketplace_event_projections") ]));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("is_canonical=true"), [43114]);
    expect(replay).toHaveBeenCalledWith(canonicalEvent);
  });
});

describe("indexer health contract filtering", () => {
  it("filters health aggregation to configured contract addresses", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await new IndexerStore(db).getIndexerHealth({ chainId: 43113, addresses: [token] });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("contract_address = ANY($2::text[])"), [43113, [token]]);
  });
});

describe("ERC1155 transfer projection storage", () => {
  it("persists a transfer and updates the recipient ownership snapshot atomically", async () => {
    const { pool, client } = poolWith([
      {}, { rows: [{ id: "transfer-1" }] }, { rows: [] }, {}, {}, {},
    ]);
    const result = await new IndexerStore(pool).applyTransfer({ chainId: 43113, contractAddress: token, transactionHash, blockNumber: 100, blockHash, logIndex: 4, eventType: "MINT", from: "0x0000000000000000000000000000000000000000", to: buyer, tokenId: "12", amount: "2", blockTimestamp: new Date(), raw: {} });
    expect(result).toMatchObject({ duplicate: false, transfer: { id: "transfer-1" } });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO transfers"), expect.arrayContaining([43113, token, "12", buyer, "2"]));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO ownership_snapshots"), expect.arrayContaining([43113, token, "12", buyer, "2"]));
  });

  it("projects a primary purchase onto the ERC1155 ownership record", async () => {
    const sale = "0xcccccccccccccccccccccccccccccccccccccccc";
    const { pool, client } = poolWith([
      {}, { rows: [{ id: "marker" }] }, { rows: [] }, {}, {}, { rows: [{ id: "tx" }] }, { rows: [{ id: "purchase", status: "CONFIRMED" }] }, {},
    ]);
    const result = await new IndexerStore(pool).applyPrimaryPurchase({ chainId: 43113, saleAddress: sale, tokenContractAddress: token, transactionHash, blockNumber: 100, blockHash, logIndex: 4, buyerWallet: buyer, tokenId: "12", quantity: "2", paidWei: "1000", artistCutWei: "750", platformCutWei: "250" });
    expect(result).toMatchObject({ duplicate: false, ownershipCredited: true, purchase: { status: "CONFIRMED" } });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO primary_purchases"), expect.arrayContaining([43113, sale, token, buyer, "12", "2", "1000", "750", "250"]));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO ownership_snapshots"), expect.arrayContaining([43113, token, "12", buyer, "2"]));
  });
});
