import { zeroAddress, retry } from "./indexer-utils.js";
import { decodeMarketplaceLog } from "./marketplace-events.js";
import { reconcileMarketplaceListing } from "./marketplace-reconcile.js";

export { retry } from "./indexer-utils.js";

function cleanHex(value) { return String(value || "0x").replace(/^0x/, ""); }
function lowerHash(value) { return String(value || "").toLowerCase(); }
function word(data, index) { const value = cleanHex(data).slice(index * 64, index * 64 + 64); if (value.length !== 64) throw new Error("ABI word is incomplete."); return value; }
function uintWord(value) { return BigInt(`0x${value}`).toString(); }
function topicAddress(value) { const hex = cleanHex(value); if (hex.length < 40) throw new Error("Indexed address is malformed."); return `0x${hex.slice(-40)}`.toLowerCase(); }
function words(data) { const hex = cleanHex(data); if (hex.length % 64 !== 0) throw new Error("Event data is not word-aligned."); return hex.match(/.{64}/g) || []; }
function arrayFromOffset(data, offsetWord) { const bytesOffset = Number(BigInt(`0x${offsetWord}`)); if (!Number.isSafeInteger(bytesOffset) || bytesOffset % 32 !== 0) throw new Error("ABI dynamic offset is invalid."); const start = bytesOffset / 32; const listLength = Number(BigInt(`0x${word(data, start)}`)); if (!Number.isSafeInteger(listLength) || listLength > 10000) throw new Error("ABI dynamic array length is invalid."); return Array.from({ length: listLength }, (_, index) => uintWord(word(data, start + 1 + index))); }

export function decodeTransferLog(log, { chainId, blockTimestamp, eventTopics = {} }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const knownTopics = {
    TransferSingle: new Set([eventTopics.TransferSingle].filter(Boolean).map((value) => String(value).toLowerCase())),
    TransferBatch: new Set([eventTopics.TransferBatch].filter(Boolean).map((value) => String(value).toLowerCase())),
  };
  const common = { chainId, contractAddress: String(log.address || "").toLowerCase(), transactionHash: String(log.transactionHash || "").toLowerCase(), blockNumber: Number(log.blockNumber), blockHash: String(log.blockHash || "").toLowerCase(), logIndex: Number(log.logIndex), blockTimestamp, operator: topicAddress(log.topics?.[1]) };
  if (knownTopics.TransferSingle.has(topic)) {
    if (log.topics.length < 4) throw new Error("TransferSingle requires from and to topics.");
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    return [{ ...common, eventType: from === zeroAddress ? "MINT" : to === zeroAddress ? "BURN" : "TransferSingle", from, to, tokenId: uintWord(word(log.data, 0)), amount: uintWord(word(log.data, 1)), raw: log }];
  }
  if (knownTopics.TransferBatch.has(topic)) {
    if (log.topics.length < 4) throw new Error("TransferBatch requires from and to topics.");
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    const ids = arrayFromOffset(log.data, word(log.data, 0));
    const amounts = arrayFromOffset(log.data, word(log.data, 1));
    if (ids.length !== amounts.length) throw new Error("TransferBatch ids and values length differ.");
    return ids.map((tokenId, index) => ({ ...common, eventType: from === zeroAddress ? "MINT" : to === zeroAddress ? "BURN" : "TransferBatch", from, to, tokenId, amount: amounts[index], batchIndex: index, raw: log }));
  }
  return [];
}

export function classifyMarketplaceLog(log, topics = {}) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const entries = Object.entries(topics).find(([, value]) => String(value).toLowerCase() === topic);
  if (!entries) return null;
  const [eventType] = entries;
  return { eventType, raw: log, indexed: log.topics, dataWords: words(log.data || "0x") };
}

export class BlockchainIndexer {
  constructor({ rpc, store, configs, confirmations = 12, chunkSize = 500, retryOptions = {}, logger = console, onProgress = null } = {}) {
    if (!rpc || !store || !Array.isArray(configs) || configs.length === 0) throw new TypeError("Indexer requires rpc, store, and at least one contract config.");
    this.rpc = rpc;
    this.store = store;
    this.configs = configs;
    this.confirmations = confirmations;
    this.chunkSize = chunkSize;
    this.retryOptions = retryOptions;
    this.logger = logger;
    this.onProgress = onProgress;
  }

