-- Fastmail alias/identity sync (v0.1)
--
-- Mirrors a Fastmail account's sending identities and Masked Email addresses into
-- MailFlow so the user can send from any of them. All added columns are nullable or
-- defaulted so existing rows stay valid.

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS fastmail_api_token TEXT,
  ADD COLUMN IF NOT EXISTS fastmail_last_sync TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fastmail_sync_error TEXT;

ALTER TABLE account_aliases
  ADD COLUMN IF NOT EXISTS provenance VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS fastmail_identity_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS fastmail_masked_email_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS fastmail_label TEXT,
  ADD COLUMN IF NOT EXISTS fastmail_reply_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fastmail_bcc JSONB NOT NULL DEFAULT '[]'::jsonb;

-- provenance separates user-created aliases ('manual', freely editable) from rows
-- mirrored out of Fastmail ('fastmail', read-only in the UI and replaced on each sync).
-- Guard the constraint so re-running the migration is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_aliases_provenance_check'
  ) THEN
    ALTER TABLE account_aliases
      ADD CONSTRAINT account_aliases_provenance_check
      CHECK (provenance IN ('manual', 'fastmail'));
  END IF;
END $$;

-- One row per Fastmail identity and per Masked Email, scoped to the account. Partial so
-- only Fastmail-provenanced rows are constrained, and unique so reconciliation matches an
-- existing row by its provider ID instead of inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS account_aliases_fastmail_identity_idx
  ON account_aliases (account_id, fastmail_identity_id)
  WHERE provenance = 'fastmail' AND fastmail_identity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS account_aliases_fastmail_mask_idx
  ON account_aliases (account_id, fastmail_masked_email_id)
  WHERE provenance = 'fastmail' AND fastmail_masked_email_id IS NOT NULL;

-- Claim table that dedupes masked-email -> identity promotion across concurrent syncs: a
-- worker inserts a claim row before creating the Fastmail identity so a second worker
-- (even in another process) sees the pending claim and backs off. Claims are reclaimable
-- after a TTL so a crashed promotion can be retried; the TTL reasoning lives in
-- fastmailAliasSync.js (FASTMAIL_PROMOTION_CLAIM_TTL).
CREATE TABLE IF NOT EXISTS fastmail_identity_promotions (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  masked_email_id VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, masked_email_id)
);

-- Addresses a message was delivered to, captured at ingest. Reply-sender resolution
-- matches these (plus To/Cc) against the account's identities and Masked Email addresses
-- to pick which alias a reply should come From (senderResolver.js).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
