-- Multi-address-book CardDAV: surface per-book roles (write-target /
-- subscribed / lookup-only) so a connected server exposing several address
-- books can be treated by role rather than symmetrically. This migration is
-- schema-only — it does not change sync
-- behavior. Backfill preserves today's behavior exactly: every existing
-- carddav book stays subscribed + lookup, and the first create-capable book
-- per user becomes the write-target (mirroring the current selectedCreateBook
-- rule), so no existing user's write destination changes.

ALTER TABLE address_books
  ADD COLUMN IF NOT EXISTS is_write_target  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_subscribed    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_lookup_source BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'address_books_write_target_subscribed'
      AND conrelid = 'address_books'::regclass
  ) THEN
    ALTER TABLE address_books
      ADD CONSTRAINT address_books_write_target_subscribed
      CHECK (NOT is_write_target OR is_subscribed);
  END IF;
END $$;

-- At most one write-target per user among carddav books.
CREATE UNIQUE INDEX IF NOT EXISTS carddav_one_write_target_idx
  ON address_books (user_id)
  WHERE source = 'carddav' AND is_write_target;

-- Backfill: preserve today's behavior for existing single/multi-book users.
UPDATE address_books
  SET is_subscribed = true, is_lookup_source = true
  WHERE source = 'carddav';

-- First create-capable book per user becomes the write-target (mirrors the
-- current selectedCreateBook rule; tie-break by insertion order).
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id
    ORDER BY (remote_create_capability = 'allowed') DESC, created_at, id
  ) AS position
  FROM address_books
  WHERE source = 'carddav'
    AND remote_create_capability IN ('allowed', 'unknown')
)
UPDATE address_books SET is_write_target = true
  WHERE id IN (SELECT id FROM ranked WHERE position = 1);

-- Ledger gains a terminal 'lookup' status and a projected display name.
ALTER TABLE carddav_remote_objects
  DROP CONSTRAINT IF EXISTS carddav_remote_objects_mapping_status_check,
  ADD  CONSTRAINT carddav_remote_objects_mapping_status_check
    CHECK (mapping_status IN
      ('pending_materialization','synced','pending_push','conflict','lookup')),
  ADD COLUMN IF NOT EXISTS lookup_display_name TEXT;

-- Fast inbound lookup by email across a user's lookup books.
CREATE INDEX IF NOT EXISTS carddav_lookup_email_idx
  ON carddav_remote_objects (primary_email)
  WHERE mapping_status = 'lookup';
