-- Distinguishes public OAuth clients (device-code flow — e.g. personal
-- Outlook.com / Hotmail accounts) from confidential ones (authorization-code flow
-- with a client secret). Public clients must NEVER send a client_secret on token
-- refresh; Microsoft rejects it with AADSTS90023 ("Public clients can't send a
-- client secret"). One instance can host both kinds, so the decision has to be
-- per account, not based on whether a secret happens to be configured globally.
--
-- Existing rows default to false (confidential); a device-code account created
-- before this column self-heals to true on its first refresh if the secret is
-- rejected. See routes/oauth.js doRefreshMicrosoftToken.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_public_client BOOLEAN NOT NULL DEFAULT false;
