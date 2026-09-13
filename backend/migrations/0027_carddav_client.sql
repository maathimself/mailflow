-- CardDAV client: pull contacts from an external CardDAV server (e.g. Nextcloud)
-- into MailExpert. Synced contacts land in a dedicated, read-only address book per
-- remote collection. Email-uniqueness is moved from per-user to per-address-book
-- so a synced contact can coexist with an auto-harvested or manually-added contact
-- that shares an email address (the user chooses duplicate handling per connection).

-- Mark address books that mirror an external CardDAV collection (read-only in the UI).
ALTER TABLE address_books ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE address_books ADD COLUMN IF NOT EXISTS external_url TEXT;

-- Switch email-uniqueness scope: per-user -> per-address-book. Existing rows already
-- satisfy the stricter per-user rule, so the new index cannot fail on current data.
DROP INDEX IF EXISTS contacts_user_primary_email_idx;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_book_primary_email_idx
  ON contacts (address_book_id, primary_email)
  WHERE primary_email IS NOT NULL;

-- Retain a non-unique (user_id, primary_email) index for photo/autocomplete lookups.
CREATE INDEX IF NOT EXISTS contacts_user_primary_email_lookup_idx
  ON contacts (user_id, primary_email)
  WHERE primary_email IS NOT NULL;
