BEGIN;

-- Reviewer alerts for artist verification submissions (primary channel: an
-- X/Twitter DM to the reviewer account). One row per notifiable event; the
-- UNIQUE event_key is the idempotency guarantee: a repeated request, retry or
-- sweep can never create a second alert for the same submission.
CREATE TABLE IF NOT EXISTS verification_notifications (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES artist_verification_applications(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('X_DM')),
  status text NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'RETRY', 'FAILED', 'CONFIG_MISSING', 'UNCONFIRMED')),
  -- Only the fields the alert text needs (artist name, public id, timestamp);
  -- never contact details, legal name or evidence.
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  claim_expires_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_notifications_due_idx
  ON verification_notifications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS verification_notifications_app_idx
  ON verification_notifications (application_id);

-- PostgREST: deny all. The Render API is superuser and bypasses RLS.
ALTER TABLE verification_notifications ENABLE ROW LEVEL SECURITY;

COMMIT;
