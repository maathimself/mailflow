ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS read_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS star_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_modseq NUMERIC(20,0);

CREATE TABLE message_flag_deliveries (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  flag TEXT NOT NULL CHECK (flag IN ('read', 'star')),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder VARCHAR(500) NOT NULL,
  uid BIGINT NOT NULL,
  uid_validity BIGINT NOT NULL,
  folder_generation BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  desired_value BOOLEAN NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivering', 'uncertain', 'confirmed')),
  captured_modseq NUMERIC(20,0),
  condstore BOOLEAN,
  uncertainty_tombstones JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempt_generation BIGINT NOT NULL DEFAULT 0,
  attempt_owner UUID,
  provider_started_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, flag)
);

CREATE INDEX message_flag_deliveries_reconcile_idx
  ON message_flag_deliveries (state, updated_at)
  WHERE state IN ('pending', 'delivering', 'uncertain');
