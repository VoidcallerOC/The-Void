import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { requireWalletAuth } from "./api-runtime.js";
import { MEDIA_AUTH_TTL_SECONDS, PROTECTED_MEDIA_TYPES } from "../src/lib/media-auth.js";

const MEDIA = Object.freeze({
  "audio/ep1-01-the-hollow.mp3": { experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 },
  "audio/ep1-02-dont-look-down.mp3": { experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 },
  "audio/ep1-03-shattered.mp3": { experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 },
  "audio/ep1-04-starlight.mp3": { experienceId: "self-titled", mediaType: "AUDIO", chainId: 43114 },
});

function requirementMatches(requirement, ownership) {
  if (!requirement || requirement.type !== "ownership") return false;
  return ownership.some((record) => String(record.contract_address || "").toLowerCase() === String(requirement.contract || "").toLowerCase() && Number(record.chain_id) === Number(requirement.chainId) && (requirement.tokenIds || []).map(String).includes(String(record.token_id)) && BigInt(record.amount || 0) >= BigInt(requirement.minAmount || 1));
}

export function createMediaService({ db, repository, authenticator, storage, ownershipVerifier = null, now = () => new Date() } = {}) {
  if (!db?.query || !repository || !storage) throw new TypeError("Media service requires database, repository, and private storage.");
  async function verifyOwnership({ wallet, experienceId, chainId }) {
    if (ownershipVerifier) return ownershipVerifier({ wallet, experienceId, chainId });
    const experience = await db.query("SELECT id, requirements, media_config FROM experiences WHERE id=$1 AND status='PUBLISHED' LIMIT 1", [experienceId]);
    if (!experience.rows[0]) return { owns: false, state: "NOT_FOUND" };
    const requirements = Array.isArray(experience.rows[0].requirements) ? experience.rows[0].requirements : [];
    const owned = await db.query("SELECT chain_id, contract_address, token_id, amount FROM ownership_snapshots WHERE wallet_address=$1 AND chain_id=$2 AND amount > 0 LIMIT 1000", [wallet.toLowerCase(), chainId]);
    const owns = requirements.length > 0 && requirements.every((requirement) => requirementMatches(requirement, owned.rows));
    return { owns, state: owns ? "CONFIRMED" : "UNAUTHORIZED", chainId, watermark: owned.rows[0]?.synchronization_watermark || null };
  }
  async function issueGrant({ request, mediaKey, experienceId, mediaType, chainId, requestId }) {
    const identity = await requireWalletAuth(authenticator, request);
    const descriptor = MEDIA[mediaKey];
    if (!descriptor || descriptor.experienceId !== experienceId || descriptor.mediaType !== mediaType || Number(descriptor.chainId) !== Number(chainId)) throw new ApiError(403, "MEDIA_MISMATCH", "The requested media is not valid for this experience and chain.");
    if (!PROTECTED_MEDIA_TYPES.has(mediaType)) throw new ApiError(400, "INVALID_MEDIA_TYPE", "Unsupported protected media type.");
    const ownership = await verifyOwnership({ wallet: identity.wallet, experienceId, chainId: Number(chainId) });
    const grantId = randomUUID();
    if (!ownership?.owns || !["CONFIRMED", "FINALIZED"].includes(ownership.state)) {
      await repository.appendAuditEvent({ eventType: "MEDIA_ACCESS_DENIED", actorWallet: identity.wallet, subjectType: "media", subjectId: mediaKey, requestId, chainId, payload: { experienceId, mediaType, reason: ownership?.state || "OWNERSHIP_NOT_VERIFIED" } });
      throw new ApiError(403, "MEDIA_NOT_AUTHORIZED", "Current token ownership does not authorize this media.");
    }
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + MEDIA_AUTH_TTL_SECONDS * 1000);
    await repository.createGrant({ grantId, experienceId, wallet: identity.wallet, mediaType, issuedAt, expiresAt, ownershipChainId: chainId, ownershipWatermark: ownership.watermark, metadata: { mediaKey } });
    await repository.recordMediaAuthorization({ grantId, wallet: identity.wallet, experienceId, mediaType, action: "GRANT_ISSUED", requestId, reason: "ownership_verified" });
    return { grantId, mediaKey, wallet: identity.wallet, chainId: Number(chainId), expiresAt: expiresAt.toISOString() };
  }
  async function stream({ request, mediaKey, requestId }) {
    const descriptor = MEDIA[mediaKey];
    if (!descriptor) throw new ApiError(404, "MEDIA_NOT_FOUND", "Protected media was not found.");
    const grant = await issueGrant({ request, mediaKey, experienceId: descriptor.experienceId, mediaType: descriptor.mediaType, chainId: descriptor.chainId, requestId });
    const asset = await storage.stat(mediaKey);
    await repository.recordMediaAuthorization({ grantId: grant.grantId, wallet: grant.wallet, experienceId: descriptor.experienceId, mediaType: descriptor.mediaType, action: "MEDIA_AUTHORIZED", requestId, reason: "stream_started" });
    return { ...asset, stream: storage.stream(mediaKey), grant };
  }
  async function revoke({ request, grantId, requestId }) {
    const identity = await requireWalletAuth(authenticator, request);
    const grant = await repository.revokeMediaGrant({ grantId, wallet: identity.wallet });
    if (!grant) throw new ApiError(404, "GRANT_NOT_FOUND", "The grant was not found or was already revoked.");
    await repository.recordMediaAuthorization({ grantId, wallet: identity.wallet, experienceId: grant.experience_id, mediaType: grant.media_type, action: "REVOKED", requestId, reason: "wallet_requested_revocation" });
    return { grantId, revokedAt: grant.revoked_at };
  }
  return { issueGrant, stream, revoke, catalog: MEDIA, storage };
}
