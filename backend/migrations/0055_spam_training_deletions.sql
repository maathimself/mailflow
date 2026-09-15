-- Antispam v0.2 — GDPR deletion audit trail (design §16.6, Option B).
--
-- Separate table (recommended over overloading spam_training_log with
-- label='deleted'): keeps the training corpus clean while giving the audit
-- trail a natural home. Every GDPR reset (per-account or per-user) writes
-- one row; the user can list their own deletions via GET /api/spam/deletions.
-- Rows are kept for compliance (2-year retention matches GDPR log practice).

CREATE TABLE IF NOT EXISTS spam_training_deletions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      UUID REFERENCES email_accounts(id) ON DELETE SET NULL,
  scope           VARCHAR(20) NOT NULL CHECK (scope IN ('per_account', 'all')),
  records_deleted BIGINT NOT NULL,
  reason          VARCHAR(50) DEFAULT 'gdpr_erasure',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      INET,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_spam_training_deletions_user
  ON spam_training_deletions (user_id, requested_at DESC);

COMMENT ON TABLE spam_training_deletions IS
  'Audit trail of GDPR training-data resets. One row per reset (scope per_account or all).';

COMMENT ON COLUMN spam_training_deletions.scope IS
  'per_account = one IMAP account reset; all = the whole user model reset.';