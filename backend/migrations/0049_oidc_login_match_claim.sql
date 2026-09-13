-- Configurable OIDC claim used to match an SSO login to an existing MailExpert account
-- during the initial link (provisioning_mode = login_existing_only). The value is a claim
-- name read from the *verified* id_token (e.g. 'email', 'preferred_username', 'upn') and is
-- always matched against users.username. Default 'email' preserves the prior hardcoded
-- behavior exactly, so existing installs are unaffected. See routes/oidc.js and issue #289.
ALTER TABLE oidc_providers
  ADD COLUMN IF NOT EXISTS login_match_claim VARCHAR(64) NOT NULL DEFAULT 'email';
