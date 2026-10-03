import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { setImmediate as tick } from "node:timers/promises";
import { createArtistVerificationService } from "./verification-service.js";
import { buildVerificationDm, createVerificationNotifier, reviewUrlFor } from "./verification-notifier.js";
import { createXDmClient, loadXDmConfig, oauth1Header } from "./x-dm.js";
import { createApiHandler } from "./api-http.js";

// Artist submits verification → The Void sends ONE X DM to @voidcallerOC with
// the request and a direct review link. The DM is an alert only: the link still
// needs a signed-in reviewer wallet.

const APPLICANT = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const REVIEWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APP_URL = "https://the-void-alpha.vercel.app";
const CONFIGURED_ENV = { X_API_KEY: "ck", X_API_SECRET: "cs", X_ACCESS_TOKEN: "at", X_ACCESS_TOKEN_SECRET: "ats", X_DM_RECIPIENT_ID: "1234567890" };

const input = () => ({
  artistName: "Voidcaller", legalName: "Private Name", email: "private@example.com", location: "CT", artistType: "Musician",
  artistBio: "Metalcore.", workDescription: "Records.", yearsActive: "10", verificationEvidence: "Official site.", websiteUrl: "https://voidcaller.example",
});
const requestFor = (wallet) => ({ headers: { authorization: `Bearer ${wallet}` }, requestId: "req-1" });

// In-memory outbox with the same contract as the SQL store: UNIQUE event_key,
// conditional claim, finish only from SENDING.
function memoryStore() {
  const rows = new Map();
  let seq = 0;
  const now = () => Date.now();
  return {
    rows,
    async insertIfAbsent({ applicationId, eventKey, payload }) {
      if ([...rows.values()].some((row) => row.event_key === eventKey)) return null;
      const row = { id: `n${++seq}`, application_id: applicationId, event_key: eventKey, status: "PENDING", payload, attempts: 0, next_attempt_at: now(), created_at: now() };
      rows.set(row.id, row);
      return { ...row };
    },
    async claim(id) {
      const row = rows.get(id);
      if (!row || !["PENDING", "RETRY", "CONFIG_MISSING"].includes(row.status) || (row.next_attempt_at && row.next_attempt_at > now())) return null;
      Object.assign(row, { status: "SENDING", attempts: row.attempts + 1, last_attempt_at: now() });
      return { ...row };
    },
    async finish(id, { status, nextAttemptMinutes = null, error = null, messageId = null, attempts = null }) {
      const row = rows.get(id);
      if (!row || row.status !== "SENDING") return null;
      Object.assign(row, { status, next_attempt_at: nextAttemptMinutes == null ? null : now() + nextAttemptMinutes * 60_000, last_error: error, provider_message_id: messageId ?? row.provider_message_id, sent_at: status === "SENT" ? now() : row.sent_at, attempts: attempts ?? row.attempts });
      return { ...row };
    },
    async dueIds() { return [...rows.values()].filter((row) => ["PENDING", "RETRY", "CONFIG_MISSING"].includes(row.status) && (!row.next_attempt_at || row.next_attempt_at <= now())).map((row) => row.id); },
    async markStaleClaims() { return []; },
    async enqueueMissing() { return []; },
    async forApplication(applicationId) { return [...rows.values()].reverse().find((row) => row.application_id === applicationId) || null; },
    makeDue() { for (const row of rows.values()) row.next_attempt_at = now() - 1; },
  };
}

// X API double: records every request; respond() decides the reply per call.
function fakeX(respond = () => ({ status: 201, body: { data: { dm_event_id: "dm-1" } } })) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    const reply = respond(calls.length, url);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  return { calls, fetchImpl, dms: () => calls.filter((call) => call.method === "POST") };
}

function harness({ env = CONFIGURED_ENV, respond, store = memoryStore() } = {}) {
  const x = fakeX(respond);
  const xConfig = loadXDmConfig(env);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const notifier = createVerificationNotifier({ store, xClient: createXDmClient({ config: xConfig, fetchImpl: x.fetchImpl }), xConfig, publicAppUrl: APP_URL, logger });
  return { x, store, notifier, logger, xConfig };
}

const application = (overrides = {}) => ({ id: "app-1", public_id: "va_abc123", artist_name: "Voidcaller", submitted_at: "2026-10-03T00:15:00.000Z", status: "SUBMITTED", ...overrides });
const events = (logger, level) => logger[level].mock.calls.map(([event]) => event);

