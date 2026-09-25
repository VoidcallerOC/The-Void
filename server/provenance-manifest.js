import { createHash } from "node:crypto";
import { ApiError } from "./api-errors.js";

/** Provenance schema for The-Void releases. This document references the existing
 * canonical metadata digest. It does not replace that digest, and it never
 * commits URLs, file bytes, storage keys, or secrets. */
export const PROVENANCE_SCHEMA_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const WALLET = /^0x[0-9a-f]{40}$/;
const BANNED_KEY = /^(bytes|data|content|body|jwt|secret|token|storagekey|storage_key|cid|uri|url|filename|path|gateway|authorization|cookie)$/i;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function serialize(value) {
  return JSON.stringify(stableValue(value));
}

function invalid(message) {
  throw new ApiError(400, "PROVENANCE_INPUT_INVALID", message);
}

function mutable(field) {
  throw new ApiError(400, "PROVENANCE_MUTABLE_REFERENCE", `${field} must be a SHA-256 digest of file bytes, not a URL or path.`);
}

function rejectBanned(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (BANNED_KEY.test(key)) throw new ApiError(400, "PROVENANCE_FORBIDDEN_FIELD", `${field} cannot include ${key}. Provenance commits hashes only.`);
  }
}

function looksMutable(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || /\s/.test(value);
}

function contentHash(value, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) invalid(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") invalid(`${field} must be a SHA-256 hex digest.`);
  const raw = String(value).trim();
  if (looksMutable(raw)) mutable(field);
  const hash = raw.toLowerCase();
  if (!SHA256.test(hash)) throw new ApiError(400, "PROVENANCE_HASH_INVALID", `${field} must be a 64-character SHA-256 hex digest.`);
  return hash;
}

function requiredId(value, field) {
  if (typeof value !== "string" && typeof value !== "number") invalid(`${field} is required.`);
  const id = String(value).trim();
  if (!id || id.length > 128) invalid(`${field} is required.`);
  if (looksMutable(id)) mutable(field);
  return id;
}

function proofTimestamp(value) {
  if (value == null || value === "") invalid("A canonical proof timestamp is required.");
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) invalid("Proof timestamp is not a valid time.");
  return date.toISOString();
}

function walletAddress(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  if (!WALLET.test(wallet)) invalid("Creator wallet must be an EVM address.");
  return wallet;
}

function assetVersion(value, field) {
  if (value == null || value === "") return 1;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) invalid(`${field} must be a positive integer.`);
  return version;
}

function assetType(value, field, fallback) {
  const type = String(value || fallback || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,64}$/.test(type)) invalid(`${field} must be a stable asset type.`);
  return type;
}

function optionalAsset(value, field, role, fallbackType) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    return { role, assetType: fallbackType, version: 1, sha256: contentHash(value, field, { required: true }) };
  }
  if (typeof value !== "object" || Array.isArray(value)) invalid(`${field} must describe a hashed asset.`);
  rejectBanned(value, field);
  return {
    role,
    assetType: assetType(value.assetType || value.mediaType, `${field}.assetType`, fallbackType),
    version: assetVersion(value.version, `${field}.version`),
    sha256: contentHash(value.sha256 ?? value.hash, `${field}.sha256`, { required: true }),
  };
}

function protectedAssets(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid("protectedMedia must be an array of hashed assets.");
  return value.map((entry, index) => {
    const field = `protectedMedia[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`${field} must describe a hashed asset.`);
    rejectBanned(entry, field);
    return {
      role: "protected-media",
      experienceId: requiredId(entry.experienceId, `${field}.experienceId`),
      assetType: assetType(entry.assetType || entry.mediaType, `${field}.assetType`, "AUDIO"),
      version: assetVersion(entry.version, `${field}.version`),
      sha256: contentHash(entry.sha256 ?? entry.hash, `${field}.sha256`, { required: true }),
    };
  });
}

function sortedAssets(assets) {
  return [...assets].sort((left, right) => {
    const key = (asset) => [asset.role, asset.experienceId || "", asset.assetType, String(asset.version).padStart(7, "0"), asset.sha256].join("\0");
    const a = key(left);
    const b = key(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

/** SHA-256 of file bytes. Callers store the digest, never the bytes, in provenance. */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Commitment of a provenance record ignoring proof time and the root itself. */
export function provenanceCommitment(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const body = { ...record };
  delete body.createdAt;
  delete body.root;
  return serialize(body);
}

/**
 * Build the canonical provenance manifest for one existing release edition.
 * `metadataDigest` must be the digest already produced by `canonicalMetadata`.
 * Asset identities are SHA-256 digests of bytes. URLs are rejected, not hashed.
 */
export function canonicalProvenanceManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Provenance input must describe an existing release edition.");
  if (!input.creator || typeof input.creator !== "object" || Array.isArray(input.creator)) invalid("Creator attribution is required.");
  rejectBanned(input.creator, "creator");
  const artwork = optionalAsset(input.artwork, "artwork", "artwork", "IMAGE");
  const audio = optionalAsset(input.audio, "audio", "audio", "AUDIO");
  const manifest = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    releaseId: requiredId(input.releaseId, "releaseId"),
    editionId: requiredId(input.editionId, "editionId"),
    creator: {
      artistId: requiredId(input.creator.artistId, "creator.artistId"),
      wallet: walletAddress(input.creator.wallet),
    },
    metadataDigest: contentHash(input.metadataDigest, "metadataDigest", { required: true }),
    createdAt: proofTimestamp(input.createdAt),
    assets: sortedAssets([artwork, audio, ...protectedAssets(input.protectedMedia)].filter(Boolean)),
  };
  const serialized = serialize(manifest);
  const root = createHash("sha256").update(serialized).digest("hex");
  return { manifest, serialized, root, metadataDigest: manifest.metadataDigest, record: { ...manifest, root } };
}

/** Hashes already stored for artist-owned protected assets. Entries without a
 * content hash, and every storage key or URI, are left out. */
export function protectedMediaCommitments(experiences, mediaAssets) {
  const byId = new Map((mediaAssets || []).map((asset) => [asset.id, asset]));
  const commitments = [];
  for (const experience of experiences || []) {
    const config = experience?.media_config || experience?.mediaConfig || {};
    const entries = Array.isArray(config.protectedMedia) ? config.protectedMedia : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const assetId = String(entry.assetId || "").trim();
      if (!assetId) continue;
      const asset = byId.get(assetId);
      const sha256 = asset?.metadata?.contentSha256 || asset?.contentSha256 || null;
      if (!sha256) continue;
      commitments.push({
        experienceId: experience.id,
        sha256,
        assetType: entry.mediaType || asset.media_type || asset.mediaType || "AUDIO",
        version: asset?.metadata?.version || experience.version || 1,
      });
    }
  }
  return commitments;
}
