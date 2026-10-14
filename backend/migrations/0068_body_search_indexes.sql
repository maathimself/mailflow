-- no-transaction
-- Drop before rebuilding: IF NOT EXISTS would accept an invalid index left by
-- an interrupted concurrent build, or a valid build without its migration row.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search;
CREATE INDEX CONCURRENTLY idx_messages_body_search
  ON messages USING GIN (mailflow_body_search_vector(body_text))
  WHERE is_deleted = false;

-- An indexed overflow arm lets the planner combine all free-text arms with
-- BitmapOr. Its account key limits exceptional candidates to the search scope.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_search_overflow;
CREATE INDEX CONCURRENTLY idx_messages_body_search_overflow
  ON messages (account_id)
  WHERE is_deleted = false AND mailflow_body_search_vector(body_text) IS NULL;

-- Partial expression index statistics are ignored for whole-table selectivity.
-- Without these frequencies a common body term is estimated as 0.5% of rows,
-- preferring a full bitmap/sort over the date index that can satisfy LIMIT early.
CREATE STATISTICS IF NOT EXISTS stats_messages_body_search
  ON (mailflow_body_search_vector(body_text)) FROM messages;
ANALYZE messages;
