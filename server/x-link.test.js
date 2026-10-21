import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createXAccountLinkService, loadXLinkConfig } from "./x-link.js";
import { createApiHandler } from "./api-http.js";
import { createRateLimiter } from "./api-runtime.js";
import { hashSecret } from "./auth.js";

const walletA = "0x1111111111111111111111111111111111111111";
const walletB = "0x2222222222222222222222222222222222222222";
const tokenA = "a".repeat(40);
const tokenA2 = "b".repeat(40);
const tokenB = "c".repeat(40);
const env = { X_OAUTH_CLIENT_ID: "client-id-placeholder", X_OAUTH_CLIENT_SECRET: "client-secret-placeholder", X_OAUTH_REDIRECT_URI: "https://void.example/x/callback" };

const sessions = { [tokenA]: walletA, [tokenA2]: walletA, [tokenB]: walletB };
const authenticator = async (request) => {
  const token = /^Bearer (\S+)$/.exec(request.headers?.authorization || "")?.[1];
  return sessions[token] ? { wallet: sessions[token] } : null;
};
const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, requestId: "req-1" });

/** In-memory stand-in for the three statements the service issues. */
function fakeDb({ failLinkInsert = false } = {}) {
  const attempts = new Map();
  const links = [];
  return {
    attempts, links,
    query: vi.fn(async (sql, p) => {
      if (sql.startsWith("UPDATE x_link_attempts SET consumed_at=$2")) {
        for (const a of attempts.values()) if (a.wallet === p[0] && !a.consumed) a.consumed = p[1];
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO x_link_attempts")) { attempts.set(p[0], { wallet: p[1], session: p[2], verifier: p[3], expires: p[5], consumed: null }); return { rows: [] }; }
      if (sql.startsWith("UPDATE x_link_attempts SET consumed_at=$4")) {
        const a = attempts.get(p[0]);
        if (!a || a.wallet !== p[1] || a.session !== p[2] || a.consumed || a.expires <= p[3]) return { rows: [] };
        a.consumed = p[3];
        return { rows: [{ code_verifier: a.verifier }] };
      }
      if (sql.startsWith("INSERT INTO x_account_links")) {
        if (failLinkInsert) throw new Error("connection terminated");
        const [wallet, id, username, name, image, at] = p;
        if (links.some((l) => l.x_user_id === id && l.wallet_address !== wallet)) throw Object.assign(new Error("duplicate key"), { code: "23505" });
        const mine = links.find((l) => l.wallet_address === wallet);
        if (mine) { if (mine.x_user_id !== id) return { rows: [] }; Object.assign(mine, { x_username: username, x_display_name: name, x_profile_image_url: image, verified_at: at }); return { rows: [mine] }; }
        const row = { wallet_address: wallet, x_user_id: id, x_username: username, x_display_name: name, x_profile_image_url: image, status: "CONNECTED", connected_at: at, verified_at: at };
        links.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT * FROM x_account_links")) return { rows: links.filter((l) => l.wallet_address === p[0]) };
      if (sql.startsWith("DELETE FROM x_account_links")) {
        const i = links.findIndex((l) => l.wallet_address === p[0]);
        return { rows: i >= 0 ? links.splice(i, 1).map((l) => ({ x_user_id: l.x_user_id })) : [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

function xApi({ user = { id: "9001", username: "void_fan", name: "Void Fan", profile_image_url: "https://pbs.twimg.com/profile_images/1/a.jpg" }, tokenStatus = 200, tokenBody, meStatus = 200, meBody } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === "bad") throw new SyntaxError("bad json"); return body; } });
    if (String(url).endsWith("/oauth2/token")) return json(tokenStatus, tokenBody ?? { token_type: "bearer", access_token: "X-ACCESS-TOKEN" });
    if (String(url).includes("/users/me")) return json(meStatus, meBody ?? { data: user });
    if (String(url).endsWith("/oauth2/revoke")) return json(200, { revoked: true });
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetchImpl, calls };
}

function setup({ db = fakeDb(), x = xApi(), config = loadXLinkConfig(env), now, audit = vi.fn(async () => {}), logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } = {}) {
  const service = createXAccountLinkService({ db, authenticator, config, fetchImpl: x.fetchImpl, now, audit, logger });
  return { service, db, x, audit, logger };
}

async function begin(service, token = tokenA) {
  const { authorizationUrl } = await service.start({ request: req(token) });
  return new URL(authorizationUrl);
}

describe("X account linking", () => {
  it("starts an authorization-code + PKCE (S256) flow on X's own page with a CSPRNG state", async () => {
    const { service, db } = setup();
    const url = await begin(service);
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(env.X_OAUTH_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(env.X_OAUTH_REDIRECT_URI);
    expect(q.get("scope")).toBe("users.read tweet.read");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = db.attempts.get(hashSecret(q.get("state")));
    expect(stored.session).toBe(hashSecret(tokenA));
    expect(createHash("sha256").update(stored.verifier).digest("base64url")).toBe(q.get("code_challenge"));
    expect(url.toString()).not.toContain(env.X_OAUTH_CLIENT_SECRET);
    expect([...db.attempts.keys()].includes(q.get("state"))).toBe(false); // only the hash is stored
  });

  it("links the verified X user id and username, exchanging the code server-side with the PKCE verifier", async () => {
    const { service, db, x, audit } = setup();
    const state = (await begin(service)).searchParams.get("state");
    const result = await service.complete({ request: req(tokenA), input: { code: "auth-code", state } });
    expect(result).toMatchObject({ connected: true, status: "CONNECTED", xUserId: "9001", username: "void_fan", profileUrl: "https://x.com/void_fan" });
    const token = x.calls[0];
    expect(token.url).toBe("https://api.x.com/2/oauth2/token");
    expect(token.options.headers.authorization).toBe(`Basic ${Buffer.from("client-id-placeholder:client-secret-placeholder").toString("base64")}`);
    const form = new URLSearchParams(token.options.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe(env.X_OAUTH_REDIRECT_URI);
    expect(form.get("code_verifier")).toBe(db.attempts.get(hashSecret(state)).verifier);
    const me = x.calls[1];
    expect(me.url).toBe("https://api.x.com/2/users/me?user.fields=id,username,name,profile_image_url");
    expect(me.options.headers.authorization).toBe("Bearer X-ACCESS-TOKEN");
    expect(x.calls[2].url).toBe("https://api.x.com/2/oauth2/revoke");
    expect(x.calls).toHaveLength(3); // exact calls: token, users/me, revoke
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("X-ACCESS-TOKEN");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "X_ACCOUNT_LINKED", actorWallet: walletA, subjectId: "9001" }));
    expect(await service.status({ request: req(tokenA) })).toMatchObject({ connected: true, username: "void_fan" });
  });

  it("does not trust a user-supplied username: identity comes only from X's authenticated-user response", async () => {
    const { service } = setup();
    const state = (await begin(service)).searchParams.get("state");
    const result = await service.complete({ request: req(tokenA), input: { code: "c", state, username: "elonmusk", xUserId: "1" } });
    expect(result.username).toBe("void_fan");
    expect(result.xUserId).toBe("9001");
  });

  it.each([[undefined], ["short"], ["x".repeat(43)], [{ a: 1 }]])("rejects missing or invalid state (%#)", async (state) => {
    const { service, x } = setup();
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state } })).rejects.toMatchObject({ code: "X_STATE_INVALID" });
    expect(x.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a callback from another session, another wallet, or after replay, without calling X", async () => {
    const { service, x } = setup();
    const state = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA2), input: { code: "c", state } })).rejects.toMatchObject({ code: "X_STATE_INVALID" }); // same wallet, different session
    const state2 = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenB), input: { code: "c", state: state2 } })).rejects.toMatchObject({ code: "X_STATE_INVALID" }); // other wallet
    expect(x.fetchImpl).not.toHaveBeenCalled();
    await service.complete({ request: req(tokenA), input: { code: "c", state: state2 } });
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state: state2 } })).rejects.toMatchObject({ code: "X_STATE_INVALID" }); // replay
  });

  it("rejects an expired attempt and a superseded attempt", async () => {
    let clock = new Date("2026-10-21T12:00:00Z");
    const { service } = setup({ now: () => clock });
    const old = (await begin(service)).searchParams.get("state");
    const fresh = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state: old } })).rejects.toMatchObject({ code: "X_STATE_INVALID" });
    clock = new Date(clock.getTime() + 11 * 60_000);
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state: fresh } })).rejects.toMatchObject({ code: "X_STATE_INVALID" });
  });

  it("handles denial/cancellation safely: consumes the attempt, links nothing, never calls X", async () => {
    const { service, db, x } = setup();
    const state = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA), input: { error: "access_denied", state } })).rejects.toMatchObject({ code: "X_AUTH_DENIED", status: 400 });
    expect(db.links).toHaveLength(0);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state } })).rejects.toMatchObject({ code: "X_STATE_INVALID" });
  });

  it("rejects a missing or oversized authorization code", async () => {
    const { service } = setup();
    for (const code of [undefined, "", "a".repeat(3000), "has space"]) {
      const state = (await begin(service)).searchParams.get("state");
      await expect(service.complete({ request: req(tokenA), input: { code, state } })).rejects.toMatchObject({ code: "X_CODE_INVALID" });
    }
  });

  it("is idempotent for the same X account and refreshes the username", async () => {
    const db = fakeDb();
    await (async () => {
      const first = setup({ db });
      await first.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(first.service)).searchParams.get("state") } });
    })();
    const renamed = setup({ db, x: xApi({ user: { id: "9001", username: "renamed", name: "N" } }) });
    const result = await renamed.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(renamed.service)).searchParams.get("state") } });
    expect(result.username).toBe("renamed");
    expect(db.links).toHaveLength(1);
  });

  it("refuses to link an X account already linked to another Void user, without transferring it", async () => {
    const db = fakeDb();
    const a = setup({ db });
    await a.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(a.service)).searchParams.get("state") } });
    const b = setup({ db });
    await expect(b.service.complete({ request: req(tokenB), input: { code: "c", state: (await begin(b.service, tokenB)).searchParams.get("state") } })).rejects.toMatchObject({ code: "X_ACCOUNT_ALREADY_LINKED", status: 409 });
    expect(db.links).toEqual([expect.objectContaining({ wallet_address: walletA, x_user_id: "9001" })]);
  });

  it("does not silently replace a different X account on the same Void user", async () => {
    const db = fakeDb();
    const a = setup({ db });
    await a.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(a.service)).searchParams.get("state") } });
    const other = setup({ db, x: xApi({ user: { id: "777", username: "other" } }) });
    await expect(other.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(other.service)).searchParams.get("state") } })).rejects.toMatchObject({ code: "X_LINK_EXISTS", status: 409 });
    expect(db.links[0].x_user_id).toBe("9001");
  });

  it("leaves identity unchanged and reports a clear error when the database fails during linking", async () => {
    const db = fakeDb({ failLinkInsert: true });
    const { service, logger } = setup({ db });
    const state = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state } })).rejects.toMatchObject({ code: "X_LINK_PERSIST_FAILED", status: 500 });
    expect(db.links).toHaveLength(0);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("X-ACCESS-TOKEN");
  });

  it("unlinks only the caller's own connection and requires explicit confirmation", async () => {
    const db = fakeDb();
    const a = setup({ db });
    await a.service.complete({ request: req(tokenA), input: { code: "c", state: (await begin(a.service)).searchParams.get("state") } });
    await expect(a.service.disconnect({ request: req(tokenA), input: {} })).rejects.toMatchObject({ code: "X_DISCONNECT_UNCONFIRMED" });
    await a.service.disconnect({ request: req(tokenB), input: { confirm: true } }); // B has nothing to unlink
    expect(db.links).toHaveLength(1);
    expect(await a.service.status({ request: req(tokenB) })).toMatchObject({ connected: false });
    const result = await a.service.disconnect({ request: req(tokenA), input: { confirm: true } });
    expect(result).toMatchObject({ connected: false });
    expect(db.links).toHaveLength(0);
    expect(a.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "X_ACCOUNT_UNLINKED", actorWallet: walletA }));
  });

  it("requires an authenticated Void session for every operation", async () => {
    const { service, db } = setup();
    for (const call of [() => service.status({ request: req() }), () => service.start({ request: req() }), () => service.complete({ request: req("z".repeat(40)), input: {} }), () => service.disconnect({ request: req(), input: { confirm: true } })]) {
      await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails clearly, and fakes nothing, when X configuration is missing or invalid", async () => {
    const missing = loadXLinkConfig({});
    expect(missing).toMatchObject({ configured: false, missing: ["X_OAUTH_CLIENT_ID", "X_OAUTH_CLIENT_SECRET", "X_OAUTH_REDIRECT_URI"] });
    const invalid = loadXLinkConfig({ ...env, X_OAUTH_REDIRECT_URI: "http://void.example/x/callback?x=1" });
    expect(invalid).toMatchObject({ configured: false, invalid: ["X_OAUTH_REDIRECT_URI"] });
    expect(loadXLinkConfig({ ...env, X_OAUTH_REDIRECT_URI: "http://localhost:5173/x/callback" }).configured).toBe(true);
    const { service, x } = setup({ config: missing });
    await expect(service.start({ request: req(tokenA) })).rejects.toMatchObject({ code: "X_LINK_NOT_CONFIGURED", status: 503 });
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state: "s".repeat(43) } })).rejects.toMatchObject({ code: "X_LINK_NOT_CONFIGURED" });
    expect(await service.status({ request: req(tokenA) })).toEqual({ available: false, connected: false });
    expect(x.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["token exchange rejected", { tokenStatus: 400 }, "X_CODE_REJECTED"],
    ["token exchange rate limited", { tokenStatus: 429 }, "X_API_RATE_LIMITED"],
    ["token exchange server error", { tokenStatus: 503 }, "X_API_UNAVAILABLE"],
    ["token response malformed", { tokenBody: { nope: true } }, "X_RESPONSE_MALFORMED"],
    ["identity lookup rate limited", { meStatus: 429 }, "X_API_RATE_LIMITED"],
    ["identity lookup unauthorized", { meStatus: 401 }, "X_IDENTITY_REJECTED"],
    ["identity missing data", { meBody: {} }, "X_RESPONSE_MALFORMED"],
    ["identity id not numeric", { meBody: { data: { id: "abc", username: "ok" } } }, "X_RESPONSE_MALFORMED"],
    ["identity username invalid", { meBody: { data: { id: "1", username: "bad name!" } } }, "X_RESPONSE_MALFORMED"],
    ["identity not JSON", { meBody: "bad" }, "X_RESPONSE_MALFORMED"],
  ])("maps X API failure safely: %s", async (_name, options, code) => {
    const db = fakeDb();
    const { service } = setup({ db, x: xApi(options) });
    const state = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state } })).rejects.toMatchObject({ code });
    expect(db.links).toHaveLength(0);
  });

  it("reports a network failure to X as unavailable", async () => {
    const x = { fetchImpl: vi.fn(async () => { throw new Error("ECONNRESET"); }), calls: [] };
    const { service } = setup({ x });
    const state = (await begin(service)).searchParams.get("state");
    await expect(service.complete({ request: req(tokenA), input: { code: "c", state } })).rejects.toMatchObject({ code: "X_API_UNAVAILABLE", status: 502 });
  });

  it("rate limits connection attempts and callback processing per wallet", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const callbackLimiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const service = createXAccountLinkService({ db: fakeDb(), authenticator, config: loadXLinkConfig(env), fetchImpl: xApi().fetchImpl, limiter, callbackLimiter });
    await service.start({ request: req(tokenA) });
    await service.start({ request: req(tokenA) });
    await expect(service.start({ request: req(tokenA) })).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await service.start({ request: req(tokenB) }); // other wallets are unaffected
    await expect(service.complete({ request: req(tokenA), input: {} })).rejects.toMatchObject({ code: "X_STATE_INVALID" });
    await expect(service.complete({ request: req(tokenA), input: {} })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("X link HTTP routes", () => {
  function http(xLink) {
    const handler = createApiHandler({ service: {}, xLink, logger: { error() {} } });
    return async (method, path, { token, body } = {}) => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
      const request = Object.assign((async function* () { yield* chunks; })(), { method, url: path, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: "1.1.1.1" } });
      let out = { status: 0, body: null };
      const response = { writeHead(status) { out.status = status; }, end(text) { out.body = text ? JSON.parse(text) : null; } };
      await handler(request, response);
      return out;
    };
  }

  it("routes status/start/callback/disconnect and returns 401 without a session", async () => {
    const db = fakeDb();
    const { service } = setup({ db });
    const call = http(service);
    expect((await call("GET", "/api/x-link")).status).toBe(401);
    expect((await call("POST", "/api/x-link/start")).status).toBe(401);
    expect((await call("POST", "/api/x-link/disconnect", { body: { confirm: true } })).status).toBe(401);
    const started = await call("POST", "/api/x-link/start", { token: tokenA, body: {} });
    expect(started.status).toBe(200);
    const state = new URL(started.body.data.authorizationUrl).searchParams.get("state");
    const done = await call("POST", "/api/x-link/callback", { token: tokenA, body: { code: "c", state } });
    expect(done.body.data).toMatchObject({ connected: true, username: "void_fan" });
    expect((await call("GET", "/api/x-link", { token: tokenB })).body.data.connected).toBe(false);
    expect((await call("POST", "/api/x-link/disconnect", { token: tokenA, body: { confirm: true } })).body.data.connected).toBe(false);
  });

  it("returns 503 when linking is not wired", async () => {
    const call = http(null);
    expect((await call("GET", "/api/x-link", { token: tokenA })).status).toBe(503);
  });
});

describe("X link stays out of authorization", () => {
  it("works for a wallet with no link, and no auth/ownership/marketplace/studio code reads x_account_links", async () => {
    const { service } = setup();
    expect(await service.status({ request: req(tokenA) })).toMatchObject({ connected: false, available: true });
    const { readFile } = await import("node:fs/promises");
    for (const file of ["auth.js", "wallet-auth.js", "ownership.js", "legacy-ownership.js", "studio-service.js", "artist-authorization.js", "api-service.js", "media-gateway.js", "verification-service.js"]) {
      expect(await readFile(new URL(`./${file}`, import.meta.url), "utf8"), file).not.toMatch(/x_account_links|x-link/);
    }
  });
});

describe("migration 042", () => {
  it("enforces the X user id as the unique external key and denies PostgREST access", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("./migrations/042_x_account_links.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/x_user_id text NOT NULL UNIQUE/);
    expect(sql).toMatch(/wallet_address text PRIMARY KEY/);
    expect(sql).toMatch(/ALTER TABLE x_account_links ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE x_link_attempts ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/access_token|refresh_token|secret/i);
  });
});
