import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { chainId, editionQuantity, enumValue, nonNegativeBigInt, optionalText, positiveBigInt, requiredText, walletAddress } from "./validation.js";
import deployment from "../config/fuji-release.json" with { type: "json" };
import { canonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest, protectedMediaCommitments, provenanceCommitment } from "./provenance-manifest.js";
import { assertProvenanceConsistency, persistPublicationProof, publicationView } from "./studio-publication.js";
import { verifyEditionPublication } from "./publication-anchor.js";
import { assertArtistMayPublish, assertTokenNotOwnedByAnotherArtist } from "./artist-authorization.js";
import { MAX_ARTWORK_BYTES, MAX_PREVIEW_AUDIO_BYTES, sniffArtwork, sniffAudio } from "./artwork-storage.js";
import { isLegacyMainnetCatalogRelease, isLegacyMainnetEdition } from "../src/lib/legacy-genesis.js";
import { releaseIsMintable } from "../src/lib/studio-release-choices.js";
import { studioCatalogForConnectedWallet } from "../src/lib/studio-wallet-catalog.js";

// Full-length audio the browser may upload straight to private storage. WAV
// masters are far larger than an API request body can carry.
export const DIRECT_AUDIO_MIME_TYPES = Object.freeze(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/flac", "audio/x-flac", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/aiff", "audio/x-aiff"]);
export const DIRECT_VIDEO_MIME_TYPES = Object.freeze(["video/mp4", "video/quicktime", "video/webm"]);
export const DIRECT_ARCHIVE_MIME_TYPES = Object.freeze(["application/zip", "application/x-zip-compressed"]);
const DIRECT_UPLOAD_MEDIA_TYPES = Object.freeze(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "DEMO", "LIVE_RECORDING"]);

export function directUploadMimeTypes(mediaType) {
  if (mediaType === "VIDEO") return DIRECT_VIDEO_MIME_TYPES;
  if (mediaType === "STEMS" || mediaType === "DOWNLOAD") return [...DIRECT_ARCHIVE_MIME_TYPES, ...DIRECT_AUDIO_MIME_TYPES];
  return DIRECT_AUDIO_MIME_TYPES;
}

function unsupportedUpload(mediaType) {
  if (mediaType === "VIDEO") return ["MEDIA_TYPE_UNSUPPORTED", "A music video must be MP4, MOV, or WebM."];
  if (mediaType === "STEMS" || mediaType === "DOWNLOAD") return ["MEDIA_TYPE_UNSUPPORTED", "Upload a ZIP, or WAV, AIFF, FLAC, MP3, AAC/M4A or OGG."];
  return ["AUDIO_TYPE_UNSUPPORTED", "Audio must be WAV, AIFF, FLAC, MP3, AAC/M4A or OGG."];
}
const DIRECT_UPLOAD_TTL_SECONDS = 900;

const LIFECYCLE = Object.freeze(["DRAFT", "REVIEW", "PUBLISHED"]);
const TYPES = Object.freeze(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "ARTWORK", "LYRICS", "DEMO", "LIVE_RECORDING", "TICKET", "VIP_ACCESS", "DISCOUNT", "PHYSICAL_REDEMPTION"]);
const PRODUCT_TYPES = Object.freeze({
  FULL_RECORD: "AUDIO", UNRELEASED_TRACK: "AUDIO", DEMO: "DEMO", LIVE_RECORDING: "LIVE_RECORDING",
  ALTERNATE_VERSION: "AUDIO", INSTRUMENTAL: "AUDIO", STEMS: "STEMS", MUSIC_VIDEO: "VIDEO",
  DIGITAL_DOWNLOAD: "DOWNLOAD", ALTERNATE_ARTWORK: "ARTWORK", COLLECTOR_ARCHIVE: "DOWNLOAD",
  MEMBERSHIP: "TICKET", VIP_BACKSTAGE: "VIP_ACCESS", PHYSICAL_DIGITAL: "PHYSICAL_REDEMPTION",
});

function normalizedSlug(value, field) {
  const slug = requiredText(value, field, { max: 96 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, "INVALID_SLUG", `${field} must use lowercase letters, numbers, and single hyphens.`);
  return slug;
}

function generatedSlug(value, field) {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/g, "");
  if (!slug) throw new ApiError(400, "TITLE_REQUIRED", `${field} is required before publishing.`);
  return slug;
}

async function availableSlug(db, { table, scopeColumn, scopeValue, value, field }) {
  const base = generatedSlug(value, field);
  const where = scopeColumn ? `WHERE ${scopeColumn}=$1 AND slug LIKE $2` : "WHERE slug LIKE $1";
  const params = scopeColumn ? [scopeValue, `${base}%`] : [`${base}%`];
  const { rows } = await db.query(`SELECT slug FROM ${table} ${where} LIMIT 100`, params);
  const used = new Set((rows || []).map((row) => row.slug));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 31 - String(suffix).length - 1))}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ApiError(409, "SLUG_COLLISION", `The ${field} could not be assigned a unique internal identifier.`);
}

function contractAddress(value, field) {
  const address = requiredText(value, field, { max: 42 }).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ApiError(400, "INVALID_CONTRACT_ADDRESS", `${field} must be a 20-byte EVM address.`);
  return address;
}

const CERTIFIED_CHAIN_ID = deployment.chainId;
const CERTIFIED_CONTRACT = deployment.contractAddress.toLowerCase();
export const EDITION_ABI = "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))";
function hashedAsset(value, assetType) {
  if (value == null || value === "") return null;
  if (typeof value === "string") return { sha256: value, assetType, version: 1 };
  return value;
}

function provenanceForPublication({ release, edition, wallet, metadataDigest, experiences, mediaAssets, input, previous }) {
  const fields = {
    releaseId: release.id,
    editionId: edition.id,
    creator: { artistId: release.artist_id, wallet },
    metadataDigest,
    artwork: hashedAsset(input.artworkSha256, "IMAGE"),
    audio: hashedAsset(input.audioSha256, "AUDIO"),
    protectedMedia: protectedMediaCommitments(experiences, mediaAssets),
  };
  const draft = canonicalProvenanceManifest({ ...fields, createdAt: new Date().toISOString() });
  const createdAt = previous && provenanceCommitment(previous) === provenanceCommitment(draft.record) ? previous.createdAt : draft.manifest.createdAt;
  return createdAt === draft.manifest.createdAt ? draft : canonicalProvenanceManifest({ ...fields, createdAt });
}

function certifiedTokenId(releaseSlug, editionSlug) {
  const releaseId = ethers.encodeBytes32String(requiredText(releaseSlug, "release.slug", { max: 31 }));
  const editionId = ethers.encodeBytes32String(requiredText(editionSlug, "edition.slug", { max: 31 }));
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", releaseId, editionId]));
  const tokenId = BigInt(digest);
  return tokenId === 0n ? 1n : tokenId;
}

