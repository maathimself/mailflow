ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS include_in_unified_inbox BOOLEAN NOT NULL DEFAULT true;
