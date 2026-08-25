ALTER TABLE provider_operations
  ADD COLUMN IF NOT EXISTS request_key TEXT,
  ADD COLUMN IF NOT EXISTS source_message_id UUID;

CREATE INDEX IF NOT EXISTS provider_operations_source_recovery_idx
  ON provider_operations (account_id, source_message_id, updated_at DESC)
  WHERE kind = 'move'
    AND state IN ('provider_started', 'provider_applied', 'completed');

CREATE INDEX IF NOT EXISTS provider_operations_request_replay_idx
  ON provider_operations (account_id, request_key, updated_at DESC)
  WHERE kind = 'move' AND state = 'completed';

CREATE INDEX IF NOT EXISTS provider_operations_cleanup_pending_idx
  ON provider_operations (updated_at, operation_key)
  WHERE state = 'completed' AND marker_cleanup_state = 'pending';
