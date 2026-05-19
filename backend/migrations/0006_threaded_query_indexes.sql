-- no-transaction
--
-- Covering indexes to speed up the threaded message list query.
-- Run outside a transaction so CREATE INDEX CONCURRENTLY can build without
-- holding an exclusive lock on the messages table during app startup.
--
-- idx_messages_threaded_dedup: supports the DISTINCT ON in the deduped CTE,
-- which groups by (account_id, thread_id, message_id) and prefers INBOX copies.
-- Previously relied on idx_messages_list which sorts by date, not thread_id.
--
-- idx_messages_thread_count: supports the COUNT(DISTINCT message_id) per thread
-- in thread_totals after it is scoped to threads already in the result window.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_threaded_dedup
  ON messages(account_id, folder, COALESCE(thread_id, id::text), message_id, date)
  WHERE is_deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_count
  ON messages(account_id, COALESCE(thread_id, id::text), message_id)
  WHERE is_deleted = false AND message_id IS NOT NULL;
