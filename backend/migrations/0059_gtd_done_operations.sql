CREATE TABLE IF NOT EXISTS gtd_done_operations (
  operation_key TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  acted_message_id UUID NOT NULL,
  thread_key TEXT NOT NULL,
  intent JSONB NOT NULL,
  plan_digest TEXT NOT NULL,
  plan JSONB NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('seen', 'archive', 'labels', 'completed')) DEFAULT 'seen',
  item_index INTEGER NOT NULL DEFAULT 0 CHECK (item_index >= 0),
  outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
  response JSONB,
  claim_owner UUID,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (operation_key)
);

CREATE INDEX IF NOT EXISTS idx_gtd_done_operations_owner
  ON gtd_done_operations (user_id, account_id, acted_message_id, updated_at DESC);
