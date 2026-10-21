import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { createRateLimiter, requireWalletAuth } from "./api-runtime.js";
import { hashSecret } from "./auth.js";

// Optional "Connect X account": OAuth 2.0 Authorization Code + PKCE, used only to prove
// which X account the signed-in wallet session controls. It is identity linking, not login:
// nothing here grants wallet ownership, creator or marketplace rights. No X tokens are kept.

export const X_LINK_ENV = Object.freeze(["X_OAUTH_CLIENT_ID", "X_OAUTH_CLIENT_SECRET", "X_OAUTH_REDIRECT_URI"]);
const DEFAULT_SCOPES = "users.read tweet.read"; // /2/users/me is documented under tweet.read + users.read
const ATTEMPT_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const NUMERIC_ID = /^\d{1,25}$/;
const STATE = /^[A-Za-z0-9_-]{32,128}$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;

/** Reads X OAuth link configuration. Never throws: missing/invalid values are reported. */
export function loadXLinkConfig(env = {}) {
  const missing = X_LINK_ENV.filter((key) => !String(env[key] || "").trim());
  const invalid = [];
  const redirectUri = String(env.X_OAUTH_REDIRECT_URI || "").trim();
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      const local = ["localhost", "127.0.0.1"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.search || url.hash) invalid.push("X_OAUTH_REDIRECT_URI");
    } catch { invalid.push("X_OAUTH_REDIRECT_URI"); }
  }
  const scopes = String(env.X_OAUTH_SCOPES || DEFAULT_SCOPES).trim().split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.some((scope) => !/^[a-z.]+$/.test(scope))) invalid.push("X_OAUTH_SCOPES");
  return Object.freeze({
    configured: missing.length === 0 && invalid.length === 0,
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
    clientId: String(env.X_OAUTH_CLIENT_ID || "").trim(),
    clientSecret: String(env.X_OAUTH_CLIENT_SECRET || "").trim(),
    redirectUri,
    scopes: Object.freeze(scopes),
    authorizeUrl: String(env.X_OAUTH_AUTHORIZE_URL || "https://x.com/i/oauth2/authorize"),
    apiBase: String(env.X_OAUTH_API_BASE_URL || "https://api.x.com/2").replace(/\/$/, ""),
  });
}

function sessionHashOf(request) {
  const raw = request?.headers?.authorization || request?.headers?.Authorization;
  const match = typeof raw === "string" ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(raw.trim()) : null;
  if (!match) throw new ApiError(401, "UNAUTHORIZED", "A wallet authentication session is required.");
  return hashSecret(match[1]);
}

function publicLink(row) {
  if (!row) return { connected: false };
  return {
    connected: true,
    status: row.status,
    xUserId: row.x_user_id,
    username: row.x_username,
    displayName: row.x_display_name || null,
    profileImageUrl: row.x_profile_image_url || null,
    profileUrl: `https://x.com/${row.x_username}`,
    connectedAt: new Date(row.connected_at).toISOString(),
    verifiedAt: new Date(row.verified_at).toISOString(),
  };
}

