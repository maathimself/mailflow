-- A mailbox's icon (#376): one emoji shown in place of its color dot, or none.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS icon VARCHAR(32);
