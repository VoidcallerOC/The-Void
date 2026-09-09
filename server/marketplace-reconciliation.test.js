import { describe, expect, it, vi } from "vitest";
import { BlockchainIndexer } from "./indexer.js";
import { MARKETPLACE_EVENT_TOPICS, MarketplaceEventError, decodeMarketplaceListingResult, decodeMarketplaceLog, marketplaceInterface } from "./marketplace-events.js";
import { reconcileMarketplaceListing, reconcileMarketplaceTransaction } from "./marketplace-reconcile.js";

const marketplace = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const seller = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const tx = `0x${"1".repeat(64)}`;
const blockHash = `0x${"2".repeat(64)}`;
const parentHash = `0x${"3".repeat(64)}`;
const block = { number: 100, hash: blockHash, parentHash, timestamp: 1_700_000_000 };

function eventLog(name, args, overrides = {}) {
  const encoded = marketplaceInterface.encodeEventLog(name, args);
  return { address: marketplace, transactionHash: tx, blockNumber: 100, blockHash, logIndex: 4, topics: encoded.topics, data: encoded.data, ...overrides };
}

function created(overrides = {}) {
  return eventLog("ListingCreated", [7, seller, token, 12, 4, 25, 1_800_000_000], overrides);
}

function sold(overrides = {}) {
  return eventLog("ListingSold", [7, buyer, seller, token, 12, 2, 50, 5, 3], overrides);
}

function indexerStore() {
  const events = new Set();
  const projections = new Set();
  return {
    recordEvent: vi.fn(async (event) => {
      const key = `${event.chainId}:${event.contractAddress}:${event.transactionHash}:${event.logIndex}`;
      if (events.has(key)) return null;
      events.add(key);
      return event;
    }),
    applyMarketplaceEvent: vi.fn(async (event) => {
      const key = `${event.chainId}:${event.marketplaceAddress}:${event.transactionHash}:${event.logIndex}`;
      if (projections.has(key)) return { duplicate: true, event };
      projections.add(key);
      return { duplicate: false, event };
    }),
    recordIndexerError: vi.fn(),
    getCheckpoint: vi.fn().mockResolvedValue(null),
    setCheckpoint: vi.fn(),
    getBlock: vi.fn().mockResolvedValue(null),
    recordBlock: vi.fn(),
    handleReorg: vi.fn(),
  };
}

