-- Rename old flat contacts table so we can rebuild cleanly.
-- Conditional so fresh installs (no prior contacts table) work too.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'contacts'
      AND column_name  = 'email'
  ) THEN
    ALTER TABLE contacts RENAME TO contacts_legacy;
  END IF;
END $$;

-- One address book per user; each CardDAV client syncs a specific book.
CREATE TABLE IF NOT EXISTS address_books (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL DEFAULT 'Personal',
  description  TEXT,
  color        TEXT,
  sync_token   TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Seed a default Personal address book for every existing user.
INSERT INTO address_books (user_id, name)
SELECT id, 'Personal' FROM users
ON CONFLICT (user_id, name) DO NOTHING;

-- Full contact record. vcard is the CardDAV source of truth;
-- the other fields are denormalized for fast query/autocomplete.
CREATE TABLE IF NOT EXISTS contacts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  address_book_id UUID        NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid             TEXT        NOT NULL,
  vcard           TEXT,
  etag            TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  display_name    TEXT,
  first_name      TEXT,
  last_name       TEXT,
  primary_email   TEXT,
  emails          JSONB       NOT NULL DEFAULT '[]',
  phones          JSONB       NOT NULL DEFAULT '[]',
  organization    TEXT,
  notes           TEXT,
  photo_data      TEXT,
  is_auto         BOOLEAN     NOT NULL DEFAULT false,
  send_count      INT         NOT NULL DEFAULT 0,
  last_sent       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(address_book_id, uid)
);

-- Migrate explicit (sent-to) contacts from the legacy table (is_auto = false).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'contacts_legacy'
  ) THEN
    INSERT INTO contacts (
      address_book_id, user_id, uid,
      display_name, primary_email, emails,
      is_auto, send_count, last_sent
    )
    SELECT
      ab.id,
      c.user_id,
      gen_random_uuid()::text,
      COALESCE(NULLIF(trim(c.name), ''), c.email),
      lower(c.email),
      jsonb_build_array(
        jsonb_build_object('value', lower(c.email), 'type', 'other', 'primary', true)
      ),
      false,
      c.send_count,
      c.last_sent
    FROM contacts_legacy c
    JOIN address_books ab ON ab.user_id = c.user_id AND ab.name = 'Personal'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Backfill auto-discovered contacts from inbound messages (is_auto = true).
-- DISTINCT ON picks the most-recent message per (user, email) for the best name.
-- Excludes bulk mail, robot senders, and emails already present from the legacy table.
INSERT INTO contacts (
  address_book_id, user_id, uid,
  display_name, primary_email, emails, is_auto
)
SELECT
  ab.id,
  latest.user_id,
  gen_random_uuid()::text,
  COALESCE(NULLIF(trim(latest.from_name), ''), latest.from_email),
  lower(latest.from_email),
  jsonb_build_array(
    jsonb_build_object('value', lower(latest.from_email), 'type', 'other', 'primary', true)
  ),
  true
FROM (
  SELECT DISTINCT ON (ea.user_id, lower(m.from_email))
    ea.user_id,
    m.from_email,
    m.from_name,
    m.date
  FROM messages m
  JOIN email_accounts ea ON ea.id = m.account_id
  WHERE m.from_email IS NOT NULL
    AND m.from_email != ''
    AND m.is_deleted = false
    AND (m.is_bulk IS NOT TRUE)
    AND m.from_email !~* '^(noreply|no-reply|donotreply|mailer-daemon|notifications?|bounce[^@]*)@'
  ORDER BY ea.user_id, lower(m.from_email), m.date DESC
) latest
JOIN address_books ab ON ab.user_id = latest.user_id AND ab.name = 'Personal'
WHERE lower(latest.from_email) NOT IN (
  SELECT primary_email
  FROM contacts
  WHERE user_id = latest.user_id AND primary_email IS NOT NULL
)
ON CONFLICT DO NOTHING;

-- Generate a minimal vCard 3.0 for every contact that doesn't have one yet.
UPDATE contacts SET
  vcard = 'BEGIN:VCARD' || E'\r\n'
       || 'VERSION:3.0' || E'\r\n'
       || 'UID:' || uid || E'\r\n'
       || 'FN:' || replace(replace(replace(
              coalesce(display_name, primary_email, ''),
              '\', '\\'), ';', '\;'), ',', '\,')
       || E'\r\n'
       || CASE WHEN primary_email IS NOT NULL
               THEN 'EMAIL:' || primary_email || E'\r\n'
               ELSE ''
          END
       || 'END:VCARD' || E'\r\n'
WHERE vcard IS NULL;

-- Derive etag from vcard content.
UPDATE contacts SET etag = md5(vcard) WHERE vcard IS NOT NULL;

-- Fast upsert by email when processing sent/received mail.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_primary_email_idx
  ON contacts (user_id, primary_email)
  WHERE primary_email IS NOT NULL;

-- Display name search for autocomplete.
CREATE INDEX IF NOT EXISTS contacts_display_name_idx ON contacts (user_id, lower(display_name));

-- Drop the legacy table — data is now in the new contacts table.
DROP TABLE IF EXISTS contacts_legacy;

-- Bump sync tokens so CardDAV clients that connect will perform a full re-sync.
UPDATE address_books SET
  sync_token = gen_random_uuid()::text,
  updated_at = NOW();
