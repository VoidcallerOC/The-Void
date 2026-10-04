import { describe, expect, it, vi } from "vitest";
import { AbiCoder, id } from "ethers";
import { BlockchainIndexer, decodeReleaseCreatedLog } from "./indexer.js";
import { loadIndexerConfig } from "./config.js";

const FACTORY = `0x${"fa".repeat(20)}`;
const RELEASE_A = `0x${"a1".repeat(20)}`;
const RELEASE_B = `0x${"b2".repeat(20)}`;
const ARTIST = `0x${"a3".repeat(20)}`;
const SALE_A = `0x${"5a".repeat(20)}`;
const SALE_B = `0x${"5b".repeat(20)}`;
const ANCHOR_A = `0x${"ab".repeat(20)}`;
const IMPLEMENTATION = `0x${"1a".repeat(20)}`;
const KEY_A = `0x${"aa".repeat(32)}`;
const KEY_B = `0x${"bb".repeat(32)}`;
const CREATED = id("ReleaseCreated(address,bytes32,address,address,address,address,uint256,uint16)");
const coder = AbiCoder.defaultAbiCoder();
const topicOf = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const block = (number) => ({ number, hash: `0xblock${number}`, parentHash: `0xblock${number - 1}`, timestamp: 1_700_000_000 + number });

function releaseLog({ release = RELEASE_A, releaseKey = KEY_A, primarySale = SALE_A, blockNumber = 5, index = 0 } = {}) {
  return {
    address: FACTORY,
    topics: [CREATED, topicOf(release), releaseKey, topicOf(ARTIST)],
    data: coder.encode(["address", "address", "address", "uint256", "uint16"], [primarySale, ANCHOR_A, IMPLEMENTATION, BigInt(index), 1]),
    transactionHash: `0x${"c1".repeat(32)}`,
    blockNumber,
    blockHash: `0xblock${blockNumber}`,
    logIndex: index,
  };
}

function storeDouble(existing = []) {
  const checkpoints = new Map();
  const events = new Map();
  const calls = { registered: [], errors: [] };
  return {
    calls,
    async getCheckpoint({ chainId, address }) { return checkpoints.get(`${chainId}:${address}`) || null; },
    async setCheckpoint(value) { checkpoints.set(`${value.chainId}:${value.address}`, value); return value; },
    async getBlock() { return null; },
    async recordBlock() {},
    async recordEvent(value) { const key = `${value.contractAddress}:${value.transactionHash}:${value.logIndex}`; if (events.has(key)) return null; events.set(key, value); return value; },
    async recordIndexerError(value) { calls.errors.push(value); },
    async registerRelease(value) { calls.registered.push(value); return value; },
    async listFactoryReleases() { return existing; },
    async applyTransfer() { return {}; },
  };
}

function configs() {
  return loadIndexerConfig({
    INDEXER_RPC_URL: "https://rpc.example",
    INDEXER_CHAIN_ID: "43113",
    INDEXER_CONTRACTS_JSON: JSON.stringify([{ address: FACTORY, contractType: "RELEASE_FACTORY", startBlock: 1 }]),
  }).contracts;
}

function rpcFor(logsByAddress, latest = 20) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(latest),
    getLogs: vi.fn(({ address, fromBlock, toBlock }) => Promise.resolve((logsByAddress[address.toLowerCase()] || []).filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock))),
    getBlock: vi.fn((_, number) => Promise.resolve(block(number))),
  };
}

describe("per-release indexing", () => {
  it("parses a trusted ReleaseCreated event with its immutable release tuple", () => {
    const parsed = decodeReleaseCreatedLog(releaseLog(), { eventTopic: CREATED });
    expect(parsed).toEqual({
      eventType: "ReleaseCreated",
      factoryAddress: FACTORY,
      releaseContractAddress: RELEASE_A,
      releaseKey: KEY_A,
      artistWallet: ARTIST,
      primarySaleAddress: SALE_A,
      provenanceAnchorAddress: ANCHOR_A,
      implementationAddress: IMPLEMENTATION,
      releaseIndex: "0",
      implementationVersion: 1,
    });
    expect(configs()[0].eventTopics.ReleaseCreated).toBe(CREATED);
  });

  it("discovers two independent releases from one artist and indexes both from creation", async () => {
    const store = storeDouble();
    const second = releaseLog({ release: RELEASE_B, releaseKey: KEY_B, primarySale: SALE_B, blockNumber: 6, index: 1 });
    const rpc = rpcFor({ [FACTORY]: [releaseLog(), second], [RELEASE_A]: [], [RELEASE_B]: [], [SALE_A]: [], [SALE_B]: [] });
    const indexer = new BlockchainIndexer({ rpc, store, confirmations: 0, configs: [...configs()] });
    await indexer.syncAll();

    expect(store.calls.registered).toEqual([
      expect.objectContaining({ releaseContractAddress: RELEASE_A, releaseKey: KEY_A, artistWallet: ARTIST, blockNumber: 5 }),
      expect.objectContaining({ releaseContractAddress: RELEASE_B, releaseKey: KEY_B, artistWallet: ARTIST, blockNumber: 6 }),
    ]);
    expect(indexer.configs.find((item) => item.address === RELEASE_A)).toMatchObject({ contractType: "ERC1155", startBlock: 5, releaseFactoryAddress: FACTORY });
    expect(indexer.configs.find((item) => item.address === RELEASE_B)).toMatchObject({ contractType: "ERC1155", startBlock: 6, releaseFactoryAddress: FACTORY });
    expect(indexer.configs.find((item) => item.address === SALE_A)).toMatchObject({ contractType: "PRIMARY_SALE", startBlock: 5, tokenAddress: RELEASE_A });
    expect(indexer.configs.find((item) => item.address === SALE_B)).toMatchObject({ contractType: "PRIMARY_SALE", startBlock: 6, tokenAddress: RELEASE_B });
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: RELEASE_A, fromBlock: 5 }));
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: RELEASE_B, fromBlock: 6 }));
  });

  it("reloads registered release contracts after a restart", async () => {
    const store = storeDouble([{ release_contract_address: RELEASE_A, primary_sale_address: SALE_A, deployment_block_number: "5" }, { release_contract_address: RELEASE_B, primary_sale_address: SALE_B, deployment_block_number: "6" }]);
    const indexer = new BlockchainIndexer({ rpc: rpcFor({}), store, confirmations: 0, configs: [...configs()] });
    await indexer.syncAll();
    expect(indexer.configs.filter((item) => item.releaseFactoryAddress === FACTORY).map((item) => item.address)).toEqual([RELEASE_A, RELEASE_B]);
    expect(indexer.configs.filter((item) => item.contractType === "PRIMARY_SALE").map((item) => item.address)).toEqual([SALE_A, SALE_B]);
  });

  it("rejects a look-alike ReleaseCreated event from an unconfigured factory", async () => {
    const store = storeDouble();
    const indexer = new BlockchainIndexer({ rpc: rpcFor({}), store, confirmations: 0, configs: [...configs()] });
    const factoryConfig = indexer.configs[0];
    await expect(indexer.processLog(factoryConfig, { ...releaseLog(), address: `0x${"ba".repeat(20)}` }, block(5))).rejects.toThrow(/unconfigured factory/);
    expect(store.calls.registered).toHaveLength(0);
  });
});