describe("marketplace event decoding", () => {
  it("decodes all contract lifecycle events with authoritative fields", () => {
    expect(MARKETPLACE_EVENT_TOPICS.ListingCreated).toBe(marketplaceInterface.getEvent("ListingCreated").topicHash.toLowerCase());
    expect(decodeMarketplaceLog(created(), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date(block.timestamp * 1000) })).toMatchObject({ eventType: "ListingCreated", listingId: "7", sellerWallet: seller, tokenContractAddress: token, tokenId: "12", amount: "4", remainingAmount: "4", priceWei: "25", currency: "native", status: "ACTIVE", blockNumber: 100, logIndex: 4 });
    expect(decodeMarketplaceLog(eventLog("ListingCancelled", [7]), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toMatchObject({ eventType: "ListingCancelled", listingId: "7", status: "CANCELLED" });
    expect(decodeMarketplaceLog(eventLog("ListingExpired", [7]), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toMatchObject({ eventType: "ListingExpired", listingId: "7", status: "EXPIRED" });
    expect(decodeMarketplaceLog(sold(), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toMatchObject({ eventType: "ListingSold", listingId: "7", buyerWallet: buyer, sellerWallet: seller, tokenContractAddress: token, tokenId: "12", quantity: "2", salePriceWei: "50", platformFeeWei: "5", royaltyWei: "3" });
    expect(decodeMarketplaceLog(sold(), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date(), platformFeeBps: 1000 })).toMatchObject({ platformFeeWei: "5" });
  });

  it("rejects malformed logs, wrong contracts, and invalid fee allocations", () => {
    expect(() => decodeMarketplaceLog({ ...created(), address: token }, { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toThrow(MarketplaceEventError);
    expect(() => decodeMarketplaceLog({ ...created(), data: "0x" }, { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toThrow(MarketplaceEventError);
    expect(() => decodeMarketplaceLog(eventLog("ListingSold", [7, buyer, seller, token, 12, 2, 50, 51, 0]), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date() })).toThrow(/fee/i);
    expect(() => decodeMarketplaceLog(sold(), { chainId: 43114, expectedAddress: marketplace, blockTimestamp: new Date(), platformFeeBps: 999 })).toThrow(/basis points/i);
  });

  it("decodes canonical getListing state and rejects malformed results", () => {
    const result = marketplaceInterface.encodeFunctionResult("getListing", [7, seller, token, 12, 2, 25, 1_700_000_000, 0, 0]);
    expect(decodeMarketplaceListingResult(result)).toMatchObject({ listingId: "7", sellerWallet: seller, tokenContractAddress: token, tokenId: "12", remainingAmount: "2", priceWei: "25", status: "ACTIVE", currency: "native" });
    expect(() => decodeMarketplaceListingResult("0x1234")).toThrow(MarketplaceEventError);
  });
});

describe("marketplace event indexing", () => {
  it("projects a marketplace event exactly once and records duplicate logs idempotently", async () => {
    const store = indexerStore();
    const indexer = new BlockchainIndexer({ rpc: { getBlockNumber: vi.fn().mockResolvedValue(100), getLogs: vi.fn().mockResolvedValue([created()]), getBlock: vi.fn().mockResolvedValue(block) }, store, confirmations: 0, configs: [{ chainId: 43114, address: marketplace, contractType: "MARKETPLACE", startBlock: 100 }] });
    await indexer.syncAll();
    const replay = await indexer.processLog({ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }, created(), block);
    expect(store.recordEvent).toHaveBeenCalledTimes(2);
    expect(store.applyMarketplaceEvent).toHaveBeenCalledTimes(2);
    expect(replay).toMatchObject({ duplicate: true, projectionApplied: false });
    expect(store.applyMarketplaceEvent.mock.calls[0][0]).toMatchObject({ eventType: "ListingCreated", listingId: "7", amount: "4", priceWei: "25" });
  });

  it("records malformed marketplace logs without projecting a listing", async () => {
    const store = indexerStore();
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [{ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }] });
    await indexer.processLog({ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }, { ...created(), topics: ["0xdeadbeef"] }, block);
    expect(store.applyMarketplaceEvent).not.toHaveBeenCalled();
    expect(store.recordIndexerError).toHaveBeenCalledWith(expect.objectContaining({ errorType: "MALFORMED_MARKETPLACE_EVENT" }));
  });

  it("retries a projection after an earlier projection failure without discarding the indexed event", async () => {
    const store = indexerStore();
    store.applyMarketplaceEvent.mockRejectedValueOnce(new Error("temporary database interruption"));
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [{ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }] });
    await expect(indexer.processLog({ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }, created(), block)).rejects.toThrow(/interruption/);
    await expect(indexer.processLog({ chainId: 43114, address: marketplace, contractType: "MARKETPLACE" }, created(), block)).resolves.toMatchObject({ duplicate: true, projectionApplied: true });
    expect(store.applyMarketplaceEvent).toHaveBeenCalledTimes(2);
  });
});

describe("canonical marketplace reconciliation", () => {
  it("reconciles canonical listing snapshots and flags a missing indexed event safely", async () => {
    const store = { reconcileMarketplaceListing: vi.fn().mockResolvedValue({ state: "ACTIVE", repaired: true }) };
    const snapshot = { listingId: "7", sellerWallet: seller, tokenContractAddress: token, tokenId: "12", remainingAmount: "2", priceWei: "25", currency: "native", status: "ACTIVE" };
    await expect(reconcileMarketplaceListing({ rpc: { getMarketplaceListing: vi.fn().mockResolvedValue(snapshot) }, store, chainId: 43114, marketplaceAddress: marketplace, listingId: 7, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "ACTIVE", repaired: true });
    expect(store.reconcileMarketplaceListing).toHaveBeenCalledWith(expect.objectContaining({ snapshot, blockTag: "finalized" }));

    store.reconcileMarketplaceListing.mockResolvedValueOnce({ state: "INVALID", repaired: true });
    await expect(reconcileMarketplaceListing({ rpc: { getMarketplaceListing: vi.fn().mockResolvedValue(null) }, store, chainId: 43114, marketplaceAddress: marketplace, listingId: 8, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "INVALID", repaired: true });
    expect(store.reconcileMarketplaceListing).toHaveBeenLastCalledWith(expect.objectContaining({ listingId: "8", snapshot: null }));
  });

  it("keeps missing receipts pending, marks failures failed, and requires confirmations for finality", async () => {
    const store = { reconcileMarketplaceTransaction: vi.fn((value) => Promise.resolve(value)) };
    const rpc = { getTransactionReceipt: vi.fn().mockResolvedValue(null), getBlockNumber: vi.fn().mockResolvedValue(120) };
    await expect(reconcileMarketplaceTransaction({ rpc, store, chainId: 43114, transactionHash: tx, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "PENDING" });

    rpc.getTransactionReceipt.mockResolvedValueOnce({ status: "0x0", blockNumber: "0x64", blockHash });
    await expect(reconcileMarketplaceTransaction({ rpc, store, chainId: 43114, transactionHash: tx, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "FAILED" });

    rpc.getTransactionReceipt.mockResolvedValueOnce({ status: "0x1", blockNumber: 115, blockHash });
    await expect(reconcileMarketplaceTransaction({ rpc, store, chainId: 43114, transactionHash: tx, confirmations: 12, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "CONFIRMED" });

    rpc.getTransactionReceipt.mockResolvedValueOnce({ status: "0x1", blockNumber: 100, blockHash });
    await expect(reconcileMarketplaceTransaction({ rpc, store, chainId: 43114, transactionHash: tx, confirmations: 12, retryOptions: { retries: 0 } })).resolves.toMatchObject({ state: "FINALIZED" });
  });
});
