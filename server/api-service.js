import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { checkDatabaseHealth } from "./db.js";
import { chainId, nonNegativeBigInt, positiveBigInt, requiredText, walletAddress } from "./validation.js";

const PUBLIC_STATUS = "PUBLISHED";
const ACTIVE_LISTING = "ACTIVE";
const TERMINAL_TRANSACTION_STATES = new Set(["FAILED", "FINALIZED", "RECONCILED", "REORGED"]);

function contractAddress(value, field) {
  const address = requiredText(value, field, { max: 128 }).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ApiError(400, "INVALID_ADDRESS", `${field} must be an EVM address.`);
  return address;
}

function transactionHash(value) {
  const hash = requiredText(value, "transactionHash", { max: 128 }).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "INVALID_TRANSACTION_HASH", "transactionHash must be a 32-byte transaction hash.");
  return hash;
}

function blockHash(value) {
  const hash = requiredText(value, "blockHash", { max: 128 }).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError(409, "INVALID_BLOCK_REFERENCE", "Blockchain verification returned an invalid block hash.");
  return hash;
}

function logIndex(value, field = "logIndex") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ApiError(400, "INVALID_LOG_INDEX", `${field} must be a non-negative integer.`);
  return parsed;
}

function limitValue(value, fallback = 50) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new ApiError(400, "INVALID_LIMIT", "limit must be an integer between 1 and 100.");
  return parsed;
}

function offsetValue(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(400, "INVALID_OFFSET", "offset must be a non-negative integer.");
  return parsed;
}

function mapRow(row) { return row || null; }

