-- The Microsoft app (client ID) and tenant an OAuth account was connected with (#674).
-- A refresh token is bound to the client that obtained it, so refreshing through a
-- different one fails. MailFlow's built-in public client and an instance's own app can
-- both be in use, and an admin can add or change MS_CLIENT_ID at any time, so the
-- refresh has to use the identity the account was connected with, not the current config.
--
-- Existing rows stay NULL and keep refreshing through the instance config, as before.
-- The first successful refresh records the identity it used. See routes/oauth.js
-- doRefreshMicrosoftToken.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_client_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS oauth_tenant_id VARCHAR(255);
