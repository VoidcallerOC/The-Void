import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { ApiError } from "./api-errors.js";

const PURPOSE = "wallet-login";
const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function normalizeAddress(value) {
  try { return getAddress(String(value || "")); } catch { throw new ApiError(400, "INVALID_WALLET", "wallet must be a valid EVM address."); }
}
function originOf(value) {
  try { return new URL(String(value)).origin; } catch { throw new ApiError(400, "INVALID_ORIGIN", "Authentication origin is invalid."); }
}
function cookieValue(header, name) {
  return String(header || "").split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.slice(1).join("=") || null;
}
function challengeMessage({ domain, address, uri, chainId, nonce, issuedAt, expiration, purpose }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nAuthenticate to The-Void.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiration}\nResources:\n- urn:the-void:purpose:${purpose}`;
}

export function createWalletAuthenticator({ db, config, now = () => new Date(), nonceTtlMs = NONCE_TTL_MS, sessionTtlMs = SESSION_TTL_MS } = {}) {
  if (!db?.query) throw new TypeError("Wallet authentication requires a database executor.");
  const authOrigin = originOf(config.authDomain || config.publicAppUrl);
  const authUri = String(config.authUri || `${authOrigin}/`);
  const chainId = Number(config.authChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new TypeError("Wallet authentication requires a valid chain id.");

  function requestContext(request = {}) {
    const origin = request.headers?.origin || authOrigin;
    if (originOf(origin) !== authOrigin) throw new ApiError(403, "ORIGIN_MISMATCH", "The request origin is not authorized for wallet authentication.");
    return { origin: authOrigin, domain: new URL(authOrigin).host, uri: authUri };
  }

  async function issueChallenge({ wallet, request, purpose = PURPOSE, requestId } = {}) {
    if (purpose !== PURPOSE) throw new ApiError(400, "INVALID_PURPOSE", "Unsupported authentication purpose.");
    const address = normalizeAddress(wallet);
    const { domain, uri } = requestContext(request);
    const issued = now();
    const expires = new Date(issued.getTime() + nonceTtlMs);
    const nonce = randomBytes(32).toString("base64url");
    const message = challengeMessage({ domain, address, uri, chainId, nonce, purpose, issuedAt: issued.toISOString(), expiration: expires.toISOString() });
    await db.query("INSERT INTO auth_nonces (nonce_hash, wallet_address, domain, origin, uri, chain_id, purpose, issued_at, expires_at, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [hash(nonce), address.toLowerCase(), domain, authOrigin, uri, chainId, purpose, issued, expires, requestId || null]);
    return { address, domain, origin: authOrigin, uri, chainId, nonce, purpose, issuedAt: issued.toISOString(), expiration: expires.toISOString(), message };
  }

  async function verify({ wallet, signature, nonce, purpose = PURPOSE, request, requestId } = {}) {
    if (purpose !== PURPOSE) throw new ApiError(400, "INVALID_PURPOSE", "Unsupported authentication purpose.");
    const claimed = normalizeAddress(wallet);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length !== 132) throw new ApiError(400, "MALFORMED_SIGNATURE", "signature must be a 65-byte EIP-191 signature.");
    if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 256) throw new ApiError(400, "INVALID_NONCE", "nonce is invalid.");
    const { domain, uri } = requestContext(request);
    const consumedAt = now();
    const challenge = await db.query("SELECT issued_at, expires_at FROM auth_nonces WHERE nonce_hash=$1 AND wallet_address=$2 AND domain=$3 AND origin=$4 AND uri=$5 AND chain_id=$6 AND purpose=$7 AND consumed_at IS NULL LIMIT 1", [hash(nonce), claimed.toLowerCase(), domain, authOrigin, uri, chainId, purpose]);
    if (!challenge.rows[0] || new Date(challenge.rows[0].expires_at) <= consumedAt) throw new ApiError(401, "CHALLENGE_INVALID", "Challenge is expired, consumed, mismatched, or unknown.");
    const issued = challenge.rows[0].issued_at instanceof Date ? challenge.rows[0].issued_at.toISOString() : new Date(challenge.rows[0].issued_at).toISOString();
    const expiration = challenge.rows[0].expires_at instanceof Date ? challenge.rows[0].expires_at.toISOString() : new Date(challenge.rows[0].expires_at).toISOString();
    const message = challengeMessage({ domain, address: claimed, uri, chainId, nonce, purpose, issuedAt: issued, expiration });
    let recovered;
    try { recovered = getAddress(verifyMessage(message, signature)); } catch { throw new ApiError(401, "INVALID_SIGNATURE", "The wallet signature could not be recovered."); }
    if (recovered !== claimed) throw new ApiError(401, "WALLET_MISMATCH", "The signature was produced by a different wallet.");
    const result = await db.query("UPDATE auth_nonces SET consumed_at=$1 WHERE nonce_hash=$2 AND wallet_address=$3 AND domain=$4 AND origin=$5 AND uri=$6 AND chain_id=$7 AND purpose=$8 AND consumed_at IS NULL AND expires_at > $1 RETURNING issued_at, expires_at", [consumedAt, hash(nonce), claimed.toLowerCase(), domain, authOrigin, uri, chainId, purpose]);
    if (!result.rows[0]) throw new ApiError(401, "CHALLENGE_INVALID", "Challenge is expired, consumed, mismatched, or unknown.");
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(consumedAt.getTime() + sessionTtlMs);
    await db.query("INSERT INTO auth_sessions (token_hash, wallet_address, chain_id, issued_at, expires_at, request_id) VALUES ($1,$2,$3,$4,$5,$6)", [hash(token), claimed.toLowerCase(), chainId, consumedAt, expires, requestId || null]);
    return { token, wallet: claimed, chainId, expiresAt: expires.toISOString() };
  }

  async function authenticate(request = {}) {
    const raw = request.headers?.authorization?.replace(/^Bearer\s+/i, "") || cookieValue(request.headers?.cookie, "void_session");
    if (!raw) return null;
    const result = await db.query("SELECT wallet_address, chain_id, expires_at FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1", [hash(raw)]);
    if (!result.rows[0] || Number(result.rows[0].chain_id) !== chainId) return null;
    return { wallet: getAddress(result.rows[0].wallet_address), chainId, expiresAt: new Date(result.rows[0].expires_at).toISOString() };
  }
  return { issueChallenge, verify, authenticate, sessionCookie: (token, expiresAt) => `void_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}` };
}

export { challengeMessage, hash, PURPOSE };
