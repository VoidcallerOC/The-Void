import { zeroAddress, retry } from "./indexer-utils.js";
import { DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE, collectionIndexerConfig, primarySaleIndexerConfig, releaseIndexerConfig } from "./config.js";
import { decodeMarketplaceLog } from "./marketplace-events.js";
import { unifiedPlatformFeeBps } from "../config/unified-marketplace.js";
import { reconcileMarketplaceListing } from "./marketplace-reconcile.js";

export { retry } from "./indexer-utils.js";

function cleanHex(value) { return String(value || "0x").replace(/^0x/, ""); }
function lowerHash(value) { return String(value || "").toLowerCase(); }
function lowerAddress(value) { return String(value || "").toLowerCase(); }
// A failure already persisted for its contract (checkpoint admission) is not persisted again by the group handler.
function markPersisted(error) { if (error && typeof error === "object") error.indexerFailurePersisted = true; return error; }
// Postgres rows expose next_block (bigint, returned as a string); in-memory stores may use nextBlock.
function storedNextBlock(checkpoint, config) {
  const value = checkpoint?.nextBlock ?? checkpoint?.next_block;
  if (value === null || value === undefined) return Number(config.startBlock ?? 0);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Stored indexer checkpoint next_block is invalid.");
  return parsed;
}
function word(data, index) { const value = cleanHex(data).slice(index * 64, index * 64 + 64); if (value.length !== 64) throw new Error("ABI word is incomplete."); return value; }
function uintWord(value) { return BigInt(`0x${value}`).toString(); }
function topicAddress(value) { const hex = cleanHex(value); if (hex.length < 40) throw new Error("Indexed address is malformed."); return `0x${hex.slice(-40)}`.toLowerCase(); }
function words(data) { const hex = cleanHex(data); if (hex.length % 64 !== 0) throw new Error("Event data is not word-aligned."); return hex.match(/.{64}/g) || []; }
function addressWord(data, index) { return topicAddress(`0x${word(data, index)}`); }
function arrayFromOffset(data, offsetWord) { const bytesOffset = Number(BigInt(`0x${offsetWord}`)); if (!Number.isSafeInteger(bytesOffset) || bytesOffset % 32 !== 0) throw new Error("ABI dynamic offset is invalid."); const start = bytesOffset / 32; const listLength = Number(BigInt(`0x${word(data, start)}`)); if (!Number.isSafeInteger(listLength) || listLength > 10000) throw new Error("ABI dynamic array length is invalid."); return Array.from({ length: listLength }, (_, index) => uintWord(word(data, start + 1 + index))); }

