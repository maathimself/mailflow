-- no-transaction
--
-- This partial index supports the oldest-first inbox triage feed on the existing
-- messages table. CONCURRENTLY avoids blocking mailbox writes while it is built.
--
-- DROP before CREATE makes retries safe after a cancelled or crashed concurrent
-- build: PostgreSQL can leave an invalid index with the target name, which plain
-- IF NOT EXISTS would otherwise skip and then record as successfully migrated.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_triage_feed;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_triage_feed
  ON messages (account_id, date, message_id)
  WHERE folder = 'INBOX' AND is_deleted = false;
