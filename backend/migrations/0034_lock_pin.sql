-- Screen-lock PIN (#235). A dedicated 4-6 digit PIN, separate from the account
-- password / SSO, so any user — including SSO-only accounts with no password — can use
-- the privacy screen lock. Stored bcrypt-hashed; never the plain PIN. Nullable: the
-- Lock option is only offered once a PIN is set.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_pin_hash TEXT;
