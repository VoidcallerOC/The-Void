import { randomUUID } from "node:crypto";

// Reviewer alerts for artist verification submissions.
//
// Primary (and only) channel: an X DM to the reviewer account configured on the
// server (default @voidcallerOC). The alert is an outbox row created server-side
// when an application becomes SUBMITTED; delivery happens after the submission
// has committed, so an X failure can never undo or fail a submission.
//
// Idempotency: event_key is UNIQUE ("<applicationId>:SUBMITTED"). Each
// submission is a new application row (a wallet can hold only one live
// application, and a repeat submit is refused with 409), so one submission =
// one key = at most one DM. Delivery must first claim the row with a
// conditional UPDATE, so concurrent attempts cannot both send.
//
// Resubmission: an applicant answering NEEDS_INFORMATION moves the row to
// UNDER_REVIEW, not SUBMITTED, so it is not a new submission and sends no DM
// (it stays in the review queue and the in-app badge). Re-applying after
// DECLINED/REVOKED creates a new application, which is a new submission and
// does send a DM.

export const NOTIFICATION_EVENTS = Object.freeze({
  SUBMITTED: "VERIFICATION_SUBMITTED",
  ATTEMPTED: "X_DM_ATTEMPTED",
  SENT: "X_DM_SENT",
  FAILED: "X_DM_FAILED",
  RETRY: "X_DM_RETRY",
  CONFIG_MISSING: "X_DM_CONFIG_MISSING",
});

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];
const CONFIG_RECHECK_MINUTES = 15;
const SWEEP_WINDOW_HOURS = 72; // never alert about very old submissions
const CLAIM_SECONDS = 120;

