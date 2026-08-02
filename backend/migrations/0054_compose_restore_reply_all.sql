-- Server-owned source recipients let Reply -> Reply All survive reload without
-- making those recipients editable until the UI explicitly patches to/cc.
ALTER TABLE compose_sessions
  ADD COLUMN IF NOT EXISTS reply_all_recipients JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Records an accepted outbox restore after its private payload is wiped, making
-- owner-scoped restore retries idempotent without retaining message content.
ALTER TABLE outbox_messages
  ADD COLUMN IF NOT EXISTS restored_compose_session_id UUID
    REFERENCES compose_sessions(id) ON DELETE SET NULL;
