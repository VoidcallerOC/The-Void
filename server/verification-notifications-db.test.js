import { randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { createNotificationStore, createVerificationNotifier } from "./verification-notifier.js";
import { createXDmClient, loadXDmConfig } from "./x-dm.js";

// Runs the real migration and SQL outbox against Postgres. Skipped unless
// TEST_DATABASE_URL points at a server where a scratch database can be created.
const testDatabaseUrl = process.env.TEST_DATABASE_URL || "";
// DROP DATABASE ... WITH (FORCE) terminates idle pooled connections (57P01).
const ignoreTerminate = (error) => { if (error?.code !== "57P01") throw error; };

describe.skipIf(!testDatabaseUrl)("verification notification outbox (Postgres)", () => {
  let admin;
  let pool;
  const name = `void_xdm_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testDatabaseUrl, ssl: false, max: 1 });
    admin.on("error", ignoreTerminate);
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(testDatabaseUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: false, max: 4 });
    pool.on("error", ignoreTerminate);
    await migrate({ pool, config: loadServerConfig({ DATABASE_URL: url.toString(), DATABASE_SSL: "false" }) });
  });

  afterAll(async () => {
    await pool?.end().catch(ignoreTerminate);
    await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(ignoreTerminate);
    await admin?.end();
  });

  async function application(publicId) {
    const id = `app-${publicId}`;
    await pool.query(
      `INSERT INTO artist_verification_applications (id, public_id, wallet_address, slug, artist_name, legal_name, email, location, artist_type, artist_bio, work_description, years_active, verification_evidence, status, submitted_at)
       VALUES ($1,$2,$3,$4,'Voidcaller','Private','p@example.com','CT','Musician','bio','work','10','evidence','SUBMITTED', now())`,
      [id, publicId, `0x${randomBytes(20).toString("hex")}`, publicId],
    );
    const { rows } = await pool.query("SELECT * FROM artist_verification_applications WHERE id=$1", [id]);
    return rows[0];
  }

  function notifier({ respond = () => ({ status: 201, body: { data: { dm_event_id: "dm-1" } } }), env = { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_TOKEN_SECRET: "ts", X_DM_RECIPIENT_ID: "42" } } = {}) {
    const sent = [];
    const fetchImpl = vi.fn(async (url, options) => {
      sent.push({ url, text: JSON.parse(options.body).text });
      // Hold the response briefly so concurrent attempts overlap.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const reply = respond(sent.length);
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    });
    const xConfig = loadXDmConfig(env);
    const store = createNotificationStore(pool);
    return { sent, store, n: createVerificationNotifier({ store, xClient: createXDmClient({ config: xConfig, fetchImpl }), xConfig, publicAppUrl: "https://the-void-alpha.vercel.app", logger: { info() {}, warn() {}, error() {} } }) };
  }

  it("the migration creates the outbox with RLS enabled and a unique event key", async () => {
    const { rows } = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname='verification_notifications'");
    expect(rows[0].relrowsecurity).toBe(true);
    const unique = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='verification_notifications' AND indexdef ILIKE '%UNIQUE%event_key%'");
    expect(unique.rows).toHaveLength(1);
  });

  it("one submission produces one SENT row and one DM, even when processed repeatedly and concurrently", async () => {
    const app = await application("va_db_once");
    const { sent, n } = notifier();
    const results = await Promise.all([n.notifySubmitted(app), n.notifySubmitted(app), n.processDue(), n.processDue()]);
    expect(results.filter((result) => result?.delivered === true || (Array.isArray(result) && result.some((r) => r.delivered)))).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.x.com/2/dm_conversations/with/42/messages");
    expect(sent[0].text).toContain("https://the-void-alpha.vercel.app/verify/review/va_db_once");
    const { rows } = await pool.query("SELECT status, attempts, sent_at, provider_message_id FROM verification_notifications WHERE application_id=$1", [app.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", attempts: 1, provider_message_id: "dm-1" });
    expect(rows[0].sent_at).toBeInstanceOf(Date);
  });

  it("a failed send is recorded as RETRY with a future attempt time, and the application stays SUBMITTED", async () => {
    const app = await application("va_db_retry");
    const { n } = notifier({ respond: () => ({ status: 502, body: { title: "Bad Gateway" } }) });
    await n.notifySubmitted(app);
    const { rows } = await pool.query("SELECT status, attempts, sent_at, last_error, next_attempt_at > now() AS later FROM verification_notifications WHERE application_id=$1", [app.id]);
    expect(rows[0]).toMatchObject({ status: "RETRY", attempts: 1, sent_at: null, later: true });
    expect(rows[0].last_error).toContain("X API HTTP 502");
    const appRow = await pool.query("SELECT status FROM artist_verification_applications WHERE id=$1", [app.id]);
    expect(appRow.rows[0].status).toBe("SUBMITTED");
    expect(await n.statusFor(app.id)).toMatchObject({ status: "RETRY", sentAt: null, recipient: "@voidcallerOC" });
  });

  it("missing configuration is stored as CONFIG_MISSING without counting an attempt", async () => {
    const app = await application("va_db_config");
    const { sent, n } = notifier({ env: {} });
    await n.notifySubmitted(app);
    expect(sent).toHaveLength(0);
    const { rows } = await pool.query("SELECT status, attempts, last_error FROM verification_notifications WHERE application_id=$1", [app.id]);
    expect(rows[0]).toMatchObject({ status: "CONFIG_MISSING", attempts: 0 });
    expect(rows[0].last_error).toContain("missing X_API_KEY");
  });

  it("an interrupted attempt is marked UNCONFIRMED and never re-sent", async () => {
    const app = await application("va_db_stale");
    const { store, sent, n } = notifier();
    const row = await store.insertIfAbsent({ applicationId: app.id, eventKey: `${app.id}:SUBMITTED`, payload: { artistName: "V", publicId: "va_db_stale", submittedAt: new Date().toISOString() } });
    await store.claim(row.id);
    await pool.query("UPDATE verification_notifications SET claim_expires_at = now() - interval '1 minute' WHERE id=$1", [row.id]);
    await n.processDue();
    const { rows } = await pool.query("SELECT status FROM verification_notifications WHERE id=$1", [row.id]);
    expect(rows[0].status).toBe("UNCONFIRMED");
    expect(sent).toHaveLength(0);
  });

  it("the backstop enqueues a recent submission whose outbox row is missing, once", async () => {
    const app = await application("va_db_backstop");
    const { sent, n } = notifier();
    await n.processDue();
    await n.processDue();
    expect(sent.filter((entry) => entry.text.includes("va_db_backstop"))).toHaveLength(1);
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM verification_notifications WHERE application_id=$1", [app.id]);
    expect(rows[0].count).toBe(1);
  });
});
