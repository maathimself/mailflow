UPDATE send_operations
   SET message_id = NULL,
       sent_folder = NULL,
       sent_metadata = NULL,
       raw_message = NULL,
       server_auto_saves = NULL,
       smtp_message = NULL,
       smtp_envelope = NULL,
       prepared_payload_digest = NULL,
       source_snapshots = NULL
 WHERE state = 'completed';

ALTER TABLE send_operations
  ADD CONSTRAINT send_operations_completed_payload_redacted
  CHECK (
    state <> 'completed' OR (
      message_id IS NULL AND sent_folder IS NULL AND sent_metadata IS NULL
      AND raw_message IS NULL AND server_auto_saves IS NULL
      AND smtp_message IS NULL AND smtp_envelope IS NULL
      AND prepared_payload_digest IS NULL AND source_snapshots IS NULL
    )
  );

UPDATE inbox_rule_forwards
   SET recipient = NULL,
       smtp_message = NULL,
       smtp_envelope = NULL,
       source_snapshot = NULL
 WHERE status = 'sent';

ALTER TABLE inbox_rule_forwards
  ADD CONSTRAINT inbox_rule_forwards_sent_payload_redacted
  CHECK (
    status <> 'sent' OR (
      recipient IS NULL AND smtp_message IS NULL
      AND smtp_envelope IS NULL AND source_snapshot IS NULL
    )
  );
