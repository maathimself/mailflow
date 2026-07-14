ALTER TABLE address_books
  ADD COLUMN IF NOT EXISTS remote_create_capability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (remote_create_capability IN ('unknown', 'allowed', 'denied')),
  ADD COLUMN IF NOT EXISTS remote_update_capability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (remote_update_capability IN ('unknown', 'allowed', 'denied')),
  ADD COLUMN IF NOT EXISTS remote_delete_capability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (remote_delete_capability IN ('unknown', 'allowed', 'denied'));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS additional_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE carddav_remote_objects
  ALTER COLUMN disposition SET DEFAULT 'separate',
  ADD COLUMN IF NOT EXISTS mapping_status TEXT NOT NULL DEFAULT 'pending_materialization'
    CHECK (mapping_status IN ('pending_materialization', 'synced', 'pending_push', 'conflict')),
  ADD COLUMN IF NOT EXISTS vcard_version TEXT
    CHECK (vcard_version IS NULL OR vcard_version IN ('3.0', '4.0')),
  ADD COLUMN IF NOT EXISTS remote_semantic_hash TEXT,
  ADD COLUMN IF NOT EXISTS local_contact_hash TEXT,
  ADD COLUMN IF NOT EXISTS mapping_revision BIGINT NOT NULL DEFAULT 0
    CHECK (mapping_revision >= 0),
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_push_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_push_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legacy_projection JSONB;

UPDATE carddav_remote_objects
SET legacy_projection = jsonb_build_object(
  'disposition', disposition,
  'merge_before', merge_before,
  'merge_applied', merge_applied
);

CREATE UNIQUE INDEX IF NOT EXISTS carddav_one_active_mapping_per_contact_idx
  ON carddav_remote_objects (local_contact_id)
  WHERE local_contact_id IS NOT NULL
    AND mapping_status <> 'pending_materialization';

CREATE TABLE IF NOT EXISTS carddav_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_book_id UUID NOT NULL,
  href TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_local_hash TEXT,
  remote_etag TEXT,
  local_vcard TEXT,
  remote_vcard TEXT,
  local_tombstone BOOLEAN NOT NULL DEFAULT false,
  remote_tombstone BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved', 'resolved')),
  resolution TEXT
    CHECK (resolution IS NULL OR resolution IN ('keep-mailflow', 'keep-carddav')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT carddav_conflicts_remote_object_fkey FOREIGN KEY (address_book_id, href)
    REFERENCES carddav_remote_objects(address_book_id, href) ON DELETE CASCADE,
  CHECK (local_tombstone OR local_vcard IS NOT NULL),
  CHECK (remote_tombstone OR remote_vcard IS NOT NULL),
  CHECK (
    (status = 'unresolved'
      AND resolution IS NULL
      AND resolved_by IS NULL
      AND resolved_at IS NULL)
    OR
    (status = 'resolved'
      AND resolution IS NOT NULL
      AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS carddav_one_unresolved_conflict_per_mapping_idx
  ON carddav_conflicts (address_book_id, href)
  WHERE status = 'unresolved';
