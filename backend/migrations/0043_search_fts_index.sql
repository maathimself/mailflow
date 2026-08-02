-- no-transaction
--
-- GIN index that serves `search_fts @@ tsquery`, plus a partial btree that lets
-- the backfill drainer (and any "needs backfill" probe) find not-yet-stamped
-- rows without a full seq scan; it self-prunes as fts_version = 1 fills in.
-- CONCURRENTLY must run outside a transaction, so these live apart from 0035's
-- trigger. Idempotent via IF NOT EXISTS (retried if a crash precedes the
-- schema_migrations INSERT).
--
-- DROP ... IF EXISTS before each CREATE: a cancelled or crashed CREATE INDEX
-- CONCURRENTLY leaves an INVALID index under the target name. On retry, plain
-- IF NOT EXISTS sees that name and silently skips the create, recording the
-- migration as done while the scan stays unindexed forever. This file only re-runs
-- after such a failure — in which case the index is either absent (drop is a no-op)
-- or invalid (drop removes the dead stub) — so dropping first is safe and cheap.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_fts;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_search_fts
  ON messages USING GIN (search_fts);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_fts_stale_v1;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_fts_stale_v1
  ON messages (date DESC)
  WHERE fts_version IS DISTINCT FROM 1;
