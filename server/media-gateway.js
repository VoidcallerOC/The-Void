import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { requiredText, walletAddress } from "./validation.js";

const ACTIVE_OWNERSHIP_STATES = new Set(["CONFIRMED", "FINALIZED", "RECONCILED"]);
const SUPPORTED_MEDIA_TYPES = new Set(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "DEMO", "LIVE_RECORDING"]);

function mediaType(value) {
  const type = requiredText(value, "mediaType", { max: 64 }).toUpperCase();
  if (!SUPPORTED_MEDIA_TYPES.has(type)) throw new ApiError(400, "UNSUPPORTED_MEDIA_TYPE", "The requested protected media type is unsupported.");
  return type;
}

function parseMediaConfig(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "{}")); } catch { throw new ApiError(500, "EXPERIENCE_MEDIA_CONFIGURATION_INVALID", "Experience media configuration is invalid."); }
}

function protectedObject(experience, requestedMediaType) {
  const config = parseMediaConfig(experience.media_config);
  if (config.protected !== true) throw new ApiError(409, "EXPERIENCE_MEDIA_NOT_PROTECTED", "This experience has no protected media for this endpoint.");
  const candidates = Array.isArray(config.protectedMedia) ? config.protectedMedia : [];
  const asset = candidates.find((item) => String(item?.mediaType || "").toUpperCase() === requestedMediaType);
  if (!asset || typeof asset !== "object" || !String(asset.storageKey || "").trim()) throw new ApiError(503, "PROTECTED_MEDIA_NOT_CONFIGURED", "Protected media is not configured for this experience.");
  return { storageKey: String(asset.storageKey).trim(), contentType: String(asset.contentType || "").trim() || null };
}

function fingerprint(value, secret) {
  if (!value) return null;
  return createHash("sha256").update(`${secret || "development-only-audit-salt"}:${String(value)}`).digest("hex");
}

function accessContext(request = {}, secret = null) {
  return { requestId: request.requestId || null, ipHash: fingerprint(request.headers?.["x-forwarded-for"] || request.ip, secret), userAgentHash: fingerprint(request.headers?.["user-agent"], secret) };
}

export class ProtectedMediaGateway {
  constructor({ db, repository, authenticator, ownershipVerifier, storage, mediaConfig } = {}) {
    if (!db?.query || !repository || !authenticator || typeof ownershipVerifier !== "function" || !storage || !mediaConfig) throw new TypeError("ProtectedMediaGateway requires persistence, wallet authentication, ownership verification, private storage, and media configuration.");
    this.db = db;
    this.repository = repository;
    this.authenticator = authenticator;
    this.ownershipVerifier = ownershipVerifier;
    this.storage = storage;
    this.mediaConfig = mediaConfig;
  }

  async loadExperience(experienceId) {
    const { rows } = await this.db.query("SELECT id, requirements, media_config, status FROM experiences WHERE id=$1 AND status='PUBLISHED' LIMIT 1", [requiredText(experienceId, "experienceId")]);
    if (!rows[0]) throw new ApiError(404, "EXPERIENCE_NOT_FOUND", "Experience was not found.");
    return rows[0];
  }

  async assertEntitlement({ wallet, experience }) {
    const ownership = await this.ownershipVerifier({ wallet, experienceId: experience.id, requirements: experience.requirements, mediaConfig: parseMediaConfig(experience.media_config) });
    if (!ownership?.owns || !ACTIVE_OWNERSHIP_STATES.has(String(ownership.state || "").toUpperCase())) throw new ApiError(403, "EXPERIENCE_ENTITLEMENT_REQUIRED", "Current confirmed ownership of the required experience entitlement is required.");
    return ownership;
  }

