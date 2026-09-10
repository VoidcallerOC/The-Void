import { withTransaction } from "./db.js";
import {
  PersistenceConflictError,
  PersistenceValidationError,
  chainId,
  enumValue,
  nonNegativeBigInt,
  normalizeJson,
  optionalText,
  positiveBigInt,
  requiredText,
  walletAddress,
} from "./validation.js";

const APPLICATION_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const LISTING_STATUSES = ["ACTIVE", "SOLD", "CANCELLED", "EXPIRED", "REORGED"];
const REDEMPTION_STATES = ["AVAILABLE", "RESERVED", "REDEEMED", "CANCELLED"];

function normalizeDbError(error, message) {
  if (error?.code === "23505") return new PersistenceConflictError(message, error);
  return error;
}

function queryExecutor(db) {
  if (!db?.query) throw new TypeError("A database pool or transaction client is required.");
  return db;
}

export class PersistenceRepository {
  constructor(db) { this.db = queryExecutor(db); }

  async saveArtist({ id, slug, displayName, status = "ACTIVE", metadata = {} }) {
    const values = [requiredText(id, "artist.id"), requiredText(slug, "artist.slug"), requiredText(displayName, "artist.displayName"), enumValue(status, "artist.status", ["ACTIVE", "ARCHIVED"]), normalizeJson(metadata)];
    try {
      const { rows } = await this.db.query(`INSERT INTO artists (id, slug, display_name, status, application_metadata) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, display_name=EXCLUDED.display_name, status=EXCLUDED.status, application_metadata=EXCLUDED.application_metadata, updated_at=now() RETURNING *`, values);
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Artist already exists with this slug or id."); }
  }

  async saveArtistProfile({ artistId, bio = null, websiteUrl = null, socialLinks = {}, metadata = {} }) {
    const values = [requiredText(artistId, "artistProfile.artistId"), optionalText(bio, "artistProfile.bio", { max: 10000 }), optionalText(websiteUrl, "artistProfile.websiteUrl"), normalizeJson(socialLinks), normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO artist_profiles (artist_id, bio, website_url, social_links, profile_metadata) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (artist_id) DO UPDATE SET bio=EXCLUDED.bio, website_url=EXCLUDED.website_url, social_links=EXCLUDED.social_links, profile_metadata=EXCLUDED.profile_metadata, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async saveRelease({ id, artistId, slug, title, description = null, status = "DRAFT", metadata = {}, publishedAt = null }) {
    const values = [requiredText(id, "release.id"), requiredText(artistId, "release.artistId"), requiredText(slug, "release.slug"), requiredText(title, "release.title"), optionalText(description, "release.description", { max: 20000 }), enumValue(status, "release.status", APPLICATION_STATUSES), normalizeJson(metadata), publishedAt];
    try {
      const { rows } = await this.db.query(`INSERT INTO releases (id, artist_id, slug, title, description, status, release_metadata, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET artist_id=EXCLUDED.artist_id, slug=EXCLUDED.slug, title=EXCLUDED.title, description=EXCLUDED.description, status=EXCLUDED.status, release_metadata=EXCLUDED.release_metadata, published_at=EXCLUDED.published_at, updated_at=now() RETURNING *`, values);
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Release already exists with this artist and slug or id."); }
  }

  async saveContract({ chainId: rawChainId, chainKey, address, contractType, name = null, deploymentTxHash = null, deploymentBlockNumber = null, verifiedSourceUrl = null, bytecodeHash = null, metadata = {} }) {
    const values = [chainId(rawChainId), requiredText(chainKey, "contract.chainKey"), requiredText(address, "contract.address", { max: 128 }).toLowerCase(), enumValue(contractType, "contract.contractType", ["ERC1155", "MARKETPLACE", "OTHER"]), optionalText(name, "contract.name"), optionalText(deploymentTxHash, "contract.deploymentTxHash", { max: 128 }), deploymentBlockNumber === null ? null : nonNegativeBigInt(deploymentBlockNumber, "contract.deploymentBlockNumber"), optionalText(verifiedSourceUrl, "contract.verifiedSourceUrl", { max: 2048 }), optionalText(bytecodeHash, "contract.bytecodeHash", { max: 256 }), normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO contracts (chain_id, chain_key, address, contract_type, name, deployment_tx_hash, deployment_block_number, verified_source_url, bytecode_hash, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (chain_id, address) DO UPDATE SET chain_key=EXCLUDED.chain_key, contract_type=EXCLUDED.contract_type, name=EXCLUDED.name, deployment_tx_hash=EXCLUDED.deployment_tx_hash, deployment_block_number=EXCLUDED.deployment_block_number, verified_source_url=EXCLUDED.verified_source_url, bytecode_hash=EXCLUDED.bytecode_hash, metadata=EXCLUDED.metadata, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async saveEdition({ id, releaseId, contractId = null, title, tier = null, description = null, supply = null, status = "DRAFT", metadata = {} }) {
    const values = [requiredText(id, "edition.id"), requiredText(releaseId, "edition.releaseId"), contractId, requiredText(title, "edition.title"), optionalText(tier, "edition.tier"), optionalText(description, "edition.description", { max: 20000 }), supply === null ? null : nonNegativeBigInt(supply, "edition.supply"), enumValue(status, "edition.status", APPLICATION_STATUSES), normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO editions (id, release_id, contract_id, title, tier, description, supply, status, application_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET release_id=EXCLUDED.release_id, contract_id=EXCLUDED.contract_id, title=EXCLUDED.title, tier=EXCLUDED.tier, description=EXCLUDED.description, supply=EXCLUDED.supply, status=EXCLUDED.status, application_metadata=EXCLUDED.application_metadata, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async saveToken({ editionId, contractId, tokenId, metadataUri = null, metadata = null, metadataVersion = null }) {
    const values = [requiredText(editionId, "token.editionId"), contractId, nonNegativeBigInt(tokenId, "token.tokenId"), optionalText(metadataUri, "token.metadataUri", { max: 2048 }), metadata === null ? null : normalizeJson(metadata), optionalText(metadataVersion, "token.metadataVersion")];
    const { rows } = await this.db.query(`INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri, metadata, metadata_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contract_id, token_id) DO UPDATE SET edition_id=EXCLUDED.edition_id, metadata_uri=EXCLUDED.metadata_uri, metadata=EXCLUDED.metadata, metadata_version=EXCLUDED.metadata_version, last_metadata_sync_at=now(), updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async saveExperience({ id, artistId = null, releaseId = null, editionId = null, title, description = null, experienceType, requirements = [], mediaConfig = {}, version = 1, status = "DRAFT" }) {
    const values = [requiredText(id, "experience.id"), artistId, releaseId, editionId, requiredText(title, "experience.title"), optionalText(description, "experience.description", { max: 20000 }), requiredText(experienceType, "experience.experienceType"), requirements, normalizeJson(mediaConfig), version, enumValue(status, "experience.status", APPLICATION_STATUSES)];
    const { rows } = await this.db.query(`INSERT INTO experiences (id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET artist_id=EXCLUDED.artist_id, release_id=EXCLUDED.release_id, edition_id=EXCLUDED.edition_id, title=EXCLUDED.title, description=EXCLUDED.description, experience_type=EXCLUDED.experience_type, requirements=EXCLUDED.requirements, media_config=EXCLUDED.media_config, version=EXCLUDED.version, status=EXCLUDED.status, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async upsertCollector(wallet) {
    const address = walletAddress(wallet);
    const { rows } = await this.db.query(`INSERT INTO collectors (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now() RETURNING *`, [address]);
    return rows[0];
  }

  async recordTransfer({ chainId: rawChainId, contractAddress, tokenId, fromWallet, toWallet, amount, transactionHash, blockNumber, blockHash, logIndex, eventType, eventData = {}, blockTimestamp }) {
    const values = [chainId(rawChainId), requiredText(contractAddress, "transfer.contractAddress", { max: 128 }).toLowerCase(), nonNegativeBigInt(tokenId, "transfer.tokenId"), walletAddress(fromWallet, "transfer.fromWallet"), walletAddress(toWallet, "transfer.toWallet"), nonNegativeBigInt(amount, "transfer.amount"), requiredText(transactionHash, "transfer.transactionHash", { max: 128 }).toLowerCase(), nonNegativeBigInt(blockNumber, "transfer.blockNumber"), requiredText(blockHash, "transfer.blockHash", { max: 128 }).toLowerCase(), Number(logIndex), enumValue(eventType, "transfer.eventType", ["TransferSingle", "TransferBatch", "MINT", "BURN"]), normalizeJson(eventData), blockTimestamp];
    if (!Number.isInteger(values[9]) || values[9] < 0) throw new PersistenceValidationError("transfer.logIndex must be a non-negative integer.", "transfer.logIndex");
    try {
      const { rows } = await this.db.query(`INSERT INTO transfers (chain_id, contract_address, token_id, from_wallet, to_wallet, amount, transaction_hash, block_number, block_hash, log_index, event_type, event_data, block_timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (chain_id, transaction_hash, log_index) DO UPDATE SET is_canonical=true, indexed_at=now() RETURNING *`, values);
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Transfer event already exists with conflicting identity."); }
  }

  async upsertOwnershipSnapshot({ chainId: rawChainId, contractAddress, tokenId, wallet, amount, sourceBlockNumber, sourceBlockHash, synchronizationWatermark }) {
    const values = [chainId(rawChainId), requiredText(contractAddress, "ownership.contractAddress", { max: 128 }).toLowerCase(), nonNegativeBigInt(tokenId, "ownership.tokenId"), walletAddress(wallet), nonNegativeBigInt(amount, "ownership.amount"), nonNegativeBigInt(sourceBlockNumber, "ownership.sourceBlockNumber"), requiredText(sourceBlockHash, "ownership.sourceBlockHash", { max: 128 }).toLowerCase(), requiredText(synchronizationWatermark, "ownership.synchronizationWatermark", { max: 256 })];
    const { rows } = await this.db.query(`INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (chain_id, contract_address, token_id, wallet_address) DO UPDATE SET amount=EXCLUDED.amount, source_block_number=EXCLUDED.source_block_number, source_block_hash=EXCLUDED.source_block_hash, synchronization_watermark=EXCLUDED.synchronization_watermark, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async upsertListing({ chainId: rawChainId, marketplaceContractId, listingId, sellerWallet, tokenContractId, tokenId, amount, remainingAmount = amount, priceWei, currency = "native", expiresAt = null, status = "ACTIVE", createdTxHash = null, createdBlockNumber = null, createdBlockHash = null, createdLogIndex = null, metadata = {} }) {
    const values = [chainId(rawChainId), marketplaceContractId, nonNegativeBigInt(listingId, "listing.listingId"), walletAddress(sellerWallet, "listing.sellerWallet"), tokenContractId, nonNegativeBigInt(tokenId, "listing.tokenId"), nonNegativeBigInt(amount, "listing.amount"), nonNegativeBigInt(remainingAmount, "listing.remainingAmount"), positiveBigInt(priceWei, "listing.priceWei"), requiredText(currency, "listing.currency", { max: 32 }), expiresAt, enumValue(status, "listing.status", LISTING_STATUSES), createdTxHash ? requiredText(createdTxHash, "listing.createdTxHash", { max: 128 }).toLowerCase() : null, createdBlockNumber === null ? null : nonNegativeBigInt(createdBlockNumber, "listing.createdBlockNumber"), createdBlockHash ? requiredText(createdBlockHash, "listing.createdBlockHash", { max: 128 }).toLowerCase() : null, createdLogIndex, normalizeJson(metadata)];
    if (BigInt(values[7]) > BigInt(values[6])) throw new PersistenceValidationError("listing.remainingAmount cannot exceed listing.amount.", "listing.remainingAmount");
    const { rows } = await this.db.query(`INSERT INTO listings (chain_id, marketplace_contract_id, listing_id, seller_wallet, token_contract_id, token_id, amount, remaining_amount, price_wei, currency, expires_at, status, created_tx_hash, created_block_number, created_block_hash, created_log_index, application_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (chain_id, marketplace_contract_id, listing_id) DO UPDATE SET remaining_amount=EXCLUDED.remaining_amount, price_wei=EXCLUDED.price_wei, expires_at=EXCLUDED.expires_at, status=EXCLUDED.status, application_metadata=EXCLUDED.application_metadata, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async transitionListing({ listingUuid, expectedStatus, nextStatus, remainingAmount = null, transactionHash = null, blockNumber = null, blockHash = null, logIndex = null }) {
    enumValue(expectedStatus, "listing.expectedStatus", LISTING_STATUSES);
    enumValue(nextStatus, "listing.nextStatus", LISTING_STATUSES);
    const values = [requiredText(listingUuid, "listing.id"), expectedStatus, nextStatus, remainingAmount === null ? null : nonNegativeBigInt(remainingAmount, "listing.remainingAmount"), transactionHash ? requiredText(transactionHash, "listing.transactionHash", { max: 128 }).toLowerCase() : null, blockNumber === null ? null : nonNegativeBigInt(blockNumber, "listing.blockNumber"), blockHash ? requiredText(blockHash, "listing.blockHash", { max: 128 }).toLowerCase() : null, logIndex];
    const { rows } = await this.db.query(`UPDATE listings SET status=$3, remaining_amount=COALESCE($4, remaining_amount), updated_at=now() WHERE id=$1 AND status=$2 RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("Listing status changed concurrently.");
    await this.db.query(`INSERT INTO listing_status_history (listing_id, status, transaction_hash, block_number, block_hash, log_index) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [rows[0].id, nextStatus, values[4], values[5], values[6], values[7]]);
    return rows[0];
  }

  async recordPurchase({ listingUuid, transactionId = null, chainId: rawChainId, transactionHash, settlementLogIndex, buyerWallet, sellerWallet, tokenContractAddress, tokenId, quantity, salePriceWei, platformFeeWei = "0", royaltyWei = "0", blockNumber, blockHash, status = "PENDING" }) {
    const values = [listingUuid, transactionId, chainId(rawChainId), requiredText(transactionHash, "purchase.transactionHash", { max: 128 }).toLowerCase(), Number(settlementLogIndex), walletAddress(buyerWallet, "purchase.buyerWallet"), walletAddress(sellerWallet, "purchase.sellerWallet"), requiredText(tokenContractAddress, "purchase.tokenContractAddress", { max: 128 }).toLowerCase(), nonNegativeBigInt(tokenId, "purchase.tokenId"), positiveBigInt(quantity, "purchase.quantity"), positiveBigInt(salePriceWei, "purchase.salePriceWei"), nonNegativeBigInt(platformFeeWei, "purchase.platformFeeWei"), nonNegativeBigInt(royaltyWei, "purchase.royaltyWei"), nonNegativeBigInt(blockNumber, "purchase.blockNumber"), requiredText(blockHash, "purchase.blockHash", { max: 128 }).toLowerCase(), enumValue(status, "purchase.status", ["PENDING", "CONFIRMED", "FINALIZED", "REORGED"])]
    if (!Number.isInteger(values[4]) || values[4] < 0) throw new PersistenceValidationError("purchase.settlementLogIndex must be a non-negative integer.", "purchase.settlementLogIndex");
    try {
      const { rows } = await this.db.query(`INSERT INTO purchases (listing_id, transaction_id, chain_id, transaction_hash, settlement_log_index, buyer_wallet, seller_wallet, token_contract_address, token_id, quantity, sale_price_wei, platform_fee_wei, royalty_wei, block_number, block_hash, status, confirmation_status, reconciliation_status, finalized_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $16 IN ('CONFIRMED','FINALIZED') THEN 'CONFIRMED' ELSE 'PENDING' END,'MATCHED',CASE WHEN $16='FINALIZED' THEN now() ELSE NULL END) ON CONFLICT (chain_id, transaction_hash, settlement_log_index) DO UPDATE SET status=EXCLUDED.status, confirmation_status=EXCLUDED.confirmation_status, finalized_at=EXCLUDED.finalized_at RETURNING *`, values);
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Purchase settlement already exists with conflicting identity."); }
  }

  async upsertTransaction({ chainId: rawChainId, transactionHash, fromWallet = null, toAddress = null, transactionType, status = "SUBMITTED", blockNumber = null, blockHash = null, nonce = null, valueWei = null }) {
    const values = [chainId(rawChainId), requiredText(transactionHash, "transaction.transactionHash", { max: 128 }).toLowerCase(), fromWallet ? walletAddress(fromWallet, "transaction.fromWallet") : null, optionalText(toAddress, "transaction.toAddress", { max: 128 })?.toLowerCase() || null, enumValue(transactionType, "transaction.transactionType", ["LISTING_CREATE", "LISTING_CANCEL", "PURCHASE", "TRANSFER", "OTHER"]), enumValue(status, "transaction.status", ["SUBMITTED", "PENDING", "OBSERVED", "MINED", "CONFIRMED", "FINALIZED", "FAILED", "REVERTED", "REPLACED", "STALE", "RECONCILIATION_REQUIRED", "REORGED"]), blockNumber === null ? null : nonNegativeBigInt(blockNumber, "transaction.blockNumber"), blockHash ? requiredText(blockHash, "transaction.blockHash", { max: 128 }).toLowerCase() : null, nonce === null ? null : nonNegativeBigInt(nonce, "transaction.nonce"), valueWei === null ? null : nonNegativeBigInt(valueWei, "transaction.valueWei")];
    const { rows } = await this.db.query(`INSERT INTO transactions (chain_id, transaction_hash, from_wallet, to_address, transaction_type, status, block_number, block_hash, nonce, value_wei, mined_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $6 IN ('MINED','CONFIRMED','FINALIZED') THEN now() ELSE NULL END,now()) ON CONFLICT (chain_id, transaction_hash) DO UPDATE SET status=EXCLUDED.status, block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, mined_at=COALESCE(transactions.mined_at, EXCLUDED.mined_at), finalized_at=CASE WHEN EXCLUDED.status='FINALIZED' THEN now() ELSE transactions.finalized_at END, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async createNonce({ nonceHash, wallet, purpose, issuedAt, expiresAt, requestId = null }) {
    const values = [requiredText(nonceHash, "nonce.nonceHash", { max: 256 }), walletAddress(wallet), requiredText(purpose, "nonce.purpose"), issuedAt, expiresAt, optionalText(requestId, "nonce.requestId", { max: 256 })];
    const { rows } = await this.db.query(`INSERT INTO auth_nonces (nonce_hash, wallet_address, purpose, issued_at, expires_at, request_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, values);
    return rows[0];
  }

  async consumeNonce({ nonceHash, wallet, purpose }) {
    const values = [requiredText(nonceHash, "nonce.nonceHash", { max: 256 }), walletAddress(wallet), requiredText(purpose, "nonce.purpose")];
    const { rows } = await this.db.query(`UPDATE auth_nonces SET consumed_at=now() WHERE nonce_hash=$1 AND wallet_address=$2 AND purpose=$3 AND consumed_at IS NULL AND expires_at > now() RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("Nonce is missing, expired, or already consumed.");
    return rows[0];
  }

  async createGrant({ grantId, experienceId, wallet, mediaType, challengeNonceHash = null, issuedAt, expiresAt, ownershipChainId = null, ownershipWatermark = null, metadata = {} }) {
    const values = [requiredText(grantId, "grant.grantId", { max: 256 }), requiredText(experienceId, "grant.experienceId"), walletAddress(wallet), requiredText(mediaType, "grant.mediaType"), challengeNonceHash, issuedAt, expiresAt, ownershipChainId === null ? null : chainId(ownershipChainId), ownershipWatermark, normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO experience_grants (grant_id, experience_id, wallet_address, media_type, challenge_nonce_hash, issued_at, expires_at, ownership_chain_id, ownership_watermark, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, values);
    return rows[0];
  }

  async transitionRedemption({ id, expectedState, nextState, actorWallet = null, note = "" }) {
    enumValue(expectedState, "redemption.expectedState", REDEMPTION_STATES);
    enumValue(nextState, "redemption.nextState", REDEMPTION_STATES);
    const transitions = { AVAILABLE: ["RESERVED", "CANCELLED"], RESERVED: ["REDEEMED", "CANCELLED"], REDEEMED: [], CANCELLED: [] };
    if (!transitions[expectedState].includes(nextState)) throw new PersistenceConflictError(`Invalid redemption transition: ${expectedState} -> ${nextState}.`);
    const values = [requiredText(id, "redemption.id"), expectedState, nextState];
    const { rows } = await this.db.query(`UPDATE redemptions SET state=$3, reserved_at=CASE WHEN $3='RESERVED' THEN now() ELSE reserved_at END, redeemed_at=CASE WHEN $3='REDEEMED' THEN now() ELSE redeemed_at END, updated_at=now() WHERE id=$1 AND state=$2 RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("Redemption state changed concurrently.");
    await this.db.query(`INSERT INTO audit_events (event_type, actor_wallet, subject_type, subject_id, payload) VALUES ('REDEMPTION_TRANSITION', $1, 'redemption', $2, $3)`, [actorWallet ? walletAddress(actorWallet, "redemption.actorWallet") : null, id, { from: expectedState, to: nextState, note }]);
    return rows[0];
  }

  async appendAuditEvent({ eventType, actorWallet = null, subjectType = null, subjectId = null, requestId = null, chainId: rawChainId = null, transactionHash = null, payload = {} }) {
    const values = [requiredText(eventType, "audit.eventType"), actorWallet ? walletAddress(actorWallet, "audit.actorWallet") : null, optionalText(subjectType, "audit.subjectType"), optionalText(subjectId, "audit.subjectId"), optionalText(requestId, "audit.requestId", { max: 256 }), rawChainId === null ? null : chainId(rawChainId), optionalText(transactionHash, "audit.transactionHash", { max: 128 })?.toLowerCase() || null, normalizeJson(payload)];
    const { rows } = await this.db.query(`INSERT INTO audit_events (event_type, actor_wallet, subject_type, subject_id, request_id, chain_id, transaction_hash, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, values);
    return rows[0];
  }

  async recordMediaAuthorization({ grantId, wallet, experienceId, mediaType, action, requestId = null, ipHash = null, userAgentHash = null, reason = null }) {
    const values = [requiredText(grantId, "mediaAuthorization.grantId"), walletAddress(wallet), requiredText(experienceId, "mediaAuthorization.experienceId"), requiredText(mediaType, "mediaAuthorization.mediaType"), enumValue(action, "mediaAuthorization.action", ["GRANT_ISSUED", "MEDIA_AUTHORIZED", "MEDIA_DENIED", "REVOKED"]), optionalText(requestId, "mediaAuthorization.requestId", { max: 256 }), optionalText(ipHash, "mediaAuthorization.ipHash", { max: 256 }), optionalText(userAgentHash, "mediaAuthorization.userAgentHash", { max: 256 }), optionalText(reason, "mediaAuthorization.reason", { max: 2000 })];
    const { rows } = await this.db.query(`INSERT INTO media_authorizations (grant_id, wallet_address, experience_id, media_type, action, request_id, ip_hash, user_agent_hash, reason) SELECT id, $2,$3,$4,$5,$6,$7,$8,$9 FROM experience_grants WHERE grant_id=$1 RETURNING *`, values);
    if (!rows[0]) throw new PersistenceValidationError("mediaAuthorization.grantId does not reference a persisted grant.", "mediaAuthorization.grantId");
    return rows[0];
  }

  async inTransaction(callback) { return withTransaction(this.db, (client) => callback(new PersistenceRepository(client))); }
}

export function createPersistenceRepository(db) { return new PersistenceRepository(db); }
