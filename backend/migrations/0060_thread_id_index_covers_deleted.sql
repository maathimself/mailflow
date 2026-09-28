-- no-transaction
-- The thread_id propagation UPDATE in syncMessages/backfillMessages has no is_deleted
-- predicate — deliberately, because soft-deleted rows are still threading inputs:
-- computeThreadId's header-chain lookup reads thread_id from ANY row, so a deleted row
-- left holding a stale provisional root would hand that stale id to the next reply that
-- references it, splitting the thread. But the only (account_id, thread_id) index was
-- partial on is_deleted = false, so the planner could never use it for that UPDATE and
-- fell back to a full sequential scan of messages — once per processed reply, which on a
-- CONDSTORE-less account re-processing its newest messages every tick meant scanning the
-- whole table about every three seconds (#495: 3,072 of 4,375 rows/s read by the whole
-- database, measured by the reporter, who also confirmed this index turns it into an
-- index scan).
--
-- A full index serves every query the partial one served, so the partial one is dropped
-- rather than kept as a second copy. CONCURRENTLY (hence no-transaction) so the swap
-- never blocks writes on a live messages table; created first, dropped second, so reads
-- keep an index throughout.
--
-- The leading DROP of the NEW name handles the crash-retry rule above: a crash mid
-- CREATE INDEX CONCURRENTLY leaves an INVALID index behind, and IF NOT EXISTS would then
-- skip it forever. Dropping first makes the retry rebuild it from scratch.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_account_thread;
CREATE INDEX CONCURRENTLY idx_messages_account_thread ON messages (account_id, thread_id);
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_id;
