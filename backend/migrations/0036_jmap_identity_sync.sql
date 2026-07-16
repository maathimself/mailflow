-- Read-only JMAP identity sync (host-configurable — Fastmail is one provider
-- profile, not a pinned default; Stalwart and other self-hosted JMAP servers
-- work the same way). Only Identity/get is ever called; nothing is written
-- back to the provider.
--
-- sendable_addresses is a private authorization set, never returned as a list
-- by any API and never rendered in any UI list or From picker enumeration —
-- "delivered to X" does not mean "allowed to send as X". It exists only so
-- reply-time and send-time can transiently authorize a From that the
-- provider has actually verified.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS jmap_session_url TEXT,
  ADD COLUMN IF NOT EXISTS jmap_api_token TEXT,
  ADD COLUMN IF NOT EXISTS jmap_identity_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS jmap_identity_sync_error TEXT;

CREATE TABLE IF NOT EXISTS sendable_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  -- Lowercase exact address, or a `*@domain` catch-all pattern (Fastmail custom-domain
  -- identities can be wildcarded).
  address VARCHAR(255) NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  reply_to JSONB NOT NULL DEFAULT '[]',
  -- 'identity' is the only kind synced by this PR; 'masked' is reserved for the optional
  -- Masked Email follow-up (synced only when the provider advertises that capability).
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('identity', 'masked')),
  provider_id VARCHAR(255) NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, kind, provider_id)
);

CREATE INDEX IF NOT EXISTS sendable_addresses_account_address_idx
  ON sendable_addresses (account_id, address);
