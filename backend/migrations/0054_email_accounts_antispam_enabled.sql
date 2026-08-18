-- Per-account antispam toggle (v0.2)
--
-- The ML model is per-user (one model per MailFlow user, shared across all
-- their IMAP accounts — see migration 0035). Whether automatic classification
-- is *applied* to a given account is controlled per-account by the user via
-- this column. Default is FALSE so existing users and new installations are
-- not surprised by auto-moves. The user must explicitly opt in per account
-- in the account configuration page.
--
-- When this flag is FALSE, the classifyMessage hook in messageService.js
-- short-circuits and leaves the message in its current folder. The user can
-- still mark spam/ham manually on the account — those manual marks are
-- written to spam_training_log and contribute to the per-user model. The
-- toggle only controls *automatic application*, not training accumulation.
--
-- The partial index below is small (only accounts that have opted in) and
-- speeds up the "find accounts that want auto-classification" query in the
-- classifyMessage hook.

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS antispam_enabled BOOLEAN NOT NULL DEFAULT false;

-- Partial index: most accounts have antispam_enabled = false, so a partial
-- index on the rare TRUE values is much smaller and faster than a full index.
CREATE INDEX IF NOT EXISTS idx_email_accounts_antispam_enabled
  ON email_accounts (id) WHERE antispam_enabled = true;

-- Self-documenting comment.
COMMENT ON COLUMN email_accounts.antispam_enabled IS
  'When TRUE, incoming messages on this account are auto-classified by the per-user spam model and auto-moved to Junk if confidence > AUTO_MOVE_THRESHOLD. Default FALSE. Manual spam/ham marks on this account still feed the per-user training data regardless of this flag.';