export function decodeTransferLog(log, { chainId, blockTimestamp, eventTopics = {} }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const knownTopics = {
    TransferSingle: new Set([eventTopics.TransferSingle].filter(Boolean).map((value) => String(value).toLowerCase())),
    TransferBatch: new Set([eventTopics.TransferBatch].filter(Boolean).map((value) => String(value).toLowerCase())),
  };
  // Only a transfer carries the indexed operator in topics[1]. Any other event the release emits (for example
  // ERC-7572 ContractURIUpdated(string), a single-topic event every clone logs at creation) is not a transfer and
  // is reported as UNKNOWN by the caller, not as MALFORMED.
  if (!knownTopics.TransferSingle.has(topic) && !knownTopics.TransferBatch.has(topic)) return [];
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

function bytes32Topic(value) { const hex = cleanHex(value).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Indexed bytes32 is malformed."); return `0x${hex}`; }
function boolTopic(value) { const hex = cleanHex(value); if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Indexed bool is malformed."); const parsed = BigInt(`0x${hex}`); if (parsed > 1n) throw new Error("Indexed bool is not 0 or 1."); return parsed === 1n; }

/** VoidRelease1155V4 album lifecycle: AlbumCreated, AlbumTrackCreated, AlbumClosed, ExpandedReleaseApproved. */
export function decodeAlbumLog(log, { chainId, blockTimestamp = null, eventTopics = {} }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const eventType = ["AlbumCreated", "AlbumTrackCreated", "AlbumClosed", "ExpandedReleaseApproved"].find((name) => eventTopics[name] && String(eventTopics[name]).toLowerCase() === topic);
  if (!eventType) return null;
  const common = { chainId, eventType, contractAddress: String(log.address || "").toLowerCase(), transactionHash: String(log.transactionHash || "").toLowerCase(), blockNumber: Number(log.blockNumber), blockHash: String(log.blockHash || "").toLowerCase(), logIndex: Number(log.logIndex), blockTimestamp };
  if (eventType === "AlbumCreated" || eventType === "AlbumClosed") {
    if (log.topics.length < 2) throw new Error(`${eventType} requires the release key topic.`);
    return { ...common, releaseKey: bytes32Topic(log.topics[1]) };
  }
  if (eventType === "AlbumTrackCreated") {
    if (log.topics.length < 3) throw new Error("AlbumTrackCreated requires tokenId and single topics.");
    const mintEnd = BigInt(`0x${word(log.data, 0)}`);
    if (mintEnd >= 1n << 64n) throw new Error("AlbumTrackCreated mintEnd exceeds uint64.");
    return { ...common, tokenId: BigInt(log.topics[1]).toString(), single: boolTopic(log.topics[2]), mintEnd: mintEnd.toString() };
  }
  return { ...common, maxTracks: uintWord(word(log.data, 0)), maxSingles: uintWord(word(log.data, 1)) };
}

/** VoidRelease1155V5 ProvenanceAnchored(root, releaseId, editionId, tokenId, artist, releaseContract).
 * The clone is its own anchor, so the emitter must equal the logged release contract. */
export function decodeProvenanceAnchoredLog(log, { chainId, blockTimestamp = null, eventTopics = {} }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  if (!eventTopics.ProvenanceAnchored || String(eventTopics.ProvenanceAnchored).toLowerCase() !== topic) return null;
  if (log.topics.length < 4) throw new Error("ProvenanceAnchored requires root, release and edition topics.");
  const contractAddress = String(log.address || "").toLowerCase();
  const releaseContract = addressWord(log.data, 2);
  if (releaseContract !== contractAddress) throw new Error("ProvenanceAnchored release contract does not match the emitting release.");
  const provenanceRoot = bytes32Topic(log.topics[1]);
  if (/^0x0{64}$/.test(provenanceRoot)) throw new Error("ProvenanceAnchored root is zero.");
  return {
    chainId,
    eventType: "ProvenanceAnchored",
    contractAddress,
    transactionHash: String(log.transactionHash || "").toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: String(log.blockHash || "").toLowerCase(),
    logIndex: Number(log.logIndex),
    blockTimestamp,
    provenanceRoot,
    releaseId: bytes32Topic(log.topics[2]),
    editionId: bytes32Topic(log.topics[3]),
    tokenId: uintWord(word(log.data, 0)),
    artist: addressWord(log.data, 1),
    releaseContract,
  };
}

export function decodePurchasedLog(log, { chainId, blockTimestamp, tokenAddress, eventTopic }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const expected = String(eventTopic || "").toLowerCase();
  if (!expected || topic !== expected) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 3) throw new Error("Purchased requires tokenId and buyer topics.");
  if (!/^0x[0-9a-f]{40}$/i.test(String(tokenAddress || ""))) throw new Error("Primary sale indexing requires the ERC1155 token address.");
  const quantity = uintWord(word(log.data, 0));
  const paidWei = uintWord(word(log.data, 1));
  const artistCutWei = uintWord(word(log.data, 2));
  const platformCutWei = uintWord(word(log.data, 3));
  if (BigInt(quantity) <= 0n || BigInt(paidWei) <= 0n) throw new Error("Purchased quantity and payment must be positive.");
  if (BigInt(artistCutWei) + BigInt(platformCutWei) !== BigInt(paidWei)) throw new Error("Purchased cuts do not sum to the amount paid.");
  return {
    chainId,
    eventType: "Purchased",
    saleAddress: String(log.address || "").toLowerCase(),
    tokenContractAddress: String(tokenAddress).toLowerCase(),
    transactionHash: String(log.transactionHash || "").toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: String(log.blockHash || "").toLowerCase(),
    logIndex: Number(log.logIndex),
    blockTimestamp,
    buyerWallet: topicAddress(log.topics[2]),
    tokenId: BigInt(log.topics[1]).toString(),
    quantity,
    paidWei,
    artistCutWei,
    platformCutWei,
  };
}

/**
 * PlatformPaid(address indexed recipient, uint256 amount) and Withdrawn(address indexed account, uint256 amount),
 * emitted by VoidPrimarySaleSettled / VoidPrimarySale / VoidPrimarySaleV2. Returns null for any other topic.
 * The log must come from the configured sale; a non-positive amount or malformed layout throws.
 */
export function decodePrimarySaleSettlementLog(log, { chainId, blockTimestamp = null, saleAddress, eventTopics = {} }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const eventType = ["PlatformPaid", "Withdrawn"].find((name) => eventTopics[name] && String(eventTopics[name]).toLowerCase() === topic);
  if (!eventType) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 2) throw new Error(`${eventType} requires exactly one indexed address topic.`);
  if (cleanHex(log.data).length !== 64) throw new Error(`${eventType} data must be exactly one amount word.`);
  const emitter = String(log.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(emitter) || emitter !== String(saleAddress || "").toLowerCase()) throw new Error(`${eventType} did not come from the configured sale.`);
  const amountWei = uintWord(word(log.data, 0));
  if (BigInt(amountWei) <= 0n) throw new Error(`${eventType} amount must be positive.`);
  const wallet = topicAddress(log.topics[1]);
  return {
    chainId,
    eventType,
    saleAddress: emitter,
    ...(eventType === "PlatformPaid" ? { recipientWallet: wallet } : { accountWallet: wallet }),
    amountWei,
    transactionHash: String(log.transactionHash || "").toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: String(log.blockHash || "").toLowerCase(),
    logIndex: Number(log.logIndex),
    blockTimestamp,
  };
}

function stringFromOffset(data, offsetWord) {
  const bytesOffset = Number(BigInt(`0x${offsetWord}`));
  if (!Number.isSafeInteger(bytesOffset) || bytesOffset % 32 !== 0) throw new Error("ABI string offset is invalid.");
  const start = bytesOffset / 32;
  const length = Number(BigInt(`0x${word(data, start)}`));
  if (!Number.isSafeInteger(length) || length > 4096) throw new Error("ABI string length is invalid.");
  const hex = cleanHex(data).slice((start + 1) * 64, (start + 1) * 64 + length * 2);
  if (hex.length !== length * 2) throw new Error("ABI string is incomplete.");
  return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) || [], (byte) => parseInt(byte, 16)));
}

/** VoidCollectionFactory.CollectionCreated(collection, artist, index, name, symbol, contractURI). */
export function decodeCollectionCreatedLog(log, { eventTopic }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  if (!eventTopic || topic !== String(eventTopic).toLowerCase()) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 4) throw new Error("CollectionCreated requires collection, artist and index topics.");
  return {
    eventType: "CollectionCreated",
    factoryAddress: String(log.address || "").toLowerCase(),
    collectionAddress: topicAddress(log.topics[1]),
    artistWallet: topicAddress(log.topics[2]),
    collectionIndex: BigInt(log.topics[3]).toString(),
    name: stringFromOffset(log.data, word(log.data, 0)),
    symbol: stringFromOffset(log.data, word(log.data, 1)),
    contractUri: stringFromOffset(log.data, word(log.data, 2)),
  };
}

/** VoidReleaseFactory.ReleaseCreated(releaseContract, releaseKey, artist, sale, anchor, implementation, index, version). */
export function decodeReleaseCreatedLog(log, { eventTopic }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  if (!eventTopic || topic !== String(eventTopic).toLowerCase()) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 4) throw new Error("ReleaseCreated requires release contract, release key and artist topics.");
  return {
    eventType: "ReleaseCreated",
    factoryAddress: String(log.address || "").toLowerCase(),
    releaseContractAddress: topicAddress(log.topics[1]),
    releaseKey: `0x${cleanHex(log.topics[2]).padStart(64, "0")}`.toLowerCase(),
    artistWallet: topicAddress(log.topics[3]),
    primarySaleAddress: addressWord(log.data, 0),
    provenanceAnchorAddress: addressWord(log.data, 1),
    implementationAddress: addressWord(log.data, 2),
    releaseIndex: uintWord(word(log.data, 3)),
    implementationVersion: Number(BigInt(`0x${word(log.data, 4)}`)),
  };
}