function lifecycle(value, field = "status") { return enumValue(String(value || "").toUpperCase(), field, LIFECYCLE); }
// Taking a release off the public site is the only step backward from PUBLISHED.
// DRAFT and REVIEW stay unreachable, and publication still requires the on-chain confirm path.
function patchStatus(input, current, noun) {
  if (input.status === undefined) return current;
  const requested = String(input.status).trim().toUpperCase();
  const now = String(current || "").trim().toUpperCase();
  if (requested === "ARCHIVED") {
    if (now !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", `Only a published ${noun} can be taken off the site.`);
    return "ARCHIVED";
  }
  const next = lifecycle(input.status);
  if (next === "PUBLISHED") throw new ApiError(409, "PUBLICATION_REQUIRES_CONFIRMATION", `Only confirmed on-chain publication can mark a ${noun} published.`);
  if (now === "PUBLISHED" && next !== now) throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", `Published ${noun}s cannot return to an earlier lifecycle state.`);
  return next;
}
function assertPublishedMayChange(current, input, message) {
  if (String(current || "").trim().toUpperCase() !== "PUBLISHED" || input.status === undefined || input.status === null || String(input.status).trim() === "") return;
  const next = String(input.status).trim().toUpperCase();
  if (next === "PUBLISHED" || next === "ARCHIVED") return;
  throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", message);
}
function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_METADATA", `${field} must be a JSON object.`);
  return value;
}
function requireMediaConfig(value) {
  const config = jsonObject(value, "mediaConfig");
  const protectedMedia = Array.isArray(config.protectedMedia) ? config.protectedMedia : [];
  if (config.protected !== true && !protectedMedia.length) return config;
  if (!protectedMedia.length) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_REQUIRED", "Protected experiences require protectedMedia configuration.");
  for (const asset of protectedMedia) {
    const storageKey = String(asset?.storageKey || "").trim();
    const assetId = String(asset?.assetId || "").trim();
    if (!asset || typeof asset !== "object" || (!storageKey && !assetId)) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Every protected media object must reference an uploaded asset.");
    if (storageKey && (storageKey.includes("..") || storageKey.startsWith("/"))) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Protected media storage keys must be relative and traversal-safe.");
  }
  return config;
}
function requireRequirements(value) {
  if (!Array.isArray(value)) throw new ApiError(400, "INVALID_REQUIREMENTS", "requirements must be an array.");
  return value.map((requirement) => {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) throw new ApiError(400, "INVALID_REQUIREMENTS", "Each requirement must be an object.");
    if (String(requirement.type || "").toLowerCase() !== "erc1155-balance") throw new ApiError(400, "UNSUPPORTED_REQUIREMENT", "Artist Studio supports ERC-1155 balance requirements only.");
    const tokenIds = Array.isArray(requirement.tokenIds) ? [...new Set(requirement.tokenIds.map((value) => nonNegativeBigInt(value, "requirements.tokenIds")))] : [];
    if (!tokenIds.length) throw new ApiError(400, "INVALID_REQUIREMENTS", "ERC-1155 requirements need one or more token IDs.");
    return { type: "erc1155-balance", contract: contractAddress(requirement.contract, "requirements.contract"), tokenIds, minAmount: positiveBigInt(requirement.minAmount ?? 1, "requirements.minAmount"), ...(requirement.chainId === undefined ? {} : { chainId: chainId(requirement.chainId, "requirements.chainId") }) };
  });
}
function profileInput(input, existing = {}) {
  const metadata = input.profileMetadata === undefined ? jsonObject(existing.profile_metadata, "profileMetadata") : jsonObject(input.profileMetadata, "profileMetadata");
  return {
    bio: input.bio === undefined ? (existing.bio ?? null) : optionalText(input.bio, "bio", { max: 10000 }),
    websiteUrl: input.websiteUrl === undefined ? (existing.website_url ?? null) : optionalText(input.websiteUrl, "websiteUrl", { max: 2048 }),
    socialLinks: input.links === undefined && input.socialLinks === undefined ? jsonObject(existing.social_links, "links") : jsonObject(input.links ?? input.socialLinks, "links"),
    metadata: { ...metadata, ...(input.profileArtwork === undefined ? {} : { profileArtwork: optionalText(input.profileArtwork, "profileArtwork", { max: 2048 }) }) },
  };
}

/** Artist-controlled application records. Contract addresses and token IDs are
 * validated infrastructure fields; artists work in releases and editions. */
