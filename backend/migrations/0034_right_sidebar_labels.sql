ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS right_sidebar_labels JSONB NOT NULL DEFAULT '[]';