/** VoidPrimarySaleV2.Purchased(collection, tokenId, buyer, qty, paid, artistCut, platformCut). */
export function decodePurchasedV2Log(log, { chainId, blockTimestamp, eventTopic }) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  if (!eventTopic || topic !== String(eventTopic).toLowerCase()) return null;
  if (!Array.isArray(log.topics) || log.topics.length < 4) throw new Error("Purchased requires collection, tokenId and buyer topics.");
  const quantity = uintWord(word(log.data, 0));
  const paidWei = uintWord(word(log.data, 1));
  const artistCutWei = uintWord(word(log.data, 2));
  const platformCutWei = uintWord(word(log.data, 3));
  if (BigInt(quantity) <= 0n || BigInt(paidWei) <= 0n) throw new Error("Purchased quantity and payment must be positive.");
  if (BigInt(artistCutWei) + BigInt(platformCutWei) !== BigInt(paidWei)) throw new Error("Purchased cuts do not sum to the amount paid.");
  return {
    chainId,
    eventType: "Purchased",
    saleAddress: String(log.address || "").toLowerCase(),
    tokenContractAddress: topicAddress(log.topics[1]),
    transactionHash: String(log.transactionHash || "").toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: String(log.blockHash || "").toLowerCase(),
    logIndex: Number(log.logIndex),
    blockTimestamp,
    tokenId: BigInt(log.topics[2]).toString(),
    buyerWallet: topicAddress(log.topics[3]),
    quantity,
    paidWei,
    artistCutWei,
    platformCutWei,
  };
}

export function classifyMarketplaceLog(log, topics = {}) {
  const topic = String(log?.topics?.[0] || "").toLowerCase();
  const entries = Object.entries(topics).find(([, value]) => String(value).toLowerCase() === topic);
  if (!entries) return null;
  const [eventType] = entries;
  return { eventType, raw: log, indexed: log.topics, dataWords: words(log.data || "0x") };
}

// Avalanche public C-Chain eth_getLogs rejects spans above 100 blocks ("block range too large").
// Operators with a private RPC may raise INDEXER_CHUNK_SIZE; keep the default at the public limit.
export const DEFAULT_INDEXER_CHUNK_SIZE = 100;

export class BlockchainIndexer {
  constructor({ rpc, store, configs, confirmations = 12, chunkSize = DEFAULT_INDEXER_CHUNK_SIZE, maxChunksPerCycle = DEFAULT_INDEXER_MAX_CHUNKS_PER_CYCLE, batchContracts = true, retryOptions = {}, logger = console, onProgress = null } = {}) {
    if (!rpc || !store || !Array.isArray(configs) || configs.length === 0) throw new TypeError("Indexer requires rpc, store, and at least one contract config.");
    const resolvedChunkSize = Number(chunkSize);
    if (!Number.isSafeInteger(resolvedChunkSize) || resolvedChunkSize < 1) throw new TypeError("Indexer chunkSize must be a positive integer.");
    const resolvedMaxChunks = maxChunksPerCycle === Infinity ? Infinity : Number(maxChunksPerCycle);
    if (resolvedMaxChunks !== Infinity && (!Number.isSafeInteger(resolvedMaxChunks) || resolvedMaxChunks < 1)) throw new TypeError("Indexer maxChunksPerCycle must be a positive integer.");
    this.rpc = rpc;
    this.store = store;
    this.configs = configs;
    this.confirmations = confirmations;
    this.chunkSize = resolvedChunkSize;
    // Fair scheduling: one contract may index at most this many chunks per syncAll before yielding to the
    // next contract. Progress is checkpointed per chunk, so a capped contract resumes where it stopped.
    this.maxChunksPerCycle = resolvedMaxChunks;
    // One eth_getLogs per block range for every contract on a chain (address array) instead of one per contract.
    // `false` restores the per-contract scan; both paths share syncGroup, so the semantics differ only in grouping.
    this.batchContracts = batchContracts !== false;
    this.retryOptions = retryOptions;
    this.logger = logger;
    this.onProgress = onProgress;
    // Release clones and sales of abandoned releases. Loaded from the database at startup; nothing in this set is
    // ever (re-)registered, whether it came from factory discovery or from explicit configuration.
    this.excludedContracts = new Set();
  }

  // Factories sync first so a collection created in this range is indexed from its
  // creation block in the same cycle; collections found earlier are reloaded once.
  async syncAll() {
    if (!this.marketplacesRegistered) await this.registerConfiguredMarketplaces();
    if (!this.collectionsLoaded) await this.loadRegisteredCollections();
    if (!this.releasesLoaded) await this.loadRegisteredReleases();
    // One tip read per cycle — avoids duplicate eth_blockNumber storms across contracts.
    const tipChainId = Number(this.configs[0]?.chainId);
    const sharedLatest = Number(await retry(() => this.rpc.getBlockNumber(tipChainId), this.retryOptions));
    // Canonical blocks read while verifying persisted checkpoints are shared for the cycle: contracts that stopped at
    // the same block (every member of a batched group) cost one eth_getBlockByNumber between them, not one each.
    this.canonicalReads = new Map();
    const results = [];
    if (this.batchContracts) {
      // Every contract of a chain is scanned together: one eth_getLogs per block range carries all their addresses.
      // Members are re-read before each chunk, so a release or sale a factory announces mid-cycle joins the same
      // cycle from its creation block (its own checkpoint keeps it from re-reading what the others already indexed).
      for (const chainId of [...new Set(this.configs.map((item) => Number(item.chainId)))]) {
        results.push(...await this.syncGroup(() => this.configs.filter((item) => Number(item.chainId) === chainId), { latest: sharedLatest }));
      }
      return results;
    }
    for (const config of this.configs.filter((item) => item.contractType === "COLLECTION_FACTORY" || item.contractType === "RELEASE_FACTORY")) {
      results.push(await this.syncContract(config, { latest: sharedLatest }));
    }
    for (const config of this.configs.filter((item) => item.contractType !== "COLLECTION_FACTORY" && item.contractType !== "RELEASE_FACTORY")) {
      results.push(await this.syncContract(config, { latest: sharedLatest }));
    }
    return results;
  }

  saleOperators() {
    return this.configs.filter((item) => item.contractType === "PRIMARY_SALE" || item.contractType === "PRIMARY_SALE_V2").map((item) => String(item.address).toLowerCase());
  }

