CREATE TABLE IF NOT EXISTS mcp_account_stages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'staged', -- staged | completed | discarded
  payload      JSONB NOT NULL, -- name, sender_name, email_address, color, protocol,
                                -- imap_host, imap_port, imap_skip_tls_verify,
                                -- smtp_host, smtp_port, smtp_tls, auth_user, signature
                                -- NEVER auth_pass / oauth_* tokens
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_account_stages_user_id ON mcp_account_stages(user_id);