export function createXAccountLinkService({ db, authenticator, config, fetchImpl = fetch, now = () => new Date(), logger = console, limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }), callbackLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 }), audit = null } = {}) {
  if (!db?.query) throw new TypeError("X account linking requires a database executor.");
  const log = (level, event, fields) => logger[level]?.(event, fields);

  async function auditQuietly(event) {
    try { await audit?.(event); } catch (error) { log("warn", "x.link.audit_failed", { detail: error?.message }); }
  }

  function assertConfigured() {
    if (!config?.configured) {
      log("error", "x.link.config_missing", { missing: config?.missing || [], invalid: config?.invalid || [] });
      throw new ApiError(503, "X_LINK_NOT_CONFIGURED", "X account linking is not available right now.");
    }
  }

  async function xFetch(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch {
      throw new ApiError(502, "X_API_UNAVAILABLE", "X could not be reached. Try again shortly.");
    } finally { clearTimeout(timer); }
  }

  function basicAuth() { return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`; }

  async function failureFrom(response, fallbackCode) {
    if (response.status === 429) return new ApiError(503, "X_API_RATE_LIMITED", "X is rate limiting requests. Try again later.");
    if (response.status === 400 || response.status === 401 || response.status === 403) return new ApiError(401, fallbackCode, "X did not accept this authorization. Start the connection again.");
    return new ApiError(502, "X_API_UNAVAILABLE", "X returned an unexpected response. Try again shortly.");
  }

  async function exchangeCode({ code, verifier }) {
    const response = await xFetch(`${config.apiBase}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(), accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier, client_id: config.clientId }).toString(),
    });
    if (!response.ok) throw await failureFrom(response, "X_CODE_REJECTED");
    let payload;
    try { payload = await response.json(); } catch { throw new ApiError(502, "X_RESPONSE_MALFORMED", "X returned an unreadable response."); }
    if (typeof payload?.access_token !== "string" || !payload.access_token || String(payload.token_type || "").toLowerCase() !== "bearer") throw new ApiError(502, "X_RESPONSE_MALFORMED", "X returned an unreadable response.");
    return payload.access_token;
  }

  async function fetchIdentity(accessToken) {
    const response = await xFetch(`${config.apiBase}/users/me?user.fields=id,username,name,profile_image_url`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    if (!response.ok) throw await failureFrom(response, "X_IDENTITY_REJECTED");
    let payload;
    try { payload = await response.json(); } catch { throw new ApiError(502, "X_RESPONSE_MALFORMED", "X returned an unreadable response."); }
    const user = payload?.data;
    if (!user || typeof user.id !== "string" || !NUMERIC_ID.test(user.id) || typeof user.username !== "string" || !USERNAME.test(user.username)) throw new ApiError(502, "X_RESPONSE_MALFORMED", "X returned an unreadable response.");
    const name = typeof user.name === "string" ? user.name.slice(0, 100) : null;
    let image = null;
    try { const url = new URL(user.profile_image_url); if (url.protocol === "https:" && /(^|\.)twimg\.com$/.test(url.hostname)) image = url.toString(); } catch { /* optional */ }
    return { id: user.id, username: user.username, name, image };
  }

  async function revokeQuietly(accessToken) {
    try {
      await xFetch(`${config.apiBase}/oauth2/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth() }, body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString() });
    } catch { /* best effort: tokens are never stored */ }
  }

  async function status({ request }) {
    const identity = await requireWalletAuth(authenticator, request);
    const { rows } = await db.query("SELECT * FROM x_account_links WHERE wallet_address=$1 LIMIT 1", [identity.wallet]);
    return { available: Boolean(config?.configured), ...publicLink(rows[0]) };
  }

  async function start({ request }) {
    const identity = await requireWalletAuth(authenticator, request);
    const sessionHash = sessionHashOf(request);
    assertConfigured();
    limiter.check(`x-link-start:${identity.wallet}`);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const issued = now();
    // Invalidate any earlier unconsumed attempt for this wallet: one pending attempt at a time.
    await db.query("UPDATE x_link_attempts SET consumed_at=$2 WHERE wallet_address=$1 AND consumed_at IS NULL", [identity.wallet, issued]);
    await db.query("INSERT INTO x_link_attempts (state_hash, wallet_address, session_hash, code_verifier, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [hashSecret(state), identity.wallet, sessionHash, verifier, issued, new Date(issued.getTime() + ATTEMPT_TTL_MS)]);
    const url = new URL(config.authorizeUrl);
    url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return { authorizationUrl: url.toString(), expiresAt: new Date(issued.getTime() + ATTEMPT_TTL_MS).toISOString() };
  }

  async function complete({ request, input = {} }) {
    const identity = await requireWalletAuth(authenticator, request);
    const sessionHash = sessionHashOf(request);
    assertConfigured();
    callbackLimiter.check(`x-link-callback:${identity.wallet}`);
    const state = input.state;
    if (typeof state !== "string" || !STATE.test(state)) throw new ApiError(400, "X_STATE_INVALID", "The connection request is invalid or missing its state.");
    const current = now();
    // Atomic single-use consume bound to wallet + initiating session + expiry.
    const consumed = await db.query("UPDATE x_link_attempts SET consumed_at=$4 WHERE state_hash=$1 AND wallet_address=$2 AND session_hash=$3 AND consumed_at IS NULL AND expires_at > $4 RETURNING code_verifier", [hashSecret(state), identity.wallet, sessionHash, current]);
    if (!consumed.rows[0]) throw new ApiError(400, "X_STATE_INVALID", "This connection request is expired, already used, or belongs to another session. Start again.");
    if (typeof input.error === "string" && input.error) {
      throw new ApiError(400, input.error === "access_denied" ? "X_AUTH_DENIED" : "X_AUTH_FAILED", input.error === "access_denied" ? "The X authorization was cancelled or denied. Nothing was connected." : "X did not complete the authorization. Nothing was connected.");
    }
    if (typeof input.code !== "string" || !CODE.test(input.code)) throw new ApiError(400, "X_CODE_INVALID", "The authorization response from X was incomplete.");
    const accessToken = await exchangeCode({ code: input.code, verifier: consumed.rows[0].code_verifier });
    let user;
    try { user = await fetchIdentity(accessToken); } finally { await revokeQuietly(accessToken); }
    let row;
    try {
      const result = await db.query(
        `INSERT INTO x_account_links (wallet_address, x_user_id, x_username, x_display_name, x_profile_image_url, connected_at, verified_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$6)
         ON CONFLICT (wallet_address) DO UPDATE SET x_username=EXCLUDED.x_username, x_display_name=EXCLUDED.x_display_name, x_profile_image_url=EXCLUDED.x_profile_image_url, verified_at=EXCLUDED.verified_at, updated_at=EXCLUDED.updated_at
         WHERE x_account_links.x_user_id = EXCLUDED.x_user_id
         RETURNING *`,
        [identity.wallet, user.id, user.username, user.name, user.image, current]);
      row = result.rows[0];
    } catch (error) {
      if (error?.code === "23505") throw new ApiError(409, "X_ACCOUNT_ALREADY_LINKED", "That X account is already connected to another Void account. It was not transferred.");
      log("error", "x.link.persist_failed", { requestId: request.requestId, detail: error?.message });
      throw new ApiError(500, "X_LINK_PERSIST_FAILED", "The X account could not be saved. Your existing connection is unchanged.");
    }
    if (!row) throw new ApiError(409, "X_LINK_EXISTS", "A different X account is already connected. Disconnect it first.");
    await auditQuietly({ eventType: "X_ACCOUNT_LINKED", actorWallet: identity.wallet, subjectType: "x_account", subjectId: user.id, requestId: request.requestId });
    return { available: true, ...publicLink(row) };
  }

  async function disconnect({ request, input = {} }) {
    const identity = await requireWalletAuth(authenticator, request);
    if (input?.confirm !== true) throw new ApiError(400, "X_DISCONNECT_UNCONFIRMED", "Disconnecting requires explicit confirmation.");
    const { rows } = await db.query("DELETE FROM x_account_links WHERE wallet_address=$1 RETURNING x_user_id", [identity.wallet]);
    if (rows[0]) await auditQuietly({ eventType: "X_ACCOUNT_UNLINKED", actorWallet: identity.wallet, subjectType: "x_account", subjectId: rows[0].x_user_id, requestId: request.requestId });
    return { available: Boolean(config?.configured), connected: false };
  }

  return { status, start, complete, disconnect };
}
