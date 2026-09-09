import { createExperience } from "../domain/models.js";
import { createMediaChallenge, createAuthorizationGrant, grantAllows, PROTECTED_MEDIA_TYPES } from "./media-auth.js";

export const CATALOG_STORAGE_KEY = "voidcaller.experience-catalog.v1";
export const REDEMPTION_STATES = Object.freeze({ AVAILABLE: "AVAILABLE", RESERVED: "RESERVED", REDEEMED: "REDEEMED", CANCELLED: "CANCELLED" });
const REDEMPTION_TRANSITIONS = Object.freeze({ AVAILABLE: ["RESERVED", "CANCELLED"], RESERVED: ["REDEEMED", "CANCELLED"], REDEEMED: [], CANCELLED: [] });

function nowIso() { return new Date().toISOString(); }
function randomId(prefix) { return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`; }
function requireText(value, name) { if (!String(value || "").trim()) throw new Error(`${name} is required`); }

export function createCatalogSnapshot({ experiences = [], version = 1, updatedAt = nowIso() } = {}) {
  return { version, updatedAt, experiences: experiences.map((experience) => createExperience(experience)) };
}

export function readCatalog(storage, fallback = createCatalogSnapshot()) {
  if (!storage?.getItem) return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(CATALOG_STORAGE_KEY));
    return parsed?.version === 1 && Array.isArray(parsed.experiences) ? parsed : fallback;
  } catch { return fallback; }
}

export function writeCatalog(storage, snapshot) {
  const next = createCatalogSnapshot(snapshot);
  storage?.setItem?.(CATALOG_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function configureArtistExperience({ catalog, artistId, experience }) {
  requireText(artistId, "artistId");
  const nextExperience = createExperience(experience);
  const existing = catalog.experiences.find((item) => item.id === nextExperience.id);
  if (existing && existing.artistId && existing.artistId !== artistId) throw new Error("Only the owning artist may update this experience");
  return createCatalogSnapshot({ ...catalog, experiences: [...catalog.experiences.filter((item) => item.id !== nextExperience.id), { ...nextExperience, artistId }] });
}

export function createChallengeResponse({ wallet, experienceId, nonce, issuedAt } = {}) {
  return { status: 200, challenge: createMediaChallenge({ wallet, experienceId, nonce, issuedAt }) };
}

export function issueMediaGrant({ challenge, signature, wallet, experience, grantId = randomId("grant"), verifySignature, ownsExperience, now = Math.floor(Date.now() / 1000) }) {
  requireText(signature, "signature");
  if (!challenge || challenge.wallet !== wallet?.toLowerCase() || challenge.experienceId !== experience?.id) throw new Error("Challenge does not match the request");
  if (typeof verifySignature !== "function" || !verifySignature({ challenge, signature, wallet })) throw new Error("Invalid wallet signature");
  if (typeof ownsExperience !== "function" || !ownsExperience({ wallet, experience })) throw new Error("Current ownership could not be verified");
  const grant = createAuthorizationGrant({ wallet, experienceId: experience.id, grantId, mediaType: experience.media?.type?.toUpperCase() || "AUDIO", issuedAt: now });
  return { grant, audit: createDownloadAudit({ action: "grant_issued", wallet, experienceId: experience.id, grantId }) };
}

export function authorizeMediaRequest({ grant, wallet, experienceId, mediaType, now, auditLog }) {
  const allowed = grantAllows(grant, { wallet, experienceId, mediaType, now });
  const audit = createDownloadAudit({ action: allowed ? "media_authorized" : "media_denied", wallet, experienceId, grantId: grant?.grantId || null, mediaType, reason: allowed ? "grant_valid" : "grant_invalid_or_expired" });
  auditLog?.append?.(audit);
  return { allowed, audit };
}

export function createDownloadAudit({ action, wallet = "", experienceId = "", grantId = null, mediaType = null, reason = "" }) {
  return { id: randomId("audit"), action, wallet: wallet.toLowerCase(), experienceId, grantId, mediaType, reason, createdAt: nowIso() };
}

export function createAuditLog(storage, key = "voidcaller.media-audit.v1") {
  const read = () => { try { return JSON.parse(storage?.getItem?.(key) || "[]"); } catch { return []; } };
  return { append(entry) { const entries = [...read(), entry]; storage?.setItem?.(key, JSON.stringify(entries)); return entry; }, entries: read };
}

export function createRedemption({ id = randomId("redemption"), experienceId, wallet, type = "PHYSICAL_REDEMPTION", state = REDEMPTION_STATES.AVAILABLE, metadata = {} }) {
  requireText(experienceId, "experienceId");
  requireText(wallet, "wallet");
  if (!Object.values(REDEMPTION_STATES).includes(state)) throw new Error(`Unsupported redemption state: ${state}`);
  return { id, experienceId, wallet: wallet.toLowerCase(), type, state, metadata, createdAt: nowIso(), updatedAt: nowIso() };
}

export function transitionRedemption(redemption, nextState, { actor = "system", note = "" } = {}) {
  if (!REDEMPTION_STATES[nextState] || !REDEMPTION_TRANSITIONS[redemption.state]?.includes(nextState)) throw new Error(`Invalid redemption transition: ${redemption.state} -> ${nextState}`);
  return { ...redemption, state: nextState, updatedAt: nowIso(), lastAction: { actor, note, at: nowIso() } };
}

export function supportedGatewayMediaType(type) { return PROTECTED_MEDIA_TYPES.has(String(type || "").toUpperCase()); }
