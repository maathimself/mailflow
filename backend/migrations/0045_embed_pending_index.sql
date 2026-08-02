-- no-transaction
-- Partial index over the embed-scan's steady-state hot predicate. Once a generation
-- reaches full coverage, the only live rows still needing work are newly-arrived
-- messages with embed_gen IS NULL, so the 60s scheduler scan (scanForEmbedding) should
-- touch O(pending), not O(mailbox). Built CONCURRENTLY (hence -- no-transaction) so it
-- never blocks boot on a large messages table; extension-independent and cheap to
-- maintain (only the sparse NULL set is indexed). Idempotent (IF NOT EXISTS) because a
-- crash before the schema_migrations INSERT retries the migration.
--
-- DROP ... IF EXISTS before the CREATE: a cancelled or crashed CREATE INDEX
-- CONCURRENTLY leaves an INVALID index under this name, and plain IF NOT EXISTS would
-- then silently skip the create on retry — recording the migration as done while the
-- embed scan stays unindexed forever. This file only re-runs after such a failure, so
-- the index is either absent (drop is a no-op) or invalid (drop clears the dead stub).
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_embed_pending;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_embed_pending
  ON messages (id) WHERE embed_gen IS NULL;
