ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS backfill_incomplete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata_complete BOOLEAN NOT NULL DEFAULT true;

-- Rows created from UID-only FETCH records before the envelope guard have this exact
-- manufactured shape. Hide and re-fetch them; a legitimate all-NIL envelope is marked
-- complete by the guarded upsert after verification.
UPDATE messages
   SET metadata_complete = false
 WHERE message_id IS NULL
   AND subject = '(no subject)'
   AND COALESCE(snippet, '') = '';

-- Every existing folder starts pending an exact UID verification pass. Complete rows remain in
-- the diff set, so only legacy hollow rows (metadata_complete=false) are fetched again. Runtime
-- backfill clears this marker without fetching for intentional provider skip views.
UPDATE folders f
   SET backfill_incomplete = true,
       total_count = (SELECT COUNT(*) FROM messages m
                       WHERE m.account_id = f.account_id AND m.folder = f.path
                         AND m.is_deleted = false AND m.metadata_complete = true),
       unread_count = (SELECT COUNT(*) FILTER (WHERE NOT m.is_read) FROM messages m
                        WHERE m.account_id = f.account_id AND m.folder = f.path
                          AND m.is_deleted = false AND m.metadata_complete = true);
