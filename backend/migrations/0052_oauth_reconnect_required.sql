-- Set when an OAuth refresh fails with a revoked or expired grant; cleared by a new consent.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS oauth_reconnect_required BOOLEAN NOT NULL DEFAULT false;