  addCollection({ chainId, address, startBlock, factoryAddress }) {
    const normalized = String(address).toLowerCase();
    if (this.configs.some((item) => String(item.address).toLowerCase() === normalized)) return false;
    this.configs.push(collectionIndexerConfig({ chainId, address: normalized, startBlock, skipMintOperators: this.saleOperators(), factoryAddress }));
    this.logger.info?.("indexer.collection.added", { chainId: Number(chainId), address: normalized, startBlock: Number(startBlock) });
    return true;
  }

  addRelease({ chainId, address, startBlock, factoryAddress }) {
    const normalized = String(address).toLowerCase();
    if (this.excludedContracts.has(normalized)) return false;
    if (this.configs.some((item) => String(item.address).toLowerCase() === normalized)) return false;
    this.configs.push(releaseIndexerConfig({ chainId, address: normalized, startBlock, skipMintOperators: this.saleOperators(), factoryAddress }));
    this.logger.info?.("indexer.release.added", { chainId: Number(chainId), address: normalized, startBlock: Number(startBlock) });
    return true;
  }

  addPrimarySale({ chainId, address, startBlock, tokenAddress }) {
    const normalized = String(address).toLowerCase();
    if (this.excludedContracts.has(normalized)) return false;
    if (this.configs.some((item) => String(item.address).toLowerCase() === normalized)) return false;
    this.configs.push(primarySaleIndexerConfig({ chainId, address: normalized, startBlock, tokenAddress }));
    this.logger.info?.("indexer.primary-sale.added", { chainId: Number(chainId), address: normalized, tokenAddress: String(tokenAddress).toLowerCase(), startBlock: Number(startBlock) });
    return true;
  }

  // Marketplace projection requires a MARKETPLACE contracts row. Ensure one exists for
  // every configured marketplace before its logs are processed; existing rows are kept.
  async registerConfiguredMarketplaces() {
    if (!this.store.registerMarketplaceContract) { this.marketplacesRegistered = true; return; }
    for (const config of this.configs.filter((item) => item.contractType === "MARKETPLACE")) {
      const inserted = await this.store.registerMarketplaceContract({ chainId: Number(config.chainId), address: config.address });
      if (inserted) this.logger.info?.("indexer.marketplace.registered", { chainId: Number(config.chainId), address: String(config.address).toLowerCase() });
    }
    this.marketplacesRegistered = true;
  }

  async loadRegisteredCollections() {
    if (!this.store.listFactoryCollections) { this.collectionsLoaded = true; return; }
    for (const factory of this.configs.filter((item) => item.contractType === "COLLECTION_FACTORY")) {
      const rows = await this.store.listFactoryCollections({ chainId: Number(factory.chainId), factoryAddress: factory.address });
      for (const row of rows) this.addCollection({ chainId: factory.chainId, address: row.address, startBlock: Number(row.deployment_block_number ?? factory.startBlock ?? 0), factoryAddress: factory.address });
    }
    this.collectionsLoaded = true;
  }

  async loadExcludedReleaseContracts() {
    if (typeof this.store.listAbandonedReleaseContracts !== "function") return;
    const chainIds = [...new Set(this.configs.map((item) => Number(item.chainId)).filter(Number.isSafeInteger))];
    for (const chainId of chainIds) {
      for (const row of await this.store.listAbandonedReleaseContracts({ chainId })) {
        for (const address of [row.release_contract_address, row.primary_sale_address]) if (address) this.excludedContracts.add(String(address).toLowerCase());
      }
    }
    // Explicit configuration (INDEXER_CONTRACTS_JSON) cannot re-register an excluded release clone or sale. Factories,
    // marketplaces and every other contract are never touched.
    const before = this.configs.length;
    this.configs = this.configs.filter((item) => !(["ERC1155", "PRIMARY_SALE", "PRIMARY_SALE_V2"].includes(item.contractType) && this.excludedContracts.has(String(item.address).toLowerCase())));
    this.logger.info?.("indexer.release.excluded", { excluded: this.excludedContracts.size, droppedFromConfiguration: before - this.configs.length });
  }

  async loadRegisteredReleases() {
    await this.loadExcludedReleaseContracts();
    if (!this.store.listFactoryReleases) { this.releasesLoaded = true; return; }
    for (const factory of this.configs.filter((item) => item.contractType === "RELEASE_FACTORY")) {
      const rows = await this.store.listFactoryReleases({ chainId: Number(factory.chainId), factoryAddress: factory.address });
      for (const row of rows) {
        const startBlock = Number(row.deployment_block_number ?? factory.startBlock ?? 0);
        if (row.primary_sale_address) this.addPrimarySale({ chainId: factory.chainId, address: row.primary_sale_address, startBlock, tokenAddress: row.release_contract_address });
        this.addRelease({ chainId: factory.chainId, address: row.release_contract_address, startBlock, factoryAddress: factory.address });
      }
    }
    this.releasesLoaded = true;
  }

  /**
   * Settlement evidence for a primary sale: PlatformPaid / Withdrawn. Returns undefined when the log is neither,
   * so the caller falls through to Purchased decoding. Malformed logs follow the MALFORMED_PRIMARY_SALE_EVENT path.
   */
  async processPrimarySaleSettlementLog(config, log, base) {
    let settlement;
    try {
      settlement = decodePrimarySaleSettlementLog(log, { chainId: base.chainId, blockTimestamp: base.blockTimestamp, saleAddress: config.address, eventTopics: config.eventTopics });
    } catch (error) {
      await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
      await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_PRIMARY_SALE_EVENT", message: error.message, payload: log });
      return { duplicate: false, malformed: true };
    }
    if (!settlement) return undefined;
    const inserted = await this.store.recordEvent({ ...base, eventType: settlement.eventType, eventData: settlement, isMalformed: false });
    try {
      const projection = await this.store.applyPrimarySaleSettlement(settlement);
      return { duplicate: !inserted, eventType: settlement.eventType, projectionApplied: !projection?.duplicate, projection };
    } catch (error) {
      await this.store.recordIndexerError({ ...base, errorType: "PRIMARY_SALE_SETTLEMENT_FAILED", message: error.message, payload: settlement });
      throw error;
    }
  }

  async finalizePrimarySaleSettlements(config, finalizedBlock) {
    if ((config.contractType !== "PRIMARY_SALE" && config.contractType !== "PRIMARY_SALE_V2") || typeof this.store.finalizePrimarySaleSettlements !== "function") return;
    try {
      await this.store.finalizePrimarySaleSettlements({ chainId: Number(config.chainId), saleAddress: String(config.address).toLowerCase(), finalizedBlock });
    } catch (error) {
      this.logger.error?.("indexer.primary-sale-settlement.finalize.failed", { chainId: Number(config.chainId), address: String(config.address).toLowerCase(), error: error.message });
    }
  }

