-- Separate SMTP credentials (issue #353).
-- Lets an account send outgoing mail through a different SMTP server with its own
-- username/password, independent of the IMAP login (e.g. receive from a webhost but
-- relay through a deliverability-focused SMTP). Both columns are nullable; when NULL
-- the SMTP transport falls back to auth_user / auth_pass, so existing accounts are
-- unaffected. Nullable ADD COLUMN with no default is metadata-only (no table rewrite).
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS smtp_auth_user VARCHAR(255);
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS smtp_auth_pass TEXT;
