import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { walletAddress } from "./validation.js";

const SHA256 = /^[0-9a-f]{64}$/;
const FIELDS = [
  "id", "release_id", "edition_id", "creator_artist_id", "creator_wallet",
  "metadata_sha256", "artwork_sha256", "audio_sha256", "experience_sha256", "manifest_sha256",
  "schema_version", "proof_timestamp", "chain_key", "chain_id", "transaction_hash", "block_number",
  "anchor_status", "verification_status", "verified_at", "failure_code", "failure_detail",
  "attempt_count", "next_retry_at", "created_at", "updated_at",
];
const RETURNING = FIELDS.join(", ");
const OWNED_COLUMNS = FIELDS.map((field) => `p.${field}`).join(", ");
const RETRYABLE = new Set(["FAILED", "REORGED"]);
const OPENABLE = new Set(["PENDING", "SUBMITTED"]);

function invalid(message) {
  throw new ApiError(400, "PROVENANCE_RECORD_INVALID", message);
}

function contentHash(value, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) invalid(`${field} is required.`);
    return null;
  }
  const raw = String(value).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new ApiError(400, "PROVENANCE_MUTABLE_REFERENCE", `${field} must be a SHA-256 digest of file bytes, not a URL or path.`);
  }
  const hash = raw.toLowerCase();
  if (!SHA256.test(hash)) throw new ApiError(400, "PROVENANCE_HASH_INVALID", `${field} must be a 64-character SHA-256 hex digest.`);
  return hash;
}

function schemaVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) invalid("schemaVersion must be a positive integer.");
  return version;
}

function proofTimestamp(value) {
  if (value == null || value === "") invalid("A proof timestamp is required.");
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) invalid("Proof timestamp is not a valid time.");
  return date.toISOString();
}

function chainKey(value) {
  if (value == null || value === "") return null;
  const key = String(value).trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) invalid("chainKey must be a stable network name.");
  return key;
}

function optionalChainId(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) invalid("chainId must be a positive integer.");
  return parsed;
}

function transactionHash(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) invalid("transactionHash is required to verify an anchor.");
    return null;
  }
  const hash = String(value).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) invalid("transactionHash must be a 32-byte transaction hash.");
  return hash;
}

function blockNumber(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) invalid("blockNumber is required to verify an anchor.");
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid("blockNumber must be a non-negative integer.");
  return parsed;
}

function failureCode(value) {
  const code = String(value ?? "").trim();
  if (!/^[A-Z0-9_]{1,64}$/.test(code)) invalid("failureCode must be a short status code.");
  return code;
}

function failureDetail(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (text.length > 240) invalid("failureDetail is too long.");
  if (/https?:\/\/|ipfs:\/\/|storage_?key|bearer\s|filename|private-media/i.test(text)) {
    throw new ApiError(400, "PROVENANCE_RECORD_INVALID", "Failure details cannot include media locations or secrets.");
  }
  return text;
}

function mapDbError(error) {
  if (error instanceof ApiError) throw error;
  if (error?.code === "23505") throw new ApiError(409, "PROVENANCE_ALREADY_RECORDED", "A provenance record already exists for this release edition and manifest version.");
  if (error?.code === "23503") throw new ApiError(409, "PROVENANCE_RELATION_INVALID", "The provenance record must reference an existing edition of that release.");
  if (error?.code === "23514") throw new ApiError(400, "PROVENANCE_RECORD_INVALID", "The provenance record failed a database constraint.");
  throw error;
}

/** Persists provenance for an existing release edition. Does not create releases. */
export class ProvenanceRecords {
  constructor({ db } = {}) {
    if (!db?.query) throw new TypeError("ProvenanceRecords requires a database executor.");
    this.db = db;
  }

  async ownedEdition({ releaseId, editionId, wallet }) {
    const owner = walletAddress(wallet, "creatorWallet");
    const release = String(releaseId ?? "").trim();
    const edition = String(editionId ?? "").trim();
    if (!release || !edition) invalid("releaseId and editionId are required.");
    const { rows } = await this.db.query(
      `SELECT r.id AS release_id, e.id AS edition_id, r.artist_id
       FROM editions e
       JOIN releases r ON r.id = e.release_id AND r.id = $1
       JOIN artist_owners ao ON ao.artist_id = r.artist_id AND ao.owner_wallet = $3
       WHERE e.id = $2
       LIMIT 1`,
      [release, edition, owner],
    );
    if (!rows[0]) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot record provenance for this release.");
    return { ...rows[0], wallet: owner };
  }

  async loadOwned(id, wallet) {
    const owner = walletAddress(wallet, "creatorWallet");
    const proofId = String(id ?? "").trim();
    if (!proofId) invalid("proof id is required.");
    const { rows } = await this.db.query(
      `SELECT ${OWNED_COLUMNS}
       FROM provenance_proofs p
       JOIN editions e ON e.id = p.edition_id AND e.release_id = p.release_id
       JOIN releases r ON r.id = p.release_id
       JOIN artist_owners ao ON ao.artist_id = r.artist_id AND ao.owner_wallet = $2
       WHERE p.id = $1
       LIMIT 1`,
      [proofId, owner],
    );
    if (!rows[0]) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot update this provenance record.");
    return rows[0];
  }

