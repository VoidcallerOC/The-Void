import { describe, expect, it, vi } from "vitest";
import { id } from "ethers";
import { BlockchainIndexer, DEFAULT_INDEXER_CHUNK_SIZE, decodePurchasedLog, decodeTransferLog, retry } from "./indexer.js";
import { DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE } from "./config.js";
import { reconcileOwnership } from "./indexer-reconcile.js";
import { CheckpointRegressionError } from "./indexer-store.js";
import { createIndexerWorker, ProductionIndexerWorker } from "./indexer-worker.js";

const singleTopic = "0xsingle";
const batchTopic = "0xbatch";
const zero = "0x0000000000000000000000000000000000000000";
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addrTopic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const block = (number, hash = `0xblock${number}`, parentHash = `0xparent${number - 1}`) => ({ number, hash, parentHash, timestamp: 1_700_000_000 + number });
const singleLog = ({ blockNumber = 1, tokenId = 1, amount = 2, from = alice, to = bob, tx = `0xtx${blockNumber}`, logIndex = 0, address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } = {}) => ({ address, topics: [singleTopic, addrTopic(alice), addrTopic(from), addrTopic(to)], data: `0x${word(tokenId)}${word(amount)}`, transactionHash: tx, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex });

function storeDouble({ checkpoints = new Map(), blocks = new Map(), failAtBlock = null } = {}) {
  const events = new Map();
  const transfers = [];
  const calls = { checkpoints: [], reorgs: [], errors: [], applied: [] };
  return {
    calls, events, transfers,
    async getCheckpoint(key) { return checkpoints.get(`${key.chainId}:${key.address}`) || null; },
    async setCheckpoint(value) { calls.checkpoints.push(value); checkpoints.set(`${value.chainId}:${value.address}`, value); return value; },
    async getBlock({ chainId, blockNumber }) { return blocks.get(`${chainId}:${blockNumber}`) || null; },
    async recordBlock(value) { blocks.set(`${value.chainId}:${value.blockNumber}`, { block_hash: value.blockHash, ...value }); },
    async handleReorg(value) { calls.reorgs.push(value); },
    async recordEvent(value) { const key = `${value.chainId}:${value.contractAddress}:${value.transactionHash}:${value.logIndex}`; if (events.has(key)) return null; events.set(key, value); return value; },
    async applyTransfer(value) { if (failAtBlock === value.blockNumber) throw new Error("projection failure"); calls.applied.push(value); transfers.push(value); return value; },
    async recordIndexerError(value) { calls.errors.push(value); },
    async getOwnership() { return { amount: "2" }; },
  };
}

describe("ERC-1155 event decoding", () => {
  it("decodes transfer, mint, and burn semantics", () => {
    expect(decodeTransferLog(singleLog({ from: alice, to: bob }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0]).toMatchObject({ eventType: "TransferSingle", tokenId: "1", amount: "2", from: alice, to: bob });
    expect(decodeTransferLog(singleLog({ from: zero, to: bob }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0].eventType).toBe("MINT");
    expect(decodeTransferLog(singleLog({ from: alice, to: zero }), { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferSingle: singleTopic } })[0].eventType).toBe("BURN");
  });

  // Production (C-Chain, 2026-10-19 to 2026-10-24): every release clone logs ERC-7572 ContractURIUpdated(string),
  // topic 0x905d9812…, with no indexed parameters, at its creation block. The decoder read topics[1] as the
  // operator before checking the event type, so each of those logs was recorded MALFORMED with an indexer_errors
  // row (8 rows), although it is simply not a transfer.
  it("treats an unknown single-topic event as not-a-transfer instead of a malformed one", async () => {
    const contractUriUpdated = { address: "0xf0c091a159de16cf0f306b2b61d37685ec5a830e", topics: ["0x905d981207a7d0b6c62cc46ab0be2a076d0298e4a86d0ab79882dbd01ac37378"], data: `0x${"00".repeat(128)}`, transactionHash: "0xtxcreate", blockNumber: 1, blockHash: "0xblock1", logIndex: 18 };
    expect(decodeTransferLog(contractUriUpdated, { chainId: 43114, blockTimestamp: new Date(0), eventTopics: { TransferSingle: singleTopic, TransferBatch: batchTopic } })).toEqual([]);
    // A real transfer that lacks its indexed addresses is still malformed.
    expect(() => decodeTransferLog({ ...contractUriUpdated, topics: [singleTopic] }, { chainId: 43114, blockTimestamp: new Date(0), eventTopics: { TransferSingle: singleTopic } })).toThrow(/malformed|requires from and to/);
    // Through the indexer: recorded as UNKNOWN, no indexer_errors row, no transfer applied, and the chunk still completes.
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1), getLogs: vi.fn().mockResolvedValue([contractUriUpdated]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: contractUriUpdated.address, contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic, TransferBatch: batchTopic } }] });
    await expect(indexer.syncAll()).resolves.toMatchObject([{ state: "CONFIRMED", nextBlock: 2 }]);
    expect([...store.events.values()].map((event) => event.eventType)).toEqual(["UNKNOWN"]);
    expect(store.calls.errors).toEqual([]);
    expect(store.transfers).toEqual([]);
  });

  it("supports multiple token IDs from a batch transfer", () => {
    const data = `0x${word(64)}${word(160)}${word(2)}${word(7)}${word(8)}${word(2)}${word(3)}${word(4)}`;
    const result = decodeTransferLog({ ...singleLog({}), topics: [batchTopic, addrTopic(alice), addrTopic(alice), addrTopic(bob)], data }, { chainId: 43114, blockTimestamp: new Date(), eventTopics: { TransferBatch: batchTopic } });
    expect(result.map((item) => [item.tokenId, item.amount])).toEqual([["7", "3"], ["8", "4"]]);
  });
});

