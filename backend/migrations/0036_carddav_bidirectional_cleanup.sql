UPDATE user_integrations
SET config = config - 'dupMode'
WHERE provider = 'carddav' AND config ? 'dupMode';

DROP INDEX IF EXISTS carddav_one_merge_source_per_contact_idx;

ALTER TABLE carddav_remote_objects
  DROP COLUMN disposition,
  DROP COLUMN merge_before,
  DROP COLUMN merge_applied,
  DROP COLUMN legacy_projection,
  ADD COLUMN IF NOT EXISTS pending_operation TEXT
    CHECK (pending_operation IS NULL OR pending_operation IN ('update', 'delete')),
  ADD COLUMN IF NOT EXISTS pending_vcard TEXT,
  ADD COLUMN IF NOT EXISTS pending_local_hash TEXT,
  ADD COLUMN IF NOT EXISTS pending_remote_semantic_hash TEXT,
  ADD COLUMN IF NOT EXISTS pending_started_at TIMESTAMPTZ,
  ADD CHECK (
    (
      pending_operation IS NULL
      AND pending_vcard IS NULL
      AND pending_local_hash IS NULL
      AND pending_remote_semantic_hash IS NULL
      AND pending_started_at IS NULL
    )
    OR
    (
      pending_operation = 'update'
      AND pending_vcard IS NOT NULL
      AND pending_local_hash IS NOT NULL
      AND pending_remote_semantic_hash IS NOT NULL
      AND pending_started_at IS NOT NULL
    )
    OR
    (
      pending_operation = 'delete'
      AND pending_vcard IS NULL
      AND pending_local_hash IS NOT NULL
      AND pending_remote_semantic_hash IS NULL
      AND pending_started_at IS NOT NULL
    )
  );
