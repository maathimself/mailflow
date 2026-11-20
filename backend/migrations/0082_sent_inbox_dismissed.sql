-- Remembers Sent-initiated (and Inbox-replied) threads dismissed from Inbox via Gmail All-Mail
-- archiving (which deletes the INBOX copy from messages), so the originating Sent row does not
-- resurrect in Inbox when threadInboxSent is enabled.
CREATE TABLE IF NOT EXISTS sent_inbox_dismissed (
  account_id   UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_key   TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, thread_key)
);
