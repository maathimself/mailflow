-- Instance-global ChatGPT/Codex subscription credentials and restart-safe
-- device authorization flows. All credential/code columns contain Mailflow's
-- enc:v1 AES-GCM envelope; raw session IDs are represented only by SHA-256.

CREATE TABLE IF NOT EXISTS ai_codex_credentials (
  singleton         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  encrypted_payload TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_codex_device_flows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash           CHAR(64) NOT NULL,
  device_auth_id_enc     TEXT,
  user_code_enc          TEXT,
  authorization_code_enc TEXT,
  code_verifier_enc      TEXT,
  interval_ms            INTEGER NOT NULL CHECK (interval_ms BETWEEN 1000 AND 60000),
  expires_at             TIMESTAMPTZ NOT NULL,
  next_poll_at           TIMESTAMPTZ NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'polling', 'authorized', 'completed', 'cancelled', 'expired', 'failed')),
  failure_code           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_codex_flows_owner_state
  ON ai_codex_device_flows(admin_user_id, session_hash, state);

CREATE INDEX IF NOT EXISTS idx_ai_codex_flows_expiry
  ON ai_codex_device_flows(expires_at)
  WHERE state IN ('pending', 'polling', 'authorized');
