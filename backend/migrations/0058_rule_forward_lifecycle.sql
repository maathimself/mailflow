ALTER TABLE inbox_rule_forwards
  DROP CONSTRAINT inbox_rule_forwards_status_check;

-- Legacy `pending` covered the entire SMTP call. A surviving row may therefore mean DATA was
-- accepted and only the success write crashed; it is never safe to make these rows retryable.
UPDATE inbox_rule_forwards SET status = 'uncertain' WHERE status = 'pending';

ALTER TABLE inbox_rule_forwards
  ADD COLUMN IF NOT EXISTS recipient TEXT,
  ADD COLUMN IF NOT EXISTS payload_digest CHAR(64),
  ADD COLUMN IF NOT EXISTS smtp_message BYTEA,
  ADD COLUMN IF NOT EXISTS smtp_envelope JSONB,
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ;

ALTER TABLE inbox_rule_forwards
  ALTER COLUMN status SET DEFAULT 'ready';

ALTER TABLE inbox_rule_forwards
  ADD CONSTRAINT inbox_rule_forwards_status_check
  CHECK (status IN ('ready', 'provider_started', 'sent', 'uncertain'));
