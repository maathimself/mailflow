-- Automatic Cc and Bcc addresses for each account (#491).
--
-- The composer pre-fills these as ordinary recipients that the user can see and remove, on mail
-- written from the account or one of its aliases. The server never adds them: sending and saving
-- a draft use only the recipients the composer submits.
--
-- '{}' means none. Each element is one bare address, validated by routes/accounts.js. The
-- constant default makes the ADD metadata-only, so existing rows are not rewritten.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS auto_cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS auto_bcc_addresses TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN email_accounts.auto_cc_addresses IS
  'Addresses the composer pre-fills as removable Cc recipients on mail from this account and its aliases. Never added by the server. ''{}'' = none.';
COMMENT ON COLUMN email_accounts.auto_bcc_addresses IS
  'Addresses the composer pre-fills as removable Bcc recipients on mail from this account and its aliases. Never added by the server. ''{}'' = none.';
