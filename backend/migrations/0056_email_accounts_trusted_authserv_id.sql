-- Trusted Authentication-Results authserv-id, per account (v0.2 antispam).
--
-- `Authentication-Results` is only meaningful when the header was written by a
-- mail system the account owner trusts: the header is just text in the message,
-- so a sender can add their own `Authentication-Results: x; dkim=pass; spf=pass;
-- dmarc=pass`. Because RFC 7601 allows multiple such headers and the antispam
-- parser lets 'pass' win across all of them, an untrusted header could both earn
-- the pass weights and silence the AUTH_*_FAIL rules.
--
-- This column holds the authserv-id (RFC 8601 §2.2: the identifier before the
-- first ';', e.g. "mx.google.com") whose headers are honored for this account.
-- Comparison is case-insensitive and ignores an authserv-id-version suffix.
--
-- NULL (the default) means "trust nothing": every Authentication-Results header
-- is ignored and treated exactly like an absent one — the auth rules stay
-- neutral and the ML auth flags are null. That is the safe default for existing
-- installs, but it also means the auth signal is silently unused until an admin
-- configures the value; the Antispam settings expose the ids actually observed
-- on recently received mail so the right value is one click away.
--
-- No index: the column is read once per classified message from the account row
-- that is already loaded by the classification query.

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS trusted_authserv_id VARCHAR(255);

COMMENT ON COLUMN email_accounts.trusted_authserv_id IS
  'authserv-id whose Authentication-Results headers are trusted for this account (e.g. mx.google.com). NULL = trust none: untrusted headers are ignored and the auth signal is neutral.';
