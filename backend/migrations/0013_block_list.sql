CREATE TABLE IF NOT EXISTS block_list (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address    VARCHAR(500) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, email_address)
);

CREATE INDEX IF NOT EXISTS idx_block_list_user ON block_list(user_id);