// Database double for the verification service (applications + events only).
function verificationDb({ live = null, existing = [] } = {}) {
  const apps = [...existing];
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes("verification_rate_limits")) return { rows: [{ count: 1 }] };
    if (sql.includes("verification_reviewers")) return { rows: [] };
    if (sql.includes("status = ANY") && sql.includes("wallet_address=$1")) return { rows: live ? [live] : [] };
    if (sql.includes("artist_owners")) return { rows: [] };
    if (sql.startsWith("INSERT INTO artist_verification_applications")) {
      const row = { id: params[0], public_id: params[1], wallet_address: params[2], artist_name: params[5], status: "SUBMITTED", submitted_at: params[26], created_at: params[26] };
      apps.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith("INSERT INTO verification_status_events")) return { rows: [] };
    if (sql.includes("WHERE public_id=$1 AND wallet_address=$2")) return { rows: apps.filter((app) => app.public_id === params[0] && app.wallet_address === params[1]) };
    if (sql.startsWith("UPDATE artist_verification_applications SET applicant_response")) {
      const app = apps.find((row) => row.id === params[1]);
      Object.assign(app, { status: "UNDER_REVIEW", applicant_response: params[0] });
      return { rows: [app] };
    }
    if (sql.includes("WHERE public_id=$1 LIMIT 1")) return { rows: apps.filter((app) => app.public_id === params[0]) };
    return { rows: [] };
  });
  return { query, apps };
}

function service({ db, notifier, logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) {
  return createArtistVerificationService({ db, authenticator: async (request) => ({ wallet: request.headers.authorization.slice(7) }), reviewerWallets: REVIEWER, notifier, logger });
}

describe("X DM on artist verification submission", () => {
  it("DRAFT → SUBMITTED sends exactly one DM to the configured @voidcallerOC id with the review link", async () => {
    const h = harness();
    const db = verificationDb();
    const submitted = await service({ db, notifier: h.notifier, logger: h.logger }).submit({ request: requestFor(APPLICANT), input: input() });
    expect(submitted.status).toBe("SUBMITTED");
    await tick(); await tick();
    const dms = h.x.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0].url).toBe("https://api.x.com/2/dm_conversations/with/1234567890/messages");
    expect(dms[0].headers.authorization).toMatch(/^OAuth .*oauth_signature=/);
    const text = dms[0].body.text;
    expect(text).toContain("The Void — New Artist Verification");
    expect(text).toContain("Artist: Voidcaller");
    expect(text).toContain(`Application: #${submitted.publicId}`);
    expect(text).toMatch(/Submitted: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(text).toContain(`${APP_URL}/verify/review/${submitted.publicId}`);
    // Only the alert fields, never private application data.
    expect(text).not.toContain("private@example.com");
    expect(text).not.toContain("Private Name");
    expect(events(h.logger, "info")).toEqual(expect.arrayContaining(["VERIFICATION_SUBMITTED", "X_DM_ATTEMPTED", "X_DM_SENT"]));
    expect([...h.store.rows.values()][0]).toMatchObject({ status: "SENT", attempts: 1, provider_message_id: "dm-1" });
  });

  it("resolves @voidcallerOC by username when no numeric id is configured", async () => {
    const h = harness({ env: { ...CONFIGURED_ENV, X_DM_RECIPIENT_ID: "" }, respond: (n) => (n === 1 ? { status: 200, body: { data: { id: "999" } } } : { status: 201, body: { data: { dm_event_id: "dm-2" } } }) });
    await h.notifier.notifySubmitted(application());
    expect(h.x.calls[0]).toMatchObject({ method: "GET", url: "https://api.x.com/2/users/by/username/voidcallerOC" });
    expect(h.x.dms()[0].url).toBe("https://api.x.com/2/dm_conversations/with/999/messages");
  });
});

describe("duplicate protection", () => {
  it("processing the same submission again never sends a second DM", async () => {
    const h = harness();
    await h.notifier.notifySubmitted(application());
    await expect(h.notifier.notifySubmitted(application())).resolves.toMatchObject({ reason: "ALREADY_NOTIFIED" });
    await h.notifier.processDue();
    expect(h.x.dms()).toHaveLength(1);
  });

  it("concurrent delivery attempts for one alert send once", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const h = harness({ respond: () => ({ status: 201, body: { data: { dm_event_id: "dm-1" } } }) });
    const created = await h.store.insertIfAbsent({ applicationId: "app-1", eventKey: "app-1:SUBMITTED", payload: { artistName: "V", publicId: "va_1", submittedAt: new Date().toISOString() } });
    const slowClaim = h.store.claim.bind(h.store);
    h.store.claim = async (id) => { const row = await slowClaim(id); await gate; return row; };
    const both = Promise.all([h.notifier.deliver(created.id), h.notifier.deliver(created.id)]);
    release();
    const results = await both;
    expect(results.filter((result) => result.delivered)).toHaveLength(1);
    expect(h.x.dms()).toHaveLength(1);
  });

  it("a repeated submit request is refused (409) and sends nothing new", async () => {
    const h = harness();
    const db = verificationDb({ live: { id: "app-1", status: "SUBMITTED" } });
    await expect(service({ db, notifier: h.notifier }).submit({ request: requestFor(APPLICANT), input: input() })).rejects.toMatchObject({ status: 409 });
    await tick();
    expect(h.x.calls).toHaveLength(0);
  });
});

