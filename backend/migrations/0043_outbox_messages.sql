-- Deferred sends. A row is a fully-resolved compose payload waiting out its undo
-- window; the worker claims it at send_at and hands it to sendService. Rows are
-- short-lived by construction (max window is 120s) — payload is NULLed on any
-- terminal status so delivered mail bodies do not accumulate at rest.
CREATE TABLE IF NOT EXISTS outbox_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','sent','cancelled','failed')),
  send_at         TIMESTAMPTZ NOT NULL,
  claimed_at      TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  subject         TEXT,
  to_preview      JSONB NOT NULL DEFAULT '[]',
  message_id      TEXT,
  sent_message_id TEXT,
  error           TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbox_messages(send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user
  ON outbox_messages(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idem
  ON outbox_messages(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
