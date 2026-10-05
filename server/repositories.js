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

const APPLICATION_STATUSES = ["DRAFT", "REVIEW", "PUBLISHED", "ARCHIVED"];
const LISTING_STATUSES = ["PENDING", "ACTIVE", "SOLD", "CANCELLED", "EXPIRED", "INVALID", "REORGED"];
const PURCHASE_STATUSES = ["PENDING", "SUBMITTED", "CONFIRMED", "FINALIZED", "RECONCILED", "FAILED", "REORGED"];
const TRANSACTION_STATUSES = ["PENDING", "SUBMITTED", "MINED", "CONFIRMED", "FINALIZED", "RECONCILED", "FAILED", "REPLACED", "REORGED"];
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

  async assignArtistOwner({ artistId, wallet, role = "OWNER" }) {
    const values = [requiredText(artistId, "artistOwner.artistId"), walletAddress(wallet, "artistOwner.wallet"), enumValue(role, "artistOwner.role", ["OWNER", "MANAGER"])];
    const { rows } = await this.db.query(`INSERT INTO artist_owners (artist_id, owner_wallet, role) VALUES ($1,$2,$3) ON CONFLICT (artist_id, owner_wallet) DO UPDATE SET role=EXCLUDED.role, updated_at=now() RETURNING *`, values);
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

  // A release contract is an immutable application binding: a retry may advance
  // evidence/status for the same deployment, but it may never silently point a
  // release at another ERC-1155 address or release key.
  async saveReleaseContract({
    releaseId,
    chainId: rawChainId,
    releaseContractId,
    factoryContractId = null,
    primarySaleContractId = null,
    provenanceAnchorContractId = null,
    releaseKey,
    artistWallet,
    implementationAddress,
    implementationVersion,
    deploymentTxHash = null,
    deploymentBlockNumber = null,
    creationLogIndex = null,
    status = "PENDING",
    metadata = {},
  }) {
    const selectedChainId = chainId(rawChainId);
    const values = [
      requiredText(releaseId, "releaseContract.releaseId"),
      selectedChainId,
      requiredText(releaseContractId, "releaseContract.releaseContractId"),
      factoryContractId,
      primarySaleContractId,
      provenanceAnchorContractId,
      requiredText(releaseKey, "releaseContract.releaseKey", { max: 66 }).toLowerCase(),
      walletAddress(artistWallet, "releaseContract.artistWallet"),
      walletAddress(implementationAddress, "releaseContract.implementationAddress"),
      Number(implementationVersion),
      optionalText(deploymentTxHash, "releaseContract.deploymentTxHash", { max: 128 })?.toLowerCase() || null,
      deploymentBlockNumber === null ? null : nonNegativeBigInt(deploymentBlockNumber, "releaseContract.deploymentBlockNumber"),
      creationLogIndex === null ? null : Number(creationLogIndex),
      enumValue(status, "releaseContract.status", ["PENDING", "DEPLOYED", "VERIFIED", "FAILED", "LEGACY_SHARED"]),
      normalizeJson(metadata),
    ];
    if (!Number.isInteger(values[9]) || values[9] <= 0 || values[9] > 32767) throw new PersistenceValidationError("releaseContract.implementationVersion must be a positive small integer.", "releaseContract.implementationVersion");
    if (values[12] !== null && (!Number.isInteger(values[12]) || values[12] < 0)) throw new PersistenceValidationError("releaseContract.creationLogIndex must be a non-negative integer.", "releaseContract.creationLogIndex");
    try {
      const { rows } = await this.db.query(`INSERT INTO release_contracts (release_id, chain_id, release_contract_id, factory_contract_id, primary_sale_contract_id, provenance_anchor_contract_id, release_key, artist_wallet, implementation_address, implementation_version, deployment_tx_hash, deployment_block_number, creation_log_index, status, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (release_id, chain_id) DO UPDATE SET factory_contract_id=EXCLUDED.factory_contract_id, primary_sale_contract_id=EXCLUDED.primary_sale_contract_id, provenance_anchor_contract_id=EXCLUDED.provenance_anchor_contract_id, implementation_address=EXCLUDED.implementation_address, implementation_version=EXCLUDED.implementation_version, deployment_tx_hash=COALESCE(EXCLUDED.deployment_tx_hash, release_contracts.deployment_tx_hash), deployment_block_number=COALESCE(EXCLUDED.deployment_block_number, release_contracts.deployment_block_number), creation_log_index=COALESCE(EXCLUDED.creation_log_index, release_contracts.creation_log_index), status=EXCLUDED.status, metadata=EXCLUDED.metadata, updated_at=now() WHERE release_contracts.release_contract_id=EXCLUDED.release_contract_id AND release_contracts.release_key=EXCLUDED.release_key AND release_contracts.artist_wallet=EXCLUDED.artist_wallet RETURNING *`, values);
      if (!rows[0]) throw new PersistenceConflictError("A release contract binding is immutable and cannot be reassigned.");
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Release contract already belongs to another release or has conflicting chain identity."); }
  }

  async getReleaseContract({ releaseId, chainId: rawChainId }) {
    const { rows } = await this.db.query(`SELECT rc.*, release_contract.address AS release_contract_address, factory_contract.address AS factory_address, sale_contract.address AS primary_sale_address, anchor_contract.address AS provenance_anchor_address FROM release_contracts rc JOIN contracts release_contract ON release_contract.id=rc.release_contract_id LEFT JOIN contracts factory_contract ON factory_contract.id=rc.factory_contract_id LEFT JOIN contracts sale_contract ON sale_contract.id=rc.primary_sale_contract_id LEFT JOIN contracts anchor_contract ON anchor_contract.id=rc.provenance_anchor_contract_id WHERE rc.release_id=$1 AND rc.chain_id=$2 LIMIT 1`, [requiredText(releaseId, "releaseContract.releaseId"), chainId(rawChainId)]);
    return rows[0] || null;
  }

  async createReleaseProvisioningRequest({ releaseId, chainId: rawChainId, releaseKey, artistWallet, factoryAddress, authorizationDigest, expectedParameters }) {
    const values = [requiredText(releaseId, "provisioning.releaseId"), chainId(rawChainId), requiredText(releaseKey, "provisioning.releaseKey").toLowerCase(), walletAddress(artistWallet, "provisioning.artistWallet"), walletAddress(factoryAddress, "provisioning.factoryAddress"), requiredText(authorizationDigest, "provisioning.authorizationDigest").toLowerCase(), normalizeJson(expectedParameters)];
    try {
      const { rows } = await this.db.query(`INSERT INTO release_provisioning_requests (release_id,chain_id,release_key,artist_wallet,factory_address,authorization_digest,expected_parameters) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (release_id,chain_id) DO UPDATE SET updated_at=now() WHERE release_provisioning_requests.release_key=EXCLUDED.release_key AND lower(release_provisioning_requests.artist_wallet)=lower(EXCLUDED.artist_wallet) AND lower(release_provisioning_requests.factory_address)=lower(EXCLUDED.factory_address) AND release_provisioning_requests.authorization_digest=EXCLUDED.authorization_digest RETURNING *`, values);
      if (!rows[0]) throw new PersistenceConflictError("A provisioning request already exists with different release parameters or artist authority.");
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "This release key or transaction is already assigned to another provisioning request."); }
  }

  async getReleaseProvisioningRequest({ releaseId, chainId: rawChainId }) {
    const { rows } = await this.db.query("SELECT * FROM release_provisioning_requests WHERE release_id=$1 AND chain_id=$2 LIMIT 1", [requiredText(releaseId, "provisioning.releaseId"), chainId(rawChainId)]);
    return rows[0] || null;
  }

  async updateReleaseProvisioningRequest({ releaseId, chainId: rawChainId, transactionHash, state = "SUBMITTED" }) {
    const selectedState = enumValue(state, "provisioning.state", ["PENDING", "SUBMITTED", "CONFIRMED", "FAILED", "RECONCILING"]);
    const tx = transactionHash == null ? null : requiredText(transactionHash, "provisioning.transactionHash", { max: 66 }).toLowerCase();
    if (tx !== null && !/^0x[0-9a-f]{64}$/.test(tx)) throw new PersistenceValidationError("provisioning.transactionHash must be a 32-byte transaction hash.", "provisioning.transactionHash");
    const { rows } = await this.db.query("UPDATE release_provisioning_requests SET transaction_hash=COALESCE($3,transaction_hash), state=$4, updated_at=now() WHERE release_id=$1 AND chain_id=$2 AND (transaction_hash IS NULL OR $3 IS NULL OR transaction_hash=$3) RETURNING *", [requiredText(releaseId, "provisioning.releaseId"), chainId(rawChainId), tx, selectedState]);
    if (!rows[0]) throw new PersistenceConflictError("The provisioning transaction hash conflicts with an existing request.");
    return rows[0];
  }

  async confirmReleaseProvisioningRequest({ releaseId, chainId: rawChainId, transactionHash, releaseContractAddress, primarySaleAddress, provenanceAnchorAddress, deploymentBlockNumber, creationLogIndex }) {
    const addresses = [releaseContractAddress, primarySaleAddress, provenanceAnchorAddress].map((value, index) => walletAddress(value, ["releaseContractAddress", "primarySaleAddress", "provenanceAnchorAddress"][index]));
    const tx = requiredText(transactionHash, "provisioning.transactionHash", { max: 66 }).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(tx)) throw new PersistenceValidationError("provisioning.transactionHash must be a 32-byte transaction hash.", "provisioning.transactionHash");
    const values = [requiredText(releaseId, "provisioning.releaseId"), chainId(rawChainId), tx, ...addresses, deploymentBlockNumber === null ? null : nonNegativeBigInt(deploymentBlockNumber, "provisioning.deploymentBlockNumber"), creationLogIndex === null ? null : Number(creationLogIndex)];
    const { rows } = await this.db.query("UPDATE release_provisioning_requests SET transaction_hash=$3,state='CONFIRMED',release_contract_address=$4,primary_sale_address=$5,provenance_anchor_address=$6,deployment_block_number=$7,creation_log_index=$8,confirmed_at=COALESCE(confirmed_at,now()),updated_at=now() WHERE release_id=$1 AND chain_id=$2 AND transaction_hash=$3 RETURNING *", values);
    if (!rows[0]) throw new PersistenceConflictError("The confirmed deployment does not match this release provisioning request.");
    return rows[0];
  }

  async saveEdition({ id, releaseId, contractId = null, title, tier = null, description = null, supply = null, status = "DRAFT", metadata = {} }) {
    const values = [requiredText(id, "edition.id"), requiredText(releaseId, "edition.releaseId"), contractId, requiredText(title, "edition.title"), optionalText(tier, "edition.tier"), optionalText(description, "edition.description", { max: 20000 }), supply === null ? null : nonNegativeBigInt(supply, "edition.supply"), enumValue(status, "edition.status", APPLICATION_STATUSES), normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO editions (id, release_id, contract_id, title, tier, description, supply, status, application_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET release_id=EXCLUDED.release_id, contract_id=EXCLUDED.contract_id, title=EXCLUDED.title, tier=EXCLUDED.tier, description=EXCLUDED.description, supply=EXCLUDED.supply, status=EXCLUDED.status, application_metadata=EXCLUDED.application_metadata, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  // A canonical token (contract_id, token_id) is never silently re-pointed to
  // another release, and so never to another artist. Re-saving the same edition
  // refreshes metadata. Only an unpublished draft may hand its token to another
  // draft of the same release (a Studio retry); anything else is a conflict.
  async saveToken({ editionId, contractId, tokenId, metadataUri = null, metadata = null, metadataVersion = null }) {
    const values = [requiredText(editionId, "token.editionId"), contractId, nonNegativeBigInt(tokenId, "token.tokenId"), optionalText(metadataUri, "token.metadataUri", { max: 2048 }), metadata === null ? null : normalizeJson(metadata), optionalText(metadataVersion, "token.metadataVersion")];
    const { rows } = await this.db.query(`INSERT INTO tokens (edition_id, contract_id, token_id, metadata_uri, metadata, metadata_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contract_id, token_id) DO UPDATE SET edition_id=EXCLUDED.edition_id, metadata_uri=EXCLUDED.metadata_uri, metadata=EXCLUDED.metadata, metadata_version=EXCLUDED.metadata_version, last_metadata_sync_at=now(), updated_at=now() WHERE tokens.edition_id=EXCLUDED.edition_id OR EXISTS (SELECT 1 FROM editions current_edition JOIN editions next_edition ON next_edition.release_id=current_edition.release_id WHERE current_edition.id=tokens.edition_id AND next_edition.id=EXCLUDED.edition_id AND current_edition.status<>'PUBLISHED') RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("This chain, contract and token ID already belong to another edition and cannot be reassigned.");
    return rows[0];
  }

  // requirements is a JSON array; node-pg would encode a JS array as a Postgres
  // array literal, which jsonb rejects, so it is serialized explicitly.
  async saveExperience({ id, artistId = null, releaseId = null, editionId = null, title, description = null, experienceType, requirements = [], mediaConfig = {}, version = 1, status = "DRAFT" }) {
    const values = [requiredText(id, "experience.id"), artistId, releaseId, editionId, requiredText(title, "experience.title"), optionalText(description, "experience.description", { max: 20000 }), requiredText(experienceType, "experience.experienceType"), JSON.stringify(Array.isArray(requirements) ? requirements : []), normalizeJson(mediaConfig), version, enumValue(status, "experience.status", APPLICATION_STATUSES)];
    const { rows } = await this.db.query(`INSERT INTO experiences (id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET artist_id=EXCLUDED.artist_id, release_id=EXCLUDED.release_id, edition_id=EXCLUDED.edition_id, title=EXCLUDED.title, description=EXCLUDED.description, experience_type=EXCLUDED.experience_type, requirements=EXCLUDED.requirements, media_config=EXCLUDED.media_config, version=EXCLUDED.version, status=EXCLUDED.status, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async saveMediaAsset({ id, artistId, storageKey, mediaType, contentSha256 = null, byteSize = null }) {
    const assetId = requiredText(id, "mediaAsset.id", { max: 128 });
    const key = requiredText(storageKey, "mediaAsset.storageKey", { max: 1024 });
    if (key.includes("..") || key.startsWith("/") || key.includes("\0")) throw new PersistenceValidationError("mediaAsset.storageKey must be a server storage key.", "mediaAsset.storageKey");
    const type = enumValue(String(mediaType || "").toUpperCase(), "mediaAsset.mediaType", ["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "DEMO", "LIVE_RECORDING"]);
    const owner = requiredText(artistId, "mediaAsset.artistId");
    const metadata = {};
    if (contentSha256 != null) {
      const hash = String(contentSha256).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new PersistenceValidationError("mediaAsset.contentSha256 must be a SHA-256 hex digest.", "mediaAsset.contentSha256");
      metadata.contentSha256 = hash;
      if (byteSize != null) metadata.byteSize = nonNegativeBigInt(byteSize, "mediaAsset.byteSize");
    }
    try {
      const { rows } = await this.db.query(`INSERT INTO media_assets (media_key, id, artist_id, storage_key, media_type, visibility, metadata) VALUES ($1,$1,$2,$3,$4,'PROTECTED',$5) ON CONFLICT (storage_key) DO UPDATE SET metadata = CASE WHEN EXCLUDED.metadata ? 'contentSha256' THEN EXCLUDED.metadata ELSE media_assets.metadata END WHERE media_assets.artist_id=$2 RETURNING *`, [assetId, owner, key, type, normalizeJson(metadata)]);
      if (!rows[0]) throw new PersistenceConflictError("Protected media storage key is already owned by another artist.");
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Protected media asset already exists."); }
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
    const values = [listingUuid, transactionId, chainId(rawChainId), requiredText(transactionHash, "purchase.transactionHash", { max: 128 }).toLowerCase(), Number(settlementLogIndex), walletAddress(buyerWallet, "purchase.buyerWallet"), walletAddress(sellerWallet, "purchase.sellerWallet"), requiredText(tokenContractAddress, "purchase.tokenContractAddress", { max: 128 }).toLowerCase(), nonNegativeBigInt(tokenId, "purchase.tokenId"), positiveBigInt(quantity, "purchase.quantity"), positiveBigInt(salePriceWei, "purchase.salePriceWei"), nonNegativeBigInt(platformFeeWei, "purchase.platformFeeWei"), nonNegativeBigInt(royaltyWei, "purchase.royaltyWei"), nonNegativeBigInt(blockNumber, "purchase.blockNumber"), requiredText(blockHash, "purchase.blockHash", { max: 128 }).toLowerCase(), enumValue(status, "purchase.status", PURCHASE_STATUSES)]
    if (!Number.isInteger(values[4]) || values[4] < 0) throw new PersistenceValidationError("purchase.settlementLogIndex must be a non-negative integer.", "purchase.settlementLogIndex");
    try {
      const { rows } = await this.db.query(`INSERT INTO purchases (listing_id, transaction_id, chain_id, transaction_hash, settlement_log_index, buyer_wallet, seller_wallet, token_contract_address, token_id, quantity, sale_price_wei, platform_fee_wei, royalty_wei, block_number, block_hash, status, finalized_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $16='FINALIZED' THEN now() ELSE NULL END) ON CONFLICT (chain_id, transaction_hash, settlement_log_index) DO UPDATE SET status=EXCLUDED.status, finalized_at=EXCLUDED.finalized_at RETURNING *`, values);
      return rows[0];
    } catch (error) { throw normalizeDbError(error, "Purchase settlement already exists with conflicting identity."); }
  }

  async upsertTransaction({ chainId: rawChainId, transactionHash, fromWallet = null, toAddress = null, transactionType, status = "SUBMITTED", blockNumber = null, blockHash = null, nonce = null, valueWei = null }) {
    const values = [chainId(rawChainId), requiredText(transactionHash, "transaction.transactionHash", { max: 128 }).toLowerCase(), fromWallet ? walletAddress(fromWallet, "transaction.fromWallet") : null, optionalText(toAddress, "transaction.toAddress", { max: 128 })?.toLowerCase() || null, enumValue(transactionType, "transaction.transactionType", ["LISTING_CREATE", "LISTING_CANCEL", "PURCHASE", "TRANSFER", "OTHER"]), enumValue(status, "transaction.status", TRANSACTION_STATUSES), blockNumber === null ? null : nonNegativeBigInt(blockNumber, "transaction.blockNumber"), blockHash ? requiredText(blockHash, "transaction.blockHash", { max: 128 }).toLowerCase() : null, nonce === null ? null : nonNegativeBigInt(nonce, "transaction.nonce"), valueWei === null ? null : nonNegativeBigInt(valueWei, "transaction.valueWei")];
    const { rows } = await this.db.query(`INSERT INTO transactions (chain_id, transaction_hash, from_wallet, to_address, transaction_type, status, block_number, block_hash, nonce, value_wei, mined_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $6 IN ('MINED','CONFIRMED','FINALIZED','RECONCILED') THEN now() ELSE NULL END,now()) ON CONFLICT (chain_id, transaction_hash) DO UPDATE SET from_wallet=COALESCE(transactions.from_wallet, EXCLUDED.from_wallet), to_address=COALESCE(transactions.to_address, EXCLUDED.to_address), status=CASE WHEN transactions.status IN ('CONFIRMED','FINALIZED','RECONCILED','FAILED','REORGED') AND EXCLUDED.status IN ('PENDING','SUBMITTED','MINED') THEN transactions.status ELSE EXCLUDED.status END, block_number=COALESCE(EXCLUDED.block_number, transactions.block_number), block_hash=COALESCE(EXCLUDED.block_hash, transactions.block_hash), value_wei=COALESCE(EXCLUDED.value_wei, transactions.value_wei), mined_at=COALESCE(transactions.mined_at, EXCLUDED.mined_at), finalized_at=CASE WHEN EXCLUDED.status IN ('FINALIZED','RECONCILED') THEN now() ELSE transactions.finalized_at END, updated_at=now() RETURNING *`, values);
    return rows[0];
  }

  async createNonce({ nonceHash, wallet, chainId: rawChainId, domain, origin, uri, purpose, issuedAt, expiresAt, requestId = null }) {
    const values = [requiredText(nonceHash, "nonce.nonceHash", { max: 256 }), walletAddress(wallet), chainId(rawChainId, "nonce.chainId"), requiredText(domain, "nonce.domain", { max: 255 }), requiredText(origin, "nonce.origin", { max: 2048 }), requiredText(uri, "nonce.uri", { max: 2048 }), requiredText(purpose, "nonce.purpose"), issuedAt, expiresAt, optionalText(requestId, "nonce.requestId", { max: 256 })];
    const { rows } = await this.db.query(`INSERT INTO auth_nonces (nonce_hash, wallet_address, chain_id, domain, origin, uri, purpose, issued_at, expires_at, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, values);
    return rows[0];
  }

  async getNonce({ nonceHash }) {
    const { rows } = await this.db.query(`SELECT nonce_hash, wallet_address, chain_id, domain, origin, uri, purpose, issued_at, expires_at, consumed_at FROM auth_nonces WHERE nonce_hash=$1 LIMIT 1`, [requiredText(nonceHash, "nonce.nonceHash", { max: 256 })]);
    return rows[0] || null;
  }

  async consumeNonce({ nonceHash, wallet, chainId: rawChainId, domain, origin, uri, purpose }) {
    const values = [requiredText(nonceHash, "nonce.nonceHash", { max: 256 }), walletAddress(wallet), chainId(rawChainId, "nonce.chainId"), requiredText(domain, "nonce.domain", { max: 255 }), requiredText(origin, "nonce.origin", { max: 2048 }), requiredText(uri, "nonce.uri", { max: 2048 }), requiredText(purpose, "nonce.purpose")];
    const { rows } = await this.db.query(`UPDATE auth_nonces SET consumed_at=now() WHERE nonce_hash=$1 AND wallet_address=$2 AND chain_id=$3 AND domain=$4 AND origin=$5 AND uri=$6 AND purpose=$7 AND consumed_at IS NULL AND expires_at > now() RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("Nonce is missing, expired, or already consumed.");
    return rows[0];
  }

  async createAuthSession({ sessionHash, wallet, chainId: rawChainId, purpose, issuedAt, expiresAt, requestId = null }) {
    const values = [requiredText(sessionHash, "session.sessionHash", { max: 256 }), walletAddress(wallet, "session.wallet"), chainId(rawChainId, "session.chainId"), requiredText(purpose, "session.purpose", { max: 64 }), issuedAt, expiresAt, optionalText(requestId, "session.requestId", { max: 256 })];
    const { rows } = await this.db.query(`INSERT INTO auth_sessions (token_hash, wallet_address, chain_id, purpose, issued_at, expires_at, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, values);
    return rows[0];
  }

  async getActiveAuthSession({ sessionHash }) {
    const { rows } = await this.db.query(`SELECT token_hash AS session_hash, wallet_address, chain_id, purpose, issued_at, expires_at FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`, [requiredText(sessionHash, "session.sessionHash", { max: 256 })]);
    return rows[0] || null;
  }

  async createGrant({ grantId, experienceId, wallet, mediaType, challengeNonceHash = null, issuedAt, expiresAt, ownershipChainId = null, ownershipWatermark = null, metadata = {} }) {
    const values = [requiredText(grantId, "grant.grantId", { max: 256 }), requiredText(experienceId, "grant.experienceId"), walletAddress(wallet), requiredText(mediaType, "grant.mediaType"), challengeNonceHash, issuedAt, expiresAt, ownershipChainId === null ? null : chainId(ownershipChainId), ownershipWatermark, normalizeJson(metadata)];
    const { rows } = await this.db.query(`INSERT INTO experience_grants (grant_id, experience_id, wallet_address, media_type, challenge_nonce_hash, issued_at, expires_at, ownership_chain_id, ownership_watermark, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, values);
    return rows[0];
  }

  async getMediaGrant({ grantId, includeInactive = false }) {
    const { rows } = await this.db.query(`SELECT * FROM experience_grants WHERE grant_id=$1 ${includeInactive ? "" : "AND revoked_at IS NULL AND expires_at > now()"} LIMIT 1`, [requiredText(grantId, "grant.grantId", { max: 256 })]);
    return rows[0] || null;
  }

  async revokeMediaGrant({ grantId, wallet, reason = "wallet_requested" }) {
    const values = [requiredText(grantId, "grant.grantId", { max: 256 }), walletAddress(wallet, "grant.wallet"), optionalText(reason, "grant.reason", { max: 2000 }) || "wallet_requested"];
    const { rows } = await this.db.query(`UPDATE experience_grants SET revoked_at=now(), metadata=metadata || jsonb_build_object('revocationReason',$3) WHERE grant_id=$1 AND wallet_address=$2 AND revoked_at IS NULL RETURNING *`, values);
    if (!rows[0]) throw new PersistenceConflictError("Grant is missing, already revoked, or belongs to another wallet.");
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
