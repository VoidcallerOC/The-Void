import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AbiCoder, id } from "ethers";
import { BlockchainIndexer, decodeCollectionCreatedLog, decodePurchasedV2Log } from "./indexer.js";
import { loadIndexerConfig } from "./config.js";

// Per-collection contracts: the indexer discovers each collection from the
// VoidCollectionFactory and indexes VoidPrimarySaleV2 purchases against it.

const FACTORY = "0xfac0000000000000000000000000000000000001";
const SALE_V2 = "0x5a1e000000000000000000000000000000000002";
const COLLECTION = "0xc011000000000000000000000000000000000003";
const ARTIST = "0xa11ce00000000000000000000000000000000004";
const BUYER = "0xb0b0000000000000000000000000000000000005";
const ZERO = "0x0000000000000000000000000000000000000000";
const CREATED = id("CollectionCreated(address,address,uint256,string,string,string)");
const PURCHASED_V2 = id("Purchased(address,uint256,address,uint256,uint256,uint256,uint256)");
const TRANSFER_SINGLE = id("TransferSingle(address,address,address,uint256,uint256)");
const coder = AbiCoder.defaultAbiCoder();
const topicOf = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const uintTopic = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const block = (number) => ({ number, hash: `0xblock${number}`, parentHash: `0xblock${number - 1}`, timestamp: 1_700_000_000 + number });

const createdLog = ({ blockNumber = 5, factory = FACTORY } = {}) => ({
  address: factory, topics: [CREATED, topicOf(COLLECTION), topicOf(ARTIST), uintTopic(0)],
  data: coder.encode(["string", "string", "string"], ["Alpha Collection", "ALPHA", "ipfs://alpha-contract"]),
  transactionHash: `0x${"c1".repeat(32)}`, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex: 0,
});
const purchasedLog = ({ blockNumber = 7, collection = COLLECTION } = {}) => ({
  address: SALE_V2, topics: [PURCHASED_V2, topicOf(collection), uintTopic(42), topicOf(BUYER)],
  data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [2n, 2000n, 1900n, 100n]),
  transactionHash: `0x${"d2".repeat(32)}`, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex: 1,
});
const mintLog = ({ blockNumber = 7 } = {}) => ({
  address: COLLECTION, topics: [TRANSFER_SINGLE, topicOf(SALE_V2), topicOf(ZERO), topicOf(BUYER)],
  data: coder.encode(["uint256", "uint256"], [42n, 2n]),
  transactionHash: `0x${"d2".repeat(32)}`, blockNumber, blockHash: `0xblock${blockNumber}`, logIndex: 0,
});

function storeDouble(registered = []) {
  const checkpoints = new Map();
  const events = new Map();
  const calls = { registered: [], purchases: [], transfers: [], errors: [] };
  return {
    calls,
    async getCheckpoint({ chainId, address }) { return checkpoints.get(`${chainId}:${address}`) || null; },
    async setCheckpoint(value) { checkpoints.set(`${value.chainId}:${value.address}`, value); return value; },
    async getBlock() { return null; },
    async recordBlock() {},
    async recordEvent(value) { const key = `${value.contractAddress}:${value.transactionHash}:${value.logIndex}`; if (events.has(key)) return null; events.set(key, value); return value; },
    async recordIndexerError(value) { calls.errors.push(value); },
    async registerCollection(value) { calls.registered.push(value); return value; },
    async listFactoryCollections() { return registered; },
    async applyPrimaryPurchase(value) { calls.purchases.push(value); return { duplicate: false }; },
    async applyTransfer(value) { calls.transfers.push(value); return value; },
  };
}

function configs() {
  return loadIndexerConfig({
    INDEXER_RPC_URL: "https://rpc.example", INDEXER_CHAIN_ID: "43113",
    INDEXER_CONTRACTS_JSON: JSON.stringify([
      { address: SALE_V2, contractType: "PRIMARY_SALE_V2", startBlock: 1 },
      { address: FACTORY, contractType: "COLLECTION_FACTORY", startBlock: 1 },
    ]),
  }).contracts;
}

function rpcFor(logsByAddress, latest = 20) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(latest),
    getLogs: vi.fn(({ address, fromBlock, toBlock }) => Promise.resolve((logsByAddress[address.toLowerCase()] || []).filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock))),
    getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
  };
}

