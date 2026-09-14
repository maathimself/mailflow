-- Observations are deliberately separate from cache counters and ingest watermarks.
CREATE SEQUENCE IF NOT EXISTS folder_status_revision;
ALTER TABLE folders
  ADD COLUMN server_total_count bigint,
  ADD COLUMN server_unread_count bigint,
  ADD COLUMN server_uid_next bigint,
  ADD COLUMN server_uid_validity bigint,
  ADD COLUMN server_highest_modseq numeric(20,0),
  ADD COLUMN server_counts_at timestamptz,
  ADD COLUMN server_count_revision bigint,
  ADD COLUMN status_attempt_revision bigint,
  ADD COLUMN status_attempted_at timestamptz,
  ADD COLUMN status_error text,
  ADD COLUMN status_synced_uid_next bigint,
  ADD COLUMN status_synced_uid_validity bigint,
  ADD COLUMN status_synced_modseq numeric(20,0),
  ADD COLUMN status_synced_at timestamptz,
  ADD COLUMN status_sync_attempted_at timestamptz;
