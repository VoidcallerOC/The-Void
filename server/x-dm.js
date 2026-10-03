import { createHmac, randomBytes } from "node:crypto";

// Server-side X (Twitter) API v2 client for one job: sending a reviewer-alert
// DM from The Void's configured X account. Credentials never leave the server
// and the recipient comes only from server configuration.
//
// Auth: OAuth 1.0a user context (consumer key/secret + the sending account's
// access token/secret). The X app needs "Read, write, and Direct Messages"
// permission and an API access tier that includes the DM endpoints.

export const X_DM_ENV = Object.freeze(["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]);
const DEFAULT_RECIPIENT = "voidcallerOC";
const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const NUMERIC_ID = /^\d{1,25}$/;

/** Reads X DM configuration. Never throws: a missing value is reported, not fatal. */
export function loadXDmConfig(env = {}) {
  const missing = X_DM_ENV.filter((key) => !String(env[key] || "").trim());
  const recipientUsername = String(env.X_DM_RECIPIENT_USERNAME || DEFAULT_RECIPIENT).trim().replace(/^@/, "");
  const recipientId = String(env.X_DM_RECIPIENT_ID || "").trim();
  const invalid = [];
  if (!USERNAME.test(recipientUsername)) invalid.push("X_DM_RECIPIENT_USERNAME");
  if (recipientId && !NUMERIC_ID.test(recipientId)) invalid.push("X_DM_RECIPIENT_ID");
  return Object.freeze({
    configured: missing.length === 0 && invalid.length === 0,
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
    recipientUsername,
    recipientId: recipientId || null,
    apiBase: String(env.X_API_BASE_URL || "https://api.x.com/2").replace(/\/$/, ""),
    credentials: Object.freeze({
      consumerKey: String(env.X_API_KEY || "").trim(),
      consumerSecret: String(env.X_API_SECRET || "").trim(),
      token: String(env.X_ACCESS_TOKEN || "").trim(),
      tokenSecret: String(env.X_ACCESS_TOKEN_SECRET || "").trim(),
    }),
  });
}

function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** OAuth 1.0a HMAC-SHA1 Authorization header. JSON bodies are not signed (per spec). */
export function oauth1Header({ method, url, credentials, nonce = randomBytes(16).toString("hex"), timestamp = Math.floor(Date.now() / 1000) }) {
  const parsed = new URL(url);
  const params = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.token,
    oauth_version: "1.0",
  };
  const all = [...Object.entries(params), ...parsed.searchParams.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  const base = [method.toUpperCase(), rfc3986(`${parsed.origin}${parsed.pathname}`), rfc3986(all.map(([key, value]) => `${key}=${value}`).join("&"))].join("&");
  const signingKey = `${rfc3986(credentials.consumerSecret)}&${rfc3986(credentials.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...params, oauth_signature: signature }).map(([key, value]) => `${rfc3986(key)}="${rfc3986(value)}"`).join(", ")}`;
}

// A short, credential-free description of an X API failure.
function describeFailure(status, body) {
  const detail = body && typeof body === "object" ? [body.title, body.detail, body.errors?.[0]?.message].filter(Boolean).join(": ") : "";
  return `X API HTTP ${status}${detail ? ` ${detail}` : ""}`.slice(0, 300);
}

/** 429 and 5xx (and network errors) are worth retrying; other 4xx are not. */
export function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

export function createXDmClient({ config, fetchImpl = fetch }) {
  let resolvedRecipientId = config.recipientId;

  async function call(method, path, payload) {
    const url = `${config.apiBase}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: oauth1Header({ method, url, credentials: config.credentials }), ...(payload ? { "content-type": "application/json" } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch (error) {
      return { ok: false, retryable: true, code: "NETWORK_ERROR", detail: `Network error reaching X API: ${String(error?.message || error).slice(0, 200)}` };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, retryable: isRetryableStatus(response.status), code: `HTTP_${response.status}`, detail: describeFailure(response.status, body) };
    return { ok: true, body };
  }

  async function recipientId() {
    if (resolvedRecipientId) return { ok: true, id: resolvedRecipientId };
    const result = await call("GET", `/users/by/username/${encodeURIComponent(config.recipientUsername)}`);
    if (!result.ok) return result;
    const id = result.body?.data?.id;
    if (!NUMERIC_ID.test(String(id || ""))) return { ok: false, retryable: false, code: "RECIPIENT_NOT_FOUND", detail: `X user @${config.recipientUsername} was not found.` };
    resolvedRecipientId = String(id);
    return { ok: true, id: resolvedRecipientId };
  }

  /** Sends `text` to the configured recipient. Returns { ok, messageId } or a failure. */
  async function send(text) {
    if (!config.configured) return { ok: false, retryable: false, code: "CONFIG_MISSING", detail: `X DM not configured: missing ${[...config.missing, ...config.invalid].join(", ")}` };
    const recipient = await recipientId();
    if (!recipient.ok) return recipient;
    const result = await call("POST", `/dm_conversations/with/${recipient.id}/messages`, { text });
    if (!result.ok) return result;
    return { ok: true, messageId: result.body?.data?.dm_event_id || null, recipientId: recipient.id };
  }

  return { send, recipientUsername: config.recipientUsername };
}