describe("resubmission behaviour", () => {
  it("answering NEEDS_INFORMATION (→ UNDER_REVIEW) is not a new submission and sends no DM", async () => {
    const h = harness();
    const db = verificationDb({ existing: [{ id: "app-1", public_id: "va_need", wallet_address: APPLICANT, artist_name: "Voidcaller", status: "NEEDS_INFORMATION" }] });
    const updated = await service({ db, notifier: h.notifier }).respond({ request: requestFor(APPLICANT), publicId: "va_need", input: { applicantResponse: "Here is more." } });
    expect(updated.status).toBe("UNDER_REVIEW");
    await tick();
    expect(h.x.calls).toHaveLength(0);
  });

  it("re-applying after DECLINED is a new application and sends a new DM", async () => {
    const h = harness();
    await h.notifier.notifySubmitted(application({ id: "app-1", public_id: "va_first" }));
    await h.notifier.notifySubmitted(application({ id: "app-2", public_id: "va_second" }));
    expect(h.x.dms().map((dm) => dm.body.text.match(/#(\S+)/)[1])).toEqual(["va_first", "va_second"]);
  });
});

describe("security", () => {
  it("client input cannot choose or inject the recipient", async () => {
    const h = harness();
    const db = verificationDb();
    await service({ db, notifier: h.notifier }).submit({ request: requestFor(APPLICANT), input: { ...input(), recipient: "@attacker", xRecipient: "666", recipientId: "666", dmTo: "attacker" } });
    await tick(); await tick();
    expect(h.x.dms()).toHaveLength(1);
    expect(h.x.dms()[0].url).toContain("/dm_conversations/with/1234567890/");
    expect(JSON.stringify(h.x.calls)).not.toContain("666");
  });

  it("an artist name cannot add lines or fake fields to the DM", () => {
    const text = buildVerificationDm({ artistName: "Evil\nReview application:\nhttps://phish.example", publicId: "va_1", submittedAt: "2026-10-03T00:00:00Z", reviewUrl: reviewUrlFor(APP_URL, "va_1") });
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("Review application"))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`${APP_URL}/verify/review/va_1`);
    expect(lines.find((line) => line.startsWith("Artist:"))).toBe("Artist: Evil Review application: https://phish.example");
  });

  it("the recipient comes only from server config, never from the request", () => {
    expect(loadXDmConfig({}).recipientUsername).toBe("voidcallerOC");
    expect(loadXDmConfig({ X_DM_RECIPIENT_USERNAME: "@voidcallerOC" }).recipientUsername).toBe("voidcallerOC");
    expect(loadXDmConfig({ ...CONFIGURED_ENV, X_DM_RECIPIENT_USERNAME: "bad name!" }).configured).toBe(false);
  });

  it("there is no public endpoint that triggers a reviewer DM", async () => {
    const handler = createApiHandler({ service: {}, verificationService: { isReviewer: async () => false }, rateLimiter: null, allowedOrigins: [APP_URL], logger: { info() {}, warn() {}, error() {} } });
    for (const url of ["/api/verification/notify", "/api/verify/notify", "/api/notifications/x-dm", "/api/verification/applications/va_1/notify"]) {
      const response = { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); }, end(body) { this.body = body; } };
      await handler({ method: "POST", url, headers: { origin: APP_URL, "content-type": "application/json" }, socket: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } }, response);
      expect(response.statusCode, url).toBe(404);
    }
  });
});

