import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { chainId, editionQuantity, enumValue, nonNegativeBigInt, optionalText, positiveBigInt, requiredText, walletAddress } from "./validation.js";
import { RELEASE_DEPLOYMENT as deployment, RELEASE_PER_CONTRACT, anchorsProvenanceAtCreation, releaseContractNames, releaseDeploymentForFactory, releaseRoyaltyPolicyForChain, releaseRoyaltyPolicyViolation, sequentialEditionId, usesSequentialTokenIds } from "../config/release-network.js";
import { isDeepStrictEqual } from "node:util";
import { EP_TRACK_LIMIT_MESSAGE, MAX_EP_TRACKS } from "../src/lib/release-types.js";
import { ALBUM_NOT_SUPPORTED_MESSAGE, RELEASE_CHAIN_STATE_UNAVAILABLE_MESSAGE, lifecycleExpectations, readReleaseLifecycle, releaseTypeChangeBlocker } from "../src/lib/release-lifecycle.js";
import { canonicalMetadata, collectionMetadata } from "./metadata-storage.js";
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
// SINGLE: a standalone release with exactly one published edition on its own contract.
// EP: a standalone multi-track release. ALBUM: a release contract with album semantics.
// Releases created before release types existed carry no type and remain EP.
const RELEASE_TYPES = Object.freeze(["SINGLE", "EP", "ALBUM"]);
function releaseType(value) {
  const type = String(value ?? "EP").trim().toUpperCase();
  if (!RELEASE_TYPES.includes(type)) throw new ApiError(400, "INVALID_RELEASE_TYPE", "Release type must be SINGLE, EP or ALBUM.");
  return type;
}
function storedReleaseType(release) {
  return releaseType(release?.release_metadata?.releaseType);
}
// Legacy `metadata.tracks` list some clients send with a release. Only growth past the cap is refused,
// so an over-limit draft can still be saved while the artist trims it.
function assertReleaseTrackList(type, metadata, previousMetadata = {}, { typeChanged = false } = {}) {
  const next = Array.isArray(metadata?.tracks) ? metadata.tracks.length : 0;
  const previous = Array.isArray(previousMetadata?.tracks) ? previousMetadata.tracks.length : 0;
  if (type === "EP" && next > MAX_EP_TRACKS && next > previous) throw new ApiError(409, "EP_TRACK_LIMIT_EXCEEDED", EP_TRACK_LIMIT_MESSAGE);
  if (type === "SINGLE" && next > (typeChanged ? 1 : Math.max(previous, 1))) throw new ApiError(409, "SINGLE_REQUIRES_ONE_TRACK", SINGLE_ONE_TRACK_MESSAGE);
}
// `removedDraft` is server-owned: a client cannot set it (that would hide a published track and free a cap slot) or clear it.
function withoutRemovedDraftFlag(metadata) {
  const rest = { ...(metadata || {}) };
  delete rest.removedDraft;
  return rest;
}
// Once an edition is confirmed on-chain (PUBLISHED, or taken off the site afterwards) its title, tier, description,
// supply and metadata are committed in the on-chain edition and the immutable metadata document. The database copy
// must not drift from them, so only an unchanged resave or taking it off the site is accepted. A removed draft is
// handled separately and a DRAFT or REVIEW edition is unaffected.
function assertEditionNotFrozen(edition, next) {
  const frozen = edition.status === "PUBLISHED" || (edition.status === "ARCHIVED" && edition.application_metadata?.removedDraft !== true);
  if (!frozen) return;
  const changed = [];
  if (next.title !== edition.title) changed.push("title");
  if ((next.tier ?? null) !== (edition.tier ?? null)) changed.push("tier");
  if ((next.description ?? null) !== (edition.description ?? null)) changed.push("description");
  if (String(next.supply ?? "") !== String(edition.supply ?? "")) changed.push("supply");
  if (!isDeepStrictEqual(next.metadata ?? {}, edition.application_metadata ?? {})) changed.push("metadata");
  if (next.status !== edition.status && !(edition.status === "PUBLISHED" && next.status === "ARCHIVED")) changed.push("status");
  if (changed.length) throw new ApiError(409, "PUBLISHED_EDITION_IMMUTABLE", `A published edition's ${changed.join(", ")} cannot be changed. It can only be taken off the site.`);
}
const SINGLE_ONE_TRACK_MESSAGE = "A single is exactly one standalone track. Remove the extra tracks before choosing Single.";
// Tracks are the release's editions. A draft the artist removed stays stored as ARCHIVED but no longer counts.
const TRACK_COUNT_SQL = "SELECT count(*)::int AS track_count FROM editions WHERE release_id=$1 AND ($2::text IS NULL OR id<>$2) AND NOT (status='ARCHIVED' AND application_metadata->>'removedDraft'='true')";

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
// The legacy shared contract exists on Fuji only. On a network without one (mainnet), a release
// that is not bound to a factory clone fails closed instead of falling back to an empty address.
const CERTIFIED_CONTRACT = String(deployment.contractAddress || "").toLowerCase();
function legacySharedContract() {
  if (!CERTIFIED_CONTRACT) throw new ApiError(409, "RELEASE_CONTRACT_BINDING_REQUIRED", "This network has no legacy shared release contract. Bind the release to a VoidReleaseFactory deployment first.");
  return CERTIFIED_CONTRACT;
}
export const EDITION_ABI = "function edition(uint256) view returns (tuple(bytes32 releaseId, bytes32 editionId, address artist, uint256 maxSupply, uint256 mintedSupply, string metadataUri, bool exists))";
const NEXT_TOKEN_ID_ABI = "function nextTokenId() view returns (uint256)";
const ROYALTY_CONFIGURED_IFACE = new ethers.Interface(["event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps)"]);

/**
 * Where the network has a royalty policy (mainnet: 2.5% to the artist's own wallet), the edition's
 * creation transaction must carry the release contract's RoyaltyConfigured event for this token with
 * exactly that rate and a receiver that is not a platform fee wallet. The royalty cannot change after
 * creation, so a non-compliant edition is never published. No policy (Fuji): nothing is checked.
 */
export function assertEditionRoyaltyPolicy({ receipt, publicationContract, tokenId, policy }) {
  if (!policy) return;
  const configured = (receipt?.logs || []).filter((log) => String(log.address || "").toLowerCase() === String(publicationContract).toLowerCase())
    .map((log) => { try { return ROYALTY_CONFIGURED_IFACE.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "RoyaltyConfigured" && parsed.args.tokenId === BigInt(tokenId));
  if (!configured) throw new ApiError(409, "ROYALTY_POLICY_MISMATCH", "The edition transaction does not record its artist royalty.");
  const violation = releaseRoyaltyPolicyViolation(policy, { receiver: configured.args.receiver, royaltyBps: configured.args.royaltyBps });
  if (violation) throw new ApiError(409, "ROYALTY_POLICY_MISMATCH", `${violation} This edition cannot be published.`);
}

// VoidRelease1155V5 (Factory V3) records the provenance root inside the edition-creating
// transaction and is its own anchor; the event signature matches VoidProvenanceAnchor's.
export const RELEASE_PROVENANCE_ABI = Object.freeze([
  "event ProvenanceAnchored(bytes32 indexed provenanceRoot, bytes32 indexed releaseId, bytes32 indexed editionId, uint256 tokenId, address artist, address releaseContract)",
  "function isAnchored(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot) view returns (bool)",
  "function provenanceRootOf(uint256 tokenId) view returns (bytes32)",
]);
const releaseProvenanceIface = new ethers.Interface(RELEASE_PROVENANCE_ABI);
function provenanceRootBytes32(root) {
  const hash = String(root || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hash) || /^0{64}$/.test(hash)) throw new ApiError(409, "PROVENANCE_ROOT_REQUIRED", "The edition has no canonical provenance root to record on-chain.");
  return `0x${hash}`;
}
// A binding's implementation version is the ReleaseCreated version the trusted factory emitted.
function bindingAnchorsAtCreation(binding) {
  return Boolean(binding) && anchorsProvenanceAtCreation(binding.implementation_version);
}
// Factory V4 clones number editions 1, 2, 3, ...: the token ID is reserved when the track is first saved
// and stored on its token row, never derived from the title.
function bindingUsesSequentialIds(binding) {
  return Boolean(binding) && usesSequentialTokenIds(binding.implementation_version);
}
/** The bytes32 edition ID the release contract records for an edition. */
function onChainEditionIdFor(binding, editionTitle, tokenId) {
  return bindingUsesSequentialIds(binding) ? sequentialEditionId(tokenId) : ethers.encodeBytes32String(generatedSlug(editionTitle, "edition name"));
}
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
function releaseCloneTokenId(editionSlug) {
  const editionId = ethers.encodeBytes32String(requiredText(editionSlug, "edition.slug", { max: 31 }));
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId]));
  const tokenId = BigInt(digest);
  return tokenId === 0n ? 1n : tokenId;
}
/**
 * The token ID of a track on a sequential release contract. A track keeps the number it was given when it
 * was first saved; a new track takes the next number after every token row this release contract has, so
 * two tracks never share one and duplicate titles do not matter. The release row lock serializes
 * reservations; UNIQUE (contract_id, token_id) backs it up. Publication then requires the chain's
 * nextTokenId() to equal this number, so tracks are published in the order they were added.
 */
async function reserveSequentialTokenId(db, { releaseId, editionId, contractId }) {
  await db.query("SELECT id FROM releases WHERE id=$1 FOR UPDATE", [releaseId]);
  const own = await db.query("SELECT token_id::text AS token_id FROM tokens WHERE edition_id=$1 AND contract_id=$2 ORDER BY token_id ASC LIMIT 1", [editionId, contractId]);
  if (own.rows[0]) return BigInt(own.rows[0].token_id);
  const { rows } = await db.query("SELECT COALESCE(MAX(token_id), 0)::text AS last_token_id FROM tokens WHERE contract_id=$1", [contractId]);
  return BigInt(rows[0]?.last_token_id ?? "0") + 1n;
}
function releaseKey(value, field = "releaseKey") {
  const key = requiredText(value, field, { max: 66 }).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key) || /^0x0{64}$/.test(key)) throw new ApiError(400, "INVALID_RELEASE_KEY", `${field} must be a non-zero bytes32 value.`);
  return key;
}

const PROVISIONING_CHAIN_ID = Number(RELEASE_PER_CONTRACT.chainId);
const RELEASE_FACTORY_V2_ABI = Object.freeze([
  "function createRelease(bytes32 applicationReleaseId,bytes32 releaseKey,string name,string symbol,string contractURI) returns (address releaseContract,address primarySale,address provenanceAnchor)",
  "event ReleaseCreated(address indexed releaseContract,bytes32 indexed releaseKey,address indexed artist,address primarySale,address provenanceAnchor,address implementation,uint256 index,uint16 version)",
]);

export function deriveStudioApplicationReleaseId(releaseId) {
  return ethers.keccak256(ethers.toUtf8Bytes(requiredText(releaseId, "releaseId", { max: 128 })));
}

export function deriveStudioReleaseKey({ releaseId, applicationReleaseId = deriveStudioApplicationReleaseId(releaseId), artistWallet, factoryAddress = RELEASE_PER_CONTRACT.factoryAddress, chainId: selectedChainId = PROVISIONING_CHAIN_ID }) {
  const artist = walletAddress(artistWallet, "artistWallet");
  const factory = walletAddress(factoryAddress, "factoryAddress");
  const appId = releaseKey(applicationReleaseId, "applicationReleaseId");
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "address", "bytes32", "address"],
    ["the-void:studio-release:v2", BigInt(chainId(selectedChainId)), factory, appId, artist],
  ));
}

function provisioningFactoryConfig() {
  const config = RELEASE_PER_CONTRACT;
  const address = String(config.factoryAddress || "").trim();
  if (config.provisioningEnabled !== true || config.deploymentAuthorized !== true || !ethers.isAddress(address) || ethers.getAddress(address) === ethers.ZeroAddress) {
    throw new ApiError(503, "RELEASE_FACTORY_V2_NOT_CONFIGURED", "Artist release creation is unavailable until the separately authorized Factory V2 deployment is configured. The existing Factory is not used as a fallback.");
  }
  return { ...config, factoryAddress: ethers.getAddress(address) };
}

// A release that already has a provisioning request stays on the factory recorded there, so
// releases prepared on a historical factory keep their key, clone and binding. New releases use
// the active (album-capable) factory.
function provisioningFactoryFor(provisioningRequest) {
  const active = provisioningFactoryConfig();
  if (!provisioningRequest?.factory_address) return active;
  const recorded = releaseDeploymentForFactory(provisioningRequest.factory_address);
  if (!recorded || Number(recorded.chainId) !== Number(active.chainId)) throw new ApiError(409, "PROVISIONING_FACTORY_UNKNOWN", "This release was prepared on a factory that is not a recorded release deployment.");
  return { ...active, factoryAddress: ethers.getAddress(recorded.factoryAddress), albumCapable: recorded.albumCapable, releaseVersion: recorded.releaseVersion };
}

// The on-chain ERC-1155 symbol. An artist may choose a short ticker (stored as release_metadata.contractSymbol);
// otherwise it is derived from the release title. It is fixed once the release contract exists.
const CONTRACT_SYMBOL_PATTERN = /^[A-Z0-9]{1,11}$/;
function contractSymbolInput(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const symbol = String(value).trim().toUpperCase();
  if (!CONTRACT_SYMBOL_PATTERN.test(symbol)) throw new ApiError(400, "CONTRACT_SYMBOL_INVALID", "The release symbol must be 1 to 11 letters or digits.");
  return symbol;
}
function derivedContractSymbol(release) {
  return contractSymbolInput(release.release_metadata?.contractSymbol) || generatedSlug(release.title, "release title").replace(/-/g, "").slice(0, 11).toUpperCase();
}

function expectedReleaseVersion(factory) {
  const version = Number(factory?.releaseVersion ?? 2);
  return Number.isSafeInteger(version) && version > 0 ? version : 2;
}

