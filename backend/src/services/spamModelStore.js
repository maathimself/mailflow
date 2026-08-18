// spam_models DB access + in-memory cache (v0.2) — V2-4.
//
// Separates DB I/O from the pure math in spamModel.js. Reads go through a
// per-user 5-minute in-memory cache (same pattern as categorizer.js's
// socialDomainCache); writes (POST /spam, /ham) update the row and
// invalidate the cache so user feedback is reflected in <1s.
//
// Retrains (scheduled / admin) rebuild the row from spam_training_log via
// spamModel.retrainFromRecords() and invalidate the cache.

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import {
  createEmptyModel,
  updateIncremental,
  retrainFromRecords,
  pruneVocabulary,
  MODEL_VERSION,
} from './spamModel.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const modelCache = new Map(); // userId -> { model, expiry }

export function invalidateModelCache(userId) {
  modelCache.delete(userId);
}

// Map a DB row to the in-memory model shape.
function rowToModel(row) {
  return {
    vocabulary: row.vocabulary || {},
    totalSpam: Number(row.total_spam) || 0,
    totalHam: Number(row.total_ham) || 0,
    priorSpam: Number(row.prior_spam),
    priorHam: Number(row.prior_ham),
    trainingRecords: Number(row.training_records) || 0,
    modelVersion: Number(row.model_version) || MODEL_VERSION,
    lastTrainedAt: row.last_trained_at ?? null,
    decayThresholdDays: Number(row.decay_threshold_days) || 90,
  };
}

/**
 * Get the cached model for a user, DB read on miss. Returns null when the
 * user has no model row yet (cold start).
 */
export async function getModelForUser(userId) {
  const cached = modelCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.model;

  const result = await query('SELECT * FROM spam_models WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  const model = row ? rowToModel(row) : null;
  modelCache.set(userId, { model, expiry: Date.now() + CACHE_TTL_MS });
  return model;
}

/** Map the in-memory model shape to the DB columns. */
function modelToParams(userId, model) {
  return [
    userId,
    JSON.stringify(model.vocabulary),
    model.totalSpam,
    model.totalHam,
    model.priorSpam,
    model.priorHam,
    model.trainingRecords,
    model.decayThresholdDays ?? 90,
    model.modelVersion ?? MODEL_VERSION,
    model.lastTrainedAt ?? new Date().toISOString(),
  ];
}

/** UPSERT a model row, then invalidate the cache. */
export async function saveModel(userId, model) {
  await query(
    `INSERT INTO spam_models
       (user_id, vocabulary, total_spam, total_ham, prior_spam, prior_ham,
        training_records, decay_threshold_days, model_version, last_trained_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       vocabulary = EXCLUDED.vocabulary,
       total_spam = EXCLUDED.total_spam,
       total_ham = EXCLUDED.total_ham,
       prior_spam = EXCLUDED.prior_spam,
       prior_ham = EXCLUDED.prior_ham,
       training_records = EXCLUDED.training_records,
       model_version = EXCLUDED.model_version,
       last_trained_at = EXCLUDED.last_trained_at,
       updated_at = NOW()`,
    modelToParams(userId, model),
  );
  invalidateModelCache(userId);
}

/**
 * Incrementally train on one user feedback event (POST /spam or /ham).
 * Extracts features at mark time, applies spamModel.updateIncremental, and
 * persists. No-op on labels other than 'spam'/'ham'.
 *
 * @param {string} userId
 * @param {Object} message — { subject, body?, bodyHtml?, headers?, attachments? }
 * @param {'spam'|'ham'} label
 * @returns {Object} the updated model
 */
export async function updateIncrementalForUser(userId, message, label) {
  if (label !== 'spam' && label !== 'ham') return null; // no-op on invalid labels
  const model = (await getModelForUser(userId)) || createEmptyModel();
  const tokens = tokenize(message);
  const flagFeatures = extractFlagFeatures(message);
  const updated = updateIncremental(model, tokens, flagFeatures, label);
  await saveModel(userId, updated);
  return updated;
}

/** All user IDs that have any row in spam_models (retrained already). */
export async function getAllUsersWithTraining() {
  const result = await query('SELECT DISTINCT user_id FROM spam_models');
  return result.rows.map(r => r.user_id);
}

/** All user IDs with at least one training-log record (candidates for retrain). */
export async function getAllUsersWithTrainingLog() {
  const result = await query('SELECT DISTINCT user_id FROM spam_training_log');
  return result.rows.map(r => r.user_id);
}

/**
 * Full retrain of one user from spam_training_log (NO JOIN; features are
 * stored at mark time — migration 0048). Applies exponential decay, purges
 * via spamModel.pruneVocabulary, saves, invalidates cache.
 *
 * @param {string} userId
 * @returns {{ ok: boolean, recordsUsed: number, duration_ms: number, reason?: string }}
 */
export async function retrainUser(userId) {
  const started = Date.now();
  const data = await query(
    `SELECT label, created_at, token_counts, flag_features, subject, body_text
     FROM spam_training_log WHERE user_id = $1`,
    [userId],
  );
  const records = data.rows;
  if (records.length === 0) {
    return { ok: false, recordsUsed: 0, duration_ms: Date.now() - started, reason: 'no_training_data' };
  }

  // Decay threshold: from the user's existing model if present, else default 90.
  const existing = await getModelForUser(userId);
  const decayThresholdDays = existing?.decayThresholdDays ?? 90;

  const model = retrainFromRecords(records, decayThresholdDays);
  // No need to prune here beyond the retrain aggregation; keep the model
  // bounded in case a user's raw vocabulary grew large (design §14).
  const pruned = Object.keys(model.vocabulary).length > 10000
    ? pruneVocabulary(model, 10000)
    : model;
  pruned.decayThresholdDays = decayThresholdDays;
  await saveModel(userId, pruned);
  return { ok: true, recordsUsed: records.length, duration_ms: Date.now() - started };
}