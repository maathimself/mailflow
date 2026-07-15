-- Remote CardDAV collection state is separate from the sync token and ETags
-- Mailflow serves to its own CardDAV clients.
DO $$
BEGIN
  IF EXISTS (
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY user_id, external_url
               ORDER BY created_at, id
             ) AS position
      FROM address_books
      WHERE source = 'carddav' AND external_url IS NOT NULL
    )
    SELECT 1
    FROM ranked
    JOIN contacts contact ON contact.address_book_id = ranked.id
    WHERE ranked.position > 1
  ) THEN
    RAISE EXCEPTION 'cannot consolidate populated duplicate CardDAV address books';
  END IF;
END $$;

ALTER TABLE address_books
  ADD COLUMN IF NOT EXISTS remote_sync_token TEXT,
  ADD COLUMN IF NOT EXISTS remote_sync_capability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (remote_sync_capability IN ('unknown', 'sync-collection', 'snapshot')),
  ADD COLUMN IF NOT EXISTS remote_sync_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remote_projection_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS carddav_remote_objects (
  address_book_id UUID NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  remote_etag TEXT,
  vcard TEXT NOT NULL,
  primary_email TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('separate', 'merge', 'skip')),
  local_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  merge_before JSONB,
  merge_applied JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (address_book_id, href)
);

UPDATE user_integrations
SET config = config || jsonb_build_object('connectionGeneration', gen_random_uuid()::text)
WHERE provider = 'carddav'
  AND NOT (config ? 'connectionGeneration');

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, external_url
           ORDER BY created_at, id
         ) AS position
  FROM address_books
  WHERE source = 'carddav' AND external_url IS NOT NULL
)
DELETE FROM address_books
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS carddav_one_remote_book_idx
  ON address_books (user_id, external_url)
  WHERE source = 'carddav' AND external_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS carddav_remote_object_contact_idx
  ON carddav_remote_objects (local_contact_id)
  WHERE local_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS carddav_remote_object_email_idx
  ON carddav_remote_objects (address_book_id, primary_email);

CREATE UNIQUE INDEX IF NOT EXISTS carddav_one_merge_source_per_contact_idx
  ON carddav_remote_objects (local_contact_id)
  WHERE disposition = 'merge' AND local_contact_id IS NOT NULL;
