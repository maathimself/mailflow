ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS observation_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_present BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS topology_identity UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS mailbox_topology_generation BIGINT NOT NULL DEFAULT 0;

-- Bind legacy snoozes while the last known folder/message identities are still actionable.
-- The quarantine below deliberately invalidates every historical folder observation, so this
-- exact, unambiguous association must happen before that reset. Headerless, ambiguous, or
-- already-unverified rows remain nullable for manual reconciliation.
ALTER TABLE snoozed_messages
  ADD COLUMN message_row_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'active'
    CHECK (resolution_state IN ('active', 'manual_intervention')),
  ADD COLUMN resolution_error JSONB;

WITH candidate_message_rows AS (
  SELECT sm.id AS snooze_id, m.id AS message_row_id,
         COUNT(*) OVER (PARTITION BY sm.id) AS match_count
    FROM snoozed_messages sm
    JOIN messages m ON m.account_id = sm.account_id
                   AND m.message_id = sm.message_id_header
                   AND m.folder = sm.snoozed_folder
                   AND m.is_deleted = false
                   AND m.metadata_complete = true
    JOIN folders f ON f.account_id = m.account_id
                  AND f.path = m.folder
                  AND f.is_present = true
                  AND f.uid_validity IS NOT NULL
   WHERE sm.message_row_id IS NULL
     AND sm.resolution_state = 'active'
), unique_message_rows AS (
  SELECT snooze_id, message_row_id
    FROM candidate_message_rows
   WHERE match_count = 1
)
UPDATE snoozed_messages sm
   SET message_row_id = unique_message_rows.message_row_id
  FROM unique_message_rows
 WHERE sm.id = unique_message_rows.snooze_id;

CREATE INDEX snoozed_messages_message_row_idx
  ON snoozed_messages (message_row_id)
  WHERE message_row_id IS NOT NULL;

-- Historical rows have not yet been confirmed by a complete post-rollout LIST.
UPDATE folders
   SET is_present = false,
       uid_validity = NULL,
       highest_modseq = NULL,
       observation_generation = observation_generation + 1,
       topology_identity = gen_random_uuid();

-- A message is actionable only when its provider folder identity is known. Existing
-- orphaned rows and rows from an unknown UID epoch are retained for reconciliation,
-- but quarantined from every normal read/mutation surface.
UPDATE messages m
   SET metadata_complete = false
 WHERE NOT EXISTS (
   SELECT 1
     FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = m.folder
      AND f.is_present = true
      AND f.uid_validity IS NOT NULL
 );