  async createProof({ releaseId, editionId, creatorWallet, metadataSha256, artworkSha256 = null, audioSha256 = null, experienceSha256 = null, manifestSha256, schemaVersion: version, proofTimestamp: timestamp, id = null }) {
    const proofId = id ? String(id).trim() : `proof-${randomUUID()}`;
    if (!proofId || proofId.length > 128) invalid("proof id is invalid.");
    const record = {
      metadataSha256: contentHash(metadataSha256, "metadataSha256", { required: true }),
      artworkSha256: contentHash(artworkSha256, "artworkSha256"),
      audioSha256: contentHash(audioSha256, "audioSha256"),
      experienceSha256: contentHash(experienceSha256, "experienceSha256"),
      manifestSha256: contentHash(manifestSha256, "manifestSha256", { required: true }),
      schemaVersion: schemaVersion(version),
      proofTimestamp: proofTimestamp(timestamp),
    };
    const owned = await this.ownedEdition({ releaseId, editionId, wallet: creatorWallet });
    const values = [
      proofId, owned.release_id, owned.edition_id, owned.artist_id, owned.wallet,
      record.metadataSha256, record.artworkSha256, record.audioSha256, record.experienceSha256, record.manifestSha256,
      record.schemaVersion, record.proofTimestamp,
    ];
    try {
      const { rows } = await this.db.query(
        `INSERT INTO provenance_proofs (
           id, release_id, edition_id, creator_artist_id, creator_wallet,
           metadata_sha256, artwork_sha256, audio_sha256, experience_sha256, manifest_sha256,
           schema_version, proof_timestamp
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${RETURNING}`,
        values,
      );
      return rows[0];
    } catch (error) {
      mapDbError(error);
    }
  }

  async recordAnchorFailure({ id, creatorWallet, failureCode: code, failureDetail: detail = null, nextRetryAt = null }) {
    const current = await this.loadOwned(id, creatorWallet);
    if (current.anchor_status === "ANCHORED" || current.verification_status === "VERIFIED") {
      throw new ApiError(409, "PROVENANCE_ANCHOR_IMMUTABLE", "A verified anchor cannot be marked failed.");
    }
    if (!OPENABLE.has(current.anchor_status)) throw new ApiError(409, "PROVENANCE_ANCHOR_NOT_OPENABLE", "Only a pending anchor can be marked failed.");
    const retryAt = nextRetryAt == null || nextRetryAt === "" ? null : proofTimestamp(nextRetryAt);
    try {
      const { rows } = await this.db.query(
        `UPDATE provenance_proofs
         SET anchor_status = 'FAILED', attempt_count = attempt_count + 1, failure_code = $2, failure_detail = $3, next_retry_at = $4, updated_at = now()
         WHERE id = $1 AND anchor_status IN ('PENDING', 'SUBMITTED')
         RETURNING ${RETURNING}`,
        [current.id, failureCode(code), failureDetail(detail), retryAt],
      );
      if (!rows[0]) throw new ApiError(409, "PROVENANCE_ANCHOR_NOT_OPENABLE", "Only a pending anchor can be marked failed.");
      return rows[0];
    } catch (error) {
      mapDbError(error);
    }
  }

  async retryProof({ id, creatorWallet }) {
    const current = await this.loadOwned(id, creatorWallet);
    if (current.verification_status === "VERIFIED" || current.anchor_status === "ANCHORED") {
      throw new ApiError(409, "PROVENANCE_ANCHOR_IMMUTABLE", "A verified anchor cannot be retried as a new proof.");
    }
    if (!RETRYABLE.has(current.anchor_status)) throw new ApiError(409, "PROVENANCE_RETRY_UNAVAILABLE", "Only a failed anchor can be retried.");
    try {
      const { rows } = await this.db.query(
        `UPDATE provenance_proofs
         SET anchor_status = 'PENDING', verification_status = 'UNVERIFIED', verified_at = NULL, failure_code = NULL, failure_detail = NULL, next_retry_at = NULL, updated_at = now()
         WHERE id = $1 AND anchor_status IN ('FAILED', 'REORGED')
         RETURNING ${RETURNING}`,
        [current.id],
      );
      if (!rows[0]) throw new ApiError(409, "PROVENANCE_RETRY_UNAVAILABLE", "Only a failed anchor can be retried.");
      return rows[0];
    } catch (error) {
      mapDbError(error);
    }
  }

  async recordVerifiedAnchor({ id, creatorWallet, chainKey: network, chainId, transactionHash: txHash, blockNumber: block, verifiedAt = new Date() }) {
    const current = await this.loadOwned(id, creatorWallet);
    if (current.verification_status === "VERIFIED") throw new ApiError(409, "PROVENANCE_ALREADY_VERIFIED", "This provenance record is already verified.");
    if (!OPENABLE.has(current.anchor_status)) throw new ApiError(409, "PROVENANCE_ANCHOR_NOT_OPENABLE", "Retry the failed anchor before verifying it.");
    const key = chainKey(network);
    const chain = optionalChainId(chainId);
    if (!key || !chain) invalid("A verified anchor requires chainKey and chainId.");
    try {
      const { rows } = await this.db.query(
        `UPDATE provenance_proofs
         SET anchor_status = 'ANCHORED', verification_status = 'VERIFIED', verified_at = $2,
             chain_key = $3, chain_id = $4, transaction_hash = $5, block_number = $6,
             failure_code = NULL, failure_detail = NULL, next_retry_at = NULL, updated_at = now()
         WHERE id = $1 AND anchor_status IN ('PENDING', 'SUBMITTED') AND verification_status <> 'VERIFIED'
         RETURNING ${RETURNING}`,
        [current.id, proofTimestamp(verifiedAt), key, chain, transactionHash(txHash, { required: true }), blockNumber(block, { required: true })],
      );
      if (!rows[0]) throw new ApiError(409, "PROVENANCE_ANCHOR_NOT_OPENABLE", "Retry the failed anchor before verifying it.");
      return rows[0];
    } catch (error) {
      mapDbError(error);
    }
  }
}

export function createProvenanceRecords(options) {
  return new ProvenanceRecords(options);
}
