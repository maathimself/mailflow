-- Staged (not executed) MCP deletions. stage_deletion records a batch; a separate
-- session-authenticated execute step flips messages.is_deleted (soft delete). No
-- tool ever hard-deletes. Renumbered to 0041 (0040 is api_tokens) per the README
-- migration-numbering rule.
CREATE TABLE IF NOT EXISTS mcp_deletion_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'staged',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_deletion_batch_messages (
  batch_id   UUID NOT NULL REFERENCES mcp_deletion_batches(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_deletion_batches_user_id ON mcp_deletion_batches(user_id);