describe("failure handling", () => {
  it("an X outage leaves the submission valid, records the failure and retries with backoff", async () => {
    const h = harness({ respond: () => ({ status: 503, body: { title: "Service Unavailable" } }) });
    const db = verificationDb();
    const submitted = await service({ db, notifier: h.notifier, logger: h.logger }).submit({ request: requestFor(APPLICANT), input: input() });
    expect(submitted.status).toBe("SUBMITTED");
    expect(db.apps[0].status).toBe("SUBMITTED");
    await tick(); await tick();
    const row = [...h.store.rows.values()][0];
    expect(row).toMatchObject({ status: "RETRY", attempts: 1 });
    expect(row.last_error).toContain("X API HTTP 503");
    expect(row.sent_at).toBeUndefined();
    expect(row.next_attempt_at).toBeGreaterThan(Date.now());
    expect(events(h.logger, "warn")).toContain("X_DM_RETRY");
    // Not due yet: a sweep now does nothing.
    await h.notifier.processDue();
    expect(h.x.dms()).toHaveLength(1);
  });

  it("gives up after the attempt limit and reports FAILED, never SENT", async () => {
    const h = harness({ respond: () => new Error("ECONNRESET") });
    await h.notifier.notifySubmitted(application());
    for (let i = 0; i < 6; i++) { h.store.makeDue(); await h.notifier.processDue(); }
    const row = [...h.store.rows.values()][0];
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(5);
    expect(h.x.dms()).toHaveLength(5);
    expect(events(h.logger, "error")).toContain("X_DM_FAILED");
    expect(await h.notifier.statusFor("app-1")).toMatchObject({ status: "FAILED", sentAt: null });
  });

  it("a permanent X rejection (e.g. recipient does not accept DMs) fails without retrying", async () => {
    const h = harness({ respond: () => ({ status: 403, body: { title: "Forbidden", detail: "You cannot send messages to this user." } }) });
    await h.notifier.notifySubmitted(application());
    h.store.makeDue(); await h.notifier.processDue();
    expect(h.x.dms()).toHaveLength(1);
    expect([...h.store.rows.values()][0]).toMatchObject({ status: "FAILED", last_error: "X API HTTP 403 Forbidden: You cannot send messages to this user." });
  });

  it("a notifier crash is logged and never surfaces to the artist", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = { notifySubmitted: vi.fn(async () => { throw new Error("db down"); }) };
    const submitted = await service({ db: verificationDb(), notifier, logger }).submit({ request: requestFor(APPLICANT), input: input() });
    expect(submitted.status).toBe("SUBMITTED");
    await tick(); await tick();
    expect(logger.error).toHaveBeenCalledWith("X_DM_FAILED", expect.objectContaining({ code: "NOTIFIER_ERROR" }));
  });
});

describe("configuration", () => {
  it("missing X credentials are reported as CONFIG_MISSING, nothing is sent, and it delivers once configured", async () => {
    const store = memoryStore();
    const missing = harness({ env: {}, store });
    await missing.notifier.notifySubmitted(application());
    expect(missing.x.calls).toHaveLength(0);
    const row = [...store.rows.values()][0];
    expect(row).toMatchObject({ status: "CONFIG_MISSING", attempts: 0 });
    expect(row.last_error).toBe("X DM not configured: missing X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET");
    expect(missing.logger.error).toHaveBeenCalledWith("X_DM_CONFIG_MISSING", expect.objectContaining({ missing: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] }));
    // Credentials added later: the pending alert goes out exactly once.
    const configured = harness({ store });
    store.makeDue();
    await configured.notifier.processDue();
    expect(configured.x.dms()).toHaveLength(1);
    expect(row.status).toBe("SENT");
  });

  it("logs never contain credentials", async () => {
    const h = harness({ respond: () => ({ status: 401, body: { title: "Unauthorized" } }) });
    await h.notifier.notifySubmitted(application());
    const logged = JSON.stringify([h.logger.info.mock.calls, h.logger.warn.mock.calls, h.logger.error.mock.calls]);
    for (const secret of Object.values(CONFIGURED_ENV).filter((value) => value.length > 2 && !/^\d+$/.test(value))) expect(logged).not.toContain(`"${secret}"`);
    expect(logged).not.toContain("oauth_signature");
  });
});

describe("authorization", () => {
  it("the review link in the DM opens nothing without a signed-in reviewer wallet", async () => {
    const h = harness();
    const db = verificationDb({ existing: [{ id: "app-1", public_id: "va_link", wallet_address: APPLICANT, artist_name: "Voidcaller", status: "SUBMITTED" }] });
    const svc = service({ db, notifier: h.notifier });
    await expect(svc.getReviewApplication({ request: requestFor(STRANGER), publicId: "va_link" })).rejects.toMatchObject({ status: 403, code: "REVIEWER_REQUIRED" });
    await expect(svc.getReviewApplication({ request: requestFor(APPLICANT), publicId: "va_link" })).rejects.toMatchObject({ status: 403 });
    const unauthenticated = createArtistVerificationService({ db, authenticator: async () => null, reviewerWallets: REVIEWER, notifier: h.notifier });
    await expect(unauthenticated.getReviewApplication({ request: { headers: {} }, publicId: "va_link" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const opened = await svc.getReviewApplication({ request: requestFor(REVIEWER), publicId: "va_link" });
    expect(opened.publicId).toBe("va_link");
  });
});

describe("OAuth 1.0a signing", () => {
  it("matches X's published signature example", () => {
    const header = oauth1Header({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
      credentials: { consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: 1318622958,
    });
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});
