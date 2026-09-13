-- Opt-in RP-initiated (end-session) logout per OIDC provider. When enabled, logging
-- out of MailExpert also redirects the browser to the provider's end_session_endpoint
-- so the upstream SSO session is cleared, instead of only dropping MailExpert's cookie.
ALTER TABLE oidc_providers ADD COLUMN IF NOT EXISTS rp_initiated_logout BOOLEAN NOT NULL DEFAULT false;
