import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { chainId, enumValue, nonNegativeBigInt, optionalText, positiveBigInt, requiredText, walletAddress } from "./validation.js";
import deployment from "../config/fuji-release.json" with { type: "json" };
import { canonicalMetadata } from "./metadata-storage.js";
import { canonicalProvenanceManifest, protectedMediaCommitments, provenanceCommitment } from "./provenance-manifest.js";

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
function patchStatus(input, current, noun) {
  if (input.status === undefined) return current;
  const next = lifecycle(input.status);
  if (next === "PUBLISHED") throw new ApiError(409, "PUBLICATION_REQUIRES_CONFIRMATION", `Only confirmed on-chain publication can mark a ${noun} published.`);
  if (current === "PUBLISHED" && next !== current) throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", `Published ${noun}s cannot return to an earlier lifecycle state.`);
  return next;
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
  constructor({ db, repository, authenticator, metadataStorage = null, mediaUploader = null, logger = console } = {}) {
    if (!db?.query || !repository || typeof authenticator !== "function") throw new TypeError("ArtistStudioService requires persistence and wallet authentication.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.metadataStorage = metadataStorage;
    this.mediaUploader = mediaUploader;
    this.logger = logger;
  }

  async identity(request) { return requireWalletAuth(this.authenticator, request); }
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
    if (!this.metadataStorage) throw new ApiError(503, "METADATA_STORAGE_NOT_CONFIGURED", "The release is ready, but metadata publication needs to be completed before blockchain publication.");
    if (release.status === "PUBLISHED") throw new ApiError(409, "RELEASE_ALREADY_PUBLISHED", "This release has already been published and its metadata is immutable.");
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.metadata, t.metadata_version FROM editions e LEFT JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY e.created_at DESC LIMIT 1", [release.id]);
    const edition = editionResult.rows[0];
    if (!edition) throw new ApiError(400, "EDITION_REQUIRED", "Create an edition before publishing the release.");
    const experiences = await this.db.query("SELECT id, title, description, experience_type, media_config, version FROM experiences WHERE edition_id=$1 ORDER BY created_at ASC LIMIT 100", [edition.id]);
    const mediaAssets = await this.db.query("SELECT id, media_type, metadata FROM media_assets WHERE artist_id=$1", [release.artist_id]);
    const generated = canonicalMetadata({ release, edition, artist: { name: release.display_name }, artwork: input.artwork, includes: input.includes || edition.application_metadata?.includes, experiences: experiences.rows, releaseType: input.releaseType, tier: edition.tier });
    const provenance = provenanceForPublication({ release, edition, wallet: identity.wallet, metadataDigest: generated.digest, experiences: experiences.rows, mediaAssets: mediaAssets.rows, input, previous: edition.metadata?.provenance });
    const metadataDocument = { ...generated.metadata, _void: { version: 1, digest: generated.digest }, provenance: provenance.record };
    const previous = edition.metadata_version && edition.metadata_uri && edition.metadata?.["_void"]?.digest === generated.digest && edition.metadata?.provenance?.root === provenance.root ? { uri: edition.metadata_uri } : null;
    const stored = previous || await this.metadataStorage.write({ metadata: metadataDocument, name: `${release.slug}-${edition.id}` });
    await this.repository.saveToken({ editionId: edition.id, contractId: edition.contract_id, tokenId: certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name")), metadataUri: stored.uri, metadata: metadataDocument, metadataVersion: generated.digest });
    await this.audit({ identity, request, eventType: "STUDIO_METADATA_PUBLISHED", subjectType: "release", subjectId: release.id, payload: { editionId: edition.id, digest: generated.digest, provenanceRoot: provenance.root } });
    const editionSlug = generatedSlug(edition.title, "edition name");
    return { releaseId: release.id, editionId: edition.id, releaseSlug: release.slug, editionSlug, tokenId: certifiedTokenId(release.slug, editionSlug).toString(), metadataUri: stored.uri, digest: generated.digest, provenanceRoot: provenance.root };
  }

  async confirmPublication({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const transactionHash = requiredText(input?.transactionHash, "transactionHash", { max: 128 }).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new ApiError(400, "TRANSACTION_INVALID", "The publication transaction could not be verified.");
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot publish this release.");
    const editionResult = await this.db.query("SELECT e.*, t.metadata_uri, t.token_id FROM editions e JOIN tokens t ON t.edition_id=e.id WHERE e.release_id=$1 ORDER BY e.created_at DESC LIMIT 1", [release.id]);
    const edition = editionResult.rows[0];
    if (!edition?.metadata_uri) throw new ApiError(409, "METADATA_REQUIRED", "Metadata must be published before the blockchain transaction can be confirmed.");
    try {
      const provider = new ethers.JsonRpcProvider(deployment.rpcUrl);
      const receipt = await provider.getTransactionReceipt(transactionHash);
      if (!receipt || receipt.status !== 1) throw new Error("receipt unavailable or unsuccessful");
      const eventInterface = new ethers.Interface([...deployment.abi, "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
      const expectedTokenId = certifiedTokenId(release.slug, generatedSlug(edition.title, "edition name"));
      const expectedReleaseId = ethers.encodeBytes32String(requiredText(release.slug, "release.slug", { max: 31 }));
      const expectedEditionId = ethers.encodeBytes32String(generatedSlug(edition.title, "edition name"));
      const event = receipt.logs.map((log) => { try { return eventInterface.parseLog(log); } catch { return null; } }).find((parsed) => parsed?.name === "EditionCreated" && parsed.args.tokenId === expectedTokenId && parsed.args.releaseId === expectedReleaseId && parsed.args.editionId === expectedEditionId && parsed.args.metadataUri === edition.metadata_uri);
      if (!event) throw new Error("expected EditionCreated event was not found");
      const contract = new ethers.Contract(CERTIFIED_CONTRACT, [...deployment.abi, "function edition(uint256) view returns (bytes32, bytes32, address, uint256, uint256, string, bool)"], provider);
      const onChain = await contract.edition(expectedTokenId);
      if (!onChain[6] || onChain[5] !== edition.metadata_uri) throw new Error("on-chain edition verification failed");
      await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: edition.title, tier: edition.tier, description: edition.description, supply: edition.supply, status: "PUBLISHED", metadata: edition.application_metadata || {} });
      await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: release.title, description: release.description, status: "PUBLISHED", metadata: release.release_metadata || {}, publishedAt: release.published_at || new Date() });
      await this.publishReleaseExperiences(release);
      await this.audit({ identity, request, eventType: "STUDIO_PUBLICATION_CONFIRMED", subjectType: "release", subjectId: release.id, payload: { transactionHash, tokenId: expectedTokenId.toString() } });
      return { releaseId: release.id, editionId: edition.id, tokenId: expectedTokenId.toString(), transactionHash, status: "PUBLISHED" };
    } catch (error) {
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
    const slug = await availableSlug(this.db, { table: "releases", scopeColumn: "artist_id", scopeValue: artist.id, value: title, field: "release title" });
    const release = await this.repository.saveRelease({ id, artistId: artist.id, slug, title, description: optionalText(input.description, "release.description", { max: 20000 }), status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork ? { artwork: optionalText(input.artwork, "artwork", { max: 2048 }) } : {}) }, "release.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_CREATED", subjectType: "release", subjectId: release.id, payload: { artistId: artist.id } });
    return release;
  }

  async updateRelease({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    if (release.status === "PUBLISHED" && input.status && lifecycle(input.status) !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", "Published releases cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, release.status, "release");
    const saved = await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: release.slug, title: input.title === undefined ? release.title : requiredText(input.title, "release.title", { max: 256 }), description: input.description === undefined ? release.description : optionalText(input.description, "release.description", { max: 20000 }), status, metadata: input.metadata === undefined ? release.release_metadata : jsonObject(input.metadata, "release.metadata"), publishedAt: status === "PUBLISHED" ? (release.published_at || new Date()) : null });
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
    const id = input.id ? requiredText(input.id, "edition.id", { max: 128 }) : `edition-${randomUUID()}`;
    const edition = await this.repository.inTransaction(async (repository) => {
      const contract = await repository.saveContract({ chainId: selectedChainId, chainKey: input.chainKey || String(selectedChainId), address, contractType: "ERC1155", name: optionalText(input.contractName, "edition.contractName", { max: 256 }), metadata: jsonObject(input.contractMetadata, "edition.contractMetadata") });
      const saved = await repository.saveEdition({ id, releaseId: release.id, contractId: contract.id, title: editionName, tier: optionalText(input.tier, "edition.tier", { max: 128 }), description: optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? null : positiveBigInt(input.quantity, "edition.quantity"), status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork === undefined ? {} : { artwork: optionalText(input.artwork, "edition.artwork", { max: 2048 }) }), priceWei: input.priceWei === undefined ? null : positiveBigInt(input.priceWei, "edition.priceWei"), marketplace: jsonObject(input.marketplace, "edition.marketplace") }, "edition.metadata") });
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
    if (edition.status === "PUBLISHED" && input.status && lifecycle(input.status) !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", "Published editions cannot return to an earlier lifecycle state.");
    const status = patchStatus(input, edition.status, "edition");
    const saved = await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: input.name === undefined && input.title === undefined ? edition.title : requiredText(input.name || input.title, "edition.name", { max: 256 }), tier: input.tier === undefined ? edition.tier : optionalText(input.tier, "edition.tier", { max: 128 }), description: input.description === undefined ? edition.description : optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? edition.supply : positiveBigInt(input.quantity, "edition.quantity"), status, metadata: input.metadata === undefined ? edition.application_metadata : jsonObject(input.metadata, "edition.metadata") });
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
    const bound = await this.bindProtectedExperience({ artistId: edition.artist_id, mediaConfig: input.mediaConfig, requirements: input.requirements });
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
    if (experience.status === "PUBLISHED" && input.status && lifecycle(input.status) !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", "Published experiences cannot return to an earlier lifecycle state.");
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
    const stored = await this.mediaUploader({ artistId: artist.id, body, filename: optionalText(input.filename, "filename", { max: 256 }) || "upload.bin", contentType: optionalText(input.contentType, "contentType", { max: 128 }) || "application/octet-stream", mediaType });
    const storageKey = requiredText(stored?.storageKey, "storageKey", { max: 1024 });
    const id = `asset-${randomUUID()}`;
    const asset = await this.repository.saveMediaAsset({ id, artistId: artist.id, storageKey, mediaType, contentSha256, byteSize: body.length });
    await this.audit({ identity, request, eventType: "STUDIO_MEDIA_UPLOADED", subjectType: "media_asset", subjectId: asset.id, payload: { mediaType, contentSha256 } });
    return { id: asset.id, mediaType: asset.media_type || mediaType, createdAt: asset.created_at || null };
  }
}

export function createArtistStudioService(options) { return new ArtistStudioService(options); }
