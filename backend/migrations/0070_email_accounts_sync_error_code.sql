-- What kind of failure sync_error holds, so the UI can say what to do about it (sign in
-- again, turn on IMAP in Outlook.com, ask an administrator) without parsing server text.
-- The codes are listed in src/services/accountErrorCode.js. NULL whenever sync_error is NULL,
-- and for errors recorded before this column existed, which the UI shows as a generic
-- connection problem until the next failure records a code.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS sync_error_code VARCHAR(64);
