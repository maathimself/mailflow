ALTER TABLE message_flag_deliveries
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

DROP INDEX IF EXISTS message_flag_deliveries_reconcile_idx;
CREATE INDEX message_flag_deliveries_reconcile_idx
  ON message_flag_deliveries (state, lease_expires_at, updated_at)
  WHERE state IN ('pending', 'delivering', 'uncertain');
