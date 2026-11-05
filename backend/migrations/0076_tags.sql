-- User-defined tags on messages, stored in the database only (nothing is written to IMAP).
--
--   tag_definitions  one row per tag per user: a name and a colour
--   message_tags     a tag on an email
--
-- Tags belong to the email, not to a row of the messages table. MailFlow gives a message a new row id
-- when it is trashed (UPDATE ... id = gen_random_uuid()) and when it is moved or archived in bulk
-- (DELETE + reinsert), and a full resync reinserts rows too. Tags keyed by the row id would either block
-- those statements (foreign key) or be lost on every move. They are keyed by the account and the
-- email's Message-ID instead, so they follow the email. A message without a Message-ID falls back to
-- its row id.

CREATE OR REPLACE FUNCTION tag_email_key(message_id TEXT, row_id UUID) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(NULLIF(message_id, ''), 'row:' || row_id::text) $$;

CREATE TABLE IF NOT EXISTS tag_definitions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(80) NOT NULL,
  color      VARCHAR(7) NOT NULL DEFAULT '#6b7280',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_definitions_user_name ON tag_definitions (user_id, lower(name));

CREATE TABLE IF NOT EXISTS message_tags (
  account_id  UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  email_key   TEXT NOT NULL,
  tag_id      UUID NOT NULL REFERENCES tag_definitions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when no message with this key exists any more (permanently deleted); the row is removed after
  -- a grace period, and the mark cleared if the email comes back (a move is delete + insert).
  orphaned_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, email_key, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_message_tags_tag ON message_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_orphaned ON message_tags (orphaned_at) WHERE orphaned_at IS NOT NULL;