// A private file belongs to one edition at a time. An experience reserves its files unless it is
// ARCHIVED: archiving (taking an edition off the site) keeps the row and its media association as
// history but ends the reservation, and the gateway no longer serves an archived experience, so a
// retired edition's file can back a new active edition. Any non-archived experience of another
// edition still reserves it.
const ACTIVE_MEDIA_CLAIM_SQL = "SELECT id FROM experiences WHERE edition_id<>$1 AND media_config::text LIKE $2 AND status<>'ARCHIVED' LIMIT 1";
const PROTECTED_MEDIA_IN_USE_MESSAGE = "This file is already used by an active experience of a different edition. Identical file bytes always resolve to the same stored file, so upload a different file for this edition, or retire the other edition first.";

function requiresFactoryRelease(release) {
  return String(release?.release_metadata?.publicationArchitecture || "").trim().toLowerCase() === "release-per-contract";
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
  if (config.primary !== undefined && typeof config.primary !== "boolean") throw new ApiError(400, "INVALID_PRIMARY_EXPERIENCE", "mediaConfig.primary must be true or false.");
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
// The explicit primary designation stored in media_config (true, false, or undefined for rows
// saved before designations existed).
function primaryOf(mediaConfig) {
  let config = mediaConfig;
  if (typeof config === "string") { try { config = JSON.parse(config); } catch { return undefined; } }
  return typeof config?.primary === "boolean" ? config.primary : undefined;
}
// Asset ids a stored experience unlocks (media_config may arrive as JSON text or an object).
function protectedAssetIds(mediaConfig) {
  let config = mediaConfig;
  if (typeof config === "string") { try { config = JSON.parse(config); } catch { return []; } }
  const entries = Array.isArray(config?.protectedMedia) ? config.protectedMedia : [];
  return entries.map((entry) => String(entry?.assetId || "").trim()).filter(Boolean);
}
// An experience's delivery type is the type a collector asks the gateway for, and the gateway
// picks the protectedMedia entry of exactly that type, so the two must agree or nothing plays.
function assertExperienceMatchesMedia(experienceType, protectedMedia) {
  const type = String(experienceType || "").trim().toUpperCase();
  if (!type || !Array.isArray(protectedMedia)) return;
  const wrong = protectedMedia.find((entry) => String(entry?.mediaType || "").toUpperCase() !== type);
  if (wrong) throw new ApiError(400, "EXPERIENCE_MEDIA_TYPE_MISMATCH", `A ${type} experience needs ${type} media, but this file is ${String(wrong.mediaType || "").toUpperCase() || "untyped"}.`);
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
  constructor({ db, repository, authenticator, metadataStorage = null, mediaUploader = null, directMediaUploads = null, artworkUploader = null, portfolioStore = null, provenanceRecords = null, publicationChain = null, metadataFetcher = null, logger = console } = {}) {
    if (!db?.query || !repository || typeof authenticator !== "function") throw new TypeError("ArtistStudioService requires persistence and wallet authentication.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.metadataStorage = metadataStorage;
    this.mediaUploader = mediaUploader;
    this.directMediaUploads = directMediaUploads;
    this.artworkUploader = artworkUploader;
    this.portfolioStore = portfolioStore;
    this.provenanceRecords = provenanceRecords;
    this.publicationChain = publicationChain;
    this.metadataFetcher = metadataFetcher;
    this.logger = logger;
  }

  async identity(request) { return requireWalletAuth(this.authenticator, request); }
  async listCatalog({ request } = {}) {
    const identity = await this.identity(request);
    const owner = identity.wallet;
    const [artists, releases, editions, experiences, albumSingles, releaseBindings, releaseSales, secondaryRoyalties] = await Promise.all([
      this.db.query("SELECT a.id, a.slug, a.display_name, a.status, ao.owner_wallet, p.bio, p.website_url, p.social_links, p.profile_metadata FROM artists a JOIN artist_owners ao ON ao.artist_id=a.id LEFT JOIN artist_profiles p ON p.artist_id=a.id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY a.display_name LIMIT 100", [owner]),
      this.db.query("SELECT r.id, r.artist_id, r.slug, r.title, r.description, r.status, r.release_metadata, r.updated_at FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY r.created_at DESC LIMIT 500", [owner]),
      // token_id only for PUBLISHED editions: a draft's token does not exist on-chain yet.
      this.db.query("SELECT e.id, e.release_id, e.title, e.description, e.supply, e.status, e.application_metadata, c.address AS contract_address, c.address AS release_contract_address, factory.address AS factory_address, sale.address AS primary_sale_address, c.chain_id, CASE WHEN e.status='PUBLISHED' THEN (SELECT t.token_id::text FROM tokens t WHERE t.edition_id=e.id ORDER BY t.created_at DESC LIMIT 1) END AS token_id, EXISTS (SELECT 1 FROM primary_purchases p JOIN tokens pt ON pt.edition_id = e.id AND pt.token_id = p.token_id JOIN contracts pc ON pc.id = pt.contract_id WHERE pc.chain_id = p.chain_id AND lower(pc.address) = lower(p.token_contract_address) AND p.status NOT IN ('FAILED', 'REORGED')) AS buyable_sale FROM editions e JOIN releases r ON r.id=e.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id LEFT JOIN contracts c ON c.id=e.contract_id LEFT JOIN release_contracts rc ON rc.release_id=e.release_id AND rc.release_contract_id=e.contract_id AND rc.status IN ('DEPLOYED','VERIFIED') LEFT JOIN contracts factory ON factory.id=rc.factory_contract_id LEFT JOIN contracts sale ON sale.id=rc.primary_sale_contract_id WHERE lower(ao.owner_wallet)=lower($1) AND NOT (e.status='ARCHIVED' AND e.application_metadata->>'removedDraft'='true') ORDER BY e.created_at DESC LIMIT 500", [owner]),
      this.db.query("SELECT x.id, x.artist_id, x.release_id, x.edition_id, x.title, x.description, x.experience_type, x.requirements, x.media_config, x.status FROM experiences x JOIN artist_owners ao ON ao.artist_id=x.artist_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY x.created_at DESC LIMIT 500", [owner]),
      this.db.query("SELECT s.album_release_id, s.single_release_id, s.single_edition_id, s.track_position FROM release_album_singles s JOIN releases r ON r.id=s.album_release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE lower(ao.owner_wallet)=lower($1) ORDER BY s.album_release_id, s.track_position LIMIT 1000", [owner]),
      // Every factory binding (any factory version) so Studio can read each sale contract's balances.
      this.db.query("SELECT rc.release_id, rc.chain_id, rc.artist_wallet, release_contract.address AS release_contract_address, factory_contract.address AS factory_address, sale_contract.address AS primary_sale_address, COALESCE((SELECT SUM(pp.artist_cut_wei) FROM primary_purchases pp WHERE pp.chain_id=rc.chain_id AND lower(pp.sale_contract_address)=lower(sale_contract.address) AND pp.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED')), 0)::text AS artist_earned_wei, COALESCE((SELECT SUM(w.amount_wei) FROM primary_sale_withdrawals w WHERE w.chain_id=rc.chain_id AND lower(w.sale_contract_address)=lower(sale_contract.address) AND lower(w.account_wallet)=lower(rc.artist_wallet) AND w.status <> 'REORGED'), 0)::text AS artist_withdrawn_wei FROM release_contracts rc JOIN releases r ON r.id=rc.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id JOIN contracts release_contract ON release_contract.id=rc.release_contract_id LEFT JOIN contracts factory_contract ON factory_contract.id=rc.factory_contract_id JOIN contracts sale_contract ON sale_contract.id=rc.primary_sale_contract_id WHERE lower(ao.owner_wallet)=lower($1) AND rc.status IN ('DEPLOYED','VERIFIED') ORDER BY rc.created_at DESC LIMIT 500", [owner]),
      // Every sale that has sold this owner's release contracts, one row per (release, sale): a settled sale attached
      // to an existing release is a second row for the same release. Artist fields only. Earned is the indexer's sum of
      // artist cuts (an allocation); withdrawn is what the artist wallet has actually withdrawn per indexed Withdrawn events.
      this.db.query("WITH sold AS (SELECT rc.chain_id, rc.artist_wallet, lower(release_contract.address) AS release_contract_address, lower(pp.sale_contract_address) AS sale_contract_address, SUM(pp.artist_cut_wei) AS earned, COUNT(*)::int AS sales FROM release_contracts rc JOIN releases r ON r.id=rc.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id JOIN contracts release_contract ON release_contract.id=rc.release_contract_id JOIN primary_purchases pp ON pp.chain_id=rc.chain_id AND lower(pp.token_contract_address)=lower(release_contract.address) AND pp.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED') WHERE lower(ao.owner_wallet)=lower($1) AND rc.status IN ('DEPLOYED','VERIFIED') GROUP BY rc.chain_id, rc.artist_wallet, lower(release_contract.address), lower(pp.sale_contract_address)) SELECT s.chain_id, s.release_contract_address, s.sale_contract_address, s.earned::text AS artist_earned_wei, COALESCE((SELECT SUM(w.amount_wei) FROM primary_sale_withdrawals w WHERE w.chain_id=s.chain_id AND lower(w.sale_contract_address)=s.sale_contract_address AND lower(w.account_wallet)=lower(s.artist_wallet) AND w.status <> 'REORGED'), 0)::text AS artist_withdrawn_wei, s.sales FROM sold s ORDER BY s.release_contract_address, s.sale_contract_address LIMIT 500", [owner]),
      // Secondary-sale royalties settled by the marketplace for this owner's release contracts, per token. The marketplace
      // pays them straight to the edition's payout wallet at settlement; there is nothing to claim. Only settled rows count.
      this.db.query("SELECT p.chain_id, lower(p.token_contract_address) AS token_contract_address, p.token_id::text AS token_id, SUM(p.royalty_wei)::text AS royalty_wei, COUNT(*)::int AS sales FROM purchases p JOIN contracts c ON c.chain_id=p.chain_id AND lower(c.address)=lower(p.token_contract_address) JOIN release_contracts rc ON rc.release_contract_id=c.id AND rc.status IN ('DEPLOYED','VERIFIED') JOIN releases r ON r.id=rc.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE lower(ao.owner_wallet)=lower($1) AND p.status IN ('CONFIRMED', 'FINALIZED', 'RECONCILED') GROUP BY p.chain_id, lower(p.token_contract_address), p.token_id ORDER BY lower(p.token_contract_address), p.token_id LIMIT 500", [owner]),
    ]);
    // artist_owners already scopes the rows to this wallet. The admin/deployer
    // wallet still drops Voidcaller artist profiles so those releases stay with
    // the platform artist wallet.
    return studioCatalogForConnectedWallet({ artists: artists.rows, releases: releases.rows, editions: editions.rows, experiences: experiences.rows, albumSingles: albumSingles.rows, releaseBindings: releaseBindings.rows, releaseSales: releaseSales.rows, secondaryRoyalties: secondaryRoyalties.rows }, owner);
  }

  /**
   * D3: every token ID stored for one release's editions, and its factory bindings, for Studio's
   * check immediately before album activation. Scoped to the release after the same ownership check
   * as updateRelease, and deliberately uncapped: the owner-wide catalog is limited to the newest 500
   * editions, so an older edition could be missing from it. The token query is the server guard's.
   */
  async releaseLifecycleEditions({ request, releaseId }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.id FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    const [tokens, bindings] = await Promise.all([
      this.db.query("SELECT DISTINCT t.token_id::text AS token_id FROM tokens t JOIN editions e ON e.id=t.edition_id WHERE e.release_id=$1", [release.id]),
      this.db.query("SELECT rc.release_id, rc.chain_id, release_contract.address AS release_contract_address, factory_contract.address AS factory_address FROM release_contracts rc JOIN contracts release_contract ON release_contract.id=rc.release_contract_id LEFT JOIN contracts factory_contract ON factory_contract.id=rc.factory_contract_id WHERE rc.release_id=$1 AND rc.status IN ('DEPLOYED','VERIFIED')", [release.id]),
    ]);
    return { releaseId: release.id, complete: true, tokenIds: tokens.rows.map((row) => row.token_id), releaseBindings: bindings.rows };
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

  // A verified binding is the source of truth for all new release-contract flows.
  // Legacy releases have no row and continue to use the certified shared contract.
  async releaseContractBinding(releaseId) {
    const { rows } = await this.db.query("SELECT rc.*, release_contract.address AS release_contract_address, factory_contract.address AS factory_address, sale_contract.address AS primary_sale_address, anchor_contract.address AS provenance_anchor_address FROM release_contracts rc JOIN contracts release_contract ON release_contract.id=rc.release_contract_id LEFT JOIN contracts factory_contract ON factory_contract.id=rc.factory_contract_id LEFT JOIN contracts sale_contract ON sale_contract.id=rc.primary_sale_contract_id LEFT JOIN contracts anchor_contract ON anchor_contract.id=rc.provenance_anchor_contract_id WHERE rc.release_id=$1 AND rc.status IN ('DEPLOYED','VERIFIED') ORDER BY rc.implementation_version DESC, rc.created_at DESC LIMIT 1", [releaseId]);
    const binding = rows[0];
    // Treat any incomplete row as absent. This protects legacy records and makes
    // the release-contract path opt-in only after the full factory tuple exists.
    if (!binding?.release_contract_id || !ethers.isAddress(binding.release_contract_address || "") || !Number.isSafeInteger(Number(binding.chain_id)) || Number(binding.chain_id) <= 0 || !/^0x[0-9a-f]{64}$/i.test(String(binding.release_key || ""))) return null;
    return binding;
  }

  /**
   * Binds an artist-owned Studio release to an already-indexed factory deployment.
   * Deployment remains an external/Safe operation; the Studio accepts no arbitrary
   * addresses and only persists the immutable tuple emitted by the configured factory.
   */
  async bindReleaseContract({ request, releaseId, input = {} }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id AND ao.role='OWNER' WHERE r.id=$1 AND lower(ao.owner_wallet)=lower($2) LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_OWNER_REQUIRED", "Only the canonical artist OWNER may bind a release contract.");
    if (release.status === "PUBLISHED") throw new ApiError(409, "RELEASE_CONTRACT_LOCKED", "A published release cannot be rebound to a different contract.");
    // A retired release is never bound to a contract, even one its own provisioning request created on-chain.
    if (release.status === "ARCHIVED") throw new ApiError(409, "RELEASE_ARCHIVED", "This release was taken off the site, so no contract can be bound to it. Create a new release instead.");
    const selectedChainId = chainId(input.chainId, "chainId");
    const selectedReleaseAddress = contractAddress(input.releaseContractAddress, "releaseContractAddress");
    const selectedReleaseKey = releaseKey(input.releaseKey);
    if (selectedChainId !== Number(provisioningFactoryConfig().chainId) || String(release.release_metadata?.releaseKey || "").toLowerCase() !== selectedReleaseKey) throw new ApiError(409, "RELEASE_PROVISIONING_MISMATCH", "The release key or chain does not match this application's prepared provisioning request.");
    const provisioning = await this.repository.getReleaseProvisioningRequest({ releaseId: release.id, chainId: selectedChainId });
    const factoryConfig = provisioningFactoryFor(provisioning);
    if (!provisioning || String(provisioning.release_key).toLowerCase() !== selectedReleaseKey || String(provisioning.artist_wallet).toLowerCase() !== identity.wallet.toLowerCase()) throw new ApiError(409, "PROVISIONING_REQUEST_REQUIRED", "This release must have a durable artist provisioning request before it can be bound.");
    const indexed = await this.db.query("SELECT * FROM factory_releases WHERE chain_id=$1 AND lower(factory_address)=lower($2) AND lower(release_contract_address)=lower($3) AND lower(release_key)=lower($4) AND lower(artist_wallet)=lower($5) LIMIT 1", [selectedChainId, factoryConfig.factoryAddress, selectedReleaseAddress, selectedReleaseKey, identity.wallet]);
    const deployment = indexed.rows[0];
    if (!deployment) throw new ApiError(409, "RELEASE_DEPLOYMENT_NOT_INDEXED", "This release contract is not a confirmed factory deployment for the authenticated artist.");
    const releaseVersion = expectedReleaseVersion(factoryConfig);
    if (Number(deployment.implementation_version) !== releaseVersion || (provisioning.transaction_hash && String(provisioning.transaction_hash).toLowerCase() !== String(deployment.transaction_hash).toLowerCase())) throw new ApiError(409, "RELEASE_DEPLOYMENT_EVENT_MISMATCH", "The indexed factory event does not match this release's factory version or stored transaction.");
    const inlineAnchor = anchorsProvenanceAtCreation(releaseVersion);
    // A Factory V3 clone is its own provenance anchor; a V2 anchor must be a distinct contract.
    if (inlineAnchor !== (String(deployment.provenance_anchor_address).toLowerCase() === String(deployment.release_contract_address).toLowerCase())) throw new ApiError(409, "RELEASE_DEPLOYMENT_EVENT_MISMATCH", "The indexed provenance anchor does not match this factory version.");
    const saved = await this.repository.inTransaction(async (repository) => {
      const releaseContract = await repository.saveContract({ chainId: selectedChainId, chainKey: String(selectedChainId), address: deployment.release_contract_address, contractType: "ERC1155", name: releaseContractNames(releaseVersion).release, deploymentTxHash: deployment.transaction_hash, deploymentBlockNumber: deployment.deployment_block_number, metadata: { source: "RELEASE_FACTORY", factory: deployment.factory_address, releaseKey: deployment.release_key, implementation: deployment.implementation_address, implementationVersion: deployment.implementation_version, ...(inlineAnchor ? { provenanceAtCreation: true } : {}) } });
      const factory = await repository.saveContract({ chainId: selectedChainId, chainKey: String(selectedChainId), address: deployment.factory_address, contractType: "OTHER", name: releaseContractNames(releaseVersion).factory, deploymentTxHash: null, deploymentBlockNumber: null, metadata: { role: "RELEASE_FACTORY", version: releaseVersion } });
      const primarySale = await repository.saveContract({ chainId: selectedChainId, chainKey: String(selectedChainId), address: deployment.primary_sale_address, contractType: "OTHER", name: "VoidPrimarySale", deploymentTxHash: deployment.transaction_hash, deploymentBlockNumber: deployment.deployment_block_number, metadata: { role: "PRIMARY_SALE", releaseContract: deployment.release_contract_address } });
      const anchor = inlineAnchor ? releaseContract : await repository.saveContract({ chainId: selectedChainId, chainKey: String(selectedChainId), address: deployment.provenance_anchor_address, contractType: "OTHER", name: "VoidProvenanceAnchor", deploymentTxHash: deployment.transaction_hash, deploymentBlockNumber: deployment.deployment_block_number, metadata: { role: "PROVENANCE_ANCHOR", releaseContract: deployment.release_contract_address } });
      return repository.saveReleaseContract({ releaseId: release.id, chainId: selectedChainId, releaseContractId: releaseContract.id, factoryContractId: factory.id, primarySaleContractId: primarySale.id, provenanceAnchorContractId: anchor.id, releaseKey: deployment.release_key, artistWallet: deployment.artist_wallet, implementationAddress: deployment.implementation_address, implementationVersion: deployment.implementation_version, deploymentTxHash: deployment.transaction_hash, deploymentBlockNumber: deployment.deployment_block_number, creationLogIndex: input.creationLogIndex ?? null, status: "DEPLOYED", metadata: { factoryIndex: deployment.factory_index } });
    });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_CONTRACT_BOUND", subjectType: "release", subjectId: release.id, payload: { chainId: selectedChainId, releaseContractAddress: deployment.release_contract_address, primarySaleAddress: deployment.primary_sale_address, releaseKey: deployment.release_key } });
    return { ...saved, releaseContractAddress: deployment.release_contract_address, primarySaleAddress: deployment.primary_sale_address, provenanceAnchorAddress: deployment.provenance_anchor_address };
  }

  // Generates (once) and then reuses the release's collection-level contract URI. The URI is
  // produced through the configured metadata pipeline and persisted to release_metadata.contractURI,
  // so every repeated provisioning preparation reuses the exact same value and the authorization
  // digest stays stable (a retry can never bind different metadata to the same pending request). It
  // is never an empty string, placeholder, or fabricated CID: if metadata storage is unconfigured or
  // the upload fails, provisioning fails closed here, before any transaction is authorized.
  async ensureReleaseContractURI(release) {
    const existing = optionalText(release.release_metadata?.contractURI, "release.contractURI", { max: 2048 });
    if (existing) return existing;
    if (typeof this.metadataStorage?.write !== "function") {
      throw new ApiError(503, "METADATA_STORAGE_UNAVAILABLE", "Collection metadata storage is not configured. A release cannot be provisioned without a contract URI.");
    }
    const image = optionalText(release.release_metadata?.artwork, "release.artwork", { max: 2048 }) || null;
    const metadata = collectionMetadata({ release, image });
    const { uri } = await this.metadataStorage.write({ metadata, name: `collection-${release.id}` });
    const contractURI = optionalText(uri, "contractURI", { max: 2048 });
    if (!contractURI || !/^ipfs:\/\/.+/.test(contractURI)) {
      throw new ApiError(503, "METADATA_URI_INVALID", "Collection metadata storage did not return a usable contract URI.");
    }
    // Persist only while the release is still a draft and no URI is set yet, so concurrent
    // preparations converge on one stored URI instead of binding different metadata.
    const persisted = await this.db.query(
      "UPDATE releases SET release_metadata=jsonb_set(COALESCE(release_metadata,'{}'::jsonb),'{contractURI}',to_jsonb($2::text),true), updated_at=now() WHERE id=$1 AND status='DRAFT' AND COALESCE(release_metadata->>'contractURI','')='' RETURNING id",
      [release.id, contractURI],
    );
    if (persisted.rows[0]) return contractURI;
    const current = await this.db.query("SELECT release_metadata->>'contractURI' AS uri FROM releases WHERE id=$1 LIMIT 1", [release.id]);
    const stored = optionalText(current.rows[0]?.uri, "release.contractURI", { max: 2048 });
    if (!stored) throw new ApiError(409, "RELEASE_PROVISIONING_LOCKED", "The release contract URI could not be persisted before authorization.");
    return stored;
  }

  async prepareReleaseProvisioning({ request, releaseId }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id AND ao.role='OWNER' WHERE r.id=$1 AND lower(ao.owner_wallet)=lower($2) LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_OWNER_REQUIRED", "Only the canonical artist OWNER may provision a blockchain release. Verified managers cannot create releases on-chain.");
    if (release.status !== "DRAFT") throw new ApiError(409, "RELEASE_PROVISIONING_LOCKED", "Only a draft release can be provisioned.");
    // Publication later requires a verified artist. Check it before the artist pays gas for createRelease,
    // so an unverified wallet never ends up with an on-chain release it cannot publish.
    await assertArtistMayPublish(this.db, { artistId: release.artist_id, wallet: identity.wallet });
    const existingRequest = await this.repository.getReleaseProvisioningRequest({ releaseId: release.id, chainId: provisioningFactoryConfig().chainId });
    const factory = provisioningFactoryFor(existingRequest);
    const applicationReleaseId = deriveStudioApplicationReleaseId(release.id);
    if (String(release.release_metadata?.applicationReleaseId || "").toLowerCase() !== applicationReleaseId) throw new ApiError(409, "APPLICATION_RELEASE_ID_MISMATCH", "The stored application release digest does not match this release.");
    const expectedKey = deriveStudioReleaseKey({ releaseId: release.id, applicationReleaseId, artistWallet: identity.wallet, factoryAddress: factory.factoryAddress, chainId: factory.chainId });
    const persistedKey = String(release.release_metadata?.releaseKey || "").toLowerCase();
    if (existingRequest && persistedKey !== expectedKey) throw new ApiError(409, "RELEASE_KEY_MISMATCH", "The persisted release key no longer matches its durable provisioning request.");
    if (!existingRequest && persistedKey !== expectedKey) {
      const updated = await this.db.query("UPDATE releases SET release_metadata=jsonb_set(COALESCE(release_metadata,'{}'::jsonb),'{releaseKey}',to_jsonb($2::text),true), updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING id", [release.id, expectedKey]);
      if (!updated.rows[0]) throw new ApiError(409, "RELEASE_PROVISIONING_LOCKED", "The expected V2 release key could not be persisted before authorization.");
    }
    const name = requiredText(release.title, "release.title", { max: 256 });
    const symbol = derivedContractSymbol(release);
    const contractURI = await this.ensureReleaseContractURI(release);
    const expectedParameters = { chainId: Number(factory.chainId), factoryAddress: factory.factoryAddress.toLowerCase(), applicationReleaseId, applicationReleaseRecordId: release.id, releaseKey: expectedKey, artistWallet: identity.wallet.toLowerCase(), name, symbol, contractURI };
    const authorizationDigest = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(expectedParameters)));
    const requestInput = { releaseId: release.id, chainId: factory.chainId, releaseKey: expectedKey, artistWallet: identity.wallet, factoryAddress: factory.factoryAddress, authorizationDigest, expectedParameters };
    let provisioning;
    if (existingRequest?.authorization_digest && String(existingRequest.authorization_digest).toLowerCase() !== authorizationDigest) {
      // The parameters changed (for example the on-chain tag). Only a request that was never submitted and
      // whose key is not deployed may be re-prepared; anything else stays fail-closed.
      const locked = () => new ApiError(409, "RELEASE_PROVISIONING_LOCKED", "This release deployment was already submitted, so its parameters can no longer change.");
      if (existingRequest.state !== "PENDING" || existingRequest.transaction_hash) throw locked();
      const deployed = await this.db.query("SELECT 1 FROM factory_releases WHERE chain_id=$1 AND lower(release_key)=lower($2) LIMIT 1", [factory.chainId, expectedKey]);
      if (deployed.rows.length) throw locked();
      provisioning = await this.repository.refreshReleaseProvisioningRequest(requestInput);
      await this.audit({ identity, request, eventType: "STUDIO_RELEASE_PROVISIONING_REPREPARED", subjectType: "release", subjectId: release.id, payload: { requestId: provisioning.request_id, previousDigest: existingRequest.authorization_digest, authorizationDigest, previousSymbol: existingRequest.expected_parameters?.symbol ?? null, symbol } });
    } else {
      provisioning = await this.repository.createReleaseProvisioningRequest(requestInput);
    }
    return { requestId: provisioning.request_id, state: provisioning.state, releaseId: release.id, applicationReleaseId, releaseKey: expectedKey, chainId: Number(factory.chainId), factoryAddress: factory.factoryAddress, artistWallet: identity.wallet, name, symbol, contractURI, authorizationDigest, authorization: "DIRECT_ARTIST_TRANSACTION", gasPayer: identity.wallet };
  }

  async recordReleaseProvisioningSubmission({ request, releaseId, input = {} }) {
    const identity = await this.identity(request);
    const id = requiredText(releaseId, "releaseId");
    const { rows: owned } = await this.db.query("SELECT r.id, r.status FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id AND ao.role='OWNER' WHERE r.id=$1 AND lower(ao.owner_wallet)=lower($2) LIMIT 1", [id, identity.wallet]);
    if (!owned[0]) throw new ApiError(403, "ARTIST_OWNER_REQUIRED", "Only the canonical artist OWNER may submit this release deployment.");
    if (owned[0].status === "ARCHIVED") throw new ApiError(409, "RELEASE_ARCHIVED", "This release was taken off the site. Create a new release instead.");
    const provisioning = await this.repository.getReleaseProvisioningRequest({ releaseId: id, chainId: provisioningFactoryConfig().chainId });
    const factory = provisioningFactoryFor(provisioning);
    if (!provisioning || String(provisioning.artist_wallet).toLowerCase() !== identity.wallet.toLowerCase() || String(provisioning.factory_address).toLowerCase() !== factory.factoryAddress.toLowerCase()) throw new ApiError(409, "PROVISIONING_REQUEST_REQUIRED", "Prepare this exact release deployment in Studio before submitting its transaction.");
    const transactionHash = requiredText(input.transactionHash, "transactionHash", { max: 66 }).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new ApiError(400, "TRANSACTION_INVALID", "The release creation transaction hash is invalid.");
    const provider = this.publicationChain || new ethers.JsonRpcProvider(factory.rpcUrl, Number(factory.chainId), { staticNetwork: true });
    let tx = null;
    try { tx = await provider.getTransaction(transactionHash); } catch { /* RPC/indexer propagation can lag wallet submission. */ }
    if (tx) {
      const expected = provisioning.expected_parameters;
      const iface = new ethers.Interface(RELEASE_FACTORY_V2_ABI);
      const expectedData = iface.encodeFunctionData("createRelease", [expected.applicationReleaseId, expected.releaseKey, expected.name, expected.symbol, expected.contractURI]);
      if (Number(tx.chainId) !== Number(factory.chainId) || String(tx.from).toLowerCase() !== identity.wallet.toLowerCase() || String(tx.to).toLowerCase() !== factory.factoryAddress.toLowerCase() || String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
        throw new ApiError(409, "PROVISIONING_TRANSACTION_MISMATCH", "The submitted transaction does not match this artist, Factory, chain, release key, and exact initialization parameters.");
      }
    }
    const updated = await this.repository.updateReleaseProvisioningRequest({ releaseId: id, chainId: factory.chainId, transactionHash, state: tx ? "SUBMITTED" : "RECONCILING" });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_PROVISIONING_SUBMITTED", subjectType: "release", subjectId: id, payload: { chainId: Number(factory.chainId), releaseKey: provisioning.release_key, transactionHash } });
    return { requestId: updated.request_id, state: updated.state, transactionHash, chainId: Number(factory.chainId), factoryAddress: factory.factoryAddress };
  }

  async releaseProvisioningStatus({ request, releaseId }) {
    const identity = await this.identity(request);
    const id = requiredText(releaseId, "releaseId");
    const { rows: owned } = await this.db.query("SELECT r.id, r.status FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id AND ao.role='OWNER' WHERE r.id=$1 AND lower(ao.owner_wallet)=lower($2) LIMIT 1", [id, identity.wallet]);
    if (!owned[0]) throw new ApiError(403, "ARTIST_OWNER_REQUIRED", "Only the canonical artist OWNER may view this provisioning request.");
    if (owned[0].status === "ARCHIVED") throw new ApiError(409, "RELEASE_ARCHIVED", "This release was taken off the site. Its provisioning request is closed; create a new release instead.");
    const provisioning = await this.repository.getReleaseProvisioningRequest({ releaseId: id, chainId: provisioningFactoryConfig().chainId });
    if (!provisioning) return { state: "NOT_STARTED", releaseId: id };
    const factory = provisioningFactoryFor(provisioning);
    const { rows: indexed } = await this.db.query("SELECT * FROM factory_releases WHERE chain_id=$1 AND lower(factory_address)=lower($2) AND lower(release_key)=lower($3) AND lower(artist_wallet)=lower($4) LIMIT 1", [factory.chainId, factory.factoryAddress, provisioning.release_key, identity.wallet]);
    const deployment = indexed[0];
    if (!deployment) return { requestId: provisioning.request_id, state: provisioning.state, releaseId: id, releaseKey: provisioning.release_key, transactionHash: provisioning.transaction_hash || null };
    if (Number(deployment.implementation_version) !== expectedReleaseVersion(factory) || (provisioning.transaction_hash && String(deployment.transaction_hash).toLowerCase() !== String(provisioning.transaction_hash).toLowerCase())) {
      throw new ApiError(409, "RELEASE_DEPLOYMENT_EVENT_MISMATCH", "The indexed Factory event does not match the expected provisioning request.");
    }
    const provider = this.publicationChain || new ethers.JsonRpcProvider(factory.rpcUrl, Number(factory.chainId), { staticNetwork: true });
    const clone = new ethers.Contract(deployment.release_contract_address, ["function owner() view returns(address)", "function releaseKey() view returns(bytes32)", "function name() view returns(string)", "function symbol() view returns(string)", "function contractURI() view returns(string)"], provider);
    const [owner, key, name, symbol, contractURI] = await Promise.all([clone.owner(), clone.releaseKey(), clone.name(), clone.symbol(), clone.contractURI()]);
    const expected = provisioning.expected_parameters;
    if (String(owner).toLowerCase() !== identity.wallet.toLowerCase() || String(key).toLowerCase() !== String(expected.releaseKey).toLowerCase() || name !== expected.name || symbol !== expected.symbol || contractURI !== expected.contractURI) {
      throw new ApiError(409, "RELEASE_INITIALIZATION_MISMATCH", "The deployed clone's owner, key, name, symbol, or contract URI does not match the authorized application release.");
    }
    const txHash = String(deployment.transaction_hash).toLowerCase();
    if (!provisioning.transaction_hash) await this.repository.updateReleaseProvisioningRequest({ releaseId: id, chainId: factory.chainId, transactionHash: txHash, state: "RECONCILING" });
    const binding = await this.bindReleaseContract({ request, releaseId: id, input: { chainId: Number(factory.chainId), releaseContractAddress: deployment.release_contract_address, releaseKey: provisioning.release_key } });
    const confirmed = await this.repository.confirmReleaseProvisioningRequest({ releaseId: id, chainId: factory.chainId, transactionHash: txHash, releaseContractAddress: deployment.release_contract_address, primarySaleAddress: deployment.primary_sale_address, provenanceAnchorAddress: deployment.provenance_anchor_address, deploymentBlockNumber: deployment.deployment_block_number, creationLogIndex: null });
    return { requestId: confirmed.request_id, state: "CONFIRMED", transactionHash: txHash, symbol, name, ...binding };
  }

  async bindProtectedAssets(artistId, protectedMedia) {
    const { rows } = await this.db.query("SELECT id, artist_id, storage_key, media_type, visibility FROM media_assets WHERE artist_id=$1", [artistId]);
    return protectedMedia.map((asset) => {
      const assetId = String(asset.assetId || "").trim();
      const storageKey = String(asset.storageKey || "").trim();
      const match = rows.find((row) => (assetId && row.id === assetId) || (!assetId && storageKey && row.storage_key === storageKey));
      if (!match || String(match.artist_id) !== String(artistId)) throw new ApiError(400, "PROTECTED_MEDIA_NOT_OWNED", "Protected media must reference a file uploaded for this artist.");
      if (assetId && storageKey && match.storage_key !== storageKey) throw new ApiError(400, "PROTECTED_MEDIA_NOT_OWNED", "Protected media storage key does not match the artist's uploaded asset.");
      // Only a privately stored file can be token-gated; a file registered any other way is never attached.
      if (match.visibility && String(match.visibility).toUpperCase() !== "PROTECTED") throw new ApiError(400, "PROTECTED_MEDIA_NOT_PROTECTED", "Only a file stored privately can be attached to a protected experience.");
      // The stored asset's own type is authoritative: a client-supplied label may not re-type a file.
      const storedType = String(match.media_type || "").trim().toUpperCase();
      const declaredType = String(asset.mediaType || "").trim().toUpperCase();
      if (storedType && declaredType && storedType !== declaredType) throw new ApiError(400, "PROTECTED_MEDIA_TYPE_MISMATCH", `This file was uploaded as ${storedType}, not ${declaredType}.`);
      const mediaType = storedType || declaredType;
      if (!mediaType) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Every protected media object requires a media type.");
      return { assetId: match.id, mediaType, ...(asset.contentType ? { contentType: String(asset.contentType) } : {}) };
    });
  }

  /**
   * Runs an experience write so that two invariants hold under concurrent requests:
   *   1. a registered file belongs to one edition, and
   *   2. an edition has at most one primary experience.
   * Everything happens in one transaction on one connection. Lock order is fixed for every writer:
   * the edition lock first, then the file locks (sorted), then the row write. Publication
   * (`publishExperience`) takes file locks then its row and never the edition lock, so no path can wait
   * on a lock held by a path that is waiting on it. The edition's experiences are read AFTER the
   * locks, so `write` always sees committed state; a competing save waits for the lock and then sees
   * the earlier commit, so it is refused (PROTECTED_MEDIA_IN_USE / PRIMARY_EXPERIENCE_CONFLICT) rather
   * than overwriting it. Locks are transaction-scoped: commit or rollback releases them. Saves for other
   * editions do not wait on this edition's lock.
   */
  async withEditionExperiences({ editionId, assetIds, write }) {
    const ids = [...new Set(assetIds.filter(Boolean))].sort();
    return this.repository.inTransaction(async (repository) => {
      // The transaction's own connection: the locks, the checks and the save share it.
      const tx = repository.db || this.db;
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`void:edition-experiences:${editionId}`]);
      for (const assetId of ids) await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`void:media-asset:${assetId}`]);
      for (const assetId of ids) {
        const { rows } = await tx.query(ACTIVE_MEDIA_CLAIM_SQL, [editionId, `%"${assetId}"%`]);
        if (rows.length) throw new ApiError(409, "PROTECTED_MEDIA_IN_USE", PROTECTED_MEDIA_IN_USE_MESSAGE);
      }
      const siblings = (await tx.query("SELECT id, artist_id, edition_id, status, version, media_config FROM experiences WHERE edition_id=$1 ORDER BY id", [editionId])).rows;
      return write({ repository, siblings });
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

  // A protected experience is attached to one edition, so its entitlement may
  // not be redirected to a different release merely because the same artist
  // also owns that other token. The tuple remains (chain, contract, tokenId).
  async assertEditionRequirements(editionId, requirements) {
    const { rows } = await this.db.query("SELECT t.token_id::text AS token_id, lower(c.address) AS contract_address, c.chain_id FROM tokens t JOIN contracts c ON c.id=t.contract_id WHERE t.edition_id=$1", [editionId]);
    for (const requirement of requirements) {
      for (const tokenId of requirement.tokenIds) {
        const belongsToEdition = rows.some((row) => row.contract_address === requirement.contract && String(row.token_id) === String(tokenId) && (requirement.chainId === undefined || Number(row.chain_id) === Number(requirement.chainId)));
        if (!belongsToEdition) throw new ApiError(400, "REQUIREMENT_TOKEN_NOT_IN_EDITION", "Protected media must require the exact token from its own edition.");
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
    // Published editions keep immutable metadata; a published release may still add new draft editions (tracks).
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.metadata, t.metadata_version FROM editions e LEFT JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 AND e.status IN ('DRAFT','REVIEW') ORDER BY e.created_at DESC LIMIT 1", [release.id]);
    const edition = editionResult.rows[0];
    if (!edition && release.status === "PUBLISHED") throw new ApiError(409, "RELEASE_ALREADY_PUBLISHED", "This release has already been published and its metadata is immutable.");
    if (!edition) throw new ApiError(400, "EDITION_REQUIRED", "Create an edition before publishing the release.");
    await this.assertSingleOpenForEdition(release, edition.id);
    // An over-limit EP draft stays editable but cannot be submitted until it is back within the cap.
    if (storedReleaseType(release) === "EP" && await this.releaseTrackCount(release.id) > MAX_EP_TRACKS) throw new ApiError(409, "EP_TRACK_LIMIT_EXCEEDED", EP_TRACK_LIMIT_MESSAGE);
    const experiences = await this.db.query("SELECT id, title, description, experience_type, media_config, version FROM experiences WHERE edition_id=$1 ORDER BY created_at ASC LIMIT 100", [edition.id]);
    const mediaAssets = await this.db.query("SELECT id, media_type, metadata FROM media_assets WHERE artist_id=$1", [release.artist_id]);
    const previewAudio = await this.vettedPreviewAudio({ artistId: release.artist_id, uri: input.previewAudio ?? edition.application_metadata?.previewAudio });
    const generated = canonicalMetadata({ release, edition, artist: { name: release.display_name }, artwork: input.artwork, previewAudio, includes: input.includes || edition.application_metadata?.includes, experiences: experiences.rows, releaseType: releaseType(release.release_metadata?.releaseType), tier: edition.tier });
    const provenance = provenanceForPublication({ release, edition, wallet: identity.wallet, metadataDigest: generated.digest, experiences: experiences.rows, mediaAssets: mediaAssets.rows, input, previous: edition.metadata?.provenance });
    const metadataDocument = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const previous = edition.metadata_version && edition.metadata_uri && edition.metadata?.["_void"]?.digest === generated.digest && edition.metadata?.provenance?.root === provenance.root ? { uri: edition.metadata_uri } : null;
    const binding = await this.releaseContractBinding(release.id);
    if (requiresFactoryRelease(release) && !binding) throw new ApiError(409, "RELEASE_CONTRACT_BINDING_REQUIRED", "This Studio release must be bound to a mined VoidReleaseFactory deployment before publication. No legacy shared contract fallback is allowed.");
    if (binding && String(edition.contract_id) !== String(binding.release_contract_id)) throw new ApiError(409, "EDITION_CONTRACT_MISMATCH", "This edition was not created on the release's bound contract.");
    const publishChainId = binding ? Number(binding.chain_id) : CERTIFIED_CHAIN_ID;
    const publishContract = binding ? String(binding.release_contract_address).toLowerCase() : legacySharedContract();
    const sequential = bindingUsesSequentialIds(binding);
    const publishTokenId = await this.editionTokenId(release, edition, binding);
    await assertTokenNotOwnedByAnotherArtist(this.db, { artistId: release.artist_id, contractAddress: publishContract, chainId: publishChainId, tokenId: publishTokenId });
    // Once an edition-creation transaction is recorded its metadata URI is frozen: regenerating or republishing
    // would only make the stored URI differ from what the chain holds. Confirm from the recorded transaction.
    const attempt = edition.application_metadata?.publicationAttempt;
    if (attempt?.transactionHash) throw new ApiError(409, "PUBLICATION_ATTEMPT_RECORDED", "A creation transaction was already submitted for this edition and its metadata is frozen. Confirm that transaction instead of republishing.", { transactionHash: attempt.transactionHash, tokenId: attempt.tokenId, metadataUri: attempt.metadataUri });
    // Editions are immutable and keyed by identity: if this one is already on-chain, republishing metadata would only
    // overwrite the stored URI and make the app lose track of it. Reconcile through confirm instead.
    if (binding) {
      const existing = await this.onChainEdition(binding, publishTokenId);
      // A sequential contract creates only its next token ID; any other number would revert on-chain.
      if (sequential && !existing?.[6]) {
        const next = await this.onChainNextTokenId(binding);
        if (next !== null && next !== publishTokenId) throw new ApiError(409, "SEQUENTIAL_TOKEN_ID_NOT_NEXT", `This track holds token #${publishTokenId} but the release contract's next token is #${next}. Publish this release's tracks in the order they were added.`, { tokenId: publishTokenId.toString(), nextTokenId: next.toString() });
      }
      if (existing?.[6]) throw new ApiError(409, "EDITION_ALREADY_ON_CHAIN", "This edition already exists on-chain and its metadata cannot change. Nothing was republished; confirm the existing edition instead.", { tokenId: publishTokenId.toString(), onChainMetadataUri: existing[5] });
    }
    const stored = previous || await this.metadataStorage.write({ metadata: metadataDocument, name: `${release.slug}-${edition.id}` });
    await this.repository.saveToken({ editionId: edition.id, contractId: edition.contract_id, tokenId: publishTokenId, metadataUri: stored.uri, metadata: metadataDocument, metadataVersion: generated.digest });
    assertProvenanceConsistency({ releaseId: release.id, editionId: edition.id, metadata: metadataDocument, provenanceRoot: provenance.root });
    const proof = this.provenanceRecords ? await persistPublicationProof(this.provenanceRecords, { release, edition, wallet: identity.wallet, provenance }) : null;
    await this.audit({ identity, request, eventType: "STUDIO_METADATA_PUBLISHED", subjectType: "release", subjectId: release.id, payload: { editionId: edition.id, digest: generated.digest, provenanceRoot: provenance.root } });
    const editionSlug = generatedSlug(edition.title, "edition name");
    const onChainEditionId = binding ? onChainEditionIdFor(binding, edition.title, publishTokenId) : null;
    // Factory V3 releases pass this exact root into the edition-creating call; confirmation
    // refuses success unless the same transaction recorded it on the release contract.
    const provenanceAtCreation = bindingAnchorsAtCreation(binding);
    return { releaseId: release.id, editionId: edition.id, releaseSlug: release.slug, editionSlug, tokenId: publishTokenId.toString(), tokenIdScheme: sequential ? "sequential" : "edition-hash", onChainEditionId, releaseContractAddress: publishContract, primarySaleAddress: binding?.primary_sale_address || null, provenanceAnchorAddress: binding?.provenance_anchor_address || null, factoryAddress: binding?.factory_address || null, releaseKey: binding?.release_key || null, implementationVersion: binding ? Number(binding.implementation_version) : null, provenanceAtCreation, ...(provenanceAtCreation ? { provenanceRootBytes32: provenanceRootBytes32(provenance.root) } : {}), chainId: publishChainId, metadataUri: stored.uri, digest: generated.digest, provenanceRoot: provenance.root, ...publicationView({ releaseStatus: release.status, proof }) };
  }

  /** Records the edition-creation transaction the moment the wallet returns it, freezing the metadata URI and the
   * derived token ID this attempt used. Confirmation later verifies exactly this record against the chain. */
  async recordPublicationSubmission({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const transactionHash = requiredText(input?.transactionHash, "transactionHash", { max: 128 }).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new ApiError(400, "TRANSACTION_INVALID", "The publication transaction could not be verified.");
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot publish this release.");
    await assertArtistMayPublish(this.db, { artistId: release.artist_id, wallet: identity.wallet });
    const edition = await this.openPublishingEdition(release);
    if (!edition?.metadata_uri) throw new ApiError(409, "METADATA_REQUIRED", "Metadata must be published before a creation transaction can be recorded.");
    const existing = edition.application_metadata?.publicationAttempt;
    if (existing?.transactionHash) {
      if (existing.transactionHash === transactionHash) return { ...existing, alreadyRecorded: true };
      throw new ApiError(409, "PUBLICATION_ATTEMPT_EXISTS", "A different creation transaction is already recorded for this edition.", { transactionHash: existing.transactionHash });
    }
    const binding = await this.releaseContractBinding(release.id);
    const tokenId = await this.editionTokenId(release, edition, binding);
    const attempt = { transactionHash, metadataUri: edition.metadata_uri, tokenId: tokenId.toString(), provenanceRoot: edition.metadata?.provenance?.root || null, submittedAt: new Date().toISOString() };
    await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: edition.title, tier: edition.tier, description: edition.description, supply: edition.supply, status: edition.status, metadata: { ...(edition.application_metadata || {}), publicationAttempt: attempt } });
    await this.audit({ identity, request, eventType: "STUDIO_PUBLICATION_SUBMITTED", subjectType: "release", subjectId: release.id, payload: attempt });
    return attempt;
  }

  // The open edition with its canonical token row: the row whose token ID the contract derives from the edition's
  // current identity (a renamed draft can still carry a stale one).
  async openPublishingEdition(release) {
    const result = await this.db.query("SELECT e.*, t.metadata_uri, t.token_id, t.metadata, t.metadata_version FROM editions e JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY CASE WHEN e.status IN ('DRAFT','REVIEW') THEN 0 ELSE 1 END, e.created_at DESC LIMIT 20", [release.id]);
    const first = result.rows[0];
    if (!first || result.rows.length === 1) return first;
    const binding = await this.releaseContractBinding(release.id);
    // A sequential track's token row is its reserved number; titles do not create stale rows.
    if (bindingUsesSequentialIds(binding)) return result.rows.find((row) => row.id === first.id && String(row.contract_id) === String(binding.release_contract_id)) || first;
    const wanted = String(binding ? releaseCloneTokenId(generatedSlug(first.title, "edition name")) : certifiedTokenId(release.slug, generatedSlug(first.title, "edition name")));
    return result.rows.find((row) => row.id === first.id && String(row.token_id) === wanted) || first;
  }

  async confirmPublication({ request, releaseId, input }) {
    const identity = await this.identity(request);
    // The hash is optional: when the app lost track of a mined creation, the chain is searched for it.
    let transactionHash = input?.transactionHash == null || input.transactionHash === "" ? null : requiredText(input.transactionHash, "transactionHash", { max: 128 }).toLowerCase();
    if (transactionHash !== null && !/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new ApiError(400, "TRANSACTION_INVALID", "The publication transaction could not be verified.");
    const acceptOnChainMetadata = input?.acceptOnChainMetadata === true;
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot publish this release.");
    await assertArtistMayPublish(this.db, { artistId: release.artist_id, wallet: identity.wallet });
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.token_id, t.metadata, t.metadata_version FROM editions e JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY CASE WHEN e.status IN ('DRAFT','REVIEW') THEN 0 ELSE 1 END, e.created_at DESC LIMIT 20", [release.id]);
    // An edition can own several token rows (a renamed draft keeps its stale one). The row whose token ID
    // the contract derives from the edition's current identity is the one the chain can contain.
    let edition = editionResult.rows[0];
    const earlyBinding = edition ? await this.releaseContractBinding(release.id) : null;
    if (edition && editionResult.rows.length > 1 && !bindingUsesSequentialIds(earlyBinding)) {
      const wanted = String(earlyBinding ? releaseCloneTokenId(generatedSlug(edition.title, "edition name")) : certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name")));
      edition = editionResult.rows.find((row) => row.id === edition.id && String(row.token_id) === wanted) || edition;
    }
    if (!edition?.metadata_uri) throw new ApiError(409, "METADATA_REQUIRED", "Metadata must be published before the blockchain transaction can be confirmed.");
    // The recorded creation attempt is authoritative: its transaction and frozen metadata URI are what the chain must show.
    const attempt = edition.application_metadata?.publicationAttempt?.transactionHash ? edition.application_metadata.publicationAttempt : null;
    if (attempt && transactionHash !== null && transactionHash !== attempt.transactionHash) throw new ApiError(409, "PUBLICATION_TRANSACTION_MISMATCH", "This edition's recorded creation transaction is different from the one supplied.", { transactionHash: attempt.transactionHash });
    if (attempt && transactionHash === null) transactionHash = attempt.transactionHash;
    await this.assertSingleOpenForEdition(release, edition.id);
    let provenance = assertProvenanceConsistency({ releaseId: release.id, editionId: edition.id, metadata: edition.metadata, provenanceRoot: edition.metadata?.provenance?.root });
    let currentProof = this.provenanceRecords ? await this.provenanceRecords.findOwnedByRoot({ releaseId: release.id, editionId: edition.id, manifestSha256: provenance.root, creatorWallet: identity.wallet }) : null;
    const editionOpen = edition.status === "DRAFT" || edition.status === "REVIEW";
    if (!editionOpen && release.status === "PUBLISHED" && attempt?.confirmedBlock != null && attempt.transactionHash === transactionHash) {
      // Repeating the confirmation of an already-confirmed attempt changes nothing and reports the stored outcome.
      return { releaseId: release.id, editionId: edition.id, tokenId: attempt.emittedTokenId || attempt.tokenId, transactionHash, alreadyConfirmed: true, copyrightOwnership: false, ...publicationView({ releaseStatus: "PUBLISHED", proof: currentProof }) };
    }
    if (!editionOpen && release.status === "PUBLISHED" && publicationView({ releaseStatus: "PUBLISHED", proof: currentProof }).fullyPublished) {
      throw new ApiError(409, "RELEASE_ALREADY_PUBLISHED", "This release is already published and its provenance is verified.");
    }
    try {
      const binding = earlyBinding;
      if (requiresFactoryRelease(release) && !binding) throw new ApiError(409, "RELEASE_CONTRACT_BINDING_REQUIRED", "This Studio release must be bound to a mined VoidReleaseFactory deployment before publication. No legacy shared contract fallback is allowed.");
      if (binding && String(edition.contract_id) !== String(binding.release_contract_id)) throw new ApiError(409, "EDITION_CONTRACT_MISMATCH", "This edition was not created on the release's bound contract.");
      const publicationChainId = binding ? Number(binding.chain_id) : CERTIFIED_CHAIN_ID;
      const publicationContract = binding ? String(binding.release_contract_address).toLowerCase() : legacySharedContract();
      const expectedTokenId = await this.editionTokenId(release, edition, binding);
      const expectedReleaseId = binding ? binding.release_key : ethers.encodeBytes32String(requiredText(release.slug, "release.slug", { max: 31 }));
      const provider = this.publicationChain || new ethers.JsonRpcProvider(deployment.rpcUrl);
      if (transactionHash === null) {
        transactionHash = await this.findEditionCreationTransaction({ provider, binding, publicationContract, tokenId: expectedTokenId });
        if (!transactionHash) throw new ApiError(409, "EDITION_CREATION_NOT_FOUND", "No edition-creation transaction was found on-chain for this release. Nothing was changed.");
      }
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt || receipt.status !== 1) throw new Error("receipt unavailable or unsuccessful");
      const eventInterface = new ethers.Interface([...deployment.abi, "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
      const expectedEditionId = binding ? onChainEditionIdFor(binding, edition.title, expectedTokenId) : ethers.encodeBytes32String(generatedSlug(edition.title, "edition name"));
      // Only the exact release contract's own logs count; any other contract can emit a look-alike event.
      const event = receipt.logs.filter((log) => String(log.address || "").toLowerCase() === publicationContract).map((log) => { try { return eventInterface.parseLog(log); } catch { return null; } }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId === expectedTokenId && parsed.args.releaseId === expectedReleaseId && parsed.args.editionId === expectedEditionId);
      if (!event) throw new Error("expected EditionCreated event was not found");
      // With a recorded attempt the frozen URI must match the stored draft and the chain exactly; a recorded attempt is
      // never reconciled by adopting a different URI.
      if (attempt && (edition.metadata_uri !== attempt.metadataUri || event.args.metadataUri !== attempt.metadataUri)) throw new ApiError(409, "PUBLICATION_METADATA_DIVERGED", "The metadata URI no longer matches the one frozen for the submitted creation transaction, or the chain shows a different one. Nothing was changed.", { frozenMetadataUri: attempt.metadataUri, onChainMetadataUri: event.args.metadataUri });
      const onChain = this.publicationChain
        ? await this.publicationChain.edition(expectedTokenId)
        : await new ethers.Contract(publicationContract, [...deployment.abi, EDITION_ABI], provider).edition(expectedTokenId);
      // The chain is authoritative: an edition's stored URI is immutable, so it is what the event and contract agree on.
      if (!onChain[6] || onChain[5] !== event.args.metadataUri) throw new Error("on-chain edition verification failed");
      let unattachedDraft = null;
      if (event.args.metadataUri !== edition.metadata_uri) {
        // Metadata was republished after this creation was mined. Never overwrite the draft silently: the artist
        // must accept the on-chain URI, and the draft's own URI stays recorded in application_metadata.
        if (!acceptOnChainMetadata) throw new ApiError(409, "METADATA_URI_MISMATCH", "This edition already exists on-chain with different metadata than the current draft. Its metadata cannot be changed. Confirm to adopt the on-chain edition; the draft metadata stays recorded and is not published.", { onChainMetadataUri: event.args.metadataUri, draftMetadataUri: edition.metadata_uri, tokenId: expectedTokenId.toString(), transactionHash });
        if (!this.metadataFetcher) throw new ApiError(503, "METADATA_FETCH_UNAVAILABLE", "The on-chain metadata could not be read to verify it, so the edition was not adopted.");
        let chainMetadata;
        try { chainMetadata = JSON.parse(Buffer.from(await this.metadataFetcher(event.args.metadataUri)).toString("utf8")); } catch { throw new ApiError(409, "ONCHAIN_METADATA_UNREADABLE", "The on-chain metadata could not be read or parsed, so the edition was not adopted."); }
        if (chainMetadata?._void?.digest !== edition.metadata?._void?.digest) throw new ApiError(409, "ONCHAIN_METADATA_DIVERGED", "The on-chain metadata has different content than the draft, so the edition was not adopted automatically.");
        unattachedDraft = { uri: edition.metadata_uri, provenanceRoot: edition.metadata?.provenance?.root || null, digest: edition.metadata?._void?.digest || null };
        provenance = assertProvenanceConsistency({ releaseId: release.id, editionId: edition.id, metadata: chainMetadata, provenanceRoot: chainMetadata?.provenance?.root });
        edition = { ...edition, metadata_uri: event.args.metadataUri, metadata: chainMetadata };
        currentProof = this.provenanceRecords ? await this.provenanceRecords.findOwnedByRoot({ releaseId: release.id, editionId: edition.id, manifestSha256: provenance.root, creatorWallet: identity.wallet }) : null;
      }
      // The edition, as stored on the certified contract, must have been created by a wallet of this release's own artist.
      const creator = String(onChain[2] || "").toLowerCase();
      if (creator !== String(event.args.artist || "").toLowerCase()) throw new Error("on-chain edition creator does not match the publication event");
      const creatorOwns = await this.db.query("SELECT 1 FROM artist_owners WHERE artist_id=$1 AND lower(owner_wallet)=$2 LIMIT 1", [release.artist_id, creator]);
      if (!creatorOwns.rows[0]) throw new ApiError(403, "EDITION_CREATED_BY_ANOTHER_ARTIST", "The on-chain edition was not created by a wallet of this artist.");
      if (binding) assertEditionRoyaltyPolicy({ receipt, publicationContract, tokenId: expectedTokenId, policy: releaseRoyaltyPolicyForChain(publicationChainId) });
      const provenanceAtCreation = bindingAnchorsAtCreation(binding);
      const onChainProvenance = provenanceAtCreation
        ? await this.verifyProvenanceAtCreation({ receipt, provider, publicationContract, releaseId: expectedReleaseId, editionId: expectedEditionId, tokenId: expectedTokenId, artist: creator, provenanceRoot: provenance.root })
        : null;
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
              chainKey: binding ? String(publicationChainId) : (deployment.chainKey || "fuji"),
              chainId: publicationChainId,
              transactionHash,
              blockNumber: receipt.blockNumber,
              blockTimestamp: anchor.anchorBlockTimestamp,
              anchorContract: publicationContract,
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
      if (unattachedDraft) {
        await this.repository.saveToken({ editionId: edition.id, contractId: edition.contract_id, tokenId: expectedTokenId, metadataUri: edition.metadata_uri, metadata: edition.metadata, metadataVersion: edition.metadata?._void?.digest || null });
      }
      // Only token rows with no metadata URI that point elsewhere are stale duplicates (same predicate as the rename fix).
      await this.db.query("DELETE FROM tokens WHERE edition_id=$1 AND (contract_id<>$2 OR token_id<>$3::numeric) AND metadata_uri IS NULL", [edition.id, edition.contract_id, String(expectedTokenId)]);
      await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: edition.title, tier: edition.tier, description: edition.description, supply: edition.supply, status: "PUBLISHED", metadata: { ...(edition.application_metadata || {}), publicationAttempt: { ...(attempt || { transactionHash, metadataUri: edition.metadata_uri, submittedAt: null }), tokenId: expectedTokenId.toString(), emittedTokenId: event.args.tokenId.toString(), confirmedBlock: Number(receipt.blockNumber) }, ...(unattachedDraft ? { unattachedDraftMetadata: { ...unattachedDraft, reason: "EDITION_ALREADY_ON_CHAIN", transactionHash } } : {}) } });
      await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: release.title, description: release.description, status: "PUBLISHED", metadata: release.release_metadata || {}, publishedAt: release.published_at || new Date() });
      await this.publishReleaseExperiences(release);
      await this.audit({ identity, request, eventType: "STUDIO_PUBLICATION_CONFIRMED", subjectType: "release", subjectId: release.id, payload: { transactionHash, tokenId: expectedTokenId.toString(), chainId: publicationChainId, releaseContractAddress: publicationContract, provenanceRoot: provenance.root, provenanceAnchoredAtCreation: Boolean(onChainProvenance), ...(unattachedDraft ? { adoptedOnChainMetadataUri: edition.metadata_uri, unattachedDraftMetadataUri: unattachedDraft.uri } : {}) } });
      return { releaseId: release.id, editionId: edition.id, tokenId: expectedTokenId.toString(), transactionHash, chainId: publicationChainId, releaseContractAddress: publicationContract, anchorEvent: "EditionCreated", provenanceAtCreation, onChainProvenance, separateAnchorAvailable: Boolean(binding) && !provenanceAtCreation, copyrightOwnership: false, ...publicationView({ releaseStatus: "PUBLISHED", proof }) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logger.error?.("studio.publication.verify_failed", { releaseId: release.id, transactionHash, detail: error.message });
      throw new ApiError(409, "PUBLICATION_NOT_CONFIRMED", "The blockchain publication could not be verified. Your release remains unpublished and can be retried.");
    }
  }

  /** Finds the transaction that emitted EditionCreated for this token on the release contract, scanning forward from
   * the contract's creation block in public-RPC-sized windows. Returns null when none exists. */
  async findEditionCreationTransaction({ provider, binding, publicationContract, tokenId, windowBlocks = 2000, maxWindows = 200 }) {
    const topic0 = ethers.id("EditionCreated(uint256,bytes32,bytes32,address,uint256,string)");
    const topic1 = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);
    const head = Number(await provider.getBlockNumber());
    let from = Math.max(Number(binding?.deployment_block_number) || 0, 0);
    for (let window = 0; from <= head && window < maxWindows; window += 1, from += windowBlocks) {
      const logs = await provider.getLogs({ address: publicationContract, topics: [topic0, topic1], fromBlock: from, toBlock: Math.min(from + windowBlocks - 1, head) });
      if (logs.length) return String(logs[0].transactionHash).toLowerCase();
    }
    return null;
  }

  /** The token ID an edition is created with: its reserved number on a sequential release contract, otherwise
   * the contract's derivation from the edition title. */
  async editionTokenId(release, edition, binding) {
    if (!bindingUsesSequentialIds(binding)) return binding ? releaseCloneTokenId(generatedSlug(edition.title, "edition name")) : certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name"));
    const { rows } = await this.db.query("SELECT token_id::text AS token_id FROM tokens WHERE edition_id=$1 AND contract_id=$2 ORDER BY token_id ASC LIMIT 1", [edition.id, binding.release_contract_id]);
    if (!rows[0]) throw new ApiError(409, "EDITION_TOKEN_REQUIRED", "This track has no token number yet. Save the track again, then publish.");
    return BigInt(rows[0].token_id);
  }

  /** A sequential release contract's next token ID; null when the chain cannot be read (the create simulation still guards publishing). */
  async onChainNextTokenId(binding) {
    try {
      if (this.publicationChain?.nextTokenId) return BigInt(await this.publicationChain.nextTokenId());
      if (Number(binding.chain_id) !== Number(RELEASE_PER_CONTRACT.chainId)) return null;
      const provider = new ethers.JsonRpcProvider(RELEASE_PER_CONTRACT.rpcUrl, Number(binding.chain_id), { staticNetwork: true });
      return BigInt(await new ethers.Contract(String(binding.release_contract_address), [NEXT_TOKEN_ID_ABI], provider).nextTokenId());
    } catch { return null; }
  }

  /** Reads an edition from the release contract; null when the chain cannot be read (the create simulation still guards publishing). */
  async onChainEdition(binding, tokenId) {
    try {
      if (this.publicationChain?.edition) return await this.publicationChain.edition(tokenId);
      if (Number(binding.chain_id) !== Number(RELEASE_PER_CONTRACT.chainId)) return null;
      const provider = new ethers.JsonRpcProvider(RELEASE_PER_CONTRACT.rpcUrl, Number(binding.chain_id), { staticNetwork: true });
      return await new ethers.Contract(String(binding.release_contract_address), [EDITION_ABI], provider).edition(tokenId);
    } catch { return null; }
  }

  /** Factory V3 publication: the edition transaction itself must carry the release contract's
   * ProvenanceAnchored event for this exact root and edition, and the contract must report it.
   * Anything missing or different refuses publication; nothing is inferred from success alone. */
  async verifyProvenanceAtCreation({ receipt, provider, publicationContract, releaseId, editionId, tokenId, artist, provenanceRoot }) {
    const root = provenanceRootBytes32(provenanceRoot);
    const anchoredLogs = (receipt.logs || []).filter((log) => String(log.address || "").toLowerCase() === publicationContract).map((log) => { try { return releaseProvenanceIface.parseLog(log); } catch { return null; } }).filter((parsed) => parsed?.name === "ProvenanceAnchored");
    if (!anchoredLogs.length) throw new ApiError(409, "PROVENANCE_ROOT_NOT_ANCHORED", "The publication transaction did not record a provenance root. The release remains unpublished.");
    const event = anchoredLogs.find((parsed) => String(parsed.args.releaseId).toLowerCase() === String(releaseId).toLowerCase() && parsed.args.editionId === editionId && parsed.args.tokenId === tokenId);
    if (!event || String(event.args.provenanceRoot).toLowerCase() !== root || String(event.args.artist).toLowerCase() !== String(artist).toLowerCase() || String(event.args.releaseContract).toLowerCase() !== publicationContract) {
      throw new ApiError(409, "PROVENANCE_ROOT_MISMATCH", "The on-chain provenance root does not match this edition's canonical provenance. The release remains unpublished.");
    }
    let anchored;
    let storedRoot;
    try {
      if (this.publicationChain?.isAnchored) {
        [anchored, storedRoot] = await Promise.all([this.publicationChain.isAnchored({ releaseId, editionId, provenanceRoot: root }), this.publicationChain.provenanceRootOf(tokenId)]);
      } else {
        const contract = new ethers.Contract(publicationContract, RELEASE_PROVENANCE_ABI, provider);
        [anchored, storedRoot] = await Promise.all([contract.isAnchored(releaseId, editionId, root), contract.provenanceRootOf(tokenId)]);
      }
    } catch {
      throw new ApiError(503, "PROVENANCE_STATE_UNAVAILABLE", "The release contract's provenance state could not be read. The release remains unpublished and can be retried.");
    }
    if (anchored !== true || String(storedRoot || "").toLowerCase() !== root) throw new ApiError(409, "PROVENANCE_ROOT_MISMATCH", "The release contract does not record this provenance root. The release remains unpublished.");
    return { event: "ProvenanceAnchored", contract: publicationContract, provenanceRoot: root, artist: String(event.args.artist).toLowerCase(), tokenId: tokenId.toString() };
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
    const type = releaseType(input.releaseType);
    assertReleaseTrackList(type, input.metadata);
    const metadata = { ...(input.metadata || {}), releaseType: type, publicationArchitecture: "release-per-contract", chainId: PROVISIONING_CHAIN_ID, applicationReleaseId: deriveStudioApplicationReleaseId(id), releaseKey: null, ...(input.artwork ? { artwork: optionalText(input.artwork, "artwork", { max: 2048 }) } : {}), ...(contractSymbolInput(input.symbol) ? { contractSymbol: contractSymbolInput(input.symbol) } : {}) };
    const release = await this.repository.saveRelease({ id, artistId: artist.id, slug, title, description: optionalText(input.description, "release.description", { max: 20000 }), status: "DRAFT", metadata: jsonObject(metadata, "release.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_CREATED", subjectType: "release", subjectId: release.id, payload: { artistId: artist.id } });
    return { ...release, releaseKey: metadata.releaseKey, chainId: PROVISIONING_CHAIN_ID };
  }

  // The symbol is copied into the clone by createRelease, so it can change only while no contract
  // exists and no deployment transaction has been submitted for this release.
  async assertContractSymbolEditable(release) {
    const locked = () => new ApiError(409, "CONTRACT_SYMBOL_LOCKED", "The on-chain tag is fixed once the release is submitted or created on-chain.");
    if (release.status !== "DRAFT") throw locked();
    const bound = await this.db.query("SELECT 1 FROM release_contracts WHERE release_id=$1 LIMIT 1", [release.id]);
    if (bound.rows.length) throw locked();
    const requests = await this.db.query("SELECT state, transaction_hash FROM release_provisioning_requests WHERE release_id=$1", [release.id]);
    if (requests.rows.some((row) => row.transaction_hash || !["PENDING", "FAILED"].includes(row.state))) throw locked();
  }

  async updateRelease({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    // A retired release stays exactly as it was archived; a stale client cannot edit it (and so cannot leave an
    // "updated" trace on it). Start a new release instead.
    if (String(release.status).toUpperCase() === "ARCHIVED") throw new ApiError(409, "RELEASE_ARCHIVED", "This release was taken off the site and can no longer be edited. Create a new release instead.");
    assertPublishedMayChange(release.status, input, "Published releases cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, release.status, "release");
    if (status === "ARCHIVED" && await this.legacyCatalogStaysOnSite(release)) {
      throw new ApiError(409, "LEGACY_CATALOG_LOCKED", "The original mainnet VOIDCALLER catalog stays on the site.");
    }
    if (status === "ARCHIVED" && await this.collectorsCanStillBuy(release)) {
      throw new ApiError(409, "MINTABLE_RELEASE_LOCKED", "A published release collectors can still buy stays on the site.");
    }
    const metadata = input.metadata === undefined ? { ...(release.release_metadata || {}) } : jsonObject(input.metadata, "release.metadata");
    if (input.symbol !== undefined) {
      const symbol = contractSymbolInput(input.symbol);
      if ((symbol || null) !== (contractSymbolInput(release.release_metadata?.contractSymbol) || null)) {
        await this.assertContractSymbolEditable(release);
        if (symbol) metadata.contractSymbol = symbol; else delete metadata.contractSymbol;
      }
    }
    const requestedType = input.releaseType ?? (input.metadata === undefined ? undefined : metadata.releaseType);
    if (requestedType !== undefined) metadata.releaseType = releaseType(requestedType);
    else if (release.release_metadata?.releaseType !== undefined) metadata.releaseType = release.release_metadata.releaseType;
    // Published metadata embeds the release type, so it is fixed once any edition is published.
    if (releaseType(metadata.releaseType) !== storedReleaseType(release)) {
      if (await this.hasPublishedEdition(release.id)) throw new ApiError(409, "RELEASE_TYPE_LOCKED", "The release type cannot change after an edition has been published.");
      await this.assertReleaseTypeMatchesChain(release, releaseType(metadata.releaseType));
      // Switching to Single keeps the release (same id, slug and contract); it only needs a single track.
      if (releaseType(metadata.releaseType) === "SINGLE" && await this.releaseTrackCount(release.id) > 1) throw new ApiError(409, "SINGLE_REQUIRES_ONE_TRACK", SINGLE_ONE_TRACK_MESSAGE);
    }
    assertReleaseTrackList(releaseType(metadata.releaseType), metadata, release.release_metadata, { typeChanged: releaseType(metadata.releaseType) !== storedReleaseType(release) });
    const saved = await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: input.title === undefined ? release.title : requiredText(input.title, "release.title", { max: 256 }), description: input.description === undefined ? release.description : optionalText(input.description, "release.description", { max: 20000 }), status, metadata, publishedAt: status === "PUBLISHED" ? (release.published_at || new Date()) : status === "ARCHIVED" ? (release.published_at ?? null) : null });
    if (status === "ARCHIVED") await this.archiveReleaseChildren(release.id);
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_UPDATED", subjectType: "release", subjectId: release.id });
    return saved;
  }

  // D3: a release contract never moves between standalone and album mode. The database can lag the
  // chain (a mined edition whose confirmation never completed stays DRAFT), so the bound contract is
  // read directly and any read failure refuses the change. On V5 clones createAlbum also enforces
  // this on-chain; V4 and older clones are immutable, so this check cannot stop a direct wallet call.
  async assertReleaseTypeMatchesChain(release, toType) {
    const binding = await this.releaseContractBinding(release.id);
    if (!binding) return;
    // The token IDs stored when each edition was prepared are the ones sent on-chain; an edition
    // title can still change while it is a draft, so IDs are never re-derived from titles here.
    const { rows } = await this.db.query("SELECT DISTINCT t.token_id::text AS token_id FROM tokens t JOIN editions e ON e.id=t.edition_id WHERE e.release_id=$1", [release.id]);
    const tokenIds = rows.map((row) => BigInt(row.token_id));
    const expect = lifecycleExpectations({ implementationVersion: binding.implementation_version, factoryAddress: binding.factory_address });
    if (!expect) {
      this.logger.error?.("studio.release.lifecycle_deployment_unrecognised", { releaseId: release.id, implementationVersion: binding.implementation_version ?? null });
      throw new ApiError(503, "RELEASE_CHAIN_STATE_UNAVAILABLE", RELEASE_CHAIN_STATE_UNAVAILABLE_MESSAGE);
    }
    // A pre-album clone has no album functions, so ALBUM could never be activated on it.
    if (toType === "ALBUM" && !expect.albumCreated) throw new ApiError(409, "ALBUM_NOT_SUPPORTED", ALBUM_NOT_SUPPORTED_MESSAGE);
    let lifecycle;
    try {
      lifecycle = await readReleaseLifecycle(this.releaseChainRequest(binding), binding.release_contract_address, { tokenIds, expect });
    } catch (error) {
      this.logger.error?.("studio.release.lifecycle_read_failed", { releaseId: release.id, code: error?.code || null });
      throw new ApiError(503, "RELEASE_CHAIN_STATE_UNAVAILABLE", RELEASE_CHAIN_STATE_UNAVAILABLE_MESSAGE);
    }
    const blocker = releaseTypeChangeBlocker({ toType, lifecycle });
    if (blocker) throw new ApiError(409, blocker.code, blocker.message);
  }

  releaseChainRequest(binding) {
    if (typeof this.publicationChain?.request === "function") return (payload) => this.publicationChain.request(payload);
    if (Number(binding.chain_id) !== Number(RELEASE_PER_CONTRACT.chainId)) throw new ApiError(503, "RELEASE_CHAIN_STATE_UNAVAILABLE", RELEASE_CHAIN_STATE_UNAVAILABLE_MESSAGE);
    const provider = new ethers.JsonRpcProvider(RELEASE_PER_CONTRACT.rpcUrl, Number(binding.chain_id), { staticNetwork: true });
    return ({ method, params }) => provider.send(method, params);
  }

  // tokens.metadata_uri is written when metadata is submitted for publication, before the wallet transaction.
  async editionMetadataSubmitted(editionId) {
    return Boolean((await this.db.query("SELECT 1 FROM tokens WHERE edition_id=$1 AND metadata_uri IS NOT NULL LIMIT 1", [editionId])).rows[0]);
  }

  async hasPublishedEdition(releaseId, exceptEditionId = null) {
    const { rows } = await this.db.query("SELECT 1 FROM editions WHERE release_id=$1 AND status='PUBLISHED' AND ($2::text IS NULL OR id<>$2) LIMIT 1", [releaseId, exceptEditionId]);
    return Boolean(rows[0]);
  }

  async releaseTrackCount(releaseId, exceptEditionId = null, query = (sql, params) => this.db.query(sql, params)) {
    const { rows } = await query(TRACK_COUNT_SQL, [releaseId, exceptEditionId]);
    return Number(rows[0]?.track_count ?? 0);
  }

  // The EP cap: a new track is refused at the cap, but editing or removing tracks of an over-limit draft is not.
  async assertEpHasTrackSlot(release, query) {
    if (storedReleaseType(release) !== "EP") return;
    if (await this.releaseTrackCount(release.id, null, query) >= MAX_EP_TRACKS) throw new ApiError(409, "EP_TRACK_LIMIT_EXCEEDED", EP_TRACK_LIMIT_MESSAGE);
  }

  // A SINGLE is exactly one standalone edition: once one is published, no other edition may be created or published.
  async assertSingleOpenForEdition(release, editionId = null) {
    if (storedReleaseType(release) !== "SINGLE") return;
    if (await this.hasPublishedEdition(release.id, editionId)) {
      throw new ApiError(409, "SINGLE_ALREADY_PUBLISHED", "A single is one standalone edition and this single is already published. Create a new release for another track.");
    }
  }

  // Lists a published standalone SINGLE on one of the same artist's ALBUM releases. The single's
  // release, contract, edition, provenance and ownership rows are never modified.
  async associateAlbumSingle({ request, albumReleaseId, input = {} }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(albumReleaseId, "albumReleaseId"), identity.wallet]);
    const album = rows[0];
    if (!album) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    if (storedReleaseType(album) !== "ALBUM") throw new ApiError(409, "ALBUM_RELEASE_REQUIRED", "Singles can only be added to an Album release.");
    if (album.status === "ARCHIVED") throw new ApiError(409, "ALBUM_RELEASE_ARCHIVED", "This album has been taken off the site.");
    const single = (await this.db.query("SELECT r.* FROM releases r WHERE r.id=$1 LIMIT 1", [requiredText(input.singleReleaseId, "singleReleaseId", { max: 128 })])).rows[0];
    if (!single || single.artist_id !== album.artist_id) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "Only this artist's own singles can be added to the album.");
    if (storedReleaseType(single) !== "SINGLE") throw new ApiError(409, "SINGLE_RELEASE_REQUIRED", "Only a release published as a Single can be added to an album.");
    const edition = (await this.db.query("SELECT id FROM editions WHERE release_id=$1 AND status='PUBLISHED' ORDER BY created_at ASC LIMIT 1", [single.id])).rows[0];
    if (single.status !== "PUBLISHED" || !edition) throw new ApiError(409, "SINGLE_NOT_PUBLISHED", "Publish the single before adding it to an album.");
    const position = Number(input.trackPosition);
    if (!Number.isInteger(position) || position < 1 || position > 999) throw new ApiError(400, "INVALID_TRACK_POSITION", "trackPosition must be a whole number from 1 to 999.");
    let inserted;
    try {
      inserted = (await this.db.query("INSERT INTO release_album_singles (album_release_id, single_release_id, single_edition_id, track_position, associated_by_wallet) VALUES ($1,$2,$3,$4,$5) RETURNING album_release_id, single_release_id, single_edition_id, track_position, created_at", [album.id, single.id, edition.id, position, String(identity.wallet).toLowerCase()])).rows[0];
    } catch (error) {
      if (error?.code !== "23505") throw error;
      const takenPosition = String(error.constraint || error.detail || "").includes("track_position");
      throw new ApiError(409, takenPosition ? "ALBUM_TRACK_POSITION_TAKEN" : "ALBUM_SINGLE_ALREADY_ADDED", takenPosition ? "Another single already holds that track position on this album." : "This single is already on the album.");
    }
    await this.audit({ identity, request, eventType: "STUDIO_ALBUM_SINGLE_ASSOCIATED", subjectType: "release", subjectId: album.id, payload: { singleReleaseId: single.id, singleEditionId: edition.id, trackPosition: position } });
    return { albumReleaseId: inserted.album_release_id, singleReleaseId: inserted.single_release_id, singleEditionId: inserted.single_edition_id, trackPosition: inserted.track_position, createdAt: inserted.created_at };
  }

  async createEdition({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    await this.assertSingleOpenForEdition(release);
    const binding = await this.releaseContractBinding(release.id);
    if (requiresFactoryRelease(release) && !binding) throw new ApiError(409, "RELEASE_CONTRACT_BINDING_REQUIRED", "Create and bind the release through VoidReleaseFactory before creating an edition. No legacy shared contract fallback is allowed.");
    const selectedChainId = binding ? Number(binding.chain_id) : CERTIFIED_CHAIN_ID;
    const address = binding ? String(binding.release_contract_address).toLowerCase() : legacySharedContract();
    const editionName = requiredText(input.trackTitle || input.title || input.name || release.title, "track.title", { max: 256 });
    const editionSlug = generatedSlug(editionName, "track title");
    // A sequential release contract numbers its tracks; the number is reserved below under the release lock.
    const sequential = bindingUsesSequentialIds(binding);
    const derivedTokenId = sequential ? null : binding ? releaseCloneTokenId(editionSlug) : certifiedTokenId(release.slug, editionSlug);
    if (derivedTokenId !== null) await assertTokenNotOwnedByAnotherArtist(this.db, { artistId: release.artist_id, contractAddress: address, chainId: selectedChainId, tokenId: derivedTokenId });
    const id = input.id ? requiredText(input.id, "edition.id", { max: 128 }) : `edition-${randomUUID()}`;
    let existing = null;
    if (input.id) {
      // saveEdition upserts by id; never let a re-post reopen a published edition or move one across releases.
      existing = (await this.db.query("SELECT release_id, status FROM editions WHERE id=$1 LIMIT 1", [id])).rows[0] || null;
      if (existing && (existing.release_id !== release.id || !["DRAFT", "REVIEW"].includes(existing.status))) throw new ApiError(409, "EDITION_ALREADY_EXISTS", "This edition already exists and can no longer be replaced.");
    }
    // Re-posting an existing draft edits it; only a genuinely new track needs a free slot.
    if (!existing) await this.assertEpHasTrackSlot(release);
    const edition = await this.repository.inTransaction(async (repository) => {
      // Re-check under a release row lock so two concurrent requests cannot both take the last slot.
      if (!existing && repository.db?.query) {
        await repository.db.query("SELECT id FROM releases WHERE id=$1 FOR UPDATE", [release.id]);
        await this.assertEpHasTrackSlot(release, (sql, params) => repository.db.query(sql, params));
      }
      const contract = binding
        ? { id: binding.release_contract_id }
        : await repository.saveContract({ chainId: selectedChainId, chainKey: input.chainKey || String(selectedChainId), address, contractType: "ERC1155", name: optionalText(input.contractName, "edition.contractName", { max: 256 }), metadata: jsonObject(input.contractMetadata, "edition.contractMetadata") });
      const saved = await repository.saveEdition({ id, releaseId: release.id, contractId: contract.id, title: editionName, tier: optionalText(input.tier, "edition.tier", { max: 128 }), description: optionalText(input.description, "edition.description", { max: 20000 }), supply: editionQuantity(input.quantity, "edition.quantity") ?? "0", status: "DRAFT", metadata: jsonObject({ ...withoutRemovedDraftFlag(input.metadata), ...(input.artwork === undefined ? {} : { artwork: optionalText(input.artwork, "edition.artwork", { max: 2048 }) }), priceWei: input.priceWei === undefined ? null : positiveBigInt(input.priceWei, "edition.priceWei"), marketplace: jsonObject(input.marketplace, "edition.marketplace") }, "edition.metadata") });
      const tokenId = sequential ? await reserveSequentialTokenId(repository.db?.query ? repository.db : this.db, { releaseId: release.id, editionId: saved.id, contractId: contract.id }) : derivedTokenId;
      await repository.saveToken({ editionId: saved.id, contractId: contract.id, tokenId, metadataUri: null, metadata: input.tokenMetadata === undefined ? null : jsonObject(input.tokenMetadata, "edition.tokenMetadata") });
      // The token ID derives from the edition title. Renaming a draft whose metadata was never submitted leaves
      // its earlier row behind, giving the edition two token rows. A row with no metadata URI was never submitted
      // for publication, so it cannot be on-chain yet; only that stale row of this edition is replaced.
      if (existing && repository.db?.query) await repository.db.query("DELETE FROM tokens WHERE edition_id=$1 AND (contract_id<>$2 OR token_id<>$3::numeric) AND metadata_uri IS NULL", [saved.id, contract.id, String(tokenId)]);
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
    // A removed draft stays archived: restoring it would add a track without passing the EP cap.
    if (edition.status === "ARCHIVED" && edition.application_metadata?.removedDraft === true) throw new ApiError(409, "TRACK_REMOVED", "This draft track was removed from the release. Add it again as a new track.");
    // Removing a draft track (so an over-limit EP can be trimmed): the row is kept as ARCHIVED, never deleted.
    const removingDraft = String(input.status ?? "").trim().toUpperCase() === "ARCHIVED" && ["DRAFT", "REVIEW"].includes(edition.status);
    if (removingDraft && await this.releaseContractBinding(edition.release_id)) throw new ApiError(409, "TRACK_REMOVAL_UNAVAILABLE", "A track on a release that already has its contract cannot be removed here.");
    // Once its metadata was submitted the track may already be minted (the database can lag the chain), so it is never hidden.
    if (removingDraft && await this.editionMetadataSubmitted(edition.id)) throw new ApiError(409, "TRACK_REMOVAL_UNAVAILABLE", "This track's metadata was already submitted for publication, so it cannot be removed here.");
    const status = removingDraft ? "ARCHIVED" : patchStatus(input, edition.status, "edition");
    const next = { id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: input.name === undefined && input.title === undefined ? edition.title : requiredText(input.name || input.title, "edition.name", { max: 256 }), tier: input.tier === undefined ? edition.tier : optionalText(input.tier, "edition.tier", { max: 128 }), description: input.description === undefined ? edition.description : optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? edition.supply : editionQuantity(input.quantity, "edition.quantity"), status, metadata: { ...withoutRemovedDraftFlag(input.metadata === undefined ? edition.application_metadata : jsonObject(input.metadata, "edition.metadata")), ...(removingDraft ? { removedDraft: true } : {}) } };
    assertEditionNotFrozen(edition, next);
    // Submitted metadata fixes the token id (derived from the title) and the max supply that the wallet transaction
    // may already have put on-chain, and the database cannot show whether it was mined. Until publication is
    // confirmed, an unchanged resave (what the Studio sends on every retry) is fine; changing either is not.
    if (["DRAFT", "REVIEW"].includes(edition.status) && !removingDraft && (next.title !== edition.title || String(next.supply ?? "") !== String(edition.supply ?? "")) && await this.editionMetadataSubmitted(edition.id)) {
      throw new ApiError(409, "EDITION_SUBMITTED_LOCKED", "This track's metadata was already submitted for publication, so its title and supply can no longer change while publication is unconfirmed. The transaction may already be on-chain. Retry publishing with the same title and supply, or create a new track.");
    }
    const saved = await this.repository.saveEdition(next);
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
    // The same id on the same edition is a re-save of that experience (it is updated in place); the
    // same id anywhere else is never overwritten.
    const preflight = (await this.db.query("SELECT id, artist_id, edition_id, status, version, media_config FROM experiences WHERE edition_id=$1 OR id=$2", [edition.id, id])).rows;
    const sameId = preflight.find((row) => row.id === id) || null;
    if (sameId && (String(sameId.edition_id) !== String(edition.id) || String(sameId.artist_id) !== String(edition.artist_id))) throw new ApiError(409, "EXPERIENCE_ID_CONFLICT", "That experience id belongs to a different edition or artist.");
    const requirements = await this.defaultEditionRequirements({ editionId: edition.id, mediaConfig: input.mediaConfig, requirements: input.requirements });
    const bound = await this.bindProtectedExperience({ artistId: edition.artist_id, mediaConfig: input.mediaConfig, requirements });
    if (Array.isArray(bound.mediaConfig?.protectedMedia) && bound.mediaConfig.protectedMedia.length) await this.assertEditionRequirements(edition.id, bound.requirements);
    assertExperienceMatchesMedia(mappedType, bound.mediaConfig?.protectedMedia);
    const baseConfig = { ...bound.mediaConfig, ...(productType ? { productType, deliveryType: mappedType } : {}) };
    const boundAssetIds = protectedAssetIds(baseConfig);
    const { experience, existed } = await this.withEditionExperiences({ editionId: edition.id, assetIds: boundAssetIds, write: async ({ repository, siblings }) => {
      // Decided from the rows as they are now, under the locks. A file already unlocked by an
      // experience on this edition is not given a second experience.
      const existing = siblings.find((row) => row.id === id) || siblings.find((row) => protectedAssetIds(row.media_config).some((assetId) => boundAssetIds.includes(assetId))) || null;
      const mediaConfig = { ...baseConfig };
      // A re-save that does not mention primary keeps the experience's designation.
      if (existing && mediaConfig.primary === undefined && primaryOf(existing.media_config) !== undefined) mediaConfig.primary = primaryOf(existing.media_config);
      // An edition has at most one primary experience; the Studio never silently moves it.
      if (mediaConfig.primary === true && siblings.some((row) => row.id !== (existing?.id || id) && primaryOf(row.media_config) === true)) throw new ApiError(409, "PRIMARY_EXPERIENCE_CONFLICT", "This edition already has a primary experience.");
      const saved = await repository.saveExperience({ id: existing?.id || id, artistId: edition.artist_id, releaseId: edition.release_id, editionId: edition.id, title: requiredText(input.title, "experience.title", { max: 256 }), description: optionalText(input.description, "experience.description", { max: 20000 }), experienceType: enumValue(mappedType, "experience.type", TYPES), requirements: bound.requirements, mediaConfig, ...(existing ? { version: Number(existing.version || 1) + 1, status: existing.status } : { status: "DRAFT" }) });
      return { experience: saved, existed: Boolean(existing) };
    } });
    await this.audit({ identity, request, eventType: existed ? "STUDIO_EXPERIENCE_UPDATED" : "STUDIO_EXPERIENCE_CREATED", subjectType: "experience", subjectId: experience.id, payload: { editionId: edition.id } });
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
    if (Array.isArray(bound.mediaConfig?.protectedMedia) && bound.mediaConfig.protectedMedia.length) await this.assertEditionRequirements(experience.edition_id, bound.requirements);
    assertExperienceMatchesMedia(mappedType, bound.mediaConfig?.protectedMedia);
    const baseConfig = productType ? { ...bound.mediaConfig, productType, deliveryType: mappedType } : { ...bound.mediaConfig };
    const saved = await this.withEditionExperiences({ editionId: experience.edition_id, assetIds: protectedAssetIds(baseConfig), write: async ({ repository, siblings }) => {
      // The designation is carried over from, and checked against, the rows as they are now, under the locks.
      const current = siblings.find((row) => row.id === experience.id) || experience;
      const mediaConfig = { ...baseConfig };
      if (mediaConfig.primary === undefined && primaryOf(current.media_config) !== undefined) mediaConfig.primary = primaryOf(current.media_config);
      if (mediaConfig.primary === true && siblings.some((row) => row.id !== experience.id && primaryOf(row.media_config) === true)) throw new ApiError(409, "PRIMARY_EXPERIENCE_CONFLICT", "This edition already has a primary experience.");
      return repository.saveExperience({ id: experience.id, artistId: experience.artist_id, releaseId: experience.release_id, editionId: experience.edition_id, title: input.title === undefined ? experience.title : requiredText(input.title, "experience.title", { max: 256 }), description: input.description === undefined ? experience.description : optionalText(input.description, "experience.description", { max: 20000 }), experienceType: enumValue(mappedType, "experience.type", TYPES), requirements: bound.requirements, mediaConfig, version: Number(experience.version || 1) + 1, status });
    } });
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
    for (const experience of rows) await this.publishExperience(release, experience);
  }

  /**
   * Marks one experience PUBLISHED without ever writing a stale snapshot. The list above is only a
   * starting point: the row is re-read FOR UPDATE inside a transaction, after taking the advisory locks
   * for the files it unlocks (sorted, then the row: the same order the create/update path uses, so the
   * two cannot deadlock), and what is written is the row's CURRENT title, requirements and media
   * configuration. If the current configuration needs a lock that was not taken, the transaction ends
   * and starts again with the union (a few tries; then the experience is left as it was and logged).
   * A file another edition has claimed blocks only this experience, never the whole publication.
   */
  async publishExperience(release, snapshot) {
    const blocked = (detail) => this.logger.error?.("studio.publication.experience_blocked", { releaseId: release.id, experienceId: snapshot.id, detail });
    const bindCurrent = (row) => this.bindProtectedExperience({ artistId: release.artist_id, mediaConfig: row.media_config || {}, requirements: Array.isArray(row.requirements) ? row.requirements : [] });
    let locked;
    try {
      locked = [...new Set(protectedAssetIds((await bindCurrent(snapshot)).mediaConfig))].sort();
    } catch (error) {
      blocked(error.message);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await this.repository.inTransaction(async (repository) => {
        const tx = repository.db || this.db;
        for (const assetId of locked) await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`void:media-asset:${assetId}`]);
        const { rows } = await tx.query("SELECT id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status FROM experiences WHERE id=$1 FOR UPDATE", [snapshot.id]);
        const current = rows[0];
        if (!current) return { state: "gone" };
        let bound;
        try { bound = await bindCurrent(current); } catch (error) { return { state: "blocked", detail: error.message }; }
        const needed = [...new Set(protectedAssetIds(bound.mediaConfig))].sort();
        if (needed.some((assetId) => !locked.includes(assetId))) return { state: "relock", locked: [...new Set([...locked, ...needed])].sort() };
        for (const assetId of needed) {
          const claimed = await tx.query(ACTIVE_MEDIA_CLAIM_SQL, [current.edition_id, `%"${assetId}"%`]);
          if (claimed.rows.length) return { state: "blocked", detail: "A file this experience unlocks is already used by a different edition." };
        }
        await repository.saveExperience({ id: current.id, artistId: current.artist_id, releaseId: current.release_id, editionId: current.edition_id, title: current.title, description: current.description, experienceType: current.experience_type, requirements: bound.requirements, mediaConfig: bound.mediaConfig, version: Number(current.version || 1), status: "PUBLISHED" });
        return { state: "saved" };
      });
      if (outcome.state === "relock") { locked = outcome.locked; continue; }
      if (outcome.state === "blocked") blocked(outcome.detail);
      return;
    }
    blocked("The experience's files kept changing while publishing; it was left as it was.");
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

  /**
   * The artist's already-registered private files that no experience uses yet, and the public preview
   * clips they uploaded before, so Studio can attach them again without a new upload. Read-only and
   * owner-only. It returns ids, types and sizes only: never a storage key, link or hash.
   */
  async listRegisteredMedia({ request, artistId }) {
    const { artist } = await this.ownedArtist({ artistId, request });
    const [assets, previews] = await Promise.all([
      this.db.query("SELECT a.id, a.media_type, a.created_at, (a.metadata->>'byteSize') AS byte_size, (SELECT i.payload->>'contentType' FROM audit_events u JOIN audit_events i ON i.event_type='STUDIO_MEDIA_UPLOAD_ISSUED' AND i.subject_type='artist' AND i.subject_id=a.artist_id AND i.payload->>'uploadId'=u.payload->>'uploadId' WHERE u.event_type='STUDIO_MEDIA_UPLOADED' AND u.subject_type='media_asset' AND u.subject_id=a.id LIMIT 1) AS content_type FROM media_assets a WHERE a.artist_id=$1 AND a.visibility='PROTECTED' AND NOT EXISTS (SELECT 1 FROM experiences x WHERE x.status<>'ARCHIVED' AND x.media_config::text LIKE '%\"' || a.id || '\"%') ORDER BY a.created_at DESC LIMIT 100", [artist.id]),
      this.db.query("SELECT payload->>'uri' AS uri, max(payload->>'contentType') AS content_type, max(payload->>'byteSize') AS byte_size, max(created_at) AS uploaded_at FROM audit_events WHERE event_type='STUDIO_AUDIO_PREVIEW_UPLOADED' AND subject_type='artist' AND subject_id=$1 AND payload->>'uri' IS NOT NULL GROUP BY payload->>'uri' ORDER BY max(created_at) DESC LIMIT 20", [artist.id]),
    ]);
    const size = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      protected: assets.rows.map((row) => ({ assetId: row.id, mediaType: String(row.media_type || "").toUpperCase(), byteSize: size(row.byte_size), contentType: row.content_type || null, registeredAt: row.created_at || null })),
      previews: previews.rows.map((row) => ({ uri: row.uri, contentType: row.content_type || null, byteSize: size(row.byte_size), uploadedAt: row.uploaded_at || null })),
    };
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


  // Artist profile picture and banner. Stored as a site file and served by
  // this API. This never calls Pinata or any other IPFS uploader. Release
  // artwork still goes through uploadArtwork.
  async uploadPortfolioImage({ request, artistId, input }) {
    const { identity, artist } = await this.ownedArtist({ artistId, request });
    if (typeof this.portfolioStore?.save !== "function") throw new ApiError(503, "PORTFOLIO_UPLOAD_UNAVAILABLE", "Portfolio image upload is not configured.");
    if (String(input.data ?? "").length > Math.ceil(MAX_ARTWORK_BYTES / 3) * 4 + 4) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
    const body = Buffer.from(requiredText(input.data, "data", { max: 20_000_000 }), "base64");
    if (!body.length) throw new ApiError(400, "ARTWORK_UPLOAD_EMPTY", "Artwork upload was empty.");
    if (body.length > MAX_ARTWORK_BYTES) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
    const image = sniffArtwork(body);
    if (!image) throw new ApiError(400, "ARTWORK_TYPE_UNSUPPORTED", "Artwork must be a PNG, JPEG, GIF or WebP image.");
    const contentSha256 = createHash("sha256").update(body).digest("hex");
    const filename = `artist-portfolio-${contentSha256.slice(0, 16)}${image.extension}`;
    let stored;
    try {
      stored = await this.portfolioStore.save({ body, filename, contentType: image.contentType });
    } catch (error) {
      throw new ApiError(error.status || 502, error.code || "PORTFOLIO_UPLOAD_FAILED", error.message || "Portfolio image upload failed.");
    }
    const uri = requiredText(stored?.uri, "uri", { max: 1024 });
    if (!uri.startsWith("/assets/artist-portfolio/")) throw new ApiError(502, "PORTFOLIO_UPLOAD_FAILED", "Portfolio image upload did not return a local site file.");
    await this.audit({ identity, request, eventType: "STUDIO_PORTFOLIO_IMAGE_UPLOADED", subjectType: "artist", subjectId: artist.id, payload: { uri, contentType: image.contentType, contentSha256, byteSize: body.length } });
    return { uri, contentType: image.contentType, byteSize: body.length };
  }

  // Public bytes for a profile picture or banner this service stored. Not a Pinata gateway.
  async openPortfolioImage({ filename }) {
    if (typeof this.portfolioStore?.read !== "function") throw new ApiError(404, "PORTFOLIO_FILE_NOT_FOUND", "Artist portfolio image was not found.");
    let file;
    try {
      file = await this.portfolioStore.read({ filename });
    } catch (error) {
      if (error?.status && error?.code) throw new ApiError(error.status, error.code, error.message);
      throw new ApiError(404, "PORTFOLIO_FILE_NOT_FOUND", "Artist portfolio image was not found.");
    }
    const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    if (!file?.body?.length || !allowed.has(file.contentType)) throw new ApiError(404, "PORTFOLIO_FILE_NOT_FOUND", "Artist portfolio image was not found.");
    return { body: file.body, contentType: file.contentType, filename: file.filename };
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
