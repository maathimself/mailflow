-- A Sent copy recorded right after sending was stored without the attachment flag, and nothing
-- set it later: sync skips uids it already holds, and storing the body leaves the flag alone.
-- Rows whose stored attachments include one sent as an attachment get the flag back, by the
-- rule sync applies to the body structure (an explicit attachment disposition).
UPDATE messages
   SET has_attachments = true
 WHERE has_attachments = false
   AND jsonb_typeof(attachments) = 'array'
   AND jsonb_array_length(attachments) > 0
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'disposition' = 'attachment'
   );
