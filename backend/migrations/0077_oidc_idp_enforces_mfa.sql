-- Per OIDC provider: does the identity provider already enforce multi-factor sign-in?
-- Single sign-on now takes the same second step as password login (GHSA-48gw-3xw6-9v67):
-- the user's own authenticator, and the admin's "2FA required" policy. An admin whose
-- provider already requires MFA can turn this on to skip MailFlow's step for its sign-ins.
-- Off by default, so the second step applies unless an admin says otherwise.
ALTER TABLE oidc_providers ADD COLUMN IF NOT EXISTS idp_enforces_mfa BOOLEAN NOT NULL DEFAULT false;