describe("primary sale purchase indexing", () => {
  const purchasedTopic = id("Purchased(uint256,address,uint256,uint256,uint256,uint256)");
  const token = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const sale = "0xcccccccccccccccccccccccccccccccccccccccc";
  const purchasedLog = () => ({
    address: sale,
    topics: [purchasedTopic, `0x${word(1)}`, addrTopic(bob)],
    data: `0x${word(2)}${word(1000)}${word(750)}${word(250)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 1,
    blockHash: "0xblock1",
    logIndex: 1,
  });

  it("decodes a Purchased event into the ERC1155 buyer, price, and fee split", () => {
    expect(decodePurchasedLog(purchasedLog(), { chainId: 43113, blockTimestamp: new Date("2026-01-01T00:00:00Z"), tokenAddress: token, eventTopic: purchasedTopic })).toMatchObject({
      eventType: "Purchased", buyerWallet: bob, tokenContractAddress: token, tokenId: "1", quantity: "2", paidWei: "1000", artistCutWei: "750", platformCutWei: "250",
    });
    expect(decodePurchasedLog(purchasedLog(), { chainId: 43113, blockTimestamp: new Date(), tokenAddress: token, eventTopic: "0x" + "11".repeat(32) })).toBeNull();
  });

  it("records the purchase and credits ownership from Purchased while the paired ERC1155 mint does not credit twice", async () => {
    const store = storeDouble();
    store.applyPrimaryPurchase = vi.fn().mockResolvedValue({ duplicate: false, ownershipCredited: true });
    const indexer = new BlockchainIndexer({ rpc: {}, store, configs: [{ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", tokenAddress: token, eventTopics: { Purchased: purchasedTopic } }] });
    await expect(indexer.processLog({ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", tokenAddress: token, eventTopics: { Purchased: purchasedTopic } }, purchasedLog(), block(1))).resolves.toMatchObject({ eventType: "Purchased", projectionApplied: true });
    expect(store.applyPrimaryPurchase).toHaveBeenCalledWith(expect.objectContaining({ buyerWallet: bob, quantity: "2", tokenContractAddress: token }));

    const releaseStore = storeDouble();
    const mint = singleLog({ from: zero, to: bob, address: token, logIndex: 0 });
    mint.topics[1] = addrTopic(sale);
    const releaseIndexer = new BlockchainIndexer({ rpc: {}, store: releaseStore, configs: [{ chainId: 43113, address: token, contractType: "ERC1155", eventTopics: { TransferSingle: singleTopic }, skipMintOperators: [sale] }] });
    await releaseIndexer.processLog({ chainId: 43113, address: token, contractType: "ERC1155", eventTopics: { TransferSingle: singleTopic }, skipMintOperators: [sale] }, mint, block(1));
    expect(releaseStore.calls.applied[0]).toMatchObject({ eventType: "MINT", to: bob, skipOwnership: true });
  });
});

describe("Fuji worker startup", () => {
  it("initializes deterministically with marketplace functionality disabled", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = createIndexerWorker({
      config: {
        marketplace: { enabled: false, address: null, chainId: null },
        databaseUrl: "postgres://staging",
        databaseSsl: false,
        poolMax: 1,
        poolIdleTimeoutMs: 1000,
        poolConnectionTimeoutMs: 1000,
        indexer: { rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113, confirmations: 12, pollIntervalMs: 15000, contracts: [{ address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1 }] },
      },
      pool: { query: vi.fn(), end: vi.fn() },
      logger,
    });
    expect(worker).toHaveProperty("syncOnce");
    expect(logger.info).toHaveBeenCalledWith("indexer.marketplace", { status: "not_configured", address: null, chainId: null });
  });

  it("waits for an existing lease instead of exiting fatally during restart", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = {
      acquireWorkerLease: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ owner_id: "new-worker" }),
      releaseWorkerLease: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new ProductionIndexerWorker({
      indexer: { syncAll: vi.fn() },
      store,
      rpc: {},
      config: { chainId: 43113, contracts: [], leaseTtlMs: 90, pollIntervalMs: 1, ownershipReconciliationIntervalMs: 90 },
      logger,
    });
    worker.cycle = vi.fn(async () => { worker.stop(); return { stopped: true }; });

    await expect(worker.start()).resolves.toBeUndefined();
    expect(store.acquireWorkerLease).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("indexer.worker.lease.waiting", expect.objectContaining({ chainId: 43113 }));
    expect(store.releaseWorkerLease).toHaveBeenCalledWith(expect.objectContaining({ ownerId: worker.ownerId }));
  });
});

describe("durable index synchronization", () => {
  it("processes multiple contracts and prevents duplicate events", async () => {
    const store = storeDouble();
    // The filter carries every contract's address; the node answers with each contract's log.
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn(({ address }) => Promise.resolve([].concat(address).map((item) => singleLog({ blockNumber: 1, address: item, tx: `0x${item.slice(-4)}1` })))), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }, { chainId: 43114, address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await indexer.syncAll();
    await indexer.syncAll();
    expect(store.transfers).toHaveLength(2);
    expect(store.events.size).toBe(2);
    // One eth_getLogs for both contracts in the first cycle; nothing to scan in the second.
    expect(rpc.getLogs).toHaveBeenCalledTimes(1);
    expect(rpc.getLogs.mock.calls[0][0].address).toEqual(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
  });

  it("advances empty ranges without fetching every block and fetches each event block once", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(9), getLogs: vi.fn().mockResolvedValue([
      singleLog({ blockNumber: 5, tx: "0xtx5a" }),
      singleLog({ blockNumber: 5, tx: "0xtx5b", logIndex: 1 }),
    ]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 10, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic } }] });
    const [result] = await indexer.syncAll();
    expect(result.processedBlocks).toBe(10);
    expect(rpc.getBlock).toHaveBeenCalledTimes(2);
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).lastProcessedBlock).toBe(9);
    expect(store.transfers).toHaveLength(2);
  });

  it("resumes from the last checkpoint after interruption", async () => {
    const store = storeDouble();
    let failed = true;
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(3), getLogs: vi.fn(() => Promise.resolve([singleLog({ blockNumber: 1 }), singleLog({ blockNumber: 2 }), singleLog({ blockNumber: 3 })])), getBlock: vi.fn((_, number) => { if (number === 2 && failed) { failed = false; return Promise.reject(new Error("RPC interrupted")); } return Promise.resolve(block(number)); }) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow("RPC interrupted");
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).nextBlock).toBe(2);
    await indexer.syncAll();
    expect(store.calls.applied.some((item) => item.blockNumber === 3)).toBe(true);
  });

  it("defaults getLogs spans to at most 100 blocks for Avalanche public RPC limits", () => {
    expect(DEFAULT_INDEXER_CHUNK_SIZE).toBe(100);
    const indexer = new BlockchainIndexer({
      rpc: {},
      store: storeDouble(),
      configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }],
    });
    expect(indexer.chunkSize).toBe(100);
  });

  it("splits a large backlog into sequential getLogs ranges of at most 100 blocks for factory and marketplace", async () => {
    const factory = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
    const marketplace = "0x0e77116142844478a55eed2ab79de9f93770f8f5";
    const start = 97_619_965;
    const tip = start + 249;
    const store = storeDouble();
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(tip),
      getLogs: vi.fn(async ({ fromBlock, toBlock }) => {
        expect(toBlock - fromBlock + 1).toBeLessThanOrEqual(100);
        return [];
      }),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
    };
    const indexer = new BlockchainIndexer({
      rpc,
      store,
      confirmations: 0,
      configs: [
        { chainId: 43114, address: factory, contractType: "RELEASE_FACTORY", startBlock: start, eventTopics: {} },
        { chainId: 43114, address: marketplace, contractType: "MARKETPLACE", startBlock: start + 13, eventTopics: {} },
      ],
    });
    const results = await indexer.syncAll();
    expect(results).toHaveLength(2);
    const ranges = rpc.getLogs.mock.calls.map(([filter]) => ({
      addresses: [].concat(filter.address).map((item) => String(item).toLowerCase()),
      fromBlock: filter.fromBlock,
      toBlock: filter.toBlock,
      span: filter.toBlock - filter.fromBlock + 1,
    }));
    expect(ranges.every((range) => range.span <= 100)).toBe(true);
    expect(ranges.every((range) => range.span >= 1)).toBe(true);

    // One request per range for both contracts. The marketplace starts 13 blocks later; it rides the same requests
    // and its checkpoint, not the cursor, decides which returned logs it takes.
    expect(ranges).toHaveLength(3);
    expect(ranges.map((range) => [range.fromBlock, range.toBlock])).toEqual([
      [start, start + 99],
      [start + 100, start + 199],
      [start + 200, tip],
    ]);
    expect(ranges.every((range) => range.addresses.length === 2 && range.addresses.includes(factory) && range.addresses.includes(marketplace))).toBe(true);
    expect(results.map((result) => [result.address, result.processedBlocks])).toEqual([[factory, 250], [marketplace, 250 - 13]]);
    expect((await store.getCheckpoint({ chainId: 43114, address: factory })).nextBlock).toBe(tip + 1);
    expect((await store.getCheckpoint({ chainId: 43114, address: marketplace })).nextBlock).toBe(tip + 1);
  });

  it("does not skip blocks when a chunked getLogs request fails mid-backlog", async () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const store = storeDouble();
    let rejectOnce = true;
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(249),
      getLogs: vi.fn(async ({ fromBlock, toBlock }) => {
        expect(toBlock - fromBlock + 1).toBeLessThanOrEqual(100);
        if (rejectOnce && fromBlock === 100) {
          rejectOnce = false;
          throw new Error("block range too large: total block range in this request exceeds the maximum of 100 blocks");
        }
        return [];
      }),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
    };
    const indexer = new BlockchainIndexer({
      rpc,
      store,
      confirmations: 0,
      retryOptions: { retries: 0 },
      configs: [{ chainId: 43114, address, contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic } }],
    });
    await expect(indexer.syncAll()).rejects.toThrow(/block range too large/);
    expect((await store.getCheckpoint({ chainId: 43114, address })).nextBlock).toBe(100);
    await indexer.syncAll();
    const ranges = rpc.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock]);
    expect(ranges).toEqual([
      [0, 99],
      [100, 199],
      [100, 199],
      [200, 249],
    ]);
    expect((await store.getCheckpoint({ chainId: 43114, address })).nextBlock).toBe(250);
    expect((await store.getCheckpoint({ chainId: 43114, address })).lastProcessedBlock).toBe(249);
  });

  it("retries RPC failures and does not advance after a failed fetch", async () => {
    let attempts = 0;
    await expect(retry(async () => { attempts += 1; if (attempts < 3) throw new Error("RPC down"); return "ok"; }, { retries: 3, baseDelayMs: 0, sleep: async () => {} })).resolves.toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not advance checkpoints when getLogs exhausts HTTP 429 retries", async () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const store = storeDouble();
    const rateLimit = Object.assign(new Error("RPC HTTP 429"), { status: 429, retryable: true, retryAfterMs: 1_000 });
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(50),
      getLogs: vi.fn().mockRejectedValue(rateLimit),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
    };
    const indexer = new BlockchainIndexer({
      rpc,
      store,
      confirmations: 0,
      retryOptions: { retries: 2, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {}, random: () => 0 },
      configs: [{ chainId: 43114, address, contractType: "ERC1155", startBlock: 10, eventTopics: { TransferSingle: singleTopic } }],
    });
    await expect(indexer.syncAll()).rejects.toMatchObject({ status: 429 });
    expect(rpc.getLogs).toHaveBeenCalledTimes(3);
    expect(rpc.getLogs.mock.calls.every(([filter]) => filter.fromBlock === 10 && filter.toBlock === 50)).toBe(true);
    expect((await store.getCheckpoint({ chainId: 43114, address })).nextBlock).toBe(10);
    expect((await store.getCheckpoint({ chainId: 43114, address })).status).toBe("FAILED");
  });

  it("reads eth_blockNumber once per syncAll cycle across multiple contracts", async () => {
    const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const market = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const store = storeDouble();
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(20),
      getLogs: vi.fn().mockResolvedValue([]),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
    };
    const indexer = new BlockchainIndexer({
      rpc,
      store,
      confirmations: 0,
      chunkSize: 100,
      configs: [
        { chainId: 43114, address: factory, contractType: "RELEASE_FACTORY", startBlock: 10, eventTopics: {} },
        { chainId: 43114, address: market, contractType: "MARKETPLACE", startBlock: 10, eventTopics: {} },
      ],
    });
    await indexer.syncAll();
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
    expect((await store.getCheckpoint({ chainId: 43114, address: factory })).nextBlock).toBe(21);
    expect((await store.getCheckpoint({ chainId: 43114, address: market })).nextBlock).toBe(21);
  });

  it("recovers and advances the checkpoint after a transient 429 on getLogs", async () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const store = storeDouble();
    const rateLimit = Object.assign(new Error("RPC HTTP 429"), { status: 429, retryable: true, retryAfterMs: 1_000 });
    let logsCalls = 0;
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(15),
      getLogs: vi.fn(async () => {
        logsCalls += 1;
        if (logsCalls === 1) throw rateLimit;
        return [];
      }),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
    };
    const indexer = new BlockchainIndexer({
      rpc,
      store,
      confirmations: 0,
      retryOptions: { retries: 2, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {}, random: () => 0, deferRateLimitDelay: true },
      configs: [{ chainId: 43114, address, contractType: "ERC1155", startBlock: 10, eventTopics: { TransferSingle: singleTopic } }],
    });
    await indexer.syncAll();
    expect(logsCalls).toBe(1 + 1);
    expect((await store.getCheckpoint({ chainId: 43114, address })).nextBlock).toBe(16);
    expect((await store.getCheckpoint({ chainId: 43114, address })).status).toBe("IDLE");
  });

  it("marks a changed block hash as a reorganization", async () => {
    const store = storeDouble({ blocks: new Map([["43114:2", { block_hash: "0xold" }]]) });
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => Promise.resolve(block(number, number === 2 ? "0xnew" : undefined))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 2, eventTopics: { TransferSingle: singleTopic } }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(1);
  });

  it("rewinds from a divergent persisted checkpoint on restart and replays the replacement canonical block", async () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const checkpoints = new Map([[`43114:${address}`, { chain_id: 43114, contract_address: address, nextBlock: 4, last_processed_block: 3, last_processed_hash: "0xold3" }]]);
    const blocks = new Map([["43114:2", { block_hash: "0xcanonical2" }], ["43114:3", { block_hash: "0xold3" }]]);
    const store = storeDouble({ checkpoints, blocks });
    store.handleReorg = async (value) => { store.calls.reorgs.push(value); blocks.delete("43114:3"); };
    const rpc = {
      getBlockNumber: vi.fn().mockResolvedValue(3),
      getLogs: vi.fn().mockResolvedValue([singleLog({ blockNumber: 3, tx: "0xreplacement3" })]),
      getBlock: vi.fn((_, number) => Promise.resolve(block(number, number === 2 ? "0xcanonical2" : "0xreplacement3"))),
    };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address, contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
    expect(store.calls.reorgs).toEqual([expect.objectContaining({ chainId: 43114, fromBlock: 3, replacementHash: "0xreplacement3" })]);
    expect(store.calls.applied).toContainEqual(expect.objectContaining({ blockNumber: 3, transactionHash: "0xreplacement3" }));
  });

  it("does not advance a checkpoint across a missing block gap", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(2), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => number === 2 ? Promise.resolve(null) : Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow();
    expect((await store.getCheckpoint({ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).nextBlock).toBe(2);
  });

  it("persists failure state when the checkpoint database write fails", async () => {
    const store = storeDouble();
    store.setCheckpoint = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn().mockResolvedValue(block(1)) };
    const logger = { error: vi.fn() };
    const indexer = new BlockchainIndexer({ rpc, store, logger, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).rejects.toThrow("database unavailable");
    expect(logger.error).toHaveBeenCalledWith("indexer.failure.persistence.failed", expect.objectContaining({ originalError: "database unavailable" }));
  });

  it("records malformed events without stopping the synchronization loop", async () => {
    const store = storeDouble();
    const malformed = { ...singleLog(), topics: [singleTopic], data: "0x01" };
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1), getLogs: vi.fn().mockResolvedValue([malformed]), getBlock: vi.fn().mockResolvedValue(block(1)) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [{ chainId: 43114, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contractType: "ERC1155", startBlock: 1, eventTopics: { TransferSingle: singleTopic } }] });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
    expect(store.calls.errors[0].errorType).toBe("MALFORMED_EVENT");
  });
});

// Mirrors what IndexerStore returns from Postgres: snake_case rows with bigint columns as strings,
// and the forward-only next_block guard enforced by setCheckpoint.
function pgRowStore({ row = null, blocks = new Map() } = {}) {
  let checkpoint = row;
  const history = [];
  const calls = { reorgs: [], writes: [] };
  return {
    calls, history, blocks,
    get row() { return checkpoint; },
    async getCheckpoint() { return checkpoint ? { ...checkpoint } : null; },
    async setCheckpoint(value) {
      calls.writes.push(value);
      if (checkpoint && !value.allowRewind && value.nextBlock < Number(checkpoint.next_block)) throw new CheckpointRegressionError({ chainId: value.chainId, contractAddress: value.address, nextBlock: value.nextBlock });
      checkpoint = {
        ...checkpoint,
        chain_id: String(value.chainId), contract_address: value.address, contract_type: value.contractType, next_block: String(value.nextBlock), status: value.status,
        ...(value.lastProcessedBlock !== undefined ? { last_processed_block: String(value.lastProcessedBlock) } : {}),
        ...(value.lastError !== undefined ? { last_error: value.lastError } : {}),
        rpc_failures: (checkpoint?.rpc_failures ?? 0) + (value.rpcFailure ? 1 : 0),
      };
      history.push(Number(checkpoint.next_block));
      return checkpoint;
    },
    async getBlock({ chainId, blockNumber }) { const stored = blocks.get(`${chainId}:${blockNumber}`); return stored ? { block_hash: stored } : null; },
    async recordBlock(value) { blocks.set(`${value.chainId}:${value.blockNumber}`, value.blockHash); },
    async handleReorg(value) { calls.reorgs.push(value); for (const key of [...blocks.keys()]) if (Number(key.split(":")[1]) >= value.fromBlock) blocks.delete(key); },
    async recordEvent(value) { return value; },
    async applyTransfer(value) { return value; },
    async recordIndexerError() {},
  };
}

describe("checkpoint rewind regression (Fuji 43113)", () => {
  const address = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
  const startBlock = 58_428_586;
  const config = { chainId: 43113, address, contractType: "ERC1155", startBlock, eventTopics: { TransferSingle: singleTopic } };
  const chainRpc = (head, hashOf = (n) => `0xblock${n}`) => ({
    head,
    getBlockNumber: vi.fn(function () { return Promise.resolve(this.head); }),
    getLogs: vi.fn().mockResolvedValue([]),
    getBlock: vi.fn((_, n) => Promise.resolve(block(n, hashOf(n)))),
  });

  it("resumes from the persisted next_block instead of restarting at startBlock", async () => {
    const store = pgRowStore({ row: { chain_id: "43113", contract_address: address, next_block: "58647586", last_processed_block: "58647585" }, blocks: new Map([["43113:58647585", "0xblock58647585"]]) });
    const rpc = chainRpc(58_648_000);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 12, chunkSize: 500, configs: [config] });
    const [result] = await indexer.syncAll();
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(58_647_586);
    expect(rpc.getLogs.mock.calls.every(([range]) => range.fromBlock >= 58_647_586)).toBe(true);
    expect(store.calls.reorgs).toHaveLength(0);
    expect(result.nextBlock).toBe(58_648_000 - 12 + 1);
    expect(Math.min(...store.history)).toBeGreaterThanOrEqual(58_647_586);
  });

  it("keeps the checkpoint monotonic across repeated cycles while the head advances", async () => {
    const store = pgRowStore();
    const rpc = chainRpc(startBlock + 1_000);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 12, chunkSize: 500, configs: [config] });
    const observed = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await indexer.syncAll();
      observed.push(Number(store.row.last_processed_block));
      rpc.head += 700;
    }
    for (let i = 1; i < observed.length; i += 1) expect(observed[i]).toBeGreaterThan(observed[i - 1]);
    for (let i = 1; i < store.history.length; i += 1) expect(store.history[i]).toBeGreaterThanOrEqual(store.history[i - 1]);
    expect(store.calls.reorgs).toHaveLength(0);
  });

  it("does not treat a missing stored block hash as a reorg", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:990", "0xblock990"]]) });
    const rpc = chainRpc(1_100);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 500, configs: [{ ...config, startBlock: 900 }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(0);
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(1_001);
  });

  it("rewinds to the common ancestor on a genuine hash mismatch and then converges forward", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:998", "0xblock998"], ["43113:999", "0xorphan999"], ["43113:1000", "0xorphan1000"]]) });
    const rpc = chainRpc(1_010);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, chunkSize: 500, configs: [{ ...config, startBlock: 900 }] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toEqual([expect.objectContaining({ chainId: 43113, fromBlock: 999, replacementHash: "0xblock999" })]);
    expect(rpc.getLogs.mock.calls[0][0].fromBlock).toBe(999);
    expect(Number(store.row.next_block)).toBe(1_011);
    rpc.head = 1_020;
    await indexer.syncAll();
    expect(store.calls.reorgs).toHaveLength(1);
    expect(Number(store.row.next_block)).toBe(1_021);
  });

  it("refuses an older checkpoint write that is not a verified reorg", async () => {
    const store = pgRowStore({ row: { next_block: "58647586", last_processed_block: "58647585" } });
    await expect(store.setCheckpoint({ chainId: 43113, address, contractType: "ERC1155", nextBlock: 58_433_086, status: "RUNNING" })).rejects.toBeInstanceOf(CheckpointRegressionError);
    expect(store.row.next_block).toBe("58647586");
  });

  it("reports a meaningful error and keeps the checkpoint when verification cannot read the chain", async () => {
    const store = pgRowStore({ row: { next_block: "1001", last_processed_block: "1000" }, blocks: new Map([["43113:1000", "0xblock1000"]]) });
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(1_100), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn().mockResolvedValue(null) };
    const indexer = new BlockchainIndexer({ rpc, store, logger: { error: vi.fn() }, confirmations: 0, retryOptions: { retries: 0 }, configs: [{ ...config, startBlock: 900 }] });
    await expect(indexer.syncAll()).rejects.toThrow("RPC returned no canonical hash for block 1000 during checkpoint verification.");
    expect(store.row).toMatchObject({ next_block: "1001", status: "FAILED", rpc_failures: 1 });
    expect(store.calls.reorgs).toHaveLength(0);
  });
});

describe("ownership reconciliation", () => {
  it("compares indexed balances with finalized RPC state", async () => {
    const errors = [];
    const result = await reconcileOwnership({ rpc: { getBalanceOf: vi.fn().mockResolvedValue(2n) }, store: { getOwnership: vi.fn().mockResolvedValue({ amount: "1" }), recordIndexerError: vi.fn((value) => errors.push(value)) }, chainId: 43114, contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", assets: [1, 2], wallets: [bob], retryOptions: { retries: 0 } });
    expect(result.every((item) => item.match === false)).toBe(true);
    expect(errors).toHaveLength(2);
  });
});

describe("primary purchase finalization sweep", () => {
  const sale = "0xcccccccccccccccccccccccccccccccccccccccc";
  const setup = ({ contractType = "PRIMARY_SALE", finalize } = {}) => {
    const store = { ...storeDouble(), finalizePrimaryPurchases: finalize || vi.fn().mockResolvedValue({ finalized: 1 }) };
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(20), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const logger = { error: vi.fn() };
    const indexer = new BlockchainIndexer({ rpc, store, logger, confirmations: 12, configs: [{ chainId: 43113, address: sale.toUpperCase().replace("0X", "0x"), contractType, startBlock: 0, eventTopics: {} }] });
    return { store, indexer, logger };
  };

  it("finalizes through head minus confirmations after the checkpoint is saved, every cycle", async () => {
    const { store, indexer } = setup();
    await indexer.syncAll();
    await indexer.syncAll();
    expect(store.finalizePrimaryPurchases).toHaveBeenCalledTimes(2);
    expect(store.finalizePrimaryPurchases).toHaveBeenCalledWith({ chainId: 43113, saleAddress: sale, finalizedBlock: 8 });
  });

  it("does not sweep non-sale contracts", async () => {
    const { store, indexer } = setup({ contractType: "ERC1155" });
    await indexer.syncAll();
    expect(store.finalizePrimaryPurchases).not.toHaveBeenCalled();
  });

  it("logs a sweep failure without failing synchronization or the checkpoint", async () => {
    const { store, indexer, logger } = setup({ finalize: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith("indexer.primary-purchase.finalize.failed", expect.objectContaining({ error: "db down" }));
    expect(store.calls.errors).toHaveLength(0);
  });

  it("works against stores that predate the sweep", async () => {
    const store = storeDouble();
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(20), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 12, configs: [{ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", startBlock: 0, eventTopics: {} }] });
    await expect(indexer.syncAll()).resolves.toHaveLength(1);
  });
});

// Regression: the mainnet worker shares one paced public RPC between every release, sale, factory and marketplace.
// Without a per-cycle budget, one contract's long backlog ran to completion before the next contract got a turn,
// so a release or sale discovered later waited hours for its first blocks and every other contract's freshness
// stamp refreshed once per multi-hour cycle.
describe("per-cycle chunk budget (INDEXER_MAX_CHUNKS_PER_CYCLE): fair catch-up across contracts", () => {
  const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const rpcFor = (tip) => ({ getBlockNumber: vi.fn().mockResolvedValue(tip), getLogs: vi.fn().mockResolvedValue([]), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) });
  const erc1155 = (address) => ({ chainId: 43114, address, contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic } });
  const ranges = (rpc) => rpc.getLogs.mock.calls.map(([filter]) => [[].concat(filter.address).map((item) => String(item).toLowerCase()).join(","), filter.fromBlock, filter.toBlock]);

  it("defaults to a finite budget and refuses a non-positive one", () => {
    expect(new BlockchainIndexer({ rpc: rpcFor(0), store: storeDouble(), configs: [erc1155(a)] }).maxChunksPerCycle).toBe(DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE);
    expect(new BlockchainIndexer({ rpc: rpcFor(0), store: storeDouble(), configs: [erc1155(a)], maxChunksPerCycle: Infinity }).maxChunksPerCycle).toBe(Infinity);
    for (const value of [0, -1, 1.5, "many", null]) expect(() => new BlockchainIndexer({ rpc: rpcFor(0), store: storeDouble(), configs: [erc1155(a)], maxChunksPerCycle: value })).toThrow(/maxChunksPerCycle must be a positive integer/);
  });

  it("scans every contract of the chain in one eth_getLogs per range: a backlog is shared, never serialized", async () => {
    const store = storeDouble();
    const rpc = rpcFor(249);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)], maxChunksPerCycle: 1 });
    const first = await indexer.syncAll();
    expect(ranges(rpc)).toEqual([[`${a},${b}`, 0, 99]]);
    expect(first.map(({ address, state, partial, nextBlock, finalizedBlock, targetBlock, remainingBlocks, processedBlocks }) => ({ address, state, partial, nextBlock, finalizedBlock, targetBlock, remainingBlocks, processedBlocks })))
      .toEqual([a, b].map((address) => ({ address, state: "CATCHING_UP", partial: true, nextBlock: 100, finalizedBlock: 99, targetBlock: 249, remainingBlocks: 150, processedBlocks: 100 })));
    for (const address of [a, b]) {
      // Partial progress is persisted as RUNNING and never as a successful run: ownership freshness stays closed.
      const checkpoint = await store.getCheckpoint({ chainId: 43114, address });
      expect(checkpoint).toMatchObject({ nextBlock: 100, lastProcessedBlock: 99, finalizedBlock: 99, status: "RUNNING" });
      expect(checkpoint.markRunSucceeded).toBeFalsy();
    }
    expect(store.calls.checkpoints.filter((write) => write.markRunSucceeded)).toHaveLength(0);
    // The next cycles resume from the persisted next_block, still alternating, until both reach the target.
    const second = await indexer.syncAll();
    expect(second.map((result) => [result.state, result.nextBlock])).toEqual([["CATCHING_UP", 200], ["CATCHING_UP", 200]]);
    const third = await indexer.syncAll();
    expect(third.map((result) => [result.state, result.partial, result.nextBlock, result.finalizedBlock, result.remainingBlocks])).toEqual([["CONFIRMED", false, 250, 249, 0], ["CONFIRMED", false, 250, 249, 0]]);
    expect(ranges(rpc)).toEqual([[`${a},${b}`, 0, 99], [`${a},${b}`, 100, 199], [`${a},${b}`, 200, 249]]);
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 250, lastProcessedBlock: 249, finalizedBlock: 249, status: "IDLE", markRunSucceeded: true });
    // Still one tip read per cycle.
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(3);
  });

  it("INDEXER_BATCH_CONTRACTS=false restores one eth_getLogs per contract per range", async () => {
    const store = storeDouble();
    const rpc = rpcFor(249);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)], maxChunksPerCycle: 1, batchContracts: false });
    expect(indexer.batchContracts).toBe(false);
    await indexer.syncAll();
    expect(ranges(rpc)).toEqual([[a, 0, 99], [b, 0, 99]]);
    await indexer.syncAll();
    await indexer.syncAll();
    expect(ranges(rpc)).toEqual([[a, 0, 99], [b, 0, 99], [a, 100, 199], [b, 100, 199], [a, 200, 249], [b, 200, 249]]);
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 250, status: "IDLE", markRunSucceeded: true });
  });

  // Mainnet measurement (2026-10-24): every empty 100-block chunk cost two paced RPC calls (eth_getLogs plus the
  // end-block eth_getBlockByNumber used only as a reorg anchor), so ten contracts × 20 chunks × 2 × 5 s ≈ 33 min
  // per cycle, about what the chain advanced in the same time. Anchoring only the call's last chunk halves that.
  it("fetches an end-block anchor only for the call's last chunk, keeping the persisted checkpoint anchored", async () => {
    const store = storeDouble();
    const rpc = rpcFor(449);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a)], maxChunksPerCycle: 3 });
    await expect(indexer.syncAll()).resolves.toMatchObject([{ state: "CATCHING_UP", nextBlock: 300, finalizedBlock: 299 }]);
    expect(ranges(rpc)).toEqual([[a, 0, 99], [a, 100, 199], [a, 200, 299]]);
    // Three getLogs, one anchor: the checkpoint's last processed block is recorded and nothing else was fetched.
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([299]);
    expect(await store.getBlock({ chainId: 43114, blockNumber: 299 })).toMatchObject({ block_hash: "0xblock299" });
    expect(await store.getCheckpoint({ chainId: 43114, address: a })).toMatchObject({ nextBlock: 300, lastProcessedBlock: 299, finalizedBlock: 299, status: "RUNNING" });
    // The next cycle completes with the target block anchored (this store double does not expose
    // last_processed_block, so checkpoint verification, covered below, is not exercised here).
    await expect(indexer.syncAll()).resolves.toMatchObject([{ state: "CONFIRMED", nextBlock: 450, finalizedBlock: 449 }]);
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([299, 449]);
    expect(await store.getBlock({ chainId: 43114, blockNumber: 449 })).toMatchObject({ block_hash: "0xblock449" });
  });

  it("still fetches and records every block that carries a log inside an intermediate chunk", async () => {
    const store = storeDouble();
    const rpc = rpcFor(299);
    rpc.getLogs = vi.fn(async ({ fromBlock }) => (fromBlock === 0 ? [singleLog({ blockNumber: 42, address: a }), singleLog({ blockNumber: 77, address: a, tx: "0xtx77" })] : []));
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a)], maxChunksPerCycle: 3 });
    await expect(indexer.syncAll()).resolves.toMatchObject([{ state: "CONFIRMED", nextBlock: 300 }]);
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([42, 77, 299]);
    expect(store.transfers.map((transfer) => transfer.blockNumber)).toEqual([42, 77]);
    expect(await store.getBlock({ chainId: 43114, blockNumber: 77 })).toMatchObject({ block_hash: "0xblock77" });
  });

  it("never marks a checkpoint's finalized block ahead of the blocks actually indexed", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: rpcFor(249), store, confirmations: 0, configs: [erc1155(a)], maxChunksPerCycle: 2 });
    await indexer.syncAll();
    for (const write of store.calls.checkpoints.filter((item) => item.finalizedBlock !== undefined)) expect(write.finalizedBlock).toBeLessThanOrEqual(write.lastProcessedBlock);
    expect(store.calls.checkpoints.at(-1)).toMatchObject({ nextBlock: 200, lastProcessedBlock: 199, finalizedBlock: 199, status: "RUNNING" });
  });

  it("finalizes sale rows only through the indexed block while catching up, and through the target once complete", async () => {
    const sale = "0xcccccccccccccccccccccccccccccccccccccccc";
    const store = { ...storeDouble(), finalizePrimaryPurchases: vi.fn().mockResolvedValue({ finalized: 0 }), finalizePrimarySaleSettlements: vi.fn().mockResolvedValue({ finalized: 0 }) };
    const indexer = new BlockchainIndexer({ rpc: rpcFor(249), store, confirmations: 0, configs: [{ chainId: 43113, address: sale, contractType: "PRIMARY_SALE", startBlock: 0, eventTopics: {} }], maxChunksPerCycle: 2 });
    await indexer.syncAll();
    expect(store.finalizePrimaryPurchases).toHaveBeenLastCalledWith({ chainId: 43113, saleAddress: sale, finalizedBlock: 199 });
    expect(store.finalizePrimarySaleSettlements).toHaveBeenLastCalledWith({ chainId: 43113, saleAddress: sale, finalizedBlock: 199 });
    await indexer.syncAll();
    expect(store.finalizePrimaryPurchases).toHaveBeenLastCalledWith({ chainId: 43113, saleAddress: sale, finalizedBlock: 249 });
    expect(store.finalizePrimarySaleSettlements).toHaveBeenLastCalledWith({ chainId: 43113, saleAddress: sale, finalizedBlock: 249 });
  });

  it("indexes a release and sale discovered this cycle even while an earlier contract is still catching up", async () => {
    const factory = "0xffffffffffffffffffffffffffffffffffffffff";
    const release = "0xdddddddddddddddddddddddddddddddddddddddd";
    const sale = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const artist = alice;
    const releaseCreatedTopic = "0xreleasecreated";
    const created = { address: factory, topics: [releaseCreatedTopic, addrTopic(release), `0x${"ab".repeat(32)}`, addrTopic(artist)], data: `0x${word(sale)}${word(zero)}${word(zero)}${word(1)}${word(4)}`, transactionHash: "0xtxfactory", blockNumber: 5, blockHash: "0xblock5", logIndex: 0 };
    const store = { ...storeDouble(), registerRelease: vi.fn().mockResolvedValue() };
    // The node returns the ReleaseCreated log whenever the factory is in the filter and the range covers block 5.
    const rpc = { getBlockNumber: vi.fn().mockResolvedValue(249), getLogs: vi.fn(async ({ address, fromBlock, toBlock }) => ([].concat(address).map((item) => String(item).toLowerCase()).includes(factory) && fromBlock <= 5 && toBlock >= 5 ? [created] : [])), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) };
    const indexer = new BlockchainIndexer({
      rpc, store, confirmations: 0, maxChunksPerCycle: 2,
      configs: [{ chainId: 43114, address: factory, contractType: "RELEASE_FACTORY", startBlock: 0, eventTopics: { ReleaseCreated: releaseCreatedTopic } }, erc1155(a)],
    });
    const results = await indexer.syncAll();
    expect(store.registerRelease).toHaveBeenCalledTimes(1);
    expect(store.registerRelease).toHaveBeenCalledWith(expect.objectContaining({ releaseContractAddress: release, primarySaleAddress: sale, blockNumber: 5 }));
    // The first chunk scanned the factory and the pre-existing release together. The sale and release it announced
    // joined before the second chunk: the cursor dropped back to their creation block, the request carried all four
    // addresses, and the two contracts already past block 99 took nothing from the re-covered blocks (the factory's
    // ReleaseCreated came back a second time and was not registered again).
    expect(ranges(rpc)).toEqual([[`${factory},${a}`, 0, 99], [`${factory},${a},${sale},${release}`, 5, 104]]);
    expect(results.map((result) => [result.address, result.nextBlock, result.partial])).toEqual([[factory, 105, true], [a, 105, true], [sale, 105, true], [release, 105, true]]);
    for (const address of [factory, a]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 105, lastProcessedBlock: 104 });
    for (const address of [sale, release]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 105, lastProcessedBlock: 104, status: "RUNNING" });
  });
});

// Mainnet measurement (2026-10-24/25): ten contracts × (20 eth_getLogs + 1 anchor + 1 checkpoint verification) + 1
// tip read = 221 paced calls per cycle, 32–35 min per cycle under the public endpoint's 429 gates. One address-array
// request per range for the whole chain cuts that to ~23 calls per cycle; the public C-Chain endpoint accepts an
// address array over the same 100-block span (verified read-only against api.avax.network on 2026-10-25).
describe("batched eth_getLogs across contracts (INDEXER_BATCH_CONTRACTS)", () => {
  const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const c = "0xcccccccccccccccccccccccccccccccccccccccc";
  const erc1155 = (address, extra = {}) => ({ chainId: 43114, address, contractType: "ERC1155", startBlock: 0, eventTopics: { TransferSingle: singleTopic }, ...extra });
  const filters = (rpc) => rpc.getLogs.mock.calls.map(([filter]) => [[].concat(filter.address), filter.fromBlock, filter.toBlock]);
  const rpcFor = (tip, logs = async () => []) => ({ getBlockNumber: vi.fn().mockResolvedValue(tip), getLogs: vi.fn(logs), getBlock: vi.fn((_, number) => Promise.resolve(block(number))) });
  // Mirrors the transfers table: ON CONFLICT (chain, tx, log_index) DO NOTHING.
  const dedupingStore = (options) => {
    const store = storeDouble(options);
    const seen = new Set();
    const apply = store.applyTransfer.bind(store);
    store.applyTransfer = async (value) => { const key = `${value.transactionHash}:${value.logIndex}`; if (seen.has(key)) return { duplicate: true }; seen.add(key); return apply(value); };
    return store;
  };

  it("dispatches each returned log to the contract that emitted it and reports a log from outside the filter", async () => {
    const store = storeDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stray = singleLog({ blockNumber: 2, address: c, tx: "0xstray" });
    const rpc = rpcFor(9, async () => [singleLog({ blockNumber: 1, address: a, tx: "0xa1" }), singleLog({ blockNumber: 2, address: b, tx: "0xb2" }), stray]);
    const indexer = new BlockchainIndexer({ rpc, store, logger, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    const results = await indexer.syncAll();
    expect(filters(rpc)).toEqual([[[a, b], 0, 9]]);
    expect(store.transfers.map((transfer) => [transfer.contractAddress, transfer.blockNumber])).toEqual([[a, 1], [b, 2]]);
    expect([...store.events.values()].map((event) => event.contractAddress)).toEqual([a, b]);
    expect(store.calls.errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("indexer.sync.unexpected_log", expect.objectContaining({ address: c, blockNumber: 2 }));
    expect(results.map((result) => [result.address, result.state, result.nextBlock])).toEqual([[a, "CONFIRMED", 10], [b, "CONFIRMED", 10]]);
    // Blocks 1 and 2 (events) and 9 (anchor) were fetched once each, not once per contract.
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([1, 2, 9]);
    expect(logger.info).toHaveBeenCalledWith("indexer.sync.group.completed", expect.objectContaining({ chainId: 43114, contracts: 2, chunks: 1, rpcCalls: { getLogs: 1, getBlock: 3 } }));
  });

  it("costs one eth_getLogs per chunk and one anchor per call on empty ranges, for any number of contracts", async () => {
    const store = storeDouble();
    const rpc = rpcFor(299);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b), erc1155(c)] });
    await indexer.syncAll();
    expect(filters(rpc)).toEqual([[[a, b, c], 0, 99], [[a, b, c], 100, 199], [[a, b, c], 200, 299]]);
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([299]);
    for (const address of [a, b, c]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 300, lastProcessedBlock: 299, finalizedBlock: 299, status: "IDLE" });
  });

  it("records a malformed event for one contract without blocking the other contracts' logs in the same block", async () => {
    const store = storeDouble();
    const malformed = { ...singleLog({ blockNumber: 1, address: a, tx: "0xbad" }), topics: [singleTopic], data: "0x01" };
    const rpc = rpcFor(1, async () => [malformed, singleLog({ blockNumber: 1, address: b, tx: "0xgood", logIndex: 1 })]);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    await expect(indexer.syncAll()).resolves.toHaveLength(2);
    expect(store.calls.errors.map((error) => [error.errorType, error.contractAddress])).toEqual([["MALFORMED_EVENT", a]]);
    expect(store.transfers.map((transfer) => transfer.transactionHash)).toEqual(["0xgood"]);
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 2, status: "IDLE" });
  });

  it("processes a log the node returned twice exactly once", async () => {
    const store = dedupingStore();
    const twice = singleLog({ blockNumber: 3, address: a, tx: "0xdup" });
    const rpc = rpcFor(5, async () => [twice, { ...twice }]);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    await indexer.syncAll();
    expect(store.events.size).toBe(1);
    expect(store.transfers).toHaveLength(1);
  });

  it("resumes every member at the failed block after a block fetch fails mid-chunk, without re-applying processed logs", async () => {
    const store = dedupingStore();
    let failOnce = true;
    const rpc = rpcFor(9, async ({ fromBlock, toBlock }) => [singleLog({ blockNumber: 3, address: a, tx: "0xa3" }), singleLog({ blockNumber: 7, address: b, tx: "0xb7" })].filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
    rpc.getBlock = vi.fn((_, number) => { if (number === 7 && failOnce) { failOnce = false; return Promise.reject(new Error("RPC interrupted")); } return Promise.resolve(block(number)); });
    const indexer = new BlockchainIndexer({ rpc, store, logger: { info() {}, warn() {}, error() {} }, confirmations: 0, retryOptions: { retries: 0 }, configs: [erc1155(a), erc1155(b)] });
    await expect(indexer.syncAll()).rejects.toThrow("RPC interrupted");
    // Block 3 was fully processed for both members before block 7 failed: both resume at 7.
    for (const address of [a, b]) {
      expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 7, status: "FAILED" });
      expect(store.calls.checkpoints.find((write) => write.address === address && write.status === "FAILED")).toMatchObject({ nextBlock: 7, lastProcessedBlock: 6 });
    }
    await expect(indexer.syncAll()).resolves.toHaveLength(2);
    expect(filters(rpc).map(([, from, to]) => [from, to])).toEqual([[0, 9], [7, 9]]);
    expect(store.transfers.map((transfer) => transfer.transactionHash)).toEqual(["0xa3", "0xb7"]);
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 10, status: "IDLE" });
  });

  it("advances nothing and marks every member FAILED when the shared eth_getLogs fails", async () => {
    const store = storeDouble();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let failOnce = true;
    const rpc = rpcFor(49, async () => { if (failOnce) { failOnce = false; throw Object.assign(new Error("RPC HTTP 429"), { status: 429, retryable: true }); } return []; });
    const indexer = new BlockchainIndexer({ rpc, store, logger, confirmations: 0, retryOptions: { retries: 0 }, configs: [erc1155(a, { startBlock: 10 }), erc1155(b, { startBlock: 10 })] });
    await expect(indexer.syncAll()).rejects.toMatchObject({ status: 429 });
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 10, status: "FAILED", rpcFailure: true });
    expect(logger.error).toHaveBeenCalledWith("indexer.sync.failed", expect.objectContaining({ address: [a, b], nextBlock: 10 }));
    await expect(indexer.syncAll()).resolves.toHaveLength(2);
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 50, status: "IDLE" });
  });

  it("rewinds every member of the group when an event block's canonical hash changed", async () => {
    const store = storeDouble({ blocks: new Map([["43114:2", { block_hash: "0xold" }]]) });
    const rpc = rpcFor(2, async () => [singleLog({ blockNumber: 2, address: a, tx: "0xa2" })]);
    rpc.getBlock = vi.fn((_, number) => Promise.resolve(block(number, number === 2 ? "0xnew" : undefined)));
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    await indexer.syncAll();
    expect(store.calls.reorgs).toEqual([expect.objectContaining({ chainId: 43114, fromBlock: 2, replacementHash: "0xnew" })]);
    expect(store.calls.checkpoints.filter((write) => write.status === "REORGING").map((write) => write.address)).toEqual([a, b]);
    expect(await store.getBlock({ chainId: 43114, blockNumber: 2 })).toMatchObject({ block_hash: "0xnew" });
    for (const address of [a, b]) expect(await store.getCheckpoint({ chainId: 43114, address })).toMatchObject({ nextBlock: 3, status: "IDLE" });
  });

  it("verifies aligned persisted checkpoints with one canonical read per cycle", async () => {
    const rows = new Map([[a, { next_block: "100", last_processed_block: "99" }], [b, { next_block: "100", last_processed_block: "99" }]]);
    const store = storeDouble({ blocks: new Map([["43114:99", { block_hash: "0xblock99" }]]) });
    store.getCheckpoint = async ({ address }) => rows.get(address) || null;
    const rpc = rpcFor(149);
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    await indexer.syncAll();
    // Block 99 verified once for both members, block 149 anchored once: two reads, not four.
    expect(rpc.getBlock.mock.calls.map(([, number]) => number)).toEqual([99, 149]);
    expect(store.calls.reorgs).toEqual([]);
    expect(filters(rpc)).toEqual([[[a, b], 100, 149]]);
  });

  it("keeps a member ahead of the cursor out of the filter until the cursor reaches it, and never re-reads its indexed blocks", async () => {
    const store = storeDouble();
    store.getCheckpoint = async ({ address }) => (address === b ? { nextBlock: 150 } : null);
    const logs = [singleLog({ blockNumber: 120, address: b, tx: "0xb120" }), singleLog({ blockNumber: 160, address: b, tx: "0xb160" }), singleLog({ blockNumber: 40, address: a, tx: "0xa40" })];
    const rpc = rpcFor(249, async ({ address, fromBlock, toBlock }) => logs.filter((log) => [].concat(address).includes(log.address) && log.blockNumber >= fromBlock && log.blockNumber <= toBlock));
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [erc1155(a), erc1155(b)] });
    const results = await indexer.syncAll();
    expect(filters(rpc)).toEqual([[[a], 0, 99], [[a, b], 100, 199], [[a, b], 200, 249]]);
    // b's log at 120 precedes its own checkpoint (150): the node returned it, the indexer did not take it.
    expect(store.transfers.map((transfer) => transfer.transactionHash)).toEqual(["0xa40", "0xb160"]);
    expect(results.map((result) => [result.address, result.processedBlocks, result.state])).toEqual([[a, 250, "CONFIRMED"], [b, 100, "CONFIRMED"]]);
  });

  it("applies the chunk budget to the group and leaves a member beyond the budget untouched this cycle", async () => {
    const store = storeDouble();
    store.getCheckpoint = async ({ address }) => (address === b ? { nextBlock: 500 } : null);
    const rpc = rpcFor(999);
    const indexer = new BlockchainIndexer({ rpc, store, logger: { info() {}, warn() {}, error() {} }, confirmations: 0, maxChunksPerCycle: 2, configs: [erc1155(a), erc1155(b)] });
    const results = await indexer.syncAll();
    expect(filters(rpc)).toEqual([[[a], 0, 99], [[a], 100, 199]]);
    expect(results.map((result) => [result.address, result.nextBlock, result.state, result.processedBlocks])).toEqual([[a, 200, "CATCHING_UP", 200], [b, 500, "CATCHING_UP", 0]]);
    // Both are reported partial, so the worker defers the ownership comparison until the group is aligned.
    expect(results.every((result) => result.partial)).toBe(true);
    expect(store.calls.checkpoints.filter((write) => write.address === b).at(-1)).toMatchObject({ nextBlock: 500, lastProcessedBlock: 499, status: "RUNNING" });
    expect(store.calls.checkpoints.some((write) => write.address === b && write.markRunSucceeded)).toBe(false);
  });
});
