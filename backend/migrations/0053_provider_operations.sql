CREATE TABLE provider_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'copy', 'append')),
  state TEXT NOT NULL DEFAULT 'ready'
    CHECK (state IN (
      'ready', 'provider_started', 'provider_applied', 'completed', 'manual_intervention'
    )),
  marker TEXT NOT NULL UNIQUE,
  source_folder VARCHAR(500),
  source_uid BIGINT,
  destination_folder VARCHAR(500) NOT NULL,
  source_observation JSONB,
  destination_observation JSONB NOT NULL,
  attempt_generation BIGINT NOT NULL DEFAULT 0,
  attempt_owner UUID,
  receipt JSONB,
  uncertainty JSONB,
  marker_cleanup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (marker_cleanup_state IN ('pending', 'completed')),
  marker_cleanup_error JSONB,
  marker_cleanup_completed_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  provider_applied_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX provider_operations_recovery_idx
  ON provider_operations (state, updated_at)
  WHERE state IN ('provider_started', 'provider_applied');
