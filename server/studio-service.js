import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { chainId, enumValue, nonNegativeBigInt, optionalText, positiveBigInt, requiredText, walletAddress } from "./validation.js";

const LIFECYCLE = Object.freeze(["DRAFT", "REVIEW", "PUBLISHED"]);
const TYPES = Object.freeze(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "ARTWORK", "LYRICS", "DEMO", "LIVE_RECORDING", "TICKET", "VIP_ACCESS", "DISCOUNT", "PHYSICAL_REDEMPTION"]);

function normalizedSlug(value, field) {
  const slug = requiredText(value, field, { max: 96 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ApiError(400, "INVALID_SLUG", `${field} must use lowercase letters, numbers, and single hyphens.`);
  return slug;
}

function contractAddress(value, field) {
  const address = requiredText(value, field, { max: 42 }).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ApiError(400, "INVALID_CONTRACT_ADDRESS", `${field} must be a 20-byte EVM address.`);
  return address;
}

function lifecycle(value, field = "status") { return enumValue(String(value || "").toUpperCase(), field, LIFECYCLE); }
function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_METADATA", `${field} must be a JSON object.`);
  return value;
}
function requireMediaConfig(value) {
  const config = jsonObject(value, "mediaConfig");
  if (config.protected !== true) return config;
  if (!Array.isArray(config.protectedMedia) || !config.protectedMedia.length) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_REQUIRED", "Protected experiences require protectedMedia configuration.");
  for (const asset of config.protectedMedia) {
    if (!asset || typeof asset !== "object" || !String(asset.storageKey || "").trim()) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Every protected media object requires a private storage key.");
    if (String(asset.storageKey).includes("..") || String(asset.storageKey).startsWith("/")) throw new ApiError(400, "PROTECTED_MEDIA_CONFIGURATION_INVALID", "Protected media storage keys must be relative and traversal-safe.");
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
  constructor({ db, repository, authenticator, logger = console } = {}) {
    if (!db?.query || !repository || typeof authenticator !== "function") throw new TypeError("ArtistStudioService requires persistence and wallet authentication.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
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

  async createArtist({ request, input }) {
    const identity = await this.identity(request);
    const wallet = input.ownerWallet ? walletAddress(input.ownerWallet, "ownerWallet") : identity.wallet;
    assertWalletMatches(identity, wallet, "ownerWallet");
    const id = input.id ? requiredText(input.id, "artist.id", { max: 128 }) : `artist-${randomUUID()}`;
    const artist = await this.repository.inTransaction(async (repository) => {
      const saved = await repository.saveArtist({ id, slug: normalizedSlug(input.slug || input.name, "artist.slug"), displayName: requiredText(input.name, "artist.name", { max: 256 }), metadata: jsonObject(input.metadata, "artist.metadata") });
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
    const release = await this.repository.saveRelease({ id, artistId: artist.id, slug: normalizedSlug(input.slug || input.title, "release.slug"), title: requiredText(input.title, "release.title", { max: 256 }), description: optionalText(input.description, "release.description", { max: 20000 }), status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork ? { artwork: optionalText(input.artwork, "artwork", { max: 2048 }) } : {}) }, "release.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_CREATED", subjectType: "release", subjectId: release.id, payload: { artistId: artist.id } });
    return release;
  }

  async updateRelease({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    if (release.status === "PUBLISHED" && input.status && lifecycle(input.status) !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", "Published releases cannot return to an earlier lifecycle state.");
    const saved = await this.repository.saveRelease({ id: release.id, artistId: release.artist_id, slug: input.slug === undefined ? release.slug : normalizedSlug(input.slug, "release.slug"), title: input.title === undefined ? release.title : requiredText(input.title, "release.title", { max: 256 }), description: input.description === undefined ? release.description : optionalText(input.description, "release.description", { max: 20000 }), status: input.status === undefined ? release.status : lifecycle(input.status), metadata: input.metadata === undefined ? release.release_metadata : jsonObject(input.metadata, "release.metadata"), publishedAt: lifecycle(input.status || release.status) === "PUBLISHED" ? (release.published_at || new Date()) : null });
    await this.audit({ identity, request, eventType: "STUDIO_RELEASE_UPDATED", subjectType: "release", subjectId: release.id });
    return saved;
  }

  async createEdition({ request, releaseId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT r.*, ao.owner_wallet FROM releases r JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE r.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(releaseId, "releaseId"), identity.wallet]);
    const release = rows[0];
    if (!release) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this release.");
    const selectedChainId = chainId(input.chainId, "edition.chainId");
    const address = contractAddress(input.contractAddress, "edition.contractAddress");
    const tokenId = nonNegativeBigInt(input.tokenId, "edition.tokenId");
    const id = input.id ? requiredText(input.id, "edition.id", { max: 128 }) : `edition-${randomUUID()}`;
    const edition = await this.repository.inTransaction(async (repository) => {
      const contract = await repository.saveContract({ chainId: selectedChainId, chainKey: input.chainKey || String(selectedChainId), address, contractType: "ERC1155", name: optionalText(input.contractName, "edition.contractName", { max: 256 }), metadata: jsonObject(input.contractMetadata, "edition.contractMetadata") });
      const saved = await repository.saveEdition({ id, releaseId: release.id, contractId: contract.id, title: requiredText(input.name || input.title, "edition.name", { max: 256 }), tier: optionalText(input.tier, "edition.tier", { max: 128 }), description: optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? null : positiveBigInt(input.quantity, "edition.quantity"), status: "DRAFT", metadata: jsonObject({ ...(input.metadata || {}), ...(input.artwork === undefined ? {} : { artwork: optionalText(input.artwork, "edition.artwork", { max: 2048 }) }), priceWei: input.priceWei === undefined ? null : positiveBigInt(input.priceWei, "edition.priceWei"), marketplace: jsonObject(input.marketplace, "edition.marketplace") }, "edition.metadata") });
      await repository.saveToken({ editionId: saved.id, contractId: contract.id, tokenId, metadataUri: optionalText(input.metadataUri, "edition.metadataUri", { max: 2048 }), metadata: input.tokenMetadata === undefined ? null : jsonObject(input.tokenMetadata, "edition.tokenMetadata") });
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
    const saved = await this.repository.saveEdition({ id: edition.id, releaseId: edition.release_id, contractId: edition.contract_id, title: input.name === undefined && input.title === undefined ? edition.title : requiredText(input.name || input.title, "edition.name", { max: 256 }), tier: input.tier === undefined ? edition.tier : optionalText(input.tier, "edition.tier", { max: 128 }), description: input.description === undefined ? edition.description : optionalText(input.description, "edition.description", { max: 20000 }), supply: input.quantity === undefined ? edition.supply : positiveBigInt(input.quantity, "edition.quantity"), status: input.status === undefined ? edition.status : lifecycle(input.status), metadata: input.metadata === undefined ? edition.application_metadata : jsonObject(input.metadata, "edition.metadata") });
    await this.audit({ identity, request, eventType: "STUDIO_EDITION_UPDATED", subjectType: "edition", subjectId: edition.id });
    return saved;
  }

  async createExperience({ request, editionId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT e.*, r.artist_id, ao.owner_wallet FROM editions e JOIN releases r ON r.id=e.release_id JOIN artist_owners ao ON ao.artist_id=r.artist_id WHERE e.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(editionId, "editionId"), identity.wallet]);
    const edition = rows[0];
    if (!edition) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this edition.");
    const id = input.id ? requiredText(input.id, "experience.id", { max: 128 }) : `experience-${randomUUID()}`;
    const experience = await this.repository.saveExperience({ id, artistId: edition.artist_id, releaseId: edition.release_id, editionId: edition.id, title: requiredText(input.title, "experience.title", { max: 256 }), description: optionalText(input.description, "experience.description", { max: 20000 }), experienceType: enumValue(String(input.type || input.experienceType || "").toUpperCase(), "experience.type", TYPES), requirements: requireRequirements(input.requirements), mediaConfig: requireMediaConfig(input.mediaConfig), status: "DRAFT" });
    await this.audit({ identity, request, eventType: "STUDIO_EXPERIENCE_CREATED", subjectType: "experience", subjectId: experience.id, payload: { editionId: edition.id } });
    return experience;
  }

  async updateExperience({ request, experienceId, input }) {
    const identity = await this.identity(request);
    const { rows } = await this.db.query("SELECT x.*, ao.owner_wallet FROM experiences x JOIN artist_owners ao ON ao.artist_id=x.artist_id WHERE x.id=$1 AND ao.owner_wallet=$2 LIMIT 1", [requiredText(experienceId, "experienceId"), identity.wallet]);
    const experience = rows[0];
    if (!experience) throw new ApiError(403, "ARTIST_ACCESS_DENIED", "The authenticated wallet cannot manage this experience.");
    if (experience.status === "PUBLISHED" && input.status && lifecycle(input.status) !== "PUBLISHED") throw new ApiError(409, "LIFECYCLE_TRANSITION_INVALID", "Published experiences cannot return to an earlier lifecycle state.");
    const saved = await this.repository.saveExperience({ id: experience.id, artistId: experience.artist_id, releaseId: experience.release_id, editionId: experience.edition_id, title: input.title === undefined ? experience.title : requiredText(input.title, "experience.title", { max: 256 }), description: input.description === undefined ? experience.description : optionalText(input.description, "experience.description", { max: 20000 }), experienceType: input.type === undefined && input.experienceType === undefined ? experience.experience_type : enumValue(String(input.type || input.experienceType).toUpperCase(), "experience.type", TYPES), requirements: input.requirements === undefined ? experience.requirements : requireRequirements(input.requirements), mediaConfig: input.mediaConfig === undefined ? experience.media_config : requireMediaConfig(input.mediaConfig), version: Number(experience.version || 1) + 1, status: input.status === undefined ? experience.status : lifecycle(input.status) });
    await this.audit({ identity, request, eventType: "STUDIO_EXPERIENCE_UPDATED", subjectType: "experience", subjectId: experience.id });
    return saved;
  }
}

export function createArtistStudioService(options) { return new ArtistStudioService(options); }
