-- no-transaction
--
-- Covering index for the paged_threads CTE introduced in the threaded inbox
-- query redesign. The CTE does:
--   GROUP BY COALESCE(thread_id, id::text), ORDER BY MAX(date) DESC, LIMIT n
-- filtered by (account_id, folder, is_deleted=false).
--
-- Column order (account_id, folder, thread_id, date DESC) matches that GROUP BY
-- exactly, allowing an index-only scan without fetching heap rows for the
-- paged_threads step. The previous idx_messages_threaded_dedup had message_id
-- between thread_id and date, which forced a full-group scan to find MAX(date).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_date
  ON messages(account_id, folder, COALESCE(thread_id, id::text), date DESC)
  WHERE is_deleted = false;
