-- Bcc recipients of a draft MailFlow saved. A draft's Bcc otherwise lives only in its IMAP copy,
-- and the composer reopens drafts from this row, so a reopened draft started with an empty Bcc and
-- its next save replaced (and expunged) the only copy that still had one.
-- NULL means not known locally: received mail, and drafts saved before this column, by another
-- client, or first seen by sync. Readers go to the server copy for those and must never treat
-- NULL as "no Bcc". '[]' means MailFlow saved the draft without one.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS bcc_addresses JSONB;
