-- Antispam training features (v0.2 — Solution C)
--
-- At mark time, the /spam and /ham endpoints extract and persist the features
-- needed for retraining directly into spam_training_log. The retrain path
-- therefore never reaches back into messages, which solves two problems:
--
--   1. v0.1 spam_training_log has no foreign key to messages.id; it stores
--      message_id_header, message_uid, and folder. The original v0.2 ADR
--      proposed a JOIN on a non-existent column.
--   2. When users empty their Junk folder, the original v0.2 INNER JOIN
--      silently dropped every associated training record. Solution C makes
--      the retrain path independent of message persistence.
--
-- All new columns are nullable so existing v0.1 rows remain valid. The
-- tokenize-and-extract logic will be added in v0.2 endpoints (commit pending).

ALTER TABLE spam_training_log
  ADD COLUMN IF NOT EXISTS subject          TEXT,
  ADD COLUMN IF NOT EXISTS body_text        TEXT,
  ADD COLUMN IF NOT EXISTS body_html        TEXT,
  ADD COLUMN IF NOT EXISTS token_counts     JSONB,
  ADD COLUMN IF NOT EXISTS flag_features    JSONB,
  ADD COLUMN IF NOT EXISTS sender_domain    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS attachment_types TEXT[];

-- Index on user_id + created_at to speed up the full retrain SELECT.
-- (user_id is already the leading column of the existing v0.1 index, but
-- adding created_at makes the ORDER BY ... LIMIT pattern efficient if
-- we ever need to retrain on a date range.)
CREATE INDEX IF NOT EXISTS idx_spam_training_log_user_created
  ON spam_training_log (user_id, created_at DESC);

-- Comment on the new columns so the schema is self-documenting in psql.
COMMENT ON COLUMN spam_training_log.subject IS
  'Plain-text subject at mark time, used as bag-of-words input for retrain. NULL for v0.1 rows.';

COMMENT ON COLUMN spam_training_log.body_text IS
  'Plain-text body (HTML stripped) at mark time. May be NULL if the original message is gone or the extractor failed.';

COMMENT ON COLUMN spam_training_log.body_html IS
  'Original HTML body, kept for debugging and for future re-extraction if the tokenizer changes. May be NULL.';

COMMENT ON COLUMN spam_training_log.token_counts IS
  'Pre-tokenized word counts as {word: count}. Populated by the v0.2 /spam and /ham endpoints to avoid re-tokenization on every retrain.';

COMMENT ON COLUMN spam_training_log.flag_features IS
  'Binary flags extracted at mark time: {dkim_pass, spf_pass, dmarc_pass, has_attachment, attachment_is_executable, all_caps_subject_ratio, from_equals_reply_to_mismatch}.';

COMMENT ON COLUMN spam_training_log.sender_domain IS
  'Domain part of the From address, used for sender-based features.';

COMMENT ON COLUMN spam_training_log.attachment_types IS
  'List of attachment file extensions detected at mark time, used by ATTACHMENT_EXECUTABLE and ATTACHMENT_DOUBLE_EXT rules.';
