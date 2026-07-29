CREATE TABLE IF NOT EXISTS inbox_rule_forwards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id     UUID NOT NULL REFERENCES inbox_rules(id) ON DELETE CASCADE,
  message_id  UUID NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  UNIQUE (rule_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_rule_forwards_status
  ON inbox_rule_forwards(status, created_at);
