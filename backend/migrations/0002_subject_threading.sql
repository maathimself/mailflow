-- Add normalized_subject as a generated column for subject-based thread fallback.
-- Strips up to 3 levels of common reply/forward prefixes (Re:, FW:, AW:, etc.)
-- and lowercases the result. Used by computeThreadId when RFC 5322 In-Reply-To /
-- References headers are absent (e.g. Outlook RE:, webmail without threading headers).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS normalized_subject TEXT GENERATED ALWAYS AS (
  lower(trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          coalesce(subject, ''),
          '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
          '', 'i'
        ),
        '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
        '', 'i'
      ),
      '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
      '', 'i'
    )
  ))
) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_norm_subject
  ON messages(account_id, normalized_subject)
  WHERE is_deleted = false AND normalized_subject IS NOT NULL;

-- Retroactively re-thread existing messages that share a normalized subject but
-- ended up as singletons because their RFC 5322 headers were absent.
-- Only touches messages where thread_id = message_id (no header-based parent was
-- found at ingest time) and no in_reply_to / references are set.
-- Within each (account, normalized_subject) group, all messages are reassigned to
-- the thread_id of the earliest-dated message in the group.
WITH rethreaded AS (
  SELECT
    id,
    FIRST_VALUE(message_id) OVER (
      PARTITION BY account_id, normalized_subject
      ORDER BY date ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS new_thread_id,
    COUNT(*) OVER (PARTITION BY account_id, normalized_subject) AS group_size
  FROM messages
  WHERE is_deleted = false
    AND normalized_subject IS NOT NULL
    AND normalized_subject != ''
    AND message_id IS NOT NULL
    AND thread_id = message_id
    AND (in_reply_to IS NULL OR in_reply_to = '')
    AND (thread_references IS NULL OR thread_references = '')
)
UPDATE messages m
SET thread_id = r.new_thread_id
FROM rethreaded r
WHERE m.id = r.id
  AND r.group_size > 1
  AND m.thread_id IS DISTINCT FROM r.new_thread_id;
