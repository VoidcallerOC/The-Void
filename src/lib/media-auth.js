// Client/server contract for protected collector media. The server must verify the
// wallet signature and current ownership before issuing a short-lived grant.
export const MEDIA_AUTH_TTL_SECONDS = 300;
export const PROTECTED_MEDIA_TYPES = new Set(["AUDIO", "VIDEO", "STEMS", "DOWNLOAD", "DEMO", "LIVE_RECORDING"]);

export function createMediaChallenge({ wallet, experienceId, nonce, issuedAt = Math.floor(Date.now() / 1000) }) {
  if (!wallet || !experienceId || !nonce) throw new Error("wallet, experienceId, and nonce are required");
  return { domain: "voidcaller.media", wallet: wallet.toLowerCase(), experienceId, nonce, issuedAt, statement: `Authorize ${experienceId} media for ${wallet.toLowerCase()}.` };
}
export function isAuthorizationFresh({ issuedAt, expiresAt }, { now = Math.floor(Date.now() / 1000) } = {}) { return Number.isFinite(Number(issuedAt)) && Number.isFinite(Number(expiresAt)) && now >= Number(issuedAt) && now < Number(expiresAt); }
export function createAuthorizationGrant({ wallet, experienceId, grantId, chainId = 43114, issuedAt = Math.floor(Date.now() / 1000), ttlSeconds = MEDIA_AUTH_TTL_SECONDS, mediaType = "AUDIO" }) {
  if (!wallet || !experienceId || !grantId) throw new Error("wallet, experienceId, and grantId are required");
  if (!PROTECTED_MEDIA_TYPES.has(mediaType)) throw new Error(`Unsupported protected media type: ${mediaType}`);
  if (!Number.isInteger(Number(chainId))) throw new Error("chainId is required for protected media grants");
  return { wallet: wallet.toLowerCase(), experienceId, grantId, chainId: Number(chainId), mediaType, issuedAt, expiresAt: issuedAt + ttlSeconds, revokedAt: null };
}
export function grantAllows(grant, { wallet, experienceId, chainId = grant?.chainId, mediaType, now } = {}) { return Boolean(grant && !grant.revokedAt && grant.wallet === wallet?.toLowerCase() && grant.experienceId === experienceId && Number(grant.chainId) === Number(chainId) && grant.mediaType === mediaType && isAuthorizationFresh(grant, { now })); }
export function protectedMediaUrl({ origin, grantId }) { if (!origin || !grantId) throw new Error("origin and grantId are required"); return `${origin.replace(/\/$/, "")}/media/${encodeURIComponent(grantId)}`; }