  async issueGrant({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.wallet, "wallet");
    const wallet = walletAddress(identity.wallet);
    const requestedMediaType = mediaType(input.mediaType);
    const experience = await this.loadExperience(input.experienceId);
    const asset = protectedObject(experience, requestedMediaType);
    let ownership;
    try { ownership = await this.assertEntitlement({ wallet, experience }); } catch (error) {
      await this.repository.appendAuditEvent({ eventType: "MEDIA_ACCESS_DENIED", actorWallet: wallet, subjectType: "experience", subjectId: experience.id, requestId: request.requestId || null, payload: { mediaType: requestedMediaType, reason: error.code || "ENTITLEMENT_DENIED" } });
      throw error;
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + (this.mediaConfig.grantTtlSeconds * 1000));
    const grantId = randomUUID();
    const context = accessContext(request, this.mediaConfig.auditHashSecret);
    const grant = await this.repository.inTransaction(async (repository) => {
      const created = await repository.createGrant({ grantId, experienceId: experience.id, wallet, mediaType: requestedMediaType, issuedAt, expiresAt, ownershipChainId: ownership.chainId ?? null, ownershipWatermark: ownership.watermark ?? null, metadata: { storageKey: asset.storageKey, contentType: asset.contentType, entitlementState: String(ownership.state).toUpperCase() } });
      await repository.recordMediaAuthorization({ grantId, wallet, experienceId: experience.id, mediaType: requestedMediaType, action: "GRANT_ISSUED", ...context });
      await repository.appendAuditEvent({ eventType: "MEDIA_GRANT_ISSUED", actorWallet: wallet, subjectType: "experience", subjectId: experience.id, requestId: context.requestId, chainId: ownership.chainId ?? null, payload: { grantId, mediaType: requestedMediaType, expiresAt: expiresAt.toISOString(), ownershipWatermark: ownership.watermark ?? null } });
      return created;
    });
    return { state: "CONFIRMED", grantId: grant.grant_id, expiresAt: grant.expires_at || expiresAt.toISOString(), accessUrl: `/api/media/${encodeURIComponent(grant.grant_id)}` };
  }

  async revokeGrant({ request, input }) {
    const identity = await requireWalletAuth(this.authenticator, request);
    assertWalletMatches(identity, input.wallet, "wallet");
    const wallet = walletAddress(identity.wallet);
    const context = accessContext(request, this.mediaConfig.auditHashSecret);
    const revoked = await this.repository.inTransaction(async (repository) => {
      const grant = await repository.revokeMediaGrant({ grantId: input.grantId, wallet, reason: input.reason || "wallet_requested" });
      await repository.recordMediaAuthorization({ grantId: grant.grant_id, wallet, experienceId: grant.experience_id, mediaType: grant.media_type, action: "REVOKED", reason: input.reason || "wallet_requested", ...context });
      await repository.appendAuditEvent({ eventType: "MEDIA_GRANT_REVOKED", actorWallet: wallet, subjectType: "experience", subjectId: grant.experience_id, requestId: context.requestId, payload: { grantId: grant.grant_id, mediaType: grant.media_type } });
      return grant;
    });
    return { state: "REVOKED", grantId: revoked.grant_id, revokedAt: revoked.revoked_at };
  }

  async openMedia({ request, grantId }) {
    const grant = await this.repository.getMediaGrant({ grantId, includeInactive: true });
    if (!grant) {
      await this.repository.appendAuditEvent({ eventType: "MEDIA_ACCESS_DENIED", subjectType: "media_grant", subjectId: String(grantId), requestId: request.requestId || null, payload: { reason: "GRANT_NOT_FOUND" } });
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Protected media was not found.");
    }
    const context = accessContext(request, this.mediaConfig.auditHashSecret);
    if (grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now()) {
      await this.repository.recordMediaAuthorization({ grantId: grant.grant_id, wallet: grant.wallet_address, experienceId: grant.experience_id, mediaType: grant.media_type, action: "MEDIA_DENIED", reason: grant.revoked_at ? "GRANT_REVOKED" : "GRANT_EXPIRED", ...context });
      throw new ApiError(403, grant.revoked_at ? "MEDIA_GRANT_REVOKED" : "MEDIA_GRANT_EXPIRED", "Protected media authorization is no longer active.");
    }
    const metadata = parseMediaConfig(grant.metadata);
    if (!metadata.storageKey) throw new ApiError(500, "MEDIA_GRANT_CONFIGURATION_INVALID", "Protected media grant is missing its immutable object reference.");
    const media = await this.storage.open({ storageKey: metadata.storageKey, range: request.headers?.range || null, contentType: metadata.contentType || null });
    await this.repository.recordMediaAuthorization({ grantId: grant.grant_id, wallet: grant.wallet_address, experienceId: grant.experience_id, mediaType: grant.media_type, action: "MEDIA_AUTHORIZED", reason: media.type === "redirect" ? "SIGNED_OBJECT_URL" : "PRIVATE_STREAM", ...context });
    await this.repository.appendAuditEvent({ eventType: "MEDIA_ACCESS_AUTHORIZED", actorWallet: grant.wallet_address, subjectType: "experience", subjectId: grant.experience_id, requestId: context.requestId, payload: { grantId: grant.grant_id, mediaType: grant.media_type, delivery: media.type } });
    return media;
  }
}

export function createProtectedMediaGateway(options) { return new ProtectedMediaGateway(options); }
