import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { certifiedContractParams } from "./fuji-contract-scope.js";
import { ARTIST_SELECT } from "./artist-verified-select.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { checkDatabaseHealth } from "./db.js";
import { reportIndexedContracts } from "./indexer-contracts.js";
import { chainId, nonNegativeBigInt, positiveBigInt, requiredText, walletAddress } from "./validation.js";
import { isHiddenPublicArtist, isWithdrawnPublicListing } from "../src/lib/summit-demo.js";
import { isPublicLegacyArtwork } from "../src/lib/legacy-genesis.js";

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

const SENSITIVE_PUBLIC_KEYS = new Set(["mediaconfig", "requirements", "storagekey", "protectedmedia", "cid"]);
const CID_VALUE = /^(?:ipfs:\/\/)?(?:baf[a-z2-7]{20,}|qm[1-9a-hj-np-za-km-z]{44,})$/i;
const CID_EMBEDDED = /(?:ipfs:\/\/)?(?:baf[a-z2-7]{20,}|qm[1-9a-hj-np-za-km-z]{44,})/gi;

function sanitizePublicValue(value) {
  if (typeof value === "string") {
    // The legacy tokens' on-chain images are public by design; keep exactly those.
    if (isPublicLegacyArtwork(value)) return value;
    if (CID_VALUE.test(value.trim())) return undefined;
    const redacted = value.replace(CID_EMBEDDED, "").trim();
    return redacted ? redacted : undefined;
  }
  if (Array.isArray(value)) return value.map(sanitizePublicValue).filter((item) => item !== undefined);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_PUBLIC_KEYS.has(String(key).toLowerCase().replace(/[_-]/g, ""))) continue;
    const next = sanitizePublicValue(child);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function toPublicRow(row, fields) {
  if (!row) return null;
  const out = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const value = sanitizePublicValue(row[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// A published token's metadata is already public: it is the document its
// on-chain tokenURI points to. Only the standard display fields are exposed, and
// only for tokens that have been published (metadata_uri set). image and
// animation_url keep their ipfs:// address because that is the public artwork
// and the vetted ~30 s preview; every other value is still CID-redacted.
const PUBLIC_MEDIA_URI = /^(?:ipfs:\/\/[A-Za-z0-9]+(?:\/[\w.\-%]+)*|https:\/\/[^\s]+)$/;
function publicTokenMetadata(row) {
  const metadata = row?.token_metadata;
  if (!row?.token_metadata_uri || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const out = {};
  for (const key of ["name", "description"]) {
    const value = typeof metadata[key] === "string" ? sanitizePublicValue(metadata[key]) : undefined;
    if (value) out[key] = value;
  }
  for (const key of ["image", "animation_url"]) {
    if (typeof metadata[key] === "string" && PUBLIC_MEDIA_URI.test(metadata[key].trim())) out[key] = metadata[key].trim();
  }
  if (Array.isArray(metadata.attributes)) out.attributes = sanitizePublicValue(metadata.attributes.filter((item) => item && typeof item === "object"));
  return Object.keys(out).length ? out : undefined;
}

function toPublicEdition(row) {
  const edition = toPublicRow(row, EDITION_PUBLIC_FIELDS);
  if (!edition) return edition;
  const tokenMetadata = publicTokenMetadata(row);
  if (tokenMetadata) edition.token_metadata = tokenMetadata;
  // Only album tracks carry these keys; mintEnd is the on-chain uint64 seconds ("0" = no deadline).
  if (typeof row.album_is_single === "boolean") {
    edition.isAlbumSingle = row.album_is_single;
    edition.mintEnd = String(row.album_mint_end);
    edition.albumClosed = row.album_closed === true;
  }
  return edition;
}

const EXPERIENCE_PUBLIC_FIELDS = ["id", "artist_id", "release_id", "edition_id", "title", "description", "experience_type", "version", "status", "created_at", "updated_at", "gated", "protected"];
const RELEASE_PUBLIC_FIELDS = ["id", "artist_id", "slug", "title", "description", "status", "release_metadata", "published_at", "created_at", "updated_at", "artist_slug", "artist_name"];
const EDITION_PUBLIC_FIELDS = ["id", "release_id", "title", "tier", "description", "supply", "status", "application_metadata", "created_at", "updated_at", "release_title", "artist_id", "chain_id", "contract_address", "release_contract_address", "factory_address", "primary_sale_address", "token_id"];
const EXPERIENCE_PUBLIC_SELECT = `id, artist_id, release_id, edition_id, title, description, experience_type, version, status, created_at, updated_at, (jsonb_typeof(requirements) = 'array' AND jsonb_array_length(requirements) > 0) AS gated, (COALESCE(media_config->>'protected', '') = 'true' OR (jsonb_typeof(media_config->'protectedMedia') = 'array' AND jsonb_array_length(media_config->'protectedMedia') > 0)) AS protected`;
const RELEASE_PUBLIC_SELECT = `r.id, r.artist_id, r.slug, r.title, r.description, r.status, r.release_metadata, r.published_at, r.created_at, r.updated_at, a.slug AS artist_slug, a.display_name AS artist_name`;
const EDITION_PUBLIC_SELECT = `e.id, e.release_id, e.title, e.tier, e.description, e.supply, e.status, e.application_metadata, e.created_at, e.updated_at, r.title AS release_title, r.artist_id, c.chain_id, c.address AS contract_address, c.address AS release_contract_address, factory.address AS factory_address, sale.address AS primary_sale_address, t.token_id::text AS token_id, t.metadata_uri AS token_metadata_uri, t.metadata AS token_metadata, album_track.is_single AS album_is_single, album_track.mint_end::text AS album_mint_end, (album.closed_block_number IS NOT NULL) AS album_closed`;
// Chain-indexed VoidRelease1155V4 album state; editions without an AlbumTrackCreated row are unaffected.
const EDITION_ALBUM_JOIN = `LEFT JOIN release_album_tracks album_track ON album_track.chain_id=c.chain_id AND album_track.contract_address=lower(c.address) AND album_track.token_id=t.token_id LEFT JOIN release_albums album ON album.chain_id=c.chain_id AND album.contract_address=lower(c.address)`;

export class ApiService {
  constructor({ db, repository, authenticator = null, ownershipVerifier = null, blockchainVerifier = null, indexerStore = null, indexerConfig = null, rateLimiter = null, logger = console } = {}) {
    if (!db?.query || !repository) throw new TypeError("ApiService requires a database executor and persistence repository.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.ownershipVerifier = ownershipVerifier;
    this.blockchainVerifier = blockchainVerifier;
    this.indexerStore = indexerStore;
    this.indexerConfig = indexerConfig;
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

  async getIndexerHealth({ chainId: requestedChainId = null } = {}, healthContracts = null) {
    if (!this.indexerStore?.getIndexerHealth) throw new ApiError(503, "INDEXER_UNAVAILABLE", "Indexer health storage is not configured.");
    const selectedChainId = requestedChainId === null || requestedChainId === undefined || requestedChainId === "" ? null : chainId(requestedChainId);
    const scoped = Boolean(this.indexerConfig?.chainId) && (selectedChainId === null || this.indexerConfig.chainId === selectedChainId);
    if (!scoped) return this.indexerStore.getIndexerHealth({ chainId: selectedChainId });
    const addresses = (healthContracts || await this.getHealthContracts()).map((contract) => contract.address);
    return this.indexerStore.getIndexerHealth({ chainId: selectedChainId, addresses });
  }

  // Static INDEXER_CONTRACTS_JSON entries plus every release clone and primary sale
  // discovered through the release factory on the configured chain. Discovered
  // contracts are expected exactly like static ones, so a missing or FAILED
  // checkpoint for any of them fails readiness closed.
  async getHealthContracts() {
    const configured = this.indexerConfig?.contracts || [];
    if (!this.indexerConfig?.chainId || !this.indexerStore?.listDiscoveredReleaseContracts) return configured;
    const discovered = await this.indexerStore.listDiscoveredReleaseContracts({ chainId: this.indexerConfig.chainId });
    return [
      ...configured,
      ...discovered.flatMap((row) => [
        { address: String(row.release_contract_address).toLowerCase(), contractType: "ERC1155" },
        ...(row.primary_sale_address ? [{ address: String(row.primary_sale_address).toLowerCase(), contractType: "PRIMARY_SALE" }] : []),
      ]),
    ];
  }

  async getOperationalHealth() {
    const database = await checkDatabaseHealth(this.db);
    const empty = reportIndexedContracts();
    const contracts = { release: empty.release, primarySale: empty.primarySale };
    if (!database.ok) return { ok: false, database, indexer: { ok: false, reason: "DATABASE_UNAVAILABLE" }, contracts };
    try {
      const healthContracts = await this.getHealthContracts();
      const checkpoints = await this.getIndexerHealth({}, healthContracts);
      const indexed = checkpoints.flatMap((checkpoint) => Array.isArray(checkpoint.contracts) && checkpoint.contracts.length ? checkpoint.contracts : [checkpoint]);
      const reported = reportIndexedContracts({ indexed, configured: healthContracts });
      const checkpointHealthy = checkpoints.length > 0 && indexed.length > 0 && indexed.every((contract) => ["IDLE", "RUNNING"].includes(String(contract.status || "").toUpperCase())) && checkpoints.every((checkpoint) => checkpoint.last_successful_run_at);
      const indexer = { ok: Boolean(checkpointHealthy && reported.ok), checkpoints };
      return { ok: database.ok && indexer.ok, database, indexer, contracts: { release: reported.release, primarySale: reported.primarySale } };
    } catch (error) {
      return { ok: false, database, indexer: { ok: false, reason: error.code || "INDEXER_UNAVAILABLE" }, contracts };
    }
  }

  async getArtist({ idOrSlug }) {
    const key = requiredText(idOrSlug, "artist");
    const { rows } = await this.db.query(`${ARTIST_SELECT} WHERE a.status=$1 AND (a.id=$2 OR a.slug=$2) LIMIT 1`, [PUBLIC_STATUS === "PUBLISHED" ? "ACTIVE" : "ACTIVE", key]);
    if (!rows[0] || isHiddenPublicArtist(rows[0])) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
    return mapRow(rows[0]);
  }

  async listArtists({ limit, offset, status = "ACTIVE" }) {
    const take = limitValue(limit);
    const skip = offsetValue(offset);
    const { rows } = await this.db.query(`${ARTIST_SELECT} WHERE a.status=$1 ORDER BY a.display_name ASC`, [status]);
    return rows.filter((row) => !isHiddenPublicArtist(row)).slice(skip, skip + take);
  }

  async getRelease({ idOrSlug }) {
    const key = requiredText(idOrSlug, "release");
    const { rows } = await this.db.query(`SELECT ${RELEASE_PUBLIC_SELECT} FROM releases r JOIN artists a ON a.id=r.artist_id WHERE r.status=$1 AND (r.id=$2 OR r.slug=$2) LIMIT 1`, [PUBLIC_STATUS, key]);
    if (!rows[0] || isWithdrawnPublicListing(rows[0])) throw new ApiError(404, "RELEASE_NOT_FOUND", "Release was not found.");
    return toPublicRow(rows[0], RELEASE_PUBLIC_FIELDS);
  }

  async listReleases({ artistId = null, limit, offset }) {
    const values = [PUBLIC_STATUS, artistId, limitValue(limit), offsetValue(offset)];
    const { rows } = await this.db.query(`SELECT ${RELEASE_PUBLIC_SELECT} FROM releases r JOIN artists a ON a.id=r.artist_id WHERE r.status=$1 AND ($2::text IS NULL OR r.artist_id=$2) ORDER BY r.published_at DESC NULLS LAST, r.title ASC LIMIT $3 OFFSET $4`, values);
    return rows.filter((row) => !isWithdrawnPublicListing(row)).map((row) => toPublicRow(row, RELEASE_PUBLIC_FIELDS));
  }

  async getEdition({ id }) {
    const key = requiredText(id, "edition");
    const [canonicalContract, canonicalChain] = certifiedContractParams();
    const { rows } = await this.db.query(`SELECT ${EDITION_PUBLIC_SELECT} FROM editions e JOIN releases r ON r.id=e.release_id LEFT JOIN contracts c ON c.id=e.contract_id LEFT JOIN release_contracts rc ON rc.release_id=e.release_id AND rc.release_contract_id=e.contract_id AND rc.status IN ('DEPLOYED','VERIFIED') LEFT JOIN contracts factory ON factory.id=rc.factory_contract_id LEFT JOIN contracts sale ON sale.id=rc.primary_sale_contract_id LEFT JOIN tokens t ON t.edition_id=e.id AND (t.contract_id IN (SELECT id FROM contracts WHERE lower(address)=$3 AND chain_id=$4) OR t.contract_id IN (SELECT release_contract_id FROM release_contracts WHERE release_id=e.release_id AND status IN ('DEPLOYED','VERIFIED'))) ${EDITION_ALBUM_JOIN} WHERE e.status=$1 AND e.id=$2 LIMIT 1`, [PUBLIC_STATUS, key, canonicalContract, canonicalChain]);
    if (!rows[0] || isWithdrawnPublicListing(rows[0])) throw new ApiError(404, "EDITION_NOT_FOUND", "Edition was not found.");
    return toPublicEdition(rows[0]);
  }

  async listEditions({ releaseId = null, limit, offset }) {
    const [canonicalContract, canonicalChain] = certifiedContractParams();
    const { rows } = await this.db.query(`SELECT ${EDITION_PUBLIC_SELECT} FROM editions e JOIN releases r ON r.id=e.release_id LEFT JOIN contracts c ON c.id=e.contract_id LEFT JOIN release_contracts rc ON rc.release_id=e.release_id AND rc.release_contract_id=e.contract_id AND rc.status IN ('DEPLOYED','VERIFIED') LEFT JOIN contracts factory ON factory.id=rc.factory_contract_id LEFT JOIN contracts sale ON sale.id=rc.primary_sale_contract_id LEFT JOIN tokens t ON t.edition_id=e.id AND (t.contract_id IN (SELECT id FROM contracts WHERE lower(address)=$2 AND chain_id=$3) OR t.contract_id IN (SELECT release_contract_id FROM release_contracts WHERE release_id=e.release_id AND status IN ('DEPLOYED','VERIFIED'))) ${EDITION_ALBUM_JOIN} WHERE e.status=$1 AND ($4::text IS NULL OR e.release_id=$4) ORDER BY e.created_at DESC LIMIT $5 OFFSET $6`, [PUBLIC_STATUS, canonicalContract, canonicalChain, releaseId, limitValue(limit), offsetValue(offset)]);
    return rows.filter((row) => !isWithdrawnPublicListing(row)).map((row) => toPublicEdition(row));
  }

  async getExperience({ id }) {
    const key = requiredText(id, "experience");
    const { rows } = await this.db.query(`SELECT ${EXPERIENCE_PUBLIC_SELECT} FROM experiences WHERE status=$1 AND id=$2 LIMIT 1`, [PUBLIC_STATUS, key]);
    if (!rows[0] || isWithdrawnPublicListing(rows[0])) throw new ApiError(404, "EXPERIENCE_NOT_FOUND", "Experience was not found.");
    return toPublicRow(rows[0], EXPERIENCE_PUBLIC_FIELDS);
  }

  async listExperiences({ editionId = null, releaseId = null, limit, offset }) {
    const { rows } = await this.db.query(`SELECT ${EXPERIENCE_PUBLIC_SELECT} FROM experiences WHERE status=$1 AND ($2::text IS NULL OR edition_id=$2) AND ($3::text IS NULL OR release_id=$3) ORDER BY updated_at DESC LIMIT $4 OFFSET $5`, [PUBLIC_STATUS, editionId, releaseId, limitValue(limit), offsetValue(offset)]);
    return rows.filter((row) => !isWithdrawnPublicListing(row)).map((row) => toPublicRow(row, EXPERIENCE_PUBLIC_FIELDS));
  }

  async listListings({ chainId: rawChainId = null, tokenContractAddress = null, tokenId = null, sellerWallet = null, status = ACTIVE_LISTING, limit, offset }) {
    const values = [rawChainId === null ? null : chainId(rawChainId), tokenContractAddress ? requiredText(tokenContractAddress, "tokenContractAddress", { max: 128 }).toLowerCase() : null, tokenId === null ? null : nonNegativeBigInt(tokenId, "tokenId"), sellerWallet ? walletAddress(sellerWallet, "sellerWallet") : null, status, limitValue(limit), offsetValue(offset)];
    const { rows } = await this.db.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE ($1::bigint IS NULL OR l.chain_id=$1) AND ($2::text IS NULL OR tc.address=$2) AND ($3::numeric IS NULL OR l.token_id=$3) AND ($4::text IS NULL OR l.seller_wallet=$4) AND l.status=$5 AND (l.expires_at IS NULL OR l.expires_at > now()) ORDER BY l.created_at DESC LIMIT $6 OFFSET $7`, values);
    return rows;
  }

  async getMarketplaceVolume() {
    const { rows } = await this.db.query(`
      WITH public_primary AS (
        SELECT COALESCE(SUM(pp.paid_wei), 0)::text AS volume_wei
        FROM primary_purchases pp
        JOIN contracts tc ON tc.chain_id=pp.chain_id AND LOWER(tc.address)=LOWER(pp.token_contract_address)
        JOIN tokens tok ON tok.contract_id=tc.id AND tok.token_id=pp.token_id
        JOIN editions e ON e.id=tok.edition_id AND e.status='PUBLISHED'
        JOIN releases r ON r.id=e.release_id AND r.status='PUBLISHED'
        JOIN artists a ON a.id=r.artist_id AND a.status='ACTIVE'
        WHERE pp.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED')
      ), public_secondary AS (
        SELECT COALESCE(SUM(p.sale_price_wei), 0)::text AS volume_wei
        FROM purchases p
        JOIN listings l ON l.id=p.listing_id
        JOIN contracts mc ON mc.id=l.marketplace_contract_id AND mc.contract_type='MARKETPLACE'
        JOIN contracts tc ON tc.id=l.token_contract_id AND tc.chain_id=p.chain_id AND LOWER(tc.address)=LOWER(p.token_contract_address)
        JOIN tokens tok ON tok.contract_id=tc.id AND tok.token_id=p.token_id
        JOIN editions e ON e.id=tok.edition_id AND e.status='PUBLISHED'
        JOIN releases r ON r.id=e.release_id AND r.status='PUBLISHED'
        JOIN artists a ON a.id=r.artist_id AND a.status='ACTIVE'
        WHERE p.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED')
      )
      SELECT public_primary.volume_wei AS primary_mint_volume_wei,
        public_secondary.volume_wei AS secondary_market_volume_wei,
        (public_primary.volume_wei::numeric + public_secondary.volume_wei::numeric)::text AS overall_volume_wei
      FROM public_primary CROSS JOIN public_secondary
      LIMIT 1
    `);
    const row = rows[0] || { primary_mint_volume_wei: "0", secondary_market_volume_wei: "0", overall_volume_wei: "0" };
    return {
      currency: "AVAX",
      primaryMintVolumeWei: String(row.primary_mint_volume_wei || "0"),
      secondaryMarketVolumeWei: String(row.secondary_market_volume_wei || "0"),
      overallVolumeWei: String(row.overall_volume_wei || "0"),
      secondaryMarkets: "indexed marketplace contracts",
    };
  }

  async getSelfTitledEpVolume({ chainId: rawChainId, tokenContractAddress: rawTokenContractAddress, tokenIds: rawTokenIds = [] } = {}) {
    const selectedChainId = chainId(rawChainId, "chainId");
    const selectedTokenContract = contractAddress(rawTokenContractAddress, "tokenContractAddress");
    if (!Array.isArray(rawTokenIds) || rawTokenIds.length === 0) throw new ApiError(400, "INVALID_TOKEN_IDS", "tokenIds must contain at least one token ID.");
    const selectedTokenIds = rawTokenIds.map((value) => nonNegativeBigInt(value, "tokenId").toString());
    const { rows } = await this.db.query(`
      WITH public_primary AS (
        SELECT COALESCE(SUM(pp.paid_wei), 0)::text AS volume_wei
        FROM primary_purchases pp
        JOIN contracts tc ON tc.chain_id=pp.chain_id AND LOWER(tc.address)=LOWER(pp.token_contract_address)
        JOIN tokens tok ON tok.contract_id=tc.id AND tok.token_id=pp.token_id
        JOIN editions e ON e.id=tok.edition_id AND e.status='PUBLISHED'
        JOIN releases r ON r.id=e.release_id AND r.status='PUBLISHED'
        JOIN artists a ON a.id=r.artist_id AND a.status='ACTIVE'
        WHERE pp.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED') AND tc.chain_id=$1 AND LOWER(tc.address)=LOWER($2) AND tok.token_id = ANY($3::numeric[])
      ), public_secondary AS (
        SELECT COALESCE(SUM(p.sale_price_wei), 0)::text AS volume_wei
        FROM purchases p
        JOIN listings l ON l.id=p.listing_id
        JOIN contracts mc ON mc.id=l.marketplace_contract_id AND mc.contract_type='MARKETPLACE'
        JOIN contracts tc ON tc.id=l.token_contract_id AND tc.chain_id=p.chain_id AND LOWER(tc.address)=LOWER(p.token_contract_address)
        JOIN tokens tok ON tok.contract_id=tc.id AND tok.token_id=p.token_id
        JOIN editions e ON e.id=tok.edition_id AND e.status='PUBLISHED'
        JOIN releases r ON r.id=e.release_id AND r.status='PUBLISHED'
        JOIN artists a ON a.id=r.artist_id AND a.status='ACTIVE'
        WHERE p.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED') AND tc.chain_id=$1 AND LOWER(tc.address)=LOWER($2) AND tok.token_id = ANY($3::numeric[])
      )
      SELECT public_primary.volume_wei AS primary_mint_volume_wei, public_secondary.volume_wei AS secondary_market_volume_wei, (public_primary.volume_wei::numeric + public_secondary.volume_wei::numeric)::text AS overall_volume_wei
      FROM public_primary CROSS JOIN public_secondary LIMIT 1
    `, [selectedChainId, selectedTokenContract, selectedTokenIds]);
    const row = rows[0] || { primary_mint_volume_wei: "0", secondary_market_volume_wei: "0", overall_volume_wei: "0" };
    return { currency: "AVAX", primaryMintVolumeWei: String(row.primary_mint_volume_wei || "0"), secondaryMarketVolumeWei: String(row.secondary_market_volume_wei || "0"), overallVolumeWei: String(row.overall_volume_wei || "0"), secondaryMarkets: "indexed marketplace contracts" };
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
    const { rows } = await this.db.query(`SELECT t.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('status', p.status, 'listingId', p.listing_id, 'quantity', p.quantity, 'salePriceWei', p.sale_price_wei, 'settlementLogIndex', p.settlement_log_index, 'finalizedAt', p.finalized_at)) FROM purchases p WHERE p.transaction_id=t.id), '[]'::jsonb) AS purchases,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('status', pp.status, 'saleContractAddress', pp.sale_contract_address, 'tokenContractAddress', pp.token_contract_address, 'transactionHash', pp.transaction_hash, 'logIndex', pp.log_index, 'tokenId', pp.token_id::text, 'editionId', e.id, 'quantity', pp.quantity::text, 'priceWei', pp.paid_wei::text, 'purchaser', pp.buyer_wallet, 'blockNumber', pp.block_number, 'finalizedAt', pp.finalized_at))
        FROM primary_purchases pp
        LEFT JOIN contracts tc ON tc.chain_id=pp.chain_id AND LOWER(tc.address)=LOWER(pp.token_contract_address)
        LEFT JOIN tokens tok ON tok.contract_id=tc.id AND tok.token_id=pp.token_id
        LEFT JOIN editions e ON e.id=tok.edition_id
        WHERE pp.chain_id=t.chain_id AND pp.transaction_hash=t.transaction_hash), '[]'::jsonb) AS "primaryPurchases"
      FROM transactions t WHERE t.chain_id=$1 AND t.transaction_hash=$2 LIMIT 1`, [selectedChainId, selectedTransactionHash]);
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
    const { rows } = await this.db.query(`SELECT * FROM (SELECT 'TRANSFER' AS activity_type, transaction_hash, block_number, block_timestamp AS occurred_at, contract_address, token_id, amount, from_wallet, to_wallet FROM transfers WHERE (from_wallet=$1 OR to_wallet=$1) AND is_canonical=true UNION ALL SELECT 'PURCHASE' AS activity_type, p.transaction_hash, p.block_number, p.created_at AS occurred_at, p.token_contract_address AS contract_address, p.token_id, p.quantity AS amount, p.seller_wallet AS from_wallet, p.buyer_wallet AS to_wallet FROM purchases p WHERE p.buyer_wallet=$1 AND p.status <> 'REORGED' UNION ALL SELECT 'PURCHASE' AS activity_type, p.transaction_hash, p.block_number, p.created_at AS occurred_at, p.token_contract_address AS contract_address, p.token_id, p.quantity AS amount, '0x0000000000000000000000000000000000000000' AS from_wallet, p.buyer_wallet AS to_wallet FROM primary_purchases p WHERE p.buyer_wallet=$1 AND p.status <> 'REORGED') activity ORDER BY occurred_at DESC LIMIT $2 OFFSET $3`, [address, limitValue(limit), offsetValue(offset)]);
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
    const experienceId = requiredText(input.experienceId, "experienceId");
    // Verify against the persisted requirements. Without them the verifier
    // treats the experience as ungated, and seeded legacy experiences are real.
    const { rows: experienceRows } = await this.db.query("SELECT id, requirements, media_config FROM experiences WHERE id=$1 AND status=$2 LIMIT 1", [experienceId, PUBLIC_STATUS]);
    if (!experienceRows[0]) throw new ApiError(404, "EXPERIENCE_NOT_FOUND", "Experience was not found.");
    const ownership = await this.ownershipVerifier({ wallet: identity.wallet, experienceId, requirements: experienceRows[0].requirements, mediaConfig: experienceRows[0].media_config });
    if (!ownership?.owns || ownership.state !== "CONFIRMED" && ownership.state !== "FINALIZED") return { state: ownership?.state || "PENDING", grant: null };
    const grantId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 300_000);
    const grant = await this.repository.createGrant({ grantId, experienceId, wallet: identity.wallet, mediaType: requiredText(input.mediaType, "mediaType"), issuedAt, expiresAt, ownershipChainId: ownership.chainId, ownershipWatermark: ownership.watermark, metadata: { state: "CONFIRMED" } });
    return { state: "CONFIRMED", grant };
  }

  async redeemExperience({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.wallet, "wallet");
    const result = await this.repository.inTransaction((repository) => repository.transitionRedemption({ id: requiredText(input.redemptionId, "redemptionId"), expectedState: requiredText(input.expectedState, "expectedState"), nextState: requiredText(input.nextState, "nextState"), actorWallet: identity.wallet, note: input.note || "" }));
    return { state: result.state, redemption: result };
  }
}
