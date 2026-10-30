-- Messages the user has scheduled to send later (#543). The content is encrypted with a key
-- derived from ENCRYPTION_KEY for this purpose alone (services/encryption.js encryptBytes,
-- purpose 'scheduled-send'), bound to the row by its additional data, so ciphertext copied to
-- another row or another user does not decrypt. Plaintext columns are what the scheduler needs
-- to find, claim and account for a row, and nothing about who it is to or what it says: the
-- Message-ID fixed at schedule time and the alias it goes out from are in the payload.
--
-- There is no foreign key to account_aliases. The alias is resolved at send time, so deleting
-- it fails that message (alias_missing) rather than cascading it away or sending it from the
-- account address. Deleting the account or the user deletes its scheduled messages.
--
-- The limits that keep a row small enough for a backup line are checked here: a payload of at
-- most 10 MB and attachment chunks of at most 1 MiB, each plus the 29 bytes encryptBytes adds,
-- and 25 MB of attachments per message, as Send allows. The per-user limits (pending count,
-- stored bytes), the earliest and latest send time and the create rate are checked by the
-- application, which knows the time and holds the user's row while it counts.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  -- The composer's id for this schedule, so a retried create cannot make a second row.
  client_key        UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'editing', 'sending', 'sent', 'failed',
                                      'paused', 'uncertain', 'cancelled')),
  -- What the user asked for, shown in the UI. Never moved by retries.
  send_at           TIMESTAMPTZ NOT NULL,
  -- When the scheduler may next pick it up: send_at, or later after a transient failure.
  due_at            TIMESTAMPTZ NOT NULL,
  -- IANA zone the time was picked in (display only; send_at is absolute).
  time_zone         VARCHAR(64),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  summary_enc       BYTEA,          -- {subject, to, ccCount, bccCount, snippet, attachmentCount}
  payload_enc       BYTEA           -- the send spec: messageId, aliasId, recipients, body, ...
                    CHECK (octet_length(payload_enc) <= 10485760 + 29),
  payload_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
  attachment_bytes  BIGINT  NOT NULL DEFAULT 0 CHECK (attachment_bytes BETWEEN 0 AND 26214400),
  attempts          SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The lease of a scheduler that claimed the row: every later update of it names the token.
  claim_token       UUID,
  claimed_at        TIMESTAMPTZ,
  smtp_started_at   TIMESTAMPTZ,    -- set right before the message is handed to SMTP
  smtp_accepted_at  TIMESTAMPTZ,    -- set the moment SMTP accepted it
  -- The hold of a composer that has the message open for editing.
  edit_token        UUID,
  edit_lease_until  TIMESTAMPTZ,
  pause_reason      TEXT CHECK (pause_reason IN ('overdue', 'restored', 'edit_abandoned',
                                                 'account_disabled', 'needs_reauth', 'user')),
  -- What an edit hold or a cancel returns the message to.
  status_before     TEXT CHECK (status_before IN ('scheduled', 'paused', 'failed', 'uncertain')),
  -- A machine code, listed in services/scheduledSend.js and mapped to copy in the UI. Any text
  -- about the failure, such as the SMTP server's reply, goes in result_enc, encrypted.
  failure_code      VARCHAR(64),
  result_enc        BYTEA,          -- {sentFolder, messageId, sentCopySaved, rejected[], error}
  sent_at           TIMESTAMPTZ,
  -- Sent later than scheduled (after downtime, within the overdue grace), so the user is told.
  sent_late         BOOLEAN NOT NULL DEFAULT false,
  purge_after       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_key),
  -- SMTP can only have accepted a message it was handed.
  CHECK (smtp_accepted_at IS NULL OR smtp_started_at IS NOT NULL)
);

-- The scheduler's claim: the due rows, soonest first.
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_messages (due_at) WHERE status = 'scheduled';
-- The Scheduled view, its sidebar count and the per-user limits.
CREATE INDEX IF NOT EXISTS idx_scheduled_user
  ON scheduled_messages (user_id, status, send_at);
-- Recovery of claims whose process died, and lapsed edit holds.
CREATE INDEX IF NOT EXISTS idx_scheduled_sending
  ON scheduled_messages (claimed_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS idx_scheduled_editing
  ON scheduled_messages (edit_lease_until) WHERE status = 'editing';
CREATE INDEX IF NOT EXISTS idx_scheduled_purge
  ON scheduled_messages (purge_after) WHERE purge_after IS NOT NULL;
-- One send in flight per account: the claim skips an account that has one, and two schedulers
-- claiming for the same account at the same moment cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_account_sending
  ON scheduled_messages (account_id) WHERE status = 'sending';
-- ON DELETE CASCADE from email_accounts, and the count the account delete confirmation shows.
CREATE INDEX IF NOT EXISTS idx_scheduled_account ON scheduled_messages (account_id);

-- Attachments in chunks of at most 1 MiB of plaintext, each encrypted on its own, so a
-- backup line and a restore insert stay small whatever the attachment size (backup.js
-- writes bytea as hex inside one JSON line per row).
CREATE TABLE IF NOT EXISTS scheduled_message_attachments (
  scheduled_id      UUID NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE,
  attachment_index  SMALLINT NOT NULL CHECK (attachment_index >= 0),
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  -- Chunk 0 only: {filename, contentType, disposition, kind, size, sha256}
  meta_enc          BYTEA CHECK (meta_enc IS NULL OR chunk_index = 0),
  data_enc          BYTEA NOT NULL CHECK (octet_length(data_enc) <= 1048576 + 29),
  PRIMARY KEY (scheduled_id, attachment_index, chunk_index)
);
