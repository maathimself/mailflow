CREATE TABLE send_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key VARCHAR(128) NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'ready'
    CHECK (state IN ('ready', 'provider_started', 'provider_applied', 'completed', 'uncertain')),
  message_id TEXT,
  sent_folder TEXT,
  sent_metadata JSONB,
  raw_message BYTEA,
  server_auto_saves BOOLEAN,
  smtp_message BYTEA,
  smtp_envelope JSONB,
  prepared_payload_digest CHAR(64),
  source_snapshots JSONB,
  response JSONB,
  prepared_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  provider_applied_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, operation_key)
);

CREATE INDEX send_operations_pending_idx
  ON send_operations (state, updated_at)
  WHERE state IN ('provider_started', 'provider_applied', 'uncertain');