  // Runs every cycle for a primary sale, so rows indexed before this step existed are promoted too. A
  // failure here never blocks block indexing; the next cycle retries the same idempotent sweep.
  async finalizePrimarySalePurchases(config, finalizedBlock) {
    if (config.contractType !== "PRIMARY_SALE" || typeof this.store.finalizePrimaryPurchases !== "function") return;
    try {
      await this.store.finalizePrimaryPurchases({ chainId: Number(config.chainId), saleAddress: String(config.address).toLowerCase(), finalizedBlock });
    } catch (error) {
      this.logger.error?.("indexer.primary-purchase.finalize.failed", { chainId: Number(config.chainId), address: String(config.address).toLowerCase(), error: error.message });
    }
  }

  async syncContract(config, { latest = null } = {}) {
    const [result] = await this.syncGroup(() => [config], { latest });
    return result;
  }

  /**
   * Scans a group of contracts over one shared block cursor. Each chunk is ONE eth_getLogs whose address filter lists
   * every member whose next block falls inside the range. A returned log is dispatched to the handler of the member
   * that emitted it and dropped when it precedes that member's own checkpoint, so nothing is decoded or projected
   * twice. Every member's checkpoint advances only after every accepted log of the chunk is processed; an RPC or
   * database failure leaves each member at its last fully processed block and is rethrown. `members` is called
   * before every chunk, so contracts discovered mid-cycle (factory ReleaseCreated) are admitted and the cursor drops
   * back to their creation block; the members already past it take nothing from the re-covered blocks.
   */
  async syncGroup(members, { latest: providedLatest = null } = {}) {
    const chainId = Number(members()[0]?.chainId);
    const states = new Map();
    const calls = { getLogs: 0, getBlock: 0 };
    let latest;
    let operation = "rpc";
    let chunks = 0;
    let participating = [];
    try {
      latest = providedLatest == null
        ? Number(await retry(() => this.rpc.getBlockNumber(chainId), this.retryOptions))
        : Number(providedLatest);
    } catch (error) {
      for (const config of members()) {
        const address = lowerAddress(config.address);
        await this.persistFailure({ chainId, address, config, checkpoint: await this.store.getCheckpoint({ chainId, address }), error, rpcFailure: true });
      }
      throw error;
    }
    // A member is admitted once per call: its persisted checkpoint is read, verified against the canonical chain
    // (rewinding across a reorg), and marked RUNNING. Failures here are persisted for that member alone.
    const admit = async (config) => {
      const address = lowerAddress(config.address);
      if (states.has(address)) return states.get(address);
      const checkpoint = await this.store.getCheckpoint({ chainId, address });
      const state = { config, address, checkpoint, nextBlock: storedNextBlock(checkpoint, config), target: Math.max(-1, latest - Number(config.confirmations ?? this.confirmations)), chunkEnd: null, processed: 0, rewound: false };
      try {
        ({ nextBlock: state.nextBlock, rewound: state.rewound } = await this.verifyCanonicalCheckpoint(config, checkpoint, state.nextBlock));
      } catch (error) {
        await this.persistFailure({ chainId, address, config, checkpoint: { ...checkpoint, nextBlock: state.nextBlock }, error, rpcFailure: true });
        throw markPersisted(error);
      }
      try {
        await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: state.nextBlock, latestKnownBlock: latest, ...(state.rewound ? { lastProcessedBlock: state.nextBlock - 1, allowRewind: true } : {}), status: "RUNNING", lastError: null, markRunStarted: true });
      } catch (error) {
        await this.persistFailure({ chainId, address, config, checkpoint: { ...checkpoint, nextBlock: state.nextBlock }, error, databaseFailure: true });
        throw markPersisted(error);
      }
      states.set(address, state);
      return state;
    };
    try {
      for (;;) {
        for (const config of members()) await admit(config);
        const active = [...states.values()].filter((state) => state.nextBlock <= state.target);
        if (!active.length || chunks >= this.maxChunksPerCycle) break;
        const rangeStart = Math.min(...active.map((state) => state.nextBlock));
        const groupTarget = Math.max(...active.map((state) => state.target));
        const endBlock = Math.min(groupTarget, rangeStart + this.chunkSize - 1);
        participating = active.filter((state) => state.nextBlock <= endBlock);
        for (const state of participating) state.chunkEnd = Math.min(endBlock, state.target);
        const addresses = participating.map((state) => state.address);
        operation = "rpc";
        calls.getLogs += 1;
        const logs = await retry(() => this.rpc.getLogs({ chainId, address: addresses.length === 1 ? addresses[0] : addresses, fromBlock: rangeStart, toBlock: endBlock }), this.retryOptions);
        // Each log is routed to the member that emitted it. A log before that member's own checkpoint was indexed by
        // an earlier call (the member joined above the cursor); a log from an address outside the filter is a
        // provider fault and is reported, never processed. Order is the node's: by block, then log index.
        const accepted = [];
        for (const log of logs) {
          const state = states.get(lowerAddress(log.address));
          const blockNumber = Number(log.blockNumber);
          if (!state || !participating.includes(state)) {
            this.logger.warn?.("indexer.sync.unexpected_log", { chainId, address: lowerAddress(log.address), blockNumber, transactionHash: lowerHash(log.transactionHash) });
            continue;
          }
          if (blockNumber < state.nextBlock || blockNumber > state.chunkEnd) continue;
          accepted.push({ state, log, blockNumber });
        }
        const eventBlocks = [...new Set(accepted.map((item) => item.blockNumber))];
        // Every block with a log is fetched and recorded (reorg anchor + timestamp). The chunk's end block is fetched
        // only for the last chunk of this call, so the persisted checkpoint stays anchored while an empty intermediate
        // chunk costs one paced RPC call (eth_getLogs) instead of two. A reorg across empty blocks changes no indexed
        // state; the next anchor above it still detects it.
        const lastChunkOfCall = endBlock >= groupTarget || chunks + 1 >= this.maxChunksPerCycle;
        if (lastChunkOfCall && !eventBlocks.includes(endBlock)) eventBlocks.push(endBlock);
        eventBlocks.sort((a, b) => a - b);
        for (const blockNumber of eventBlocks) {
          let block;
          operation = "rpc";
          try {
            calls.getBlock += 1;
            block = await retry(() => this.rpc.getBlock(chainId, blockNumber), this.retryOptions);
          } catch (error) {
            await this.persistPartialChunk(participating, blockNumber, error);
            throw error;
          }
          if (!block) {
            const error = new Error("RPC returned an incomplete canonical block.");
            await this.persistPartialChunk(participating, blockNumber, error);
            throw error;
          }
          operation = "database";
          await this.ensureCanonical(participating.map((state) => state.config), block);
          for (const item of accepted) if (item.blockNumber === blockNumber) await this.processLog(item.state.config, item.log, block);
          await this.onProgress?.({ chainId, address: addresses.length === 1 ? addresses[0] : addresses, blockNumber, finalizedBlock: groupTarget });
        }
        // finalized_block never runs ahead of the data actually indexed: this chunk's last block, not the cycle target.
        operation = "database";
        for (const state of participating) {
          await this.store.setCheckpoint({ chainId, address: state.address, contractType: state.config.contractType, nextBlock: state.chunkEnd + 1, lastProcessedBlock: state.chunkEnd, finalizedBlock: state.chunkEnd, latestKnownBlock: latest, status: "RUNNING", lastError: null });
          state.processed += state.chunkEnd - Math.max(rangeStart, state.nextBlock) + 1;
          state.nextBlock = state.chunkEnd + 1;
        }
        participating = [];
        chunks += 1;
      }
      operation = "database";
      const results = [];
      for (const state of states.values()) {
        const { config, address } = state;
        if (state.nextBlock <= state.target) {
          // The per-cycle chunk budget is spent with blocks still to index. Persist the partial progress as a
          // RUNNING checkpoint without a successful run (ownership freshness keeps failing closed for this
          // contract), finalize sale rows only through the indexed block, and yield so the remaining contracts
          // get their turn this cycle. The next cycle resumes from the persisted next_block.
          const indexedThrough = state.nextBlock - 1;
          const remainingBlocks = state.target - state.nextBlock + 1;
          await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: state.nextBlock, lastProcessedBlock: indexedThrough, finalizedBlock: indexedThrough, latestKnownBlock: latest, status: "RUNNING", lastError: null });
          await this.finalizePrimarySalePurchases(config, indexedThrough);
          await this.finalizePrimarySaleSettlements(config, indexedThrough);
          this.logger.info?.("indexer.sync.catching_up", { chainId, address, nextBlock: state.nextBlock, targetBlock: state.target, remainingBlocks, chunks });
          results.push({ chainId, address, processedBlocks: state.processed, nextBlock: state.nextBlock, finalizedBlock: indexedThrough, targetBlock: state.target, remainingBlocks, state: "CATCHING_UP", partial: true });
          continue;
        }
        await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: state.nextBlock, lastProcessedBlock: state.nextBlock - 1, finalizedBlock: state.target, latestKnownBlock: latest, status: "IDLE", lastError: null, markRunSucceeded: true, markRunCompleted: true });
        await this.finalizePrimarySalePurchases(config, state.target);
        await this.finalizePrimarySaleSettlements(config, state.target);
        results.push({ chainId, address, processedBlocks: state.processed, nextBlock: state.nextBlock, finalizedBlock: state.target, targetBlock: state.target, remainingBlocks: 0, state: "CONFIRMED", partial: false });
      }
      // One line per group per cycle: the RPC cost of the scan, so a deployment can be measured from the logs alone.
      if (states.size > 1) this.logger.info?.("indexer.sync.group.completed", { chainId, contracts: states.size, chunks, rpcCalls: calls, catchingUp: results.filter((result) => result.partial).length });
      return results;
    } catch (error) {
      if (!error?.indexerFailurePersisted) {
        const failed = participating.length ? participating : [...states.values()];
        for (const state of failed) {
          await this.persistFailure({ chainId, address: state.address, config: state.config, checkpoint: { ...state.checkpoint, nextBlock: state.nextBlock }, error, rpcFailure: operation === "rpc", databaseFailure: operation === "database" });
        }
        this.logger.error?.("indexer.sync.failed", { chainId, address: failed.length === 1 ? failed[0].address : failed.map((state) => state.address), nextBlock: failed.length ? Math.min(...failed.map((state) => state.nextBlock)) : null, error: error.message });
      }
      throw error;
    }
  }

  // A block fetch failed mid-chunk: every block below it is fully processed for each member, so each resumes there.
  async persistPartialChunk(participating, blockNumber, error) {
    for (const state of participating) {
      const resume = Math.max(state.nextBlock, blockNumber);
      if (resume > state.nextBlock) {
        await this.store.setCheckpoint({ chainId: Number(state.config.chainId), address: state.address, contractType: state.config.contractType, nextBlock: resume, lastProcessedBlock: resume - 1, status: "FAILED", lastError: error.message });
      }
      state.nextBlock = resume;
    }
  }

  async persistFailure({ chainId, address, config, checkpoint, error, rpcFailure = false, databaseFailure = false }) {
    try {
      await this.store.setCheckpoint({ chainId, address, contractType: config.contractType, nextBlock: storedNextBlock(checkpoint, config), status: "FAILED", lastError: error.message, rpcFailure, databaseFailure, markRunCompleted: true });
    } catch (persistenceError) {
      this.logger.error?.("indexer.failure.persistence.failed", { chainId, address, error: persistenceError.message, originalError: error.message });
    }
  }

  async verifyCanonicalCheckpoint(config, checkpoint, fallbackNextBlock) {
    const chainId = Number(config.chainId);
    if (checkpoint?.last_processed_block === null || checkpoint?.last_processed_block === undefined || !this.store.getBlock) return { nextBlock: fallbackNextBlock, rewound: false };
    const firstBlock = Number(config.startBlock ?? 0);
    let cursor = Number(checkpoint.last_processed_block);
    let commonAncestor = cursor;
    let replacementHash = null;
    while (cursor >= firstBlock) {
      const indexed = await this.store.getBlock({ chainId, blockNumber: cursor });
      // A block that was never recorded is not evidence of divergence; only a hash mismatch is.
      if (!indexed) { cursor -= 1; continue; }
      const canonical = await this.readCanonicalBlock(chainId, cursor);
      if (!canonical?.hash) throw new Error(`RPC returned no canonical hash for block ${cursor} during checkpoint verification.`);
      if (lowerHash(indexed.block_hash) === lowerHash(canonical.hash)) { commonAncestor = cursor; break; }
      replacementHash = canonical.hash;
      cursor -= 1;
      commonAncestor = cursor;
    }
    if (!replacementHash) return { nextBlock: fallbackNextBlock, rewound: false };
    const fromBlock = Math.max(firstBlock, commonAncestor + 1);
    await this.store.handleReorg({ chainId, fromBlock, replacementHash });
    this.logger.warn?.("indexer.reorg.rewind", { chainId, address: String(config.address).toLowerCase(), fromBlock, lastProcessedBlock: Number(checkpoint.last_processed_block) });
    return { nextBlock: fromBlock, rewound: true };
  }

  // One eth_getBlockByNumber per block per cycle, shared by every contract whose checkpoint stops at that block.
  async readCanonicalBlock(chainId, blockNumber) {
    const key = `${Number(chainId)}:${Number(blockNumber)}`;
    if (this.canonicalReads?.has(key)) return this.canonicalReads.get(key);
    const block = await retry(() => this.rpc.getBlock(chainId, blockNumber), this.retryOptions);
    if (this.canonicalReads && block?.hash) this.canonicalReads.set(key, block);
    return block;
  }

  async ensureCanonical(configOrConfigs, block) {
    if (!block || !Number.isSafeInteger(Number(block.number)) || !block.hash || !block.parentHash) throw new Error("RPC returned an incomplete canonical block.");
    const configs = Array.isArray(configOrConfigs) ? configOrConfigs : [configOrConfigs];
    const chainId = Number(configs[0].chainId);
    const previous = await this.store.getBlock({ chainId, blockNumber: Number(block.number) });
    if (previous && previous.block_hash !== block.hash) {
      await this.store.handleReorg({ chainId, fromBlock: Number(block.number), replacementHash: block.hash });
      for (const config of configs) {
        await this.store.setCheckpoint({ chainId, address: lowerAddress(config.address), contractType: config.contractType, nextBlock: Number(block.number), lastProcessedBlock: Number(block.number) - 1, allowRewind: true, status: "REORGING", lastError: "Canonical block hash changed." });
      }
    }
    await this.store.recordBlock({ chainId, blockNumber: Number(block.number), blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp });
  }

  async processLog(config, log, block) {
    const chainId = Number(config.chainId);
    const base = { chainId, contractAddress: String(log.address || config.address).toLowerCase(), transactionHash: String(log.transactionHash || "").toLowerCase(), blockNumber: Number(log.blockNumber), blockHash: String(log.blockHash || block.hash).toLowerCase(), logIndex: Number(log.logIndex), blockTimestamp: new Date(Number(block.timestamp) * 1000) };
    if (!base.transactionHash || !Number.isInteger(base.logIndex) || base.logIndex < 0) return this.store.recordIndexerError({ ...base, errorType: "MALFORMED_LOG", message: "Missing transaction hash or log index." });
    if (config.contractType === "COLLECTION_FACTORY") {
      let created;
      try {
        created = decodeCollectionCreatedLog(log, { eventTopic: config.eventTopics?.CollectionCreated });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_COLLECTION_FACTORY_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      if (!created) {
        const inserted = await this.store.recordEvent({ ...base, eventType: "UNKNOWN", eventData: {}, isMalformed: false });
        return { duplicate: !inserted, eventType: "UNKNOWN" };
      }
      // Only the configured factory is trusted to announce collections.
      if (created.factoryAddress !== String(config.address).toLowerCase()) throw new Error("CollectionCreated came from an unconfigured factory.");
      const inserted = await this.store.recordEvent({ ...base, eventType: "CollectionCreated", eventData: created, isMalformed: false });
      await this.store.registerCollection({ chainId, factoryAddress: created.factoryAddress, collectionAddress: created.collectionAddress, artistWallet: created.artistWallet, name: created.name, symbol: created.symbol, contractUri: created.contractUri, collectionIndex: created.collectionIndex, blockNumber: base.blockNumber, transactionHash: base.transactionHash });
      const added = this.addCollection({ chainId, address: created.collectionAddress, startBlock: base.blockNumber, factoryAddress: created.factoryAddress });
      return { duplicate: !inserted, eventType: "CollectionCreated", collection: created.collectionAddress, added };
    }
    if (config.contractType === "RELEASE_FACTORY") {
      let created;
      try {
        created = decodeReleaseCreatedLog(log, { eventTopic: config.eventTopics?.ReleaseCreated });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_RELEASE_FACTORY_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      if (!created) {
        const inserted = await this.store.recordEvent({ ...base, eventType: "UNKNOWN", eventData: {}, isMalformed: false });
        return { duplicate: !inserted, eventType: "UNKNOWN" };
      }
      if (created.factoryAddress !== String(config.address).toLowerCase()) throw new Error("ReleaseCreated came from an unconfigured factory.");
      const inserted = await this.store.recordEvent({ ...base, eventType: "ReleaseCreated", eventData: created, isMalformed: false });
      if (!this.store.registerRelease) throw new Error("Indexer store cannot persist factory releases.");
      await this.store.registerRelease({
        chainId,
        factoryAddress: created.factoryAddress,
        releaseContractAddress: created.releaseContractAddress,
        releaseKey: created.releaseKey,
        artistWallet: created.artistWallet,
        primarySaleAddress: created.primarySaleAddress,
        provenanceAnchorAddress: created.provenanceAnchorAddress,
        implementationAddress: created.implementationAddress,
        releaseIndex: created.releaseIndex,
        implementationVersion: created.implementationVersion,
        blockNumber: base.blockNumber,
        transactionHash: base.transactionHash,
      });
      const saleAdded = this.addPrimarySale({ chainId, address: created.primarySaleAddress, startBlock: base.blockNumber, tokenAddress: created.releaseContractAddress });
      const added = this.addRelease({ chainId, address: created.releaseContractAddress, startBlock: base.blockNumber, factoryAddress: created.factoryAddress });
      return { duplicate: !inserted, eventType: "ReleaseCreated", release: created.releaseContractAddress, added, saleAdded };
    }
    if (config.contractType === "PRIMARY_SALE_V2") {
      const settled = await this.processPrimarySaleSettlementLog(config, log, base);
      if (settled) return settled;
      let purchased;
      try {
        purchased = decodePurchasedV2Log(log, { chainId, blockTimestamp: base.blockTimestamp, eventTopic: config.eventTopics?.Purchased });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_PRIMARY_SALE_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      if (!purchased) {
        const inserted = await this.store.recordEvent({ ...base, eventType: "UNKNOWN", eventData: {}, isMalformed: false });
        return { duplicate: !inserted, eventType: "UNKNOWN" };
      }
      // The sale contract only sells registered collections; refuse to credit anything else.
      if (!this.configs.some((item) => item.contractType === "ERC1155" && String(item.address).toLowerCase() === purchased.tokenContractAddress)) {
        await this.store.recordIndexerError({ ...base, errorType: "PRIMARY_SALE_UNKNOWN_COLLECTION", message: "Purchased references a collection this indexer does not track.", payload: purchased });
        throw new Error("Purchased references an untracked collection.");
      }
      const inserted = await this.store.recordEvent({ ...base, eventType: "Purchased", eventData: purchased, isMalformed: false });
      try {
        const projection = await this.store.applyPrimaryPurchase(purchased);
        return { duplicate: !inserted, eventType: "Purchased", projectionApplied: !projection?.duplicate, projection };
      } catch (error) {
        await this.store.recordIndexerError({ ...base, errorType: "PRIMARY_SALE_PROJECTION_FAILED", message: error.message, payload: purchased });
        throw error;
      }
    }
    if (config.contractType === "PRIMARY_SALE") {
      const settled = await this.processPrimarySaleSettlementLog(config, log, base);
      if (settled) return settled;
      let purchased;
      try {
        purchased = decodePurchasedLog(log, { chainId, blockTimestamp: base.blockTimestamp, tokenAddress: config.tokenAddress, eventTopic: config.eventTopics?.Purchased });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_PRIMARY_SALE_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      if (!purchased) {
        const inserted = await this.store.recordEvent({ ...base, eventType: "UNKNOWN", eventData: {}, isMalformed: false });
        return { duplicate: !inserted, eventType: "UNKNOWN" };
      }
      const inserted = await this.store.recordEvent({ ...base, eventType: "Purchased", eventData: purchased, isMalformed: false });
      try {
        const projection = await this.store.applyPrimaryPurchase(purchased);
        return { duplicate: !inserted, eventType: "Purchased", projectionApplied: !projection?.duplicate, projection };
      } catch (error) {
        await this.store.recordIndexerError({ ...base, errorType: "PRIMARY_SALE_PROJECTION_FAILED", message: error.message, payload: purchased });
        throw error;
      }
    }
    if (config.contractType === "MARKETPLACE") {
      let marketplaceEvent;
      try {
        marketplaceEvent = decodeMarketplaceLog({ ...log, ...base }, { chainId, expectedAddress: config.address, blockTimestamp: base.blockTimestamp, platformFeeBps: config.feePolicy === "unified" ? (token) => unifiedPlatformFeeBps(token) : config.platformFeeBps ?? null });
      } catch (error) {
        await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
        await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_MARKETPLACE_EVENT", message: error.message, payload: log });
        return { duplicate: false, malformed: true };
      }
      const inserted = await this.store.recordEvent({ ...base, eventType: marketplaceEvent.eventType, eventData: marketplaceEvent, isMalformed: false });
      // SaleSettled (unified marketplace) annotates the ListingSold just before it; it is recorded, never projected.
      if (marketplaceEvent.eventType === "SaleSettled") return { duplicate: !inserted, eventType: "SaleSettled", projectionApplied: false };
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
    let albumEvent = null;
    let provenanceEvent = null;
    try {
      // Factory V3 clones emit ProvenanceAnchored in the edition-creating transaction. It is recorded
      // as a canonical event; publication confirmation re-reads it from the chain independently.
      if (config.contractType === "ERC1155") provenanceEvent = decodeProvenanceAnchoredLog({ ...log, address: base.contractAddress, blockHash: base.blockHash }, { chainId, blockTimestamp: base.blockTimestamp, eventTopics: config.eventTopics || {} });
      // Album events are matched first: ExpandedReleaseApproved has no indexed topics for the transfer decoder.
      if (config.contractType === "ERC1155" && !provenanceEvent) albumEvent = decodeAlbumLog({ ...log, address: base.contractAddress, blockHash: base.blockHash }, { chainId, blockTimestamp: base.blockTimestamp, eventTopics: config.eventTopics || {} });
      transferItems = config.contractType === "ERC1155" && !albumEvent && !provenanceEvent ? decodeTransferLog(log, { ...base, eventTopics: config.eventTopics || {} }) : [];
    } catch (error) {
      await this.store.recordEvent({ ...base, eventType: "MALFORMED", eventData: {}, isMalformed: true, errorMessage: error.message });
      await this.store.recordIndexerError({ ...base, errorType: "MALFORMED_EVENT", message: error.message, payload: log });
      return { duplicate: false, malformed: true };
    }
    if (provenanceEvent) {
      const inserted = await this.store.recordEvent({ ...base, eventType: "ProvenanceAnchored", eventData: provenanceEvent, isMalformed: false });
      return { duplicate: !inserted, eventType: "ProvenanceAnchored", provenanceRoot: provenanceEvent.provenanceRoot };
    }
    if (albumEvent) {
      const inserted = await this.store.recordEvent({ ...base, eventType: albumEvent.eventType, eventData: albumEvent, isMalformed: false });
      if (!this.store.applyAlbumEvent) throw new Error("Indexer store cannot persist album events.");
      try {
        const projection = await this.store.applyAlbumEvent(albumEvent);
        return { duplicate: !inserted, eventType: albumEvent.eventType, projection };
      } catch (error) {
        await this.store.recordIndexerError({ ...base, errorType: "ALBUM_PROJECTION_FAILED", message: error.message, payload: albumEvent });
        throw error;
      }
    }
    const eventType = transferItems.length ? transferItems[0].eventType : "UNKNOWN";
    const inserted = await this.store.recordEvent({ ...base, eventType, eventData: { transferCount: transferItems.length }, isMalformed: false });
    for (const item of transferItems) {
      const operators = new Set((config.skipMintOperators || []).map((value) => String(value).toLowerCase()));
      const skipOwnership = item.eventType === "MINT" && operators.has(item.operator);
      await this.store.applyTransfer(skipOwnership ? { ...item, skipOwnership: true } : item);
    }
    return { duplicate: !inserted, eventType, transferCount: transferItems.length };
  }
}