function clean(value, max) {
  // Collapse newlines/tabs/other control characters so a name can't reshape the DM.
  return Array.from(String(value ?? ""), (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The DM text. Only artist name, application id, time and the review link. */
export function buildVerificationDm({ artistName, publicId, submittedAt, reviewUrl }) {
  const when = new Date(submittedAt);
  const stamp = Number.isNaN(when.getTime()) ? clean(submittedAt, 40) : `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [
    "The Void — New Artist Verification",
    "",
    `Artist: ${clean(artistName, 80) || "Unnamed artist"}`,
    `Application: #${clean(publicId, 40)}`,
    `Submitted: ${stamp}`,
    "",
    "Review application (reviewer sign-in required):",
    reviewUrl,
  ].join("\n");
}

export function reviewUrlFor(publicAppUrl, publicId) {
  return `${String(publicAppUrl).replace(/\/$/, "")}/verify/review/${encodeURIComponent(publicId)}`;
}

/** SQL persistence for the outbox. */
export function createNotificationStore(db) {
  return {
    async insertIfAbsent({ applicationId, eventKey, payload }) {
      const { rows } = await db.query(
        `INSERT INTO verification_notifications (id, application_id, event_key, channel, status, payload, next_attempt_at)
         VALUES ($1,$2,$3,'X_DM','PENDING',$4::jsonb, now())
         ON CONFLICT (event_key) DO NOTHING RETURNING *`,
        [randomUUID(), applicationId, eventKey, JSON.stringify(payload)],
      );
      return rows[0] || null;
    },
    // Takes the row for one attempt. Returns null if another attempt holds it,
    // it is not due yet, or it is already finished (SENT/FAILED/UNCONFIRMED).
    async claim(id) {
      const { rows } = await db.query(
        `UPDATE verification_notifications
         SET status='SENDING', attempts=attempts+1, last_attempt_at=now(), claim_expires_at=now() + make_interval(secs => $2), updated_at=now()
         WHERE id=$1 AND status IN ('PENDING','RETRY','CONFIG_MISSING') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         RETURNING *`,
        [id, CLAIM_SECONDS],
      );
      return rows[0] || null;
    },
    async finish(id, { status, nextAttemptMinutes = null, error = null, messageId = null, attempts = null }) {
      const { rows } = await db.query(
        `UPDATE verification_notifications
         SET status=$2,
             next_attempt_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END,
             last_error=$4, provider_message_id=COALESCE($5, provider_message_id),
             sent_at = CASE WHEN $2='SENT' THEN now() ELSE sent_at END,
             attempts = COALESCE($6::int, attempts),
             claim_expires_at=NULL, updated_at=now()
         WHERE id=$1 AND status='SENDING' RETURNING *`,
        [id, status, nextAttemptMinutes, error, messageId, attempts],
      );
      return rows[0] || null;
    },
    async dueIds(limit = 20) {
      const { rows } = await db.query(
        `SELECT id FROM verification_notifications
         WHERE status IN ('PENDING','RETRY','CONFIG_MISSING') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND created_at > now() - make_interval(hours => $1)
         ORDER BY created_at ASC LIMIT $2`,
        [SWEEP_WINDOW_HOURS, limit],
      );
      return rows.map((row) => row.id);
    },
    // An attempt that never recorded its outcome (process died mid-send) may or
    // may not have delivered. It is never re-sent automatically.
    async markStaleClaims() {
      const { rows } = await db.query(
        `UPDATE verification_notifications SET status='UNCONFIRMED', last_error='Delivery outcome unknown (attempt interrupted); not retried to avoid a duplicate DM.', claim_expires_at=NULL, updated_at=now()
         WHERE status='SENDING' AND claim_expires_at < now() RETURNING id, payload`,
      );
      return rows;
    },
    // Backstop: a recent submission whose outbox insert failed still gets one alert.
    async enqueueMissing() {
      const { rows } = await db.query(
        `INSERT INTO verification_notifications (id, application_id, event_key, channel, status, payload, next_attempt_at)
         SELECT gen_random_uuid()::text, a.id, a.id || ':SUBMITTED', 'X_DM', 'PENDING',
                jsonb_build_object('artistName', a.artist_name, 'publicId', a.public_id, 'submittedAt', a.submitted_at), now()
         FROM artist_verification_applications a
         WHERE a.submitted_at > now() - interval '1 hour'
           AND NOT EXISTS (SELECT 1 FROM verification_notifications n WHERE n.event_key = a.id || ':SUBMITTED')
         ON CONFLICT (event_key) DO NOTHING RETURNING id`,
      );
      return rows.map((row) => row.id);
    },
    async forApplication(applicationId) {
      const { rows } = await db.query(
        `SELECT status, attempts, last_attempt_at, next_attempt_at, sent_at, last_error FROM verification_notifications WHERE application_id=$1 AND channel='X_DM' ORDER BY created_at DESC LIMIT 1`,
        [applicationId],
      );
      return rows[0] || null;
    },
  };
}

export function createVerificationNotifier({ store, xClient, xConfig, publicAppUrl, logger = console }) {
  const log = (level, event, fields) => logger[level]?.(event, fields);

  async function deliver(id) {
    const row = await store.claim(id);
    if (!row) return { delivered: false, reason: "NOT_CLAIMED" };
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload || {};
    const fields = { notificationId: row.id, publicId: payload.publicId, attempt: row.attempts, channel: "X_DM", recipient: `@${xConfig.recipientUsername}` };

    if (!xConfig.configured) {
      // Not counted as an attempt; re-checked until configuration is present.
      const error = `X DM not configured: missing ${[...xConfig.missing, ...xConfig.invalid].join(", ")}`;
      await store.finish(row.id, { status: "CONFIG_MISSING", nextAttemptMinutes: CONFIG_RECHECK_MINUTES, error, attempts: Math.max(0, row.attempts - 1) });
      log("error", NOTIFICATION_EVENTS.CONFIG_MISSING, { ...fields, missing: [...xConfig.missing, ...xConfig.invalid] });
      return { delivered: false, status: "CONFIG_MISSING" };
    }

    log("info", NOTIFICATION_EVENTS.ATTEMPTED, fields);
    const text = buildVerificationDm({ ...payload, reviewUrl: reviewUrlFor(publicAppUrl, payload.publicId) });
    let result;
    try {
      result = await xClient.send(text);
    } catch (error) {
      result = { ok: false, retryable: true, code: "UNEXPECTED", detail: String(error?.message || error).slice(0, 200) };
    }
    if (result.ok) {
      await store.finish(row.id, { status: "SENT", messageId: result.messageId });
      log("info", NOTIFICATION_EVENTS.SENT, { ...fields, messageId: result.messageId });
      return { delivered: true, status: "SENT" };
    }
    if (result.retryable && row.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
      await store.finish(row.id, { status: "RETRY", nextAttemptMinutes: wait, error: result.detail });
      log("warn", NOTIFICATION_EVENTS.RETRY, { ...fields, code: result.code, retryInMinutes: wait });
      return { delivered: false, status: "RETRY" };
    }
    await store.finish(row.id, { status: "FAILED", error: result.detail });
    log("error", NOTIFICATION_EVENTS.FAILED, { ...fields, code: result.code, detail: result.detail });
    return { delivered: false, status: "FAILED" };
  }

  return {
    /** Called by the verification service after an application becomes SUBMITTED. */
    async notifySubmitted(application) {
      const created = await store.insertIfAbsent({
        applicationId: application.id,
        eventKey: `${application.id}:SUBMITTED`,
        payload: { artistName: application.artist_name, publicId: application.public_id, submittedAt: application.submitted_at },
      });
      if (!created) return { delivered: false, reason: "ALREADY_NOTIFIED" };
      return deliver(created.id);
    },
    deliver,
    /** Periodic retry sweep. Safe to run concurrently with request-time delivery. */
    async processDue() {
      const stale = await store.markStaleClaims();
      for (const row of stale) log("error", NOTIFICATION_EVENTS.FAILED, { notificationId: row.id, publicId: row.payload?.publicId, code: "UNCONFIRMED" });
      await store.enqueueMissing();
      const results = [];
      for (const id of await store.dueIds()) results.push(await deliver(id));
      return results;
    },
    async statusFor(applicationId) {
      const row = await store.forApplication(applicationId);
      if (!row) return null;
      return { channel: "X_DM", recipient: `@${xConfig.recipientUsername}`, status: row.status, attempts: Number(row.attempts || 0), lastAttemptAt: row.last_attempt_at || null, nextAttemptAt: row.next_attempt_at || null, sentAt: row.sent_at || null, lastError: row.last_error || null };
    },
  };
}