export class ArtistStudioService {
  constructor({ db, repository, authenticator, metadataStorage = null, mediaUploader = null, directMediaUploads = null, artworkUploader = null, provenanceRecords = null, publicationChain = null, metadataFetcher = null, logger = console } = {}) {
    if (!db?.query || !repository || typeof authenticator !== "function") throw new TypeError("ArtistStudioService requires persistence and wallet authentication.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.metadataStorage = metadataStorage;
    this.mediaUploader = mediaUploader;
    this.directMediaUploads = directMediaUploads;
    this.artworkUploader = artworkUploader;
    this.provenanceRecords = provenanceRecords;
    this.publicationChain = publicationChain;
    this.metadataFetcher = metadataFetcher;
    this.logger = logger;
  }

  async identity(request) { return requireWalletAuth(this.authenticator, request); }
  async listCatalog({ request } = {}) {
    const identity = await this.identity(request);
    const owner = identity.wallet;
    const [artists, releases, editions, experiences] = await Promise.all([
      this.db.query("SELECT a.id, a.slug, a.display_name, a.status, ao.owner_wallet, p.bio, p.website_url, p.social_links, p.profile_metadata FROM artists a JOIN artist_owners ao ON ao.artist_id=a.id LEFT JOIN artist_profiles p ON p.artist_id=a.id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY a.display_name LIMIT 100", [owner]),
      this.db.query("SELECT r.id, r.artist_id, r.slug, r.title, r.description, r.status, r.release_metadata FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY r.created_at DESC LIMIT 500", [owner]),
      // token_id only for PUBLISHED editions: a draft's token does not exist on-chain yet.
      this.db.query("SELECT e.id, e.release_id, e.title, e.description, e.supply, e.status, e.application_metadata, c.address AS contract_address, c.chain_id, CASE WHEN e.status='PUBLISHED' THEN (SELECT t.token_id::text FROM tokens t WHERE t.edition_id=e.id ORDER BY t.created_at DESC LIMIT 1) END AS token_id, EXISTS (SELECT 1 FROM primary_purchases p JOIN tokens pt ON pt.edition_id = e.id AND pt.token_id = p.token_id JOIN contracts pc ON pc.id = pt.contract_id WHERE pc.chain_id = p.chain_id AND lower(pc.address) = lower(p.token_contract_address) AND p.status NOT IN ('FAILED', 'REORGED')) AS buyable_sale FROM editions e JOIN releases r ON r.id=e.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id LEFT JOIN contracts c ON c.id=e.contract_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY e.created_at DESC LIMIT 500", [owner]),
      this.db.query("SELECT x.id, x.artist_id, x.release_id, x.edition_id, x.title, x.description, x.experience_type, x.requirements, x.media_config, x.status FROM experiences x JOIN artist_owners ao ON ao.artist_id=x.artist_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY x.created_at DESC LIMIT 500", [owner]),
    ]);
    // artist_owners already scopes the rows to this wallet. The admin/deployer
    // wallet still drops Voidcaller artist profiles so those releases stay with
    // the platform artist wallet.
    return studioCatalogForConnectedWallet({ artists: artists.rows, releases: releases.rows, editions: editions.rows, experiences: experiences.rows }, owner);
  }
  async ownedArtist({ artistId, request, lock = false }) {
    const identity = await this.identity(request);
    const query = `SELECT a.*, ao.owner_wallet, p.bio, p.website_url, p.social_links, p.profile_metadata FROM artists a JOIN artist_owners ao ON ao.artist_id=a.id LEFT JOIN artist_profiles p ON p.artist_id=a.id WHERE a.id=$1 AND ao.owner_wallet=$2${lock ? " FOR UPDATE" : ""} LIMIT 1`;
    const { rows } = await this.db.query(query, [requiredText(artistId, "artistId"), identity.wallet]);
    if (!rows[0]) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this artist.");
    return { identity, artist: rows[0] };
  }
  async audit({ identity, request, eventType, subjectType, subjectId, payload = {} }) {
    await this.repository.appendAuditEvent({ eventType, actorWallet: identity.wallet, subjectType, subjectId, requestId: request.requestId || null, payload });
  }

  async bindProtectedAssets(artistId, protectedMedia) {
    const { rows } = await this.db.query("SELECT id, artist_id, storage_key, media_type FROM media_assets WHERE artist_id=$1", [artistId]);
    return protectedMedia.map((asset) => {
      const assetId = String(asset.assetId || "").trim();
      const storageKey = String(asset.storageKey || "").trim();
      const match = rows.find((row) => (assetId && row.id === assetId) || (!assetId && storageKey && row.storage_key === storageKey));
      if (!match || String(match.artist_id) !== String(artistId)) throw new ApiError(400, "PROTECTED_MEDIA_NOT_OWNED", "Protected media must reference a file uploaded for this artist.");
      if (assetId && storageKey && match.storage_key !== storageKey) throw new ApiError(400, "PROTECTED_MEDIA_NOT_OWNED", "Protected media storage key does not match the artist's uploaded asset.");
      const mediaType = String(asset.mediaType || match.media_type || "").trim().toUpperCase();
      if (!mediaType) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Every protected media object requires a media type.");
      return { assetId: match.id, mediaType, ...(asset.contentType ? { contentType: String(asset.contentType) } : {}) };
    });
  }

  async assertArtistRequirements(artistId, requirements) {
    const { rows } = await this.db.query("SELECT t.token_id::text AS token_id, lower(c.address) AS contract_address, c.chain_id FROM tokens t JOIN editions e ON e.id=t.edition_id JOIN releases r ON r.id=e.release_id JOIN contracts c ON c.id=t.contract_id WHERE r.artist_id=$1", [artistId]);
    for (const requirement of requirements) {
      for (const tokenId of requirement.tokenIds) {
        const owned = rows.some((row) => row.contract_address === requirement.contract && String(row.token_id) === String(tokenId) && (requirement.chainId === undefined || Number(row.chain_id) === Number(requirement.chainId)));
        if (!owned) throw new ApiError(400, "REQUIREMENT_TOKEN_NOT_OWNED", "Requirements may only reference token IDs from this artist's editions.");
      }
    }
  }

  // A private full track sent without explicit requirements unlocks for
  // holders of this edition's own token(s). Never ungated: an edition with
  // no token is rejected.
  async defaultEditionRequirements({ editionId, mediaConfig, requirements }) {
    const protectedMedia = Array.isArray(mediaConfig?.protectedMedia) ? mediaConfig.protectedMedia : [];
    if (!protectedMedia.length || (Array.isArray(requirements) && requirements.length)) return requirements;
    const { rows } = await this.db.query("SELECT t.token_id::text AS token_id, lower(c.address) AS contract_address, c.chain_id FROM tokens t JOIN contracts c ON c.id=t.contract_id WHERE t.edition_id=$1", [editionId]);
    if (!rows.length) throw new ApiError(400, "PROTECTED_MEDIA_REQUIREMENTS_REQUIRED", "Save the track before attaching its full audio so it can be gated to the track's token.");
    const byContract = new Map();
    for (const row of rows) {
      const key = `${row.chain_id}:${row.contract_address}`;
      if (!byContract.has(key)) byContract.set(key, { type: "erc1155-balance", contract: row.contract_address, chainId: Number(row.chain_id), tokenIds: [], minAmount: "1" });
      byContract.get(key).tokenIds.push(String(row.token_id));
    }
    return [...byContract.values()];
  }

  async bindProtectedExperience({ artistId, mediaConfig, requirements }) {
    const config = requireMediaConfig(mediaConfig);
    const normalizedRequirements = requireRequirements(requirements);
    const protectedMedia = Array.isArray(config.protectedMedia) ? config.protectedMedia : [];
    if (protectedMedia.length && !normalizedRequirements.length) throw new ApiError(400, "PROTECTED_MEDIA_REQUIREMENTS_REQUIRED", "Protected media requires at least one ownership requirement.");
    const boundMedia = protectedMedia.length ? await this.bindProtectedAssets(artistId, protectedMedia) : [];
    if (normalizedRequirements.length) await this.assertArtistRequirements(artistId, normalizedRequirements);
    return { mediaConfig: protectedMedia.length ? { ...config, protected: true, protectedMedia: boundMedia } : config, requirements: normalizedRequirements };
  }

  async publishMetadata({ request, releaseId, input = {} }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, a.display_name, ao.owner_wallet FROM releases r JOIN artists a ON a.id=r.artist_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot publish metadata for this release.");
    await assertArtistMayPublish(this.db, { artistId: release.artist_id, wallet: identity.wallet });
    if (!this.metadataStorage) throw new ApiError(503, "METADATA_STORAGE_NOT_CONFIGURED", "The release is ready, but metadata publication needs to be completed before blockchain publication.");
    if (release.status === "PUBLISHED") throw new ApiError(409, "RELEASE_ALREADY_PUBLISHED", "This release has already been published and its metadata is immutable.");
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.metadata, t.metadata_version FROM editions e LEFT JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY e.created_at DESC LIMIT 1", [release.id]);
    const edition = editionResult.rows[0];
    if (!edition) throw new ApiError(400, "EDITION_REQUIRED", "Create an edition before publishing the release.");
    const experiences = await this.db.query("SELECT id, title, description, experience_type, media_config, version FROM experiences WHERE edition_id=$1 ORDER BY created_at ASC LIMIT 100", [edition.id]);
    const mediaAssets = await this.db.query("SELECT id, media_type, metadata FROM media_assets WHERE artist_id=$1", [release.artist_id]);
    const previewAudio = await this.vettedPreviewAudio({ artistId: release.artist_id, uri: input.previewAudio ?? edition.application_metadata?.previewAudio });
    const generated = canonicalMetadata({ release, edition, artist: { name: release.display_name }, artwork: input.artwork, previewAudio, includes: input.includes || edition.application_metadata?.includes, experiences: experiences.rows, releaseType: input.releaseType, tier: edition.tier });
    const provenance = provenanceForPublication({ release, edition, wallet: identity.wallet, metadataDigest: generated.digest, experiences: experiences.rows, mediaAssets: mediaAssets.rows, input, previous: edition.metadata?.provenance });
    const metadataDocument = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const previous = edition.metadata_version && edition.metadata_uri && edition.metadata?.["_void"]?.digest === generated.digest && edition.metadata?.provenance?.root === provenance.root ? { uri: edition.metadata_uri } : null;
    const publishTokenId = certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name"));
    await assertTokenNotOwnedByAnotherArtist(this.db, { artistId: release.artist_id, contractAddress: CERTIFIED_CONTRACT, chainId: CERTIFIED_CHAIN_ID, tokenId: publishTokenId });
    const stored = previous || await this.metadataStorage.write({ metadata: metadataDocument, name: `${release.slug}-${edition.id}` });
    await this.repository.saveToken({ editionId: edition.id, contractId: edition.contract_id, tokenId: publishTokenId, metadataUri: stored.uri, metadata: metadataDocument, metadataVersion: generated.digest });
    assertProvenanceConsistency({ releaseId: release.id, editionId: edition.id, metadata: metadataDocument, provenanceRoot: provenance.root });
    const proof = this.provenanceRecords ? await persistPublicationProof(this.provenanceRecords, { release, edition, wallet: identity.wallet, provenance }) : null;
    await this.audit({ identity, request, eventType: "STUDIO_METADATA_PUBLISHED", subjectType: "release", subjectId: release.id, payload: { editionId: edition.id, digest: generated.digest, provenanceRoot: provenance.root } });
    const editionSlug = generatedSlug(edition.title, "edition name");
    return { releaseId: release.id, editionId: edition.id, releaseSlug: release.slug, editionSlug, tokenId: certifiedTokenId(release.slug, editionSlug).toString(), metadataUri: stored.uri, digest: generated.digest, provenanceRoot: provenance.root, ...publicationView({ releaseStatus: release.status, proof }) };
  }

  async confirmPublication({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const transactionHash = requiredText(input?.transactionHash, "transactionHash", { max: 128 }).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new ApiError(400, "TRANSACTION_INVALID", "The publication transaction could not be verified.");
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot publish this release.");
    await assertArtistMayPublish(this.db, { artistId: release.artist_id, wallet: identity.wallet });
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.token_id, t.metadata, t.metadata_version FROM editions e JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY e.created_at DESC LIMIT 1", [release.id]);
    const edition = editionResult.rows[0];
    if (!edition?.metadata_uri) throw new ApiError(409, "METADATA_REQUIRED", "Metadata must be published before the blockchain transaction can be confirmed.");
    const provenance = assertProvenanceConsistency({ releaseId: release.id, editionId: edition.id, metadata: edition.metadata, provenanceRoot: edition.metadata?.provenance?.root });
    const currentProof = this.provenanceRecords ? await this.provenanceRecords.findOwnedByRoot({ releaseId: release.id, editionId: edition.id, manifestSha256: provenance.root, creatorWallet: identity.wallet }) : null;
    if (release.status === "PUBLISHED" && publicationView({ releaseStatus: "PUBLISHED", proof: currentProof }).fullyPublished) {
      throw new ApiError(409, "RELEASE_ALREADY_PUBLISHED", "This release is already published and its provenance is verified.");
    }
    try {
      const provider = this.publicationChain || new ethers.JsonRpcProvider(deployment.rpcUrl);
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt || receipt.status !== 1) throw new Error("receipt unavailable or unsuccessful");
      const eventInterface = new ethers.Interface([...deployment.abi, "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
      const expectedTokenId = certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name"));
      const expectedReleaseId = ethers.encodeBytes32String(requiredText(release.slug, "release.slug", { max: 31 }));
      const expectedEditionId = ethers.encodeBytes32String(generatedSlug(edition.title, "edition name"));
      // Only the certified release contract's own logs count; any contract can emit a look-alike event.
      const event = receipt.logs.filter((log) => String(log.address || "").toLowerCase() === CERTIFIED_CONTRACT).map((log) => { try { return eventInterface.parseLog(log); } catch { return null; } }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId === expectedTokenId && parsed.args.releaseId === expectedReleaseId && parsed.args.editionId === expectedEditionId && parsed.args.metadataUri === edition.metadata_uri);
      if (!event) throw new Error("expected EditionCreated event was not found");
      const onChain = this.publicationChain
        ? await this.publicationChain.edition(expectedTokenId)
        : await new ethers.Contract(CERTIFIED_CONTRACT, [...deployment.abi, EDITION_ABI], provider).edition(expectedTokenId);
      if (!onChain[6] || onChain[5] !== edition.metadata_uri) throw new Error("on-chain edition verification failed");
      // The edition, as stored on the certified contract, must have been created by a wallet of this release's own artist.
      const creator = String(onChain[2] || "").toLowerCase();
      if (creator !== String(event.args.artist || "").toLowerCase()) throw new Error("on-chain edition creator does not match the publication event");
      const creatorOwns = await this.db.query("SELECT 1 FROM artist_owners WHERE artist_id=$1 AND lower(owner_wallet)=$2 LIMIT 1", [release.artist_id, creator]);
      if (!creatorOwns.rows[0]) throw new ApiError(403, "EDITION_CREATED_BY_ANOTHER_ARTIST", "The on-chain edition was not created by a wallet of this artist.");
      let proof = currentProof;
      if (this.metadataFetcher && proof?.verification_status !== "VERIFIED") {
        try {
          const bytes = await this.metadataFetcher(edition.metadata_uri);
          const block = this.publicationChain?.getBlock ? await this.publicationChain.getBlock(receipt.blockNumber) : await provider.getBlock(receipt.blockNumber);
          const anchorTimestamp = block?.timestamp == null ? null : new Date(Number(block.timestamp) * 1000).toISOString();
          const anchor = verifyEditionPublication({
            metadataUri: edition.metadata_uri,
            bytes,
            receipt: { status: Number(receipt.status), blockNumber: receipt.blockNumber, transactionHash },
            event,
            onChainUri: onChain[5],
            blockTimestamp: anchorTimestamp,
            releaseId: release.id,
            editionId: edition.id,
          });
          if (anchor.provenanceRoot !== provenance.root || anchor.metadataDigest !== provenance.metadataDigest) {
            throw new ApiError(409, "PROVENANCE_INCONSISTENT", "The metadata CID does not commit this release's provenance root.");
          }
          if (this.provenanceRecords && proof) {
            proof = await this.provenanceRecords.recordVerifiedAnchor({
              id: proof.id,
              creatorWallet: identity.wallet,
              chainKey: deployment.chainKey || "fuji",
              chainId: deployment.chainId,
              transactionHash,
              blockNumber: receipt.blockNumber,
              blockTimestamp: anchor.anchorBlockTimestamp,
              anchorContract: CERTIFIED_CONTRACT,
              anchorEvent: anchor.anchorEvent,
              mechanism: anchor.mechanism,
              metadataCid: anchor.metadataCid,
            });
          }
        } catch (error) {
          if (error?.code === "PROVENANCE_INCONSISTENT" || error?.code === "PROVENANCE_ASSET_MISMATCH" || error?.code === "PROVENANCE_RECORD_INVALID") {
            if (this.provenanceRecords && proof && proof.anchor_status !== "ANCHORED") {
              proof = await this.provenanceRecords.recordAnchorFailure({
                id: proof.id,
                creatorWallet: identity.wallet,
                failureCode: error.code,
                failureDetail: error.code === "PROVENANCE_RECORD_INVALID" ? "The verified publication anchor was rejected by the provenance record." : "The publication metadata CID did not match the canonical provenance.",
              }).catch(() => proof);
            }
          } else if (error instanceof ApiError && error.code === "PUBLICATION_NOT_CONFIRMED") {
            throw error;
          } else {
            this.logger.error?.("studio.provenance.cid_unverified", { releaseId: release.id, detail: error.message });
          }
        }
      }
      await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: edition.title, tier: edition.tier, description: edition.description, supply: edition.supply, status: "PUBLISHED", metadata: edition.application_metadata || {} });
      await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: release.title, description: release.description, status: "PUBLISHED", metadata: release.release_metadata || {}, publishedAt: release.published_at || new Date() });
      await this.publishReleaseExperiences(release);
      await this.audit({ identity, request, eventType: "STUDIO_PUBLICATION_CONFIRMED", subjectType: "release", subjectId: release.id, payload: { transactionHash, tokenId: expectedTokenId.toString(), provenanceRoot: provenance.root } });
      return { releaseId: release.id, editionId: edition.id, tokenId: expectedTokenId.toString(), transactionHash, anchorEvent: "EditionCreated", copyrightOwnership: false, ...publicationView({ releaseStatus: "PUBLISHED", proof }) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.error?.("studio.publication.verify_failed", { releaseId: release.id, transactionHash, detail: error.message });
      throw new ApiError(409, "PUBLICATION_NOT_CONFIRMED", "The blockchain publication could not be verified. Your release remains unpublished and can be retried.");
    }
  }

