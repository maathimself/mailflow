CREATE TABLE IF NOT EXISTS message_triage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id_header TEXT NOT NULL,
  triaged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT,                      -- free-form: archived | replied | snoozed | left | …
  note TEXT,
  source TEXT NOT NULL DEFAULT 'mcp',
  token_id UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
  UNIQUE (account_id, message_id_header)
);
CREATE INDEX idx_message_triage_user_time ON message_triage (user_id, triaged_at DESC);
