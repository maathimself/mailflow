-- Antispam ML model (v0.2)
--
-- One row per user. The vocabulary is a JSONB map of {word: {spam, ham}}
-- containing running counts (incremental training, see backend/src/services/spamModel.js).
-- The model is rebuilt from scratch by a nightly cron job (per-user staggered
-- schedule, see backend/src/services/spamScheduler.js) with configurable
-- exponential time decay. See the ADR and design doc for the full architecture.
--
-- Reads of the model go through an in-process cache (Map<userId, Model>) with
-- a 5-minute TTL — same pattern used by categorizer.js for social domains.
-- Writes (POST /spam, /ham) update the JSONB counts in place and invalidate
-- the cache entry, so user feedback is reflected in <1 second.
--
-- Chi-square feature selection keeps the vocabulary capped at 10k words per
-- user. After each full retrain, words with term-frequency > 0.05 (likely
-- stop-words) and words with spam_count + ham_count < 3 (too rare) are
-- pruned; the top 10k words by information-theoretic discrimination are kept.
--
-- total_spam/total_ham are REAL (not integer) because the full retrain
-- (spamModel.retrainFromRecords) aggregates counts weighted by the
-- exponential decay factor 2^(-age_days/decay_threshold_days), so a token
-- can contribute < 1 to the totals. REAL (float4) is plenty: counts are
-- bounded and only used as smoothing denominators and prior ratios.

CREATE TABLE IF NOT EXISTS spam_models (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vocabulary           JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_spam           REAL NOT NULL DEFAULT 0,
  total_ham            REAL NOT NULL DEFAULT 0,
  prior_spam           REAL NOT NULL DEFAULT 0.5,
  prior_ham            REAL NOT NULL DEFAULT 0.5,
  training_records     BIGINT NOT NULL DEFAULT 0,
  decay_threshold_days INTEGER NOT NULL DEFAULT 90 CHECK (decay_threshold_days BETWEEN 7 AND 365),
  model_version        INTEGER NOT NULL DEFAULT 1,
  last_trained_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the nightly job scheduler (find users with most-recent training first).
CREATE INDEX IF NOT EXISTS idx_spam_models_last_trained
  ON spam_models (last_trained_at NULLS FIRST);

-- Index for "users with significant training" queries (admin stats dashboard).
CREATE INDEX IF NOT EXISTS idx_spam_models_training_records
  ON spam_models (training_records DESC);

-- Track schema-level metadata for spam_models.
COMMENT ON TABLE spam_models IS
  'Per-user Naive Bayes spam classifier state. One row per user. Vocabulary is JSONB; counts are running totals updated incrementally on user feedback.';

COMMENT ON COLUMN spam_models.user_id IS
  'The user this model belongs to. PK + FK to users(id) with ON DELETE CASCADE.';

COMMENT ON COLUMN spam_models.vocabulary IS
  'JSONB map: {word: {spam: int, ham: int}}. Capped at 10k entries by chi-square feature selection in the nightly retrain.';

COMMENT ON COLUMN spam_models.total_spam IS
  'Sum of all spam_count entries in vocabulary (computed on retrain, cached between retrains).';

COMMENT ON COLUMN spam_models.total_ham IS
  'Sum of all ham_count entries in vocabulary (computed on retrain, cached between retrains).';

COMMENT ON COLUMN spam_models.prior_spam IS
  'Log-probability P(spam) derived from the training set: log(spam_count / (spam_count + ham_count)). Used in the Naive Bayes MAP scoring.';

COMMENT ON COLUMN spam_models.prior_ham IS
  'Log-probability P(ham) derived from the training set: log(ham_count / (spam_count + ham_count)).';

COMMENT ON COLUMN spam_models.training_records IS
  'Total number of training records used in this model. Used to choose between rules-only, blended, and ML-dominant scoring.';

COMMENT ON COLUMN spam_models.decay_threshold_days IS
  'User-configurable decay window for the full retrain. Records older than this are downweighted (not deleted) by 2^(-age / decay_threshold_days). Default 90 days, range 7-365.';

COMMENT ON COLUMN spam_models.model_version IS
  'Version of the model format. Bumped on breaking schema changes to the vocabulary layout. Current = 1.';

COMMENT ON COLUMN spam_models.last_trained_at IS
  'Timestamp of the last full retrain (nightly job or admin retrain-now). NULL if the model has only been updated incrementally.';
