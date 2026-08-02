CREATE TABLE IF NOT EXISTS compose_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 9),
  account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  alias_id UUID REFERENCES account_aliases(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'new'
    CHECK (mode IN ('new','reply','reply_all','forward')),
  to_recipients JSONB NOT NULL DEFAULT '[]',
  cc_recipients JSONB NOT NULL DEFAULT '[]',
  bcc_recipients JSONB NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  body_is_html BOOLEAN NOT NULL DEFAULT TRUE,
  quoted_body TEXT,
  quoted_body_html TEXT,
  edited_signature TEXT,
  forwarded_attachments JSONB NOT NULL DEFAULT '[]',
  from_changed BOOLEAN NOT NULL DEFAULT FALSE,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high')),
  in_reply_to TEXT,
  thread_references JSONB NOT NULL DEFAULT '[]',
  source_draft_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  source_draft_folder TEXT,
  source_draft_uid BIGINT,
  source_draft_message_id TEXT,
  source_initial_revision JSONB,
  presentation_state TEXT NOT NULL DEFAULT 'expanded'
    CHECK (presentation_state IN ('expanded','minimized')),
  operation_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (operation_state IN ('idle','closing','discarding','sending')),
  operation_token UUID,
  revision BIGINT NOT NULL DEFAULT 1,
  field_revisions JSONB NOT NULL DEFAULT '{}',
  last_focused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slot)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compose_sessions_source_draft
  ON compose_sessions(user_id, source_draft_account_id, source_draft_folder, source_draft_uid)
  WHERE source_draft_account_id IS NOT NULL
    AND source_draft_folder IS NOT NULL
    AND source_draft_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS compose_session_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES compose_sessions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 26214400),
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compose_session_attachments_session
  ON compose_session_attachments(session_id, created_at, id);