  async syncAll() {
    const results = [];
    for (const config of this.configs) results.push(await this.syncContract(config));
    return results;
  }

  async syncContract(config) {
    const chainId = Number(config.chainId);
    const address = String(config.address).toLowerCase();
    const checkpoint = await this.store.getCheckpoint({ chainId, address });
    let operation;
    let latest;
    try { latest = Number(await retry(() => this.rpc.getBlockNumber(chainId), this.retryOptions)); } catch (error) {
      await this.persistFailure({ chainId, address, config, checkpoint, error, rpcFailure: true });
      throw error;
    }
    const target = Math.max(-1, latest - Number(config.confirmations ?? this.confirmations));
    let nextBlock = checkpoint?.nextBlock ?? Number(config.startBlock ?? 0);
    try { nextBlock = await this.verifyCanonicalCheckpoint(config, checkpoint, nextBlock); } catch (error) {
      await this.persistFailure({ chainId, address, config, checkpoint: { ...checkpoint, nextBlock }, error, rpcFailure: true });
      throw error;
    }
    operation = "database";
    try {
      await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock, latestKnownBlock: latest, status: "RUNNING", lastError: null, markRunStarted: true });
    } catch (error) {
      await this.persistFailure({ chainId, address, config, checkpoint: { ...checkpoint, nextBlock }, error, databaseFailure: true });
      throw error;
    }
    let processed = 0;
    try {
      while (nextBlock <= target) {
        const endBlock = Math.min(target, nextBlock + this.chunkSize - 1);
        operation = "rpc";
        const logs = await retry(() => this.rpc.getLogs({ chainId, address, fromBlock: nextBlock, toBlock: endBlock }), this.retryOptions);
        for (let blockNumber = nextBlock; blockNumber <= endBlock; blockNumber += 1) {
          const block = await retry(() => this.rpc.getBlock(chainId, blockNumber), this.retryOptions);
          operation = "database";
          await this.ensureCanonical(config, block);
          const blockLogs = logs.filter((log) => Number(log.blockNumber) === blockNumber);
          for (const log of blockLogs) await this.processLog(config, log, block);
          await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: blockNumber + 1, lastProcessedBlock: blockNumber, lastProcessedHash: block.hash, finalizedBlock: target, latestKnownBlock: latest, status: "RUNNING", lastError: null });
          await this.onProgress?.({ chainId, address, blockNumber, finalizedBlock: target });
          nextBlock = blockNumber + 1;
          processed += 1;
        }
      }
      operation = "database";
      await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock, lastProcessedBlock: nextBlock - 1, finalizedBlock: target, latestKnownBlock: latest, status: "IDLE", lastError: null, markRunSucceeded: true, markRunCompleted: true });
      return { chainId, address, processedBlocks: processed, nextBlock, finalizedBlock: target, state: "CONFIRMED" };
    } catch (error) {
      await this.persistFailure({ chainId, address, config, checkpoint: { ...checkpoint, nextBlock }, error, rpcFailure: operation === "rpc", databaseFailure: operation === "database" });
      this.logger.error?.("indexer.sync.failed", { chainId, address, nextBlock, error: error.message });
      throw error;
    }
  }

  async persistFailure({ chainId, address, config, checkpoint, error, rpcFailure = false, databaseFailure = false }) {
    try {
      await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: checkpoint?.nextBlock ?? Number(config.startBlock ?? 0), status: "FAILED", lastError: error.message, rpcFailure, databaseFailure, markRunCompleted: true });
    } catch (persistenceError) {
      this.logger.error?.("indexer.failure.persistence.failed", { chainId, address, error: persistenceError.message, originalError: error.message });
    }
  }

  async verifyCanonicalCheckpoint(config, checkpoint, fallbackNextBlock) {
    const chainId = Number(config.chainId);
    if (checkpoint?.last_processed_block === null || checkpoint?.last_processed_block === undefined || !this.store.getBlock) return fallbackNextBlock;
    const firstBlock = Number(config.startBlock ?? 0);
    let cursor = Number(checkpoint.last_processed_block);
    let commonAncestor = cursor;
    let replacementHash = null;
    while (cursor >= firstBlock) {
      const indexed = await this.store.getBlock({ chainId, blockNumber: cursor });
      if (!indexed) { cursor -= 1; continue; }
      const canonical = await retry(() => this.rpc.getBlock(chainId, cursor), this.retryOptions);
      if (lowerHash(indexed.block_hash) === lowerHash(canonical.hash)) { commonAncestor = cursor; break; }
      replacementHash = canonical.hash;
      cursor -= 1;
      commonAncestor = cursor;
    }
    if (commonAncestor === Number(checkpoint.last_processed_block)) return fallbackNextBlock;
    const fromBlock = Math.max(firstBlock, commonAncestor + 1);
    if (!replacementHash) {
      const replacement = await retry(() => this.rpc.getBlock(chainId, fromBlock), this.retryOptions);
      replacementHash = replacement.hash;
    }
    await this.store.handleReorg({ chainId, fromBlock, replacementHash });
    return fromBlock;
  }

  async ensureCanonical(config, block) {
    if (!block || !Number.isSafeInteger(Number(block.number)) || !block.hash || !block.parentHash) throw new Error("RPC returned an incomplete canonical block.");
    const chainId = Number(config.chainId);
    const previous = await this.store.getBlock({ chainId, blockNumber: Number(block.number) });
    if (previous && previous.block_hash !== block.hash) {
      await this.store.handleReorg({ chainId, fromBlock: Number(block.number), replacementHash: block.hash });
      await this.store.setCheckpoint({ chainId, address: String(config.address).toLowerCase(), contractType: config.contractType, nextBlock: Number(block.number), status: "REORGING", lastError: "Canonical block hash changed." });
    }
    await this.store.recordBlock({ chainId, blockNumber: Number(block.number), blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp });
  }

  async processLog(config, log, block) {
    const chainId = Number(config.chainId);
    const base = { chainId, contractAddress: String(log.address || config.address).toLowerCase(), transactionHash: String(log.transactionHash || "").toLowerCase(), blockNumber: Number(log.blockNumber), blockHash: String(log.blockHash || block.hash).toLowerCase(), logIndex: Number(log.logIndex), blockTimestamp: new Date(Number(block.timestamp) * 1000) };
    if (!base.transactionHash || !Number.isInteger(base.logIndex) || base.logIndex < 0) return this.store.recordIndexerError({ ...base, errorType: "MALFORMED_LOG", message: "Missing transaction hash or log index." });
    if (config.contractType === "MARKETPLACE") {
      let marketplaceEvent;
      try {
        marketplaceEvent = decodeMarketplaceLog({ ...log, ...base }, { chainId, expectedAddress: config.address, blockTimestamp: base.blockTimestamp, platformFeeBps: config.platformFeeBps ?? null });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_MARKETPLACE_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      const inserted = await this.store.recordEvent({ ...base, eventType: marketplaceEvent.eventType, eventData: marketplaceEvent, isMalformed: false });
      try {
        const projection = await this.store.applyMarketplaceEvent(marketplaceEvent);
        let reconciliation = null;
        if (config.reconcileListings !== false && this.rpc.getMarketplaceListing && this.store.reconcileMarketplaceListing) {
          reconciliation = await reconcileMarketplaceListing({ rpc: this.rpc, store: this.store, chainId, marketplaceAddress: config.address, listingId: marketplaceEvent.listingId, blockTag: `0x${BigInt(base.blockNumber).toString(16)}`, retryOptions: this.retryOptions });
        }
        return { duplicate: !inserted, eventType: marketplaceEvent.eventType, projectionApplied: !projection?.duplicate, projection, reconciliation };
      } catch (error) {
        await this.store.recordIndexerError({ ...base, errorType: "MARKETPLACE_PROJECTION_FAILED", message: error.message, payload: marketplaceEvent });
        throw error;
      }
    }
    let transferItems;
    try {
      transferItems = config.contractType === "ERC1155" ? decodeTransferLog(log, { ...base, eventTopics: config.eventTopics || {} }) : [];
    } catch (error) {
      await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
      await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_EVENT", message: error.message, payload: log });
      return { duplicate: false, malformed: true };
    }
    const eventType = transferItems.length ? transferItems[0].eventType : "UNKNOWN";
    const inserted = await this.store.recordEvent({ ...base, eventType, eventData: { transferCount: transferItems.length }, isMalformed: false });
    for (const item of transferItems) await this.store.applyTransfer(item);
    return { duplicate: !inserted, eventType, transferCount: transferItems.length };
  }
}
