-- no-transaction
-- Add a per-account message_id index to support fast deduplication lookups
-- during IMAP sync. The existing idx_messages_msg_id only indexes message_id
-- without account_id, making it unsuitable for the per-account relocate query
-- in processMsg (would require a heap fetch to filter by account).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_account_message_id
  ON messages(account_id, message_id)
  WHERE message_id IS NOT NULL;