  async createArtist({ request, input }) {
    const identity = await this.identity(request);
    const wallet = input.ownerWallet ? walletAddress(input.ownerWallet, "ownerWallet") : identity.wallet;
    assertWalletMatches(identity, wallet, "ownerWallet");
    const id = input.id ? requiredText(input.id, "artist.id", { max: 128 }) : `artist-${randomUUID()}`;
    const slug = await availableSlug(this.db, { table: "artists", value: input.name, field: "artist name" });
    const artist = await this.repository.inTransaction(async (repository) => {
      const saved = await repository.saveArtist({ id, slug, displayName: requiredText(input.name, "artist.name", { max: 256 }), metadata: jsonObject(input.metadata, "artist.metadata") });
      await repository.saveArtistProfile({ artistId: saved.id, ...profileInput(input) });
      await repository.assignArtistOwner({ artistId: saved.id, wallet: identity.wallet, role: "OWNER" });
      return saved;
    });
    await this.audit({ identity, request, eventType: "STUDIO_ARTIST_CREATED", subjectType: "artist", subjectId: artist.id });
    return artist;
  }

  async updateArtist({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    const saved = await this.repository.inTransaction(async (repository) => {
      const next = await repository.saveArtist({ id: artist.id, slug: input.slug === undefined ? artist.slug : normalizedSlug(input.slug, "artist.slug"), displayName: input.name === undefined ? artist.display_name : requiredText(input.name, "artist.name", { max: 256 }), status: artist.status, metadata: input.metadata === undefined ? artist.application_metadata : jsonObject(input.metadata, "artist.metadata") });
      if (["bio", "websiteUrl", "links", "socialLinks", "profileArtwork", "profileMetadata"].some((key) => input[key] !== undefined)) await repository.saveArtistProfile({ artistId: artist.id, ...profileInput(input, artist) });
      return next;
    });
    await this.audit({ identity, request, eventType: "STUDIO_ARTIST_UPDATED", subjectType: "artist", subjectId: artist.id });
    return saved;
  }

  async createRelease({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    const id = input.id ? requiredText(input.id, "release.id", { max: 128 }) : `release-${randomUUID()}`;
    const title = requiredText(input.title, "release.title", { max: 256 });
    // Release slugs become the on-chain releaseId (bytes32), which is shared by every
    // artist on the canonical contract, so they are allocated platform-wide.
    const slug = await availableSlug(this.db, { table: "releases", value: title, field: "release title" });
    const release = await this.repository.saveRelease({ id, artistId: artist.id, slug, title, description: optionalText(input.description, "release.description", { max: 20000 }), status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork ? { artwork: optionalText(input.artwork, "artwork", { max: 2048 }) } : {}) }, "release.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_CREATED", subjectType: "release", subjectId: release.id, payload: { artistId: artist.id } });
    return release;
  }