describe("per-collection indexing", () => {
  it("event topics match the deployed Solidity event declarations", async () => {
    const factory = await readFile(new URL("../contracts/VoidCollectionFactory.sol", import.meta.url), "utf8");
    const sale = await readFile(new URL("../contracts/VoidPrimarySaleV2.sol", import.meta.url), "utf8");
    expect(factory).toContain("event CollectionCreated(address indexed collection, address indexed artist, uint256 indexed index, string name, string symbol, string contractURI);");
    expect(sale).toContain("event Purchased(address indexed collection, uint256 indexed tokenId, address indexed buyer, uint256 qty, uint256 paid, uint256 artistCut, uint256 platformCut);");
  });

  it("accepts factory and sale V2 contracts and treats the V2 sale as a mint operator", () => {
    const parsed = configs();
    expect(parsed.map((item) => item.contractType)).toEqual(["PRIMARY_SALE_V2", "COLLECTION_FACTORY"]);
    expect(parsed[1].eventTopics.CollectionCreated).toBe(CREATED);
    expect(() => loadIndexerConfig({ INDEXER_RPC_URL: "https://rpc.example", INDEXER_CONTRACTS_JSON: JSON.stringify([{ address: FACTORY, contractType: "FACTORY" }]) })).toThrow(/COLLECTION_FACTORY/);
  });

  it("decodes CollectionCreated and V2 Purchased logs", () => {
    expect(decodeCollectionCreatedLog(createdLog(), { eventTopic: CREATED })).toEqual({ eventType: "CollectionCreated", factoryAddress: FACTORY, collectionAddress: COLLECTION, artistWallet: ARTIST, collectionIndex: "0", name: "Alpha Collection", symbol: "ALPHA", contractUri: "ipfs://alpha-contract" });
    expect(decodePurchasedV2Log(purchasedLog(), { chainId: 43113, blockTimestamp: new Date(), eventTopic: PURCHASED_V2 })).toMatchObject({ saleAddress: SALE_V2, tokenContractAddress: COLLECTION, tokenId: "42", buyerWallet: BUYER, quantity: "2", paidWei: "2000", artistCutWei: "1900", platformCutWei: "100" });
    const badCuts = { ...purchasedLog(), data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [1n, 1000n, 1n, 1n]) };
    expect(() => decodePurchasedV2Log(badCuts, { chainId: 43113, blockTimestamp: new Date(), eventTopic: PURCHASED_V2 })).toThrow(/cuts/);
  });

  it("discovers a new collection and indexes its mints and sales in the same cycle", async () => {
    const store = storeDouble();
    const rpc = rpcFor({ [FACTORY]: [createdLog({ blockNumber: 5 })], [SALE_V2]: [purchasedLog({ blockNumber: 7 })], [COLLECTION]: [mintLog({ blockNumber: 7 })] });
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [...configs()] });
    await indexer.syncAll();
    expect(store.calls.registered).toEqual([expect.objectContaining({ factoryAddress: FACTORY, collectionAddress: COLLECTION, artistWallet: ARTIST, name: "Alpha Collection", blockNumber: 5 })]);
    expect(indexer.configs.find((item) => item.address === COLLECTION)).toMatchObject({ contractType: "ERC1155", startBlock: 5, skipMintOperators: [SALE_V2] });
    expect(store.calls.purchases).toEqual([expect.objectContaining({ tokenContractAddress: COLLECTION, buyerWallet: BUYER, quantity: "2" })]);
    // The sale-contract mint is recorded but does not double-credit ownership.
    expect(store.calls.transfers).toEqual([expect.objectContaining({ contractAddress: COLLECTION, eventType: "MINT", skipOwnership: true })]);
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: COLLECTION, fromBlock: 5 }));
  });

  it("reloads registered collections after a restart", async () => {
    const store = storeDouble([{ address: COLLECTION, deployment_block_number: "5" }]);
    const indexer = new BlockchainIndexer({ rpc: rpcFor({}), store, confirmations: 0, configs: [...configs()] });
    await indexer.syncAll();
    expect(indexer.configs.filter((item) => item.address === COLLECTION)).toHaveLength(1);
    expect(indexer.configs.find((item) => item.address === COLLECTION).startBlock).toBe(5);
  });

  it("ignores a CollectionCreated look-alike from any other contract", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: rpcFor({}), store, confirmations: 0, configs: [...configs()] });
    const factoryConfig = indexer.configs.find((item) => item.contractType === "COLLECTION_FACTORY");
    await expect(indexer.processLog(factoryConfig, createdLog({ factory: "0xbad0000000000000000000000000000000000bad" }), block(5))).rejects.toThrow(/unconfigured factory/);
    expect(store.calls.registered).toHaveLength(0);
    expect(indexer.configs.some((item) => item.address === COLLECTION)).toBe(false);
  });

  it("refuses to credit a V2 purchase for a collection it does not track", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: rpcFor({}), store, confirmations: 0, configs: [...configs()] });
    const saleConfig = indexer.configs.find((item) => item.contractType === "PRIMARY_SALE_V2");
    await expect(indexer.processLog(saleConfig, purchasedLog({ collection: "0xdead00000000000000000000000000000000dead" }), block(7))).rejects.toThrow(/untracked collection/);
    expect(store.calls.purchases).toHaveLength(0);
    expect(store.calls.errors).toEqual([expect.objectContaining({ errorType: "PRIMARY_SALE_UNKNOWN_COLLECTION" })]);
  });
});