export class ApiService {
  constructor({ db, repository, authenticator = null, ownershipVerifier = null, blockchainVerifier = null, indexerStore = null, rateLimiter = null, logger = console } = {}) {
    if (!db?.query || !repository) throw new TypeError("ApiService requires a database executor and persistence repository.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.ownershipVerifier = ownershipVerifier;
    this.blockchainVerifier = blockchainVerifier;
    this.indexerStore = indexerStore;
    this.rateLimiter = rateLimiter;
    this.logger = logger;
  }

  async run(request, operation) {
    const requestId = request.requestId || randomUUID();
    this.rateLimiter?.check(request.rateLimitKey || request.ip || "anonymous");
    try {
      const data = await operation({ ...request, requestId });
      this.logger.info?.("api.request.completed", { requestId, method: request.method, path: request.path });
      return { status: 200, body: { data, requestId } };
    } catch (error) {
      this.logger.error?.("api.request.failed", { requestId, method: request.method, path: request.path, error: error.code || error.message });
      throw error;
    }
  }

  async getIndexerHealth({ chainId: requestedChainId = null } = {}) {
    if (!this.indexerStore?.getIndexerHealth) throw new ApiError(503, "INDEXER_UNAVAILABLE", "Indexer health storage is not configured.");
    const selectedChainId = requestedChainId === null || requestedChainId === undefined || requestedChainId === "" ? null : chainId(requestedChainId);
    return this.indexerStore.getIndexerHealth({ chainId: selectedChainId });
  }

  async getOperationalHealth() {
    const database = await checkDatabaseHealth(this.db);
    if (!database.ok) return { ok: false, database, indexer: { ok: false, reason: "DATABASE_UNAVAILABLE" } };
    try {
      const checkpoints = await this.getIndexerHealth({});
      const contracts = checkpoints.flatMap((checkpoint) => Array.isArray(checkpoint.contracts) && checkpoint.contracts.length ? checkpoint.contracts : [checkpoint]);
      const indexer = {
        ok: checkpoints.length > 0 && contracts.length > 0 && contracts.every((contract) => ["IDLE", "RUNNING"].includes(String(contract.status || "").toUpperCase())) && checkpoints.every((checkpoint) => checkpoint.last_successful_run_at),
        checkpoints,
      };
      return { ok: database.ok && indexer.ok, database, indexer };
    } catch (error) {
      return { ok: false, database, indexer: { ok: false, reason: error.code || "INDEXER_UNAVAILABLE" } };
    }
  }

  async getArtist({ idOrSlug }) {
    const key = requiredText(idOrSlug, "artist");
    const { rows } = await this.db.query(`SELECT a.*, p.bio, p.website_url, p.social_links, p.profile_metadata FROM artists a LEFT JOIN artist_profiles p ON p.artist_id=a.id WHERE a.status=$1 AND (a.id=$2 OR a.slug=$2) LIMIT 1`, [PUBLIC_STATUS === "PUBLISHED" ? "ACTIVE" : "ACTIVE", key]);
    if (!rows[0]) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
    return mapRow(rows[0]);
  }

  async listArtists({ limit, offset, status = "ACTIVE" }) {
    const { rows } = await this.db.query(`SELECT a.*, p.bio, p.website_url, p.social_links, p.profile_metadata FROM artists a LEFT JOIN artist_profiles p ON p.artist_id=a.id WHERE a.status=$1 ORDER BY a.display_name ASC LIMIT $2 OFFSET $3`, [status, limitValue(limit), offsetValue(offset)]);
    return rows;
  }

  async getRelease({ idOrSlug }) {
    const key = requiredText(idOrSlug, "release");
    const { rows } = await this.db.query(`SELECT r.*, a.slug AS artist_slug, a.display_name AS artist_name FROM releases r JOIN artists a ON a.id=r.artist_id WHERE r.status=$1 AND (r.id=$2 OR r.slug=$2) LIMIT 1`, [PUBLIC_STATUS, key]);
    if (!rows[0]) throw new ApiError(404, "RELEASE_NOT_FOUND", "Release was not found.");
    return mapRow(rows[0]);
  }

  async listReleases({ artistId = null, limit, offset }) {
    const values = [PUBLIC_STATUS, artistId, limitValue(limit), offsetValue(offset)];
    const { rows } = await this.db.query(`SELECT r.*, a.slug AS artist_slug, a.display_name AS artist_name FROM releases r JOIN artists a ON a.id=r.artist_id WHERE r.status=$1 AND ($2::text IS NULL OR r.artist_id=$2) ORDER BY r.published_at DESC NULLS LAST, r.title ASC LIMIT $3 OFFSET $4`, values);
    return rows;
  }

  async getEdition({ id }) {
    const key = requiredText(id, "edition");
    const { rows } = await this.db.query(`SELECT e.*, r.title AS release_title, r.artist_id, c.chain_id, c.address AS contract_address FROM editions e JOIN releases r ON r.id=e.release_id LEFT JOIN contracts c ON c.id=e.contract_id WHERE e.status=$1 AND e.id=$2 LIMIT 1`, [PUBLIC_STATUS, key]);
    if (!rows[0]) throw new ApiError(404, "EDITION_NOT_FOUND", "Edition was not found.");
    return mapRow(rows[0]);
  }

  async listEditions({ releaseId = null, limit, offset }) {
    const { rows } = await this.db.query(`SELECT e.*, r.title AS release_title, c.chain_id, c.address AS contract_address FROM editions e JOIN releases r ON r.id=e.release_id LEFT JOIN contracts c ON c.id=e.contract_id WHERE e.status=$1 AND ($2::text IS NULL OR e.release_id=$2) ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`, [PUBLIC_STATUS, releaseId, limitValue(limit), offsetValue(offset)]);
    return rows;
  }

  async getExperience({ id }) {
    const key = requiredText(id, "experience");
    const { rows } = await this.db.query(`SELECT * FROM experiences WHERE status=$1 AND id=$2 LIMIT 1`, [PUBLIC_STATUS, key]);
    if (!rows[0]) throw new ApiError(404, "EXPERIENCE_NOT_FOUND", "Experience was not found.");
    return mapRow(rows[0]);
  }

  async listExperiences({ editionId = null, releaseId = null, limit, offset }) {
    const { rows } = await this.db.query(`SELECT * FROM experiences WHERE status=$1 AND ($2::text IS NULL OR edition_id=$2) AND ($3::text IS NULL OR release_id=$3) ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [PUBLIC_STATUS, editionId, releaseId, limitValue(limit), offsetValue(offset)]);
    return rows;
  }

  async listListings({ chainId: rawChainId = null, tokenContractAddress = null, tokenId = null, sellerWallet = null, status = ACTIVE_LISTING, limit, offset }) {
    const values = [rawChainId === null ? null : chainId(rawChainId), tokenContractAddress ? requiredText(tokenContractAddress, "tokenContractAddress", { max: 128 }).toLowerCase() : null, tokenId === null ? null : nonNegativeBigInt(tokenId, "tokenId"), sellerWallet ? walletAddress(sellerWallet, "sellerWallet") : null, status, limitValue(limit), offsetValue(offset)];
    const { rows } = await this.db.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE ($1::bigint IS NULL OR l.chain_id=$1) AND ($2::text IS NULL OR tc.address=$2) AND ($3::numeric IS NULL OR l.token_id=$3) AND ($4::text IS NULL OR l.seller_wallet=$4) AND l.status=$5 AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY l.created_at DESC LIMIT $6 OFFSET $7`, values);
    return rows;
  }

  async getIndexedListing({ chainId: rawChainId, marketplaceAddress, listingId }) {
    const selectedChainId = chainId(rawChainId, "chainId");
    const selectedMarketplace = contractAddress(marketplaceAddress, "marketplaceAddress");
    const selectedListingId = positiveBigInt(listingId, "listingId");
    const { rows } = await this.db.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address, CASE WHEN l.status='ACTIVE' AND l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'EXPIRED' ELSE l.status END AS effective_status FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE l.chain_id=$1 AND mc.address=$2 AND l.listing_id=$3 LIMIT 1`, [selectedChainId, selectedMarketplace, selectedListingId]);
    if (!rows[0]) throw new ApiError(404, "LISTING_NOT_FOUND", "The indexed listing was not found.");
    return { ...rows[0], status: rows[0].effective_status };
  }

  async getMarketplaceTransaction({ chainId: rawChainId, transactionHash: rawTransactionHash }) {
    const selectedChainId = chainId(rawChainId, "chainId");
    const selectedTransactionHash = transactionHash(rawTransactionHash);
    const { rows } = await this.db.query(`SELECT t.*, COALESCE(jsonb_agg(jsonb_build_object('status', p.status, 'listingId', p.listing_id, 'quantity', p.quantity, 'salePriceWei', p.sale_price_wei, 'settlementLogIndex', p.settlement_log_index, 'finalizedAt', p.finalized_at)) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS purchases FROM transactions t LEFT JOIN purchases p ON p.transaction_id=t.id WHERE t.chain_id=$1 AND t.transaction_hash=$2 GROUP BY t.id LIMIT 1`, [selectedChainId, selectedTransactionHash]);
    if (!rows[0]) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "The indexed marketplace transaction was not found.");
    return rows[0];
  }

  async assertRegisteredMarketplace({ chainId: selectedChainId, marketplaceAddress }) {
    const { rows } = await this.db.query(`SELECT id, address FROM contracts WHERE chain_id=$1 AND address=$2 AND contract_type='MARKETPLACE' LIMIT 1`, [selectedChainId, marketplaceAddress]);
    if (!rows[0]) throw new ApiError(409, "MARKETPLACE_NOT_REGISTERED", "Marketplace contract is not registered for this chain.");
    return rows[0];
  }

  async getCollector({ wallet, request = {} }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, wallet, "wallet");
    const address = walletAddress(wallet);
    const { rows } = await this.db.query(`SELECT c.*, COALESCE(jsonb_agg(DISTINCT jsonb_build_object('chainId', o.chain_id, 'contractAddress', o.contract_address, 'tokenId', o.token_id, 'amount', o.amount, 'updatedAt', o.updated_at)) FILTER (WHERE o.wallet_address IS NOT NULL), '[]'::jsonb) AS ownership FROM collectors c LEFT JOIN ownership_snapshots o ON o.wallet_address=c.wallet_address AND o.amount > 0 AND o.synchronization_watermark <> 'REORG_PENDING' WHERE c.wallet_address=$1 GROUP BY c.wallet_address`, [address]);
    return rows[0] || { wallet_address: address, ownership: [] };
  }

  async collectionActivity({ wallet, limit, offset, request = {} }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, wallet, "wallet");
    const address = walletAddress(wallet);
    const { rows } = await this.db.query(`SELECT * FROM (SELECT 'TRANSFER' AS activity_type, transaction_hash, block_number, block_timestamp AS occurred_at, contract_address, token_id, amount, from_wallet, to_wallet FROM transfers WHERE (from_wallet=$1 OR to_wallet=$1) AND is_canonical=true UNION ALL SELECT 'PURCHASE' AS activity_type, p.transaction_hash, p.block_number, p.created_at AS occurred_at, p.token_contract_address AS contract_address, p.token_id, p.quantity AS amount, p.seller_wallet AS from_wallet, p.buyer_wallet AS to_wallet FROM purchases p WHERE p.buyer_wallet=$1 AND p.status <> 'REORGED') activity ORDER BY occurred_at DESC LIMIT $2 OFFSET $3`, [address, limitValue(limit), offsetValue(offset)]);
    return rows;
  }

  async createListing({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.sellerWallet, "sellerWallet");
    const txHash = transactionHash(input.transactionHash);
    const rawChainId = chainId(input.chainId);
    const marketplaceAddress = contractAddress(input.marketplaceAddress, "marketplaceAddress");
    await this.assertRegisteredMarketplace({ chainId: rawChainId, marketplaceAddress });
    const transaction = await this.repository.upsertTransaction({ chainId: rawChainId, transactionHash: txHash, fromWallet: identity.wallet, toAddress: marketplaceAddress, transactionType: "LISTING_CREATE", status: "SUBMITTED" });
    this.logger.info?.("marketplace.listing.pending", { requestId: request.requestId, transactionHash: txHash, chainId: rawChainId });
    return { state: "PENDING", transaction, message: "Listing is pending blockchain event confirmation." };
  }

  async cancelListing({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.sellerWallet, "sellerWallet");
    const selectedChainId = chainId(input.chainId);
    const marketplaceAddress = contractAddress(input.marketplaceAddress, "marketplaceAddress");
    await this.assertRegisteredMarketplace({ chainId: selectedChainId, marketplaceAddress });
    const transaction = await this.repository.upsertTransaction({ chainId: selectedChainId, transactionHash: transactionHash(input.transactionHash), fromWallet: identity.wallet, toAddress: marketplaceAddress, transactionType: "LISTING_CANCEL", status: "SUBMITTED" });
    return { state: "PENDING", transaction, message: "Cancellation is pending blockchain event confirmation." };
  }

  async createPurchaseIntent({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.buyerWallet, "buyerWallet");
    const key = requiredText(input.idempotencyKey, "idempotencyKey", { max: 256 });
    const listingId = requiredText(input.listingId, "listingId");
    const quantity = positiveBigInt(input.quantity, "quantity");
    const existing = await this.db.query(`SELECT * FROM transactions WHERE idempotency_key=$1 LIMIT 1`, [key]);
    if (existing.rows[0]) return { state: existing.rows[0].status, idempotent: true, transaction: existing.rows[0] };
    const listingResult = await this.db.query(`SELECT l.*, mc.address AS marketplace_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id WHERE l.id=$1 AND l.status=$2 AND (l.expires_at IS NULL OR l.expires_at > now()) FOR SHARE`, [listingId, ACTIVE_LISTING]);
    const listing = listingResult.rows[0];
    if (!listing) throw new ApiError(409, "LISTING_NOT_ACTIVE", "The listing is not active.");
    if (BigInt(quantity) > BigInt(listing.remaining_amount)) throw new ApiError(409, "INSUFFICIENT_QUANTITY", "The requested quantity is not available.");
    const paymentWei = (BigInt(listing.price_wei) * BigInt(quantity)).toString();
    const marketplaceAddress = contractAddress(input.marketplaceAddress, "marketplaceAddress");
    if (marketplaceAddress !== listing.marketplace_address) throw new ApiError(409, "MARKETPLACE_MISMATCH", "Purchase intent target does not match the indexed listing marketplace.");
    const { rows } = await this.db.query(`INSERT INTO transactions (chain_id, transaction_hash, idempotency_key, from_wallet, to_address, transaction_type, status, value_wei) VALUES ($1,$2,$3,$4,$5,'PURCHASE','PENDING',$6) RETURNING *`, [listing.chain_id, `intent:${key}`, key, identity.wallet, marketplaceAddress, paymentWei]);
    return { state: "PENDING", idempotent: false, paymentWei, quantity, listingId, transaction: rows[0], message: "Purchase intent created; wait for wallet submission and verification." };
  }

  async recordPurchaseSubmission({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.buyerWallet, "buyerWallet");
    const selectedChainId = chainId(input.chainId);
    const marketplaceAddress = contractAddress(input.marketplaceAddress, "marketplaceAddress");
    const selectedListingId = requiredText(input.listingId, "listingId");
    const selectedTransactionHash = transactionHash(input.transactionHash);
    const { rows: listingRows } = await this.db.query(`SELECT l.id, l.seller_wallet, l.chain_id, mc.address AS marketplace_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id WHERE l.id=$1 LIMIT 1`, [selectedListingId]);
    const listing = listingRows[0];
    if (!listing || Number(listing.chain_id) !== selectedChainId || listing.marketplace_address !== marketplaceAddress) throw new ApiError(409, "LISTING_SUBMISSION_MISMATCH", "Purchase submission does not match an indexed active listing.");
    const transaction = await this.repository.upsertTransaction({ chainId: selectedChainId, transactionHash: selectedTransactionHash, fromWallet: identity.wallet, toAddress: marketplaceAddress, transactionType: "PURCHASE", status: "SUBMITTED" });
    return { state: TERMINAL_TRANSACTION_STATES.has(transaction.status) ? transaction.status : "SUBMITTED", transaction, message: "Purchase submitted. Waiting for authoritative blockchain event indexing." };
  }

  async verifyPurchase({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.buyerWallet, "buyerWallet");
    if (typeof this.blockchainVerifier !== "function") throw new ApiError(501, "BLOCKCHAIN_VERIFIER_NOT_CONFIGURED", "Purchase verification is not configured.");
    const selectedChainId = chainId(input.chainId);
    const selectedTransactionHash = transactionHash(input.transactionHash);
    const marketplaceAddress = contractAddress(input.marketplaceAddress, "marketplaceAddress");
    const verification = await this.blockchainVerifier({ transactionHash: selectedTransactionHash, chainId: selectedChainId, marketplaceAddress });
    if (!verification || verification.state === "PENDING" || verification.state === "SUBMITTED") return { state: verification?.state || "PENDING", transactionHash: selectedTransactionHash };
    if (verification.state === "FAILED") {
      const transaction = await this.repository.upsertTransaction({ chainId: selectedChainId, transactionHash: selectedTransactionHash, fromWallet: identity.wallet, toAddress: marketplaceAddress, transactionType: "PURCHASE", status: "FAILED" });
      return { state: "FAILED", transaction };
    }
    if (verification.state !== "CONFIRMED" && verification.state !== "FINALIZED" && verification.state !== "RECONCILED") throw new ApiError(409, "INVALID_TRANSACTION_STATE", "Blockchain verifier returned an unsupported transaction state.");
    const listingResult = await this.db.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE l.id=$1 LIMIT 1`, [requiredText(input.listingId, "listingId")]);
    const listing = listingResult.rows[0];
    if (!listing) throw new ApiError(404, "LISTING_NOT_FOUND", "The referenced listing was not found.");
    const quantity = positiveBigInt(verification.quantity, "verified.quantity");
    const expectedPayment = BigInt(listing.price_wei) * BigInt(quantity);
    const platformFeeWei = nonNegativeBigInt(verification.platformFeeWei || "0", "verified.platformFeeWei");
    const royaltyWei = nonNegativeBigInt(verification.royaltyWei || "0", "verified.royaltyWei");
    const verifiedBlockNumber = nonNegativeBigInt(verification.blockNumber, "verified.blockNumber");
    const verifiedBlockHash = blockHash(verification.blockHash);
    if (Number(listing.chain_id) !== selectedChainId || BigInt(quantity) > BigInt(listing.remaining_amount) || String(verification.buyer).toLowerCase() !== identity.wallet || BigInt(verification.salePriceWei) !== expectedPayment || String(verification.seller).toLowerCase() !== listing.seller_wallet || String(verification.tokenId) !== String(listing.token_id) || contractAddress(verification.tokenContractAddress, "verified.tokenContractAddress") !== listing.token_contract_address || contractAddress(verification.marketplaceAddress || marketplaceAddress, "verified.marketplaceAddress") !== listing.marketplace_address || marketplaceAddress !== listing.marketplace_address || verification.currency !== "native" || BigInt(platformFeeWei) + BigInt(royaltyWei) > BigInt(verification.salePriceWei)) throw new ApiError(409, "SETTLEMENT_MISMATCH", "Blockchain settlement does not match the persisted listing.");
    const transaction = await this.repository.upsertTransaction({ chainId: selectedChainId, transactionHash: selectedTransactionHash, fromWallet: identity.wallet, toAddress: marketplaceAddress, transactionType: "PURCHASE", status: verification.state, blockNumber: verifiedBlockNumber, blockHash: verifiedBlockHash, valueWei: verification.salePriceWei });
    const purchase = await this.repository.recordPurchase({ listingUuid: listing.id, transactionId: transaction.id, chainId: selectedChainId, transactionHash: selectedTransactionHash, settlementLogIndex: logIndex(verification.logIndex), buyerWallet: identity.wallet, sellerWallet: listing.seller_wallet, tokenContractAddress: verification.tokenContractAddress, tokenId: verification.tokenId, quantity, salePriceWei: verification.salePriceWei, platformFeeWei, royaltyWei, blockNumber: verifiedBlockNumber, blockHash: verifiedBlockHash, status: verification.state });
    return { state: verification.state, transaction, purchase };
  }

  async issueExperienceGrant({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.wallet, "wallet");
    if (typeof this.ownershipVerifier !== "function") throw new ApiError(501, "OWNERSHIP_VERIFIER_NOT_CONFIGURED", "Ownership verification is not configured.");
    const ownership = await this.ownershipVerifier({ wallet: identity.wallet, experienceId: requiredText(input.experienceId, "experienceId") });
    if (!ownership?.owns || ownership.state !== "CONFIRMED" && ownership.state !== "FINALIZED") return { state: ownership?.state || "PENDING", grant: null };
    const grantId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 300_000);
    const grant = await this.repository.createGrant({ grantId, experienceId: input.experienceId, wallet: identity.wallet, mediaType: requiredText(input.mediaType, "mediaType"), issuedAt, expiresAt, ownershipChainId: ownership.chainId, ownershipWatermark: ownership.watermark, metadata: { state: "CONFIRMED" } });
    return { state: "CONFIRMED", grant };
  }

  async redeemExperience({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.wallet, "wallet");
    const result = await this.repository.inTransaction((repository) => repository.transitionRedemption({ id: requiredText(input.redemptionId, "redemptionId"), expectedState: requiredText(input.expectedState, "expectedState"), nextState: requiredText(input.nextState, "nextState"), actorWallet: identity.wallet, note: input.note || "" }));
    return { state: result.state, redemption: result };
  }
}