  async updateRelease({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    assertPublishedMayChange(release.status, input, "Published releases cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, release.status, "release");
    if (status === "ARCHIVED" && await this.legacyCatalogStaysOnSite(release)) {
      throw new ApiError(409, "LEGACY_CATALOG_LOCKED", "The original mainnet VOIDCALLER catalog stays on the site.");
    }
    if (status === "ARCHIVED" && await this.collectorsCanStillBuy(release)) {
      throw new ApiError(409, "MINTABLE_RELEASE_LOCKED", "A published release collectors can still buy stays on the site.");
    }
    const saved = await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: input.title === undefined ? release.title : requiredText(input.title, "release.title", { max: 256 }), description: input.description === undefined ? release.description : optionalText(input.description, "release.description", { max: 20000 }), status, metadata: input.metadata === undefined ? release.release_metadata : jsonObject(input.metadata, "release.metadata"), publishedAt: status === "PUBLISHED" ? (release.published_at || new Date()) : status === "ARCHIVED" ? (release.published_at ?? null) : null });
    if (status === "ARCHIVED") await this.archiveReleaseChildren(release.id);
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_UPDATED", subjectType: "release", subjectId: release.id });
    return saved;
  }

  async createEdition({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    const selectedChainId = CERTIFIED_CHAIN_ID;
    const address = CERTIFIED_CONTRACT;
    const editionName = requiredText(input.trackTitle || input.title || input.name || release.title, "track.title", { max: 256 });
    const editionSlug = generatedSlug(editionName, "track title");
    const tokenId = certifiedTokenId(release.slug, editionSlug);
    await assertTokenNotOwnedByAnotherArtist(this.db, { artistId: release.artist_id, contractAddress: address, chainId: selectedChainId, tokenId });
    const id = input.id ? requiredText(input.id, "edition.id", { max: 128 }) : `edition-${randomUUID()}`;
    const edition = await this.repository.inTransaction(async (repository) => {
      const contract = await repository.saveContract({ chainId: selectedChainId, chainKey: input.chainKey || String(selectedChainId), address, contractType: "ERC1155", name: optionalText(input.contractName, "edition.contractName", { max: 256 }), metadata: jsonObject(input.contractMetadata, "edition.contractMetadata") });
      const saved = await repository.saveEdition({ id, releaseId: release.id, contractId: contract.id, title: editionName, tier: optionalText(input.tier, "edition.tier", { max: 128 }), description: optionalText(input.description, "edition.description", { max: 20000 }), supply: editionQuantity(input.quantity, "edition.quantity") ?? "0", status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork === undefined ? {} : { artwork: optionalText(input.artwork, "edition.artwork", { max: 2048 }) }), priceWei: input.priceWei === undefined ? null : positiveBigInt(input.priceWei, "edition.priceWei"), marketplace: jsonObject(input.marketplace, "edition.marketplace") }, "edition.metadata") });
      await repository.saveToken({ editionId: saved.id, contractId: contract.id, tokenId, metadataUri: null, metadata: input.tokenMetadata === undefined ? null : jsonObject(input.tokenMetadata, "edition.tokenMetadata") });
      return saved;
    });
    await this.audit({ identity, request, eventType: "STUDIO_EDITION_CREATED", subjectType: "edition", subjectId: edition.id, payload: { releaseId: release.id, chainId: selectedChainId } });
    return edition;
  }

  async updateEdition({ request, editionId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT e.*, r.artist_id, ao.owner_wallet FROM editions e JOIN releases r ON r.id=e.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE e.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(editionId, "editionId"), identity.wallet]);
    const edition = rows[0];
    if (!edition) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this edition.");
    assertPublishedMayChange(edition.status, input, "Published editions cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, edition.status, "edition");
    const saved = await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: input.name === undefined && input.title === undefined ? edition.title : requiredText(input.name || input.title, "edition.name", { max: 256 }), tier: input.tier === undefined ? edition.tier : optionalText(input.tier, "edition.tier", { max: 128 }), description: input.description === undefined ? edition.description : optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? edition.supply : editionQuantity(input.quantity, "edition.quantity"), status, metadata: input.metadata === undefined ? edition.application_metadata : jsonObject(input.metadata, "edition.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_EDITION_UPDATED", subjectType: "edition", subjectId: edition.id });
    return saved;
  }

  async createExperience({ request, editionId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT e.*, r.artist_id, ao.owner_wallet FROM editions e JOIN releases r ON r.id=e.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE e.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(editionId, "editionId"), identity.wallet]);
    const edition = rows[0];
    if (!edition) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this edition.");
    const id = input.id ? requiredText(input.id, "experience.id", { max: 128 }) : `experience-${randomUUID()}`;
    const productType = input.productType ? String(input.productType).toUpperCase() : null;
    const mappedType = productType ? PRODUCT_TYPES[productType] : String(input.type || input.experienceType || "").toUpperCase();
    if (productType && !mappedType) throw new ApiError(400, "UNSUPPORTED_EXPERIENCE_CATEGORY", `Unsupported experience category: ${productType}`);
    const requirements = await this.defaultEditionRequirements({ editionId: edition.id, mediaConfig: input.mediaConfig, requirements: input.requirements });
    const bound = await this.bindProtectedExperience({ artistId: edition.artist_id, mediaConfig: input.mediaConfig, requirements });
    const mediaConfig = { ...bound.mediaConfig, ...(productType ? { productType, deliveryType: mappedType } : {}) };
    const experience = await this.repository.saveExperience({ id, artistId: edition.artist_id, releaseId: edition.release_id, editionId: edition.id, title: requiredText(input.title, "experience.title", { max: 256 }), description: optionalText(input.description, "experience.description", { max: 20000 }), experienceType: enumValue(mappedType, "experience.type", TYPES), requirements: bound.requirements, mediaConfig, status: "DRAFT" });
    await this.audit({ identity, request, eventType: "STUDIO_EXPERIENCE_CREATED", subjectType: "experience", subjectId: experience.id, payload: { editionId: edition.id } });
    return experience;
  }

  async updateExperience({ request, experienceId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT x.*, ao.owner_wallet FROM experiences x JOIN artist_owners ao ON ao.artist_id=x.artist_id WHERE x.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(experienceId, "experienceId"), identity.wallet]);
    const experience = rows[0];
    if (!experience) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this experience.");
    assertPublishedMayChange(experience.status, input, "Published experiences cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, experience.status, "experience");
    const productType = input.productType ? String(input.productType).toUpperCase() : null;
    const mappedType = productType ? PRODUCT_TYPES[productType] : (input.type === undefined && input.experienceType === undefined ? experience.experience_type : String(input.type || input.experienceType).toUpperCase());
    if (productType && !mappedType) throw new ApiError(400, "UNSUPPORTED_EXPERIENCE_CATEGORY", `Unsupported experience category: ${productType}`);
    const bound = await this.bindProtectedExperience({ artistId: experience.artist_id, mediaConfig: input.mediaConfig === undefined ? experience.media_config : input.mediaConfig, requirements: input.requirements === undefined ? experience.requirements : input.requirements });
    const mediaConfig = productType ? { ...bound.mediaConfig, productType, deliveryType: mappedType } : bound.mediaConfig;
    const saved = await this.repository.saveExperience({ id: experience.id, artistId: experience.artist_id, releaseId: experience.release_id, editionId: experience.edition_id, title: input.title === undefined ? experience.title : requiredText(input.title, "experience.title", { max: 256 }), description: input.description === undefined ? experience.description : optionalText(input.description, "experience.description", { max: 20000 }), experienceType: enumValue(mappedType, "experience.type", TYPES), requirements: bound.requirements, mediaConfig, version: Number(experience.version || 1) + 1, status });
    await this.audit({ identity, request, eventType: "STUDIO_EXPERIENCE_UPDATED", subjectType: "experience", subjectId: experience.id });
    return saved;
  }

  // The seeded C-Chain catalog (id/slug voidcaller-legacy-genesis, or an
  // edition on that mainnet contract). Kept as its own lock, ahead of the
  // broader mintable rule.
  async legacyCatalogStaysOnSite(release) {
    if (isLegacyMainnetCatalogRelease(release)) return true;
    const { rows } = await this.db.query("SELECT c.chain_id, c.address AS contract_address FROM editions e JOIN contracts c ON c.id = e.contract_id WHERE e.release_id = $1", [release.id]);
    return rows.some((row) => isLegacyMainnetEdition(row));
  }

  // Any other published release that already has an on-chain token or a
  // primary sale collectors can buy. A published release that is not
  // mintable yet can still be archived. The legacy catalog is not decided
  // here; legacyCatalogStaysOnSite already rejected it.
  async collectorsCanStillBuy(release) {
    const { rows } = await this.db.query("SELECT e.release_id, e.status, e.application_metadata, c.chain_id, c.address AS contract_address, CASE WHEN upper(e.status) = 'PUBLISHED' THEN (SELECT t.token_id::text FROM tokens t WHERE t.edition_id = e.id ORDER BY t.created_at DESC LIMIT 1) END AS token_id, EXISTS (SELECT 1 FROM primary_purchases p JOIN tokens pt ON pt.edition_id = e.id AND pt.token_id = p.token_id JOIN contracts pc ON pc.id = pt.contract_id WHERE pc.chain_id = p.chain_id AND lower(pc.address) = lower(p.token_contract_address) AND p.status NOT IN ('FAILED', 'REORGED')) AS buyable_sale FROM editions e LEFT JOIN contracts c ON c.id = e.contract_id WHERE e.release_id = $1", [release.id]);
    return rows.some((row) => releaseIsMintable({ id: row.release_id || release.id }, [row], { editionsAreScoped: true }));
  }

  // Same effect as the archive migrations: lifecycle only. Tokens, sales,
  // ownership, and purchases are not touched.
  async archiveReleaseChildren(releaseId) {
    await this.db.query("UPDATE editions SET status = 'ARCHIVED', updated_at = now() WHERE release_id = $1 AND status <> 'ARCHIVED'", [releaseId]);
    await this.db.query("UPDATE experiences SET status = 'ARCHIVED', updated_at = now() WHERE status <> 'ARCHIVED' AND (release_id = $1 OR edition_id IN (SELECT id FROM editions WHERE release_id = $1))", [releaseId]);
  }

  async publishReleaseExperiences(release) {
    const { rows } = await this.db.query("SELECT id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status FROM experiences WHERE release_id=$1", [release.id]);
    for (const experience of rows) {
      let bound;
      try {
        bound = await this.bindProtectedExperience({ artistId: release.artist_id, mediaConfig: experience.media_config || {}, requirements: Array.isArray(experience.requirements) ? experience.requirements : [] });
      } catch (error) {
        this.logger.error?.("studio.publication.experience_blocked", { releaseId: release.id, experienceId: experience.id, detail: error.message });
        continue;
      }
      await this.repository.saveExperience({ id: experience.id, artistId: experience.artist_id, releaseId: experience.release_id, editionId: experience.edition_id, title: experience.title, description: experience.description, experienceType: experience.experience_type, requirements: bound.requirements, mediaConfig: bound.mediaConfig, version: Number(experience.version || 1), status: "PUBLISHED" });
    }
  }

  async uploadProtectedMedia({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    if (typeof this.mediaUploader !== "function") throw new ApiError(503, "MEDIA_UPLOAD_UNAVAILABLE", "Protected media upload is not configured.");
    const mediaType = enumValue(String(input.mediaType || "").toUpperCase(), "mediaType", ["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "DEMO", "LIVE_RECORDING"]);
    const encoded = requiredText(input.data, "data", { max: 20_000_000 });
    const body = Buffer.from(encoded, "base64");
    if (!body.length) throw new ApiError(400, "MEDIA_UPLOAD_EMPTY", "Protected media upload was empty.");
    const contentSha256 = createHash("sha256").update(body).digest("hex");
    const publicPreview = await this.db.query("SELECT id FROM audit_events WHERE event_type='STUDIO_AUDIO_PREVIEW_UPLOADED' AND subject_type='artist' AND subject_id=$1 AND payload->>'contentSha256'=$2 LIMIT 1", [artist.id, contentSha256]);
    if (publicPreview.rows.length) throw new ApiError(409, "PRIVATE_TRACK_MATCHES_PUBLIC_PREVIEW", "This exact file is already public as a preview, so it cannot be token-gated.");
    const stored = await this.mediaUploader({ artistId: artist.id, body, filename: optionalText(input.filename, "filename", { max: 256 }) || "upload.bin", contentType: optionalText(input.contentType, "contentType", { max: 128 }) || "application/octet-stream", mediaType });
    const storageKey = requiredText(stored?.storageKey, "storageKey", { max: 1024 });
    const id = `asset-${randomUUID()}`;
    const asset = await this.repository.saveMediaAsset({ id, artistId: artist.id, storageKey, mediaType, contentSha256, byteSize: body.length });
    await this.audit({ identity, request, eventType: "STUDIO_MEDIA_UPLOADED", subjectType: "media_asset", subjectId: asset.id, payload: { mediaType, contentSha256 } });
    return { id: asset.id, mediaType: asset.media_type || mediaType, createdAt: asset.created_at || null };
  }

  // Step 1 of a direct upload: a short-lived, private-only, size- and
  // type-limited Pinata link, issued only to the artist's owner wallet.
  async createMediaUploadUrl({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    const direct = this.directMediaUploads;
    if (!direct || typeof direct.sign !== "function") throw new ApiError(503, "MEDIA_DIRECT_UPLOAD_UNAVAILABLE", "Direct protected media upload is not configured.");
    const mediaType = enumValue(String(input.mediaType || "AUDIO").toUpperCase(), "mediaType", DIRECT_UPLOAD_MEDIA_TYPES);
    const contentType = requiredText(input.contentType, "contentType", { max: 128 }).toLowerCase();
    const allowed = directUploadMimeTypes(mediaType);
    if (!allowed.includes(contentType)) {
      const [code, message] = unsupportedUpload(mediaType);
      throw new ApiError(400, code, message);
    }
    const byteSize = Number(input.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new ApiError(400, "MEDIA_UPLOAD_EMPTY", "byteSize must be the file size in bytes.");
    if (byteSize > direct.maxBytes) throw new ApiError(413, "MEDIA_UPLOAD_TOO_LARGE", `The full track must be ${Math.floor(direct.maxBytes / 1048576)} MB or smaller.`);
    const filename = optionalText(input.filename, "filename", { max: 256 }) || "track";
    const uploadId = `upload-${randomUUID()}`;
    let url;
    try {
      url = await direct.sign({ filename, maxBytes: direct.maxBytes, mimeTypes: [...allowed], expiresSeconds: DIRECT_UPLOAD_TTL_SECONDS, keyvalues: { voidArtistId: artist.id, voidUploadId: uploadId, voidMediaType: mediaType } });
    } catch (error) {
      throw new ApiError(error.status || 502, error.code || "MEDIA_UPLOAD_FAILED", error.message || "Could not create an upload link.");
    }
    await this.audit({ identity, request, eventType: "STUDIO_MEDIA_UPLOAD_ISSUED", subjectType: "artist", subjectId: artist.id, payload: { uploadId, mediaType, contentType, byteSize } });
    return { uploadId, url, maxBytes: direct.maxBytes, expiresAt: new Date(Date.now() + DIRECT_UPLOAD_TTL_SECONDS * 1000).toISOString() };
  }

  // Step 2: record the uploaded file. The browser passes the identifier Pinata
  // returned for the object it just created (file id from the multipart
  // response, or the CID from the tus Upload-CID header). That is only a
  // pointer: the server looks the object up itself in PRIVATE storage and
  // accepts it only if it carries this artist's server-issued upload id, is
  // audio, and its stored bytes hash to the declared SHA-256.
  async registerMediaUpload({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    const direct = this.directMediaUploads;
    if (!direct || typeof direct.get !== "function" || typeof direct.sha256 !== "function") throw new ApiError(503, "MEDIA_DIRECT_UPLOAD_UNAVAILABLE", "Direct protected media upload is not configured.");
    const uploadId = requiredText(input.uploadId, "uploadId", { max: 128 });
    if (!/^upload-[0-9a-f-]{36}$/.test(uploadId)) throw new ApiError(400, "INVALID_UPLOAD_ID", "uploadId is invalid.");
    const contentSha256 = requiredText(input.contentSha256, "contentSha256", { max: 64 }).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new ApiError(400, "INVALID_CONTENT_HASH", "contentSha256 must be a SHA-256 hex digest.");
    const declaredBytes = input.byteSize === undefined || input.byteSize === null ? null : Number(input.byteSize);
    if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0)) throw new ApiError(400, "INVALID_BYTE_SIZE", "byteSize must be the uploaded file size in bytes.");
    const fileId = optionalText(input.pinataFileId, "pinataFileId", { max: 64 }) || null;
    const cid = optionalText(input.cid, "cid", { max: 128 }) || null;
    if (fileId && !/^[0-9a-f-]{36}$/i.test(fileId)) throw new ApiError(400, "INVALID_PINATA_FILE_ID", "pinataFileId is invalid.");
    if (cid && !/^(?:baf[a-z0-9]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(cid)) throw new ApiError(400, "INVALID_CID", "cid is invalid.");
    if (!fileId && !cid) throw new ApiError(400, "UPLOAD_IDENTITY_REQUIRED", "Registration needs the file id or CID that private storage returned for the upload. Reload Studio and upload again.");
    const receipt = input.uploadReceipt && typeof input.uploadReceipt === "object" && JSON.stringify(input.uploadReceipt).length <= 4000 ? input.uploadReceipt : null;
    const evidence = { uploadId, artistId: artist.id, receipt, pinataFileId: fileId, cid };
    const fail = (status, code, message, extra = {}) => {
      this.logger.error?.("MEDIA_UPLOAD_VERIFY", { ...evidence, ...extra, outcome: code });
      return new ApiError(status, code, message, extra.upstream ? { upstream: extra.upstream } : extra.details);
    };

    // The upload id must be one this server issued to this artist.
    const issued = await this.db.query("SELECT id FROM audit_events WHERE event_type='STUDIO_MEDIA_UPLOAD_ISSUED' AND subject_type='artist' AND subject_id=$1 AND payload->>'uploadId'=$2 LIMIT 1", [artist.id, uploadId]);
    if (!issued.rows.length) throw fail(403, "UPLOAD_NOT_ISSUED", "This upload id was not issued to this artist.");

    let found;
    try {
      found = await direct.get({ fileId, cid });
    } catch (error) {
      throw fail(error.status || 502, error.code || "MEDIA_UPLOAD_LOOKUP_FAILED", error.message || "Could not look up the upload in private storage.", { upstream: error.upstream || null });
    }
    const { file, upstream } = found;
    if (!file) throw fail(404, "MEDIA_OBJECT_NOT_FOUND", `Private storage has no object for this upload (${upstream.endpoint} → HTTP ${upstream.status}, ${upstream.count} match).`, { upstream });
    if (!file.cid || file.cid === "pending") throw fail(409, "MEDIA_CID_PENDING", "Private storage has the object but has not finished computing its CID.", { upstream });
    if (cid && file.cid !== cid) throw fail(409, "MEDIA_UPLOAD_MISMATCH", "The stored object's CID does not match the upload.", { upstream });
    if (file.network !== "private") throw fail(409, "MEDIA_UPLOAD_NOT_PRIVATE", "The stored object is not private.", { upstream });
    // Pinata de-duplicates identical bytes: re-uploading a file returns the
    // existing object (is_duplicate) still stamped with the upload id of the
    // link that first stored it. That is acceptable only if that earlier link
    // was also issued by this server to this same artist.
    const storedUploadId = String(file.keyvalues.voidUploadId || "");
    const stampedArtistId = String(file.keyvalues.voidArtistId || "");
    // The stamped artist must be this artist, or another artist record owned
    // by the same authenticated wallet (one person can hold several profiles).
    let stampedArtistOwned = stampedArtistId === artist.id;
    if (!stampedArtistOwned && stampedArtistId) {
      const sibling = await this.db.query("SELECT artist_id FROM artist_owners WHERE artist_id=$1 AND owner_wallet=$2 LIMIT 1", [stampedArtistId, identity.wallet]);
      stampedArtistOwned = sibling.rows.length > 0;
    }
    let stampedByThisArtist = stampedArtistOwned && stampedArtistId === artist.id && storedUploadId === uploadId;
    if (!stampedByThisArtist && stampedArtistOwned && /^upload-[0-9a-f-]{36}$/.test(storedUploadId)) {
      const earlier = await this.db.query("SELECT id FROM audit_events WHERE event_type='STUDIO_MEDIA_UPLOAD_ISSUED' AND subject_type='artist' AND subject_id=$1 AND payload->>'uploadId'=$2 LIMIT 1", [stampedArtistId, storedUploadId]);
      stampedByThisArtist = earlier.rows.length > 0;
    }
    if (!stampedByThisArtist) throw fail(409, "MEDIA_UPLOAD_MISMATCH", "The stored object was not uploaded through an upload link issued to an artist this wallet owns.", { upstream });
    const mediaType = enumValue(String(file.keyvalues.voidMediaType || "AUDIO").toUpperCase(), "mediaType", DIRECT_UPLOAD_MEDIA_TYPES);
    if (!directUploadMimeTypes(mediaType).includes(String(file.mimeType || "").toLowerCase())) {
      const [code, message] = unsupportedUpload(mediaType);
      throw fail(415, code, `The stored object is ${file.mimeType || "of unknown type"}. ${message}`, { upstream });
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > direct.maxBytes) throw fail(413, "MEDIA_UPLOAD_TOO_LARGE", "The stored file is empty or too large.", { upstream });

    // Idempotent: the same private object registers once.
    const existing = await this.db.query("SELECT id, artist_id, media_type, metadata->>'contentSha256' AS content_sha256, created_at FROM media_assets WHERE storage_key=$1 LIMIT 1", [file.cid]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.content_sha256 && String(row.content_sha256).toLowerCase() !== contentSha256) throw fail(409, "MEDIA_HASH_MISMATCH", "This private object is already registered with a different SHA-256.");
      if (String(row.artist_id) !== artist.id) {
        // Registered under another artist record. Move it only if this wallet
        // owns that record too and none of its releases use the asset.
        const owner = await this.db.query("SELECT artist_id FROM artist_owners WHERE artist_id=$1 AND owner_wallet=$2 LIMIT 1", [row.artist_id, identity.wallet]);
        if (!owner.rows.length) throw fail(409, "MEDIA_ASSET_OWNED_ELSEWHERE", "This private object is registered to an artist this wallet does not own.");
        const inUse = await this.db.query("SELECT 1 FROM experiences WHERE media_config::text LIKE $1 LIMIT 1", [`%${row.id}%`]);
        if (inUse.rows.length) throw fail(409, "MEDIA_ASSET_IN_USE", "This track is already used by a release of your other artist profile. Use that profile, or upload a different master.");
        await this.db.query("UPDATE media_assets SET artist_id=$1, updated_at=now() WHERE id=$2 AND artist_id=$3", [artist.id, row.id, row.artist_id]);
        await this.audit({ identity, request, eventType: "STUDIO_MEDIA_REASSIGNED", subjectType: "media_asset", subjectId: row.id, payload: { fromArtistId: row.artist_id, toArtistId: artist.id, uploadId } });
        this.logger.info?.("MEDIA_UPLOAD_VERIFY", { ...evidence, outcome: "REASSIGNED", assetId: row.id, fromArtistId: row.artist_id, upstream });
        return { id: row.id, mediaType: row.media_type || mediaType, byteSize: file.size, createdAt: row.created_at || null };
      }
      this.logger.info?.("MEDIA_UPLOAD_VERIFY", { ...evidence, outcome: "ALREADY_REGISTERED", assetId: row.id, upstream });
      return { id: row.id, mediaType: row.media_type || mediaType, byteSize: file.size, createdAt: row.created_at || null };
    }
    const publicPreview = await this.db.query("SELECT id FROM audit_events WHERE event_type='STUDIO_AUDIO_PREVIEW_UPLOADED' AND subject_type='artist' AND subject_id=$1 AND payload->>'contentSha256'=$2 LIMIT 1", [artist.id, contentSha256]);
    if (publicPreview.rows.length) throw fail(409, "PRIVATE_TRACK_MATCHES_PUBLIC_PREVIEW", "This exact file is already public as a preview, so it cannot be token-gated.");

    let stored;
    try {
      stored = await direct.sha256({ cid: file.cid });
    } catch (error) {
      throw fail(error.status || 502, error.code || "MEDIA_HASH_UNVERIFIED", `Could not read the private object to verify it: ${error.message}`, { upstream: error.upstream || upstream });
    }
    // Compare the bytes the gateway returns with what the browser hashed.
    // Pinata's `size` is the IPFS DAG size (file + UnixFS overhead; production:
    // 65,874,601 for a 65,861,868-byte WAV), so it is not the file length.
    if (stored.sha256 !== contentSha256 || (declaredBytes !== null && stored.bytes !== declaredBytes) || stored.bytes > file.size) {
      throw fail(409, "MEDIA_HASH_MISMATCH", "The stored object's SHA-256 does not match the file the browser hashed.", { details: { gatewayBytes: stored.bytes, declaredBytes, pinataSize: file.size, download: stored.download || null } });
    }
    const hashVerified = true;
    const hashCheck = "MATCH";

    const id = `asset-${randomUUID()}`;
    const asset = await this.repository.saveMediaAsset({ id, artistId: artist.id, storageKey: file.cid, mediaType, contentSha256, byteSize: stored.bytes });
    await this.audit({ identity, request, eventType: "STUDIO_MEDIA_UPLOADED", subjectType: "media_asset", subjectId: asset.id, payload: { mediaType, contentSha256, byteSize: stored.bytes, pinataSize: file.size, uploadId, pinataFileId: file.id, direct: true, hashVerified, hashCheck } });
    this.logger.info?.("MEDIA_UPLOAD_VERIFY", { ...evidence, outcome: "REGISTERED", assetId: asset.id, hashVerified, hashCheck, gatewayBytes: stored.bytes, upstream });
    return { id: asset.id, mediaType: asset.media_type || mediaType, byteSize: stored.bytes, createdAt: asset.created_at || null };
  }

  // Public release/track artwork. Unlike protected media it is pinned publicly,
  // because cards and NFT metadata must show it to everyone.
  async uploadArtwork({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    if (typeof this.artworkUploader !== "function") throw new ApiError(503, "ARTWORK_UPLOAD_UNAVAILABLE", "Artwork upload is not configured.");
    if (String(input.data ?? "").length > Math.ceil(MAX_ARTWORK_BYTES / 3) * 4 + 4) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
    const body = Buffer.from(requiredText(input.data, "data", { max: 20_000_000 }), "base64");
    if (!body.length) throw new ApiError(400, "ARTWORK_UPLOAD_EMPTY", "Artwork upload was empty.");
    if (body.length > MAX_ARTWORK_BYTES) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
    const image = sniffArtwork(body);
    if (!image) throw new ApiError(400, "ARTWORK_TYPE_UNSUPPORTED", "Artwork must be a PNG, JPEG, GIF or WebP image.");
    const contentSha256 = createHash("sha256").update(body).digest("hex");
    let stored;
    try {
      stored = await this.artworkUploader({ artistId: artist.id, body, filename: `artwork-${contentSha256.slice(0, 16)}${image.extension}`, contentType: image.contentType });
    } catch (error) {
      throw new ApiError(error.status || 502, error.code || "ARTWORK_UPLOAD_FAILED", error.message || "Artwork upload failed.");
    }
    const uri = requiredText(stored?.uri, "uri", { max: 1024 });
    if (!uri.startsWith("ipfs://")) throw new ApiError(502, "ARTWORK_UPLOAD_FAILED", "Artwork upload did not return an IPFS URI.");
    await this.audit({ identity, request, eventType: "STUDIO_ARTWORK_UPLOADED", subjectType: "artist", subjectId: artist.id, payload: { uri, contentType: image.contentType, contentSha256, byteSize: body.length } });
    return { uri, contentType: image.contentType, byteSize: body.length };
  }

  // PUBLIC preview clip for the token's animation_url. Full-length audio must
  // go through uploadProtectedMedia instead; the two can never be the same file.
  async uploadTrackPreview({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    if (typeof this.artworkUploader !== "function") throw new ApiError(503, "PREVIEW_UPLOAD_UNAVAILABLE", "Preview upload is not configured.");
    const maxEncoded = Math.ceil(MAX_PREVIEW_AUDIO_BYTES / 3) * 4;
    if (String(input.data ?? "").length > maxEncoded) throw new ApiError(413, "PREVIEW_TOO_LARGE", "A preview must be 5 MB or smaller. Upload a ~30-second clip, not the full track.");
    const body = Buffer.from(requiredText(input.data, "data", { max: maxEncoded }), "base64");
    if (!body.length) throw new ApiError(400, "PREVIEW_UPLOAD_EMPTY", "Preview upload was empty.");
    if (body.length > MAX_PREVIEW_AUDIO_BYTES) throw new ApiError(413, "PREVIEW_TOO_LARGE", "A preview must be 5 MB or smaller. Upload a ~30-second clip, not the full track.");
    const audio = sniffAudio(body);
    if (!audio) throw new ApiError(400, "AUDIO_TYPE_UNSUPPORTED", "Audio must be MP3, WAV, FLAC, AAC/M4A or OGG.");
    const contentSha256 = createHash("sha256").update(body).digest("hex");
    const privateMatch = await this.db.query("SELECT id FROM media_assets WHERE artist_id=$1 AND metadata->>'contentSha256'=$2 LIMIT 1", [artist.id, contentSha256]);
    if (privateMatch.rows.length) throw new ApiError(409, "PREVIEW_MATCHES_PRIVATE_TRACK", "This file is already uploaded as private, token-gated audio. Upload a separate short preview clip instead.");
    let stored;
    try {
      stored = await this.artworkUploader({ artistId: artist.id, body, filename: `preview-${contentSha256.slice(0, 16)}${audio.extension}`, contentType: audio.contentType });
    } catch (error) {
      throw new ApiError(error.status || 502, error.code === "ARTWORK_UPLOAD_UNAUTHORIZED" ? "PREVIEW_UPLOAD_UNAUTHORIZED" : "PREVIEW_UPLOAD_FAILED", error.message || "Preview upload failed.");
    }
    const uri = requiredText(stored?.uri, "uri", { max: 1024 });
    if (!uri.startsWith("ipfs://")) throw new ApiError(502, "PREVIEW_UPLOAD_FAILED", "Preview upload did not return an IPFS URI.");
    // This audit row is also the registry publishMetadata checks animation_url against.
    await this.audit({ identity, request, eventType: "STUDIO_AUDIO_PREVIEW_UPLOADED", subjectType: "artist", subjectId: artist.id, payload: { uri, contentType: audio.contentType, contentSha256, byteSize: body.length } });
    return { uri, contentType: audio.contentType, byteSize: body.length };
  }

  // animation_url may only be a preview this artist uploaded through
  // uploadTrackPreview, and never one of the artist's private storage objects.
  async vettedPreviewAudio({ artistId, uri }) {
    const value = optionalText(uri, "previewAudio", { max: 2048 });
    if (!value) return null;
    const registered = await this.db.query("SELECT id FROM audit_events WHERE event_type='STUDIO_AUDIO_PREVIEW_UPLOADED' AND subject_type='artist' AND subject_id=$1 AND payload->>'uri'=$2 LIMIT 1", [artistId, value]);
    if (!registered.rows.length) throw new ApiError(400, "PREVIEW_AUDIO_NOT_REGISTERED", "animation_url must be a preview clip uploaded in Studio.");
    const cid = value.startsWith("ipfs://") ? value.slice(7).split(/[/?#]/)[0] : "";
    const privateObject = await this.db.query("SELECT id FROM media_assets WHERE artist_id=$1 AND storage_key=$2 LIMIT 1", [artistId, cid]);
    if (privateObject.rows.length) throw new ApiError(400, "PREVIEW_AUDIO_IS_PRIVATE", "animation_url cannot point to private, token-gated audio.");
    return value;
  }
}

export function createArtistStudioService(options) { return new ArtistStudioService(options); }
