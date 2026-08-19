import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamTokenizer.js', () => ({
  tokenize: vi.fn(),
  extractFlagFeatures: vi.fn(),
}));
// Partial mock: keep the real store logic, spy the write/invalidate primitives.
// saveModel/invalidateModelCache pass through to the real implementation so
// the existing query-assertion tests still see the INSERT upsert.
// NOTE: retrainUser internally calls saveModel/invalidateModelCache (module
// bindings, not exports) — the partial mock above spies only the exported
// references, so these retrainUser tests assert on the observable query layer.
vi.mock('./spamModelStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveModel: vi.fn((userId, model) => actual.saveModel(userId, model)),
    invalidateModelCache: vi.fn((userId) => actual.invalidateModelCache(userId)),
  };
});

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import {
  getModelForUser,
  saveModel,
  updateIncrementalForUser,
  invalidateModelCache,
  getAllUsersWithTraining,
  getAllUsersWithTrainingLog,
  retrainUser,
} from './spamModelStore.js';

beforeEach(() => {
  query.mockReset();
  tokenize.mockReset();
  extractFlagFeatures.mockReset();
  saveModel.mockClear();
  invalidateModelCache.mockClear();
  invalidateModelCache('test-user');
  query.mockResolvedValue({ rows: [] });
});

const row = (overrides = {}) => ({
  vocabulary: { viagra: { spam: 5, ham: 0 }, meeting: { spam: 0, ham: 3 } },
  total_spam: 5,
  total_ham: 3,
  prior_spam: 5 / 8,
  prior_ham: 3 / 8,
  training_records: 8,
  model_version: 1,
  last_trained_at: '2026-08-18T00:00:00.000Z',
  decay_threshold_days: 90,
  ...overrides,
});

describe('getModelForUser', () => {
  it('returns null when no model row exists (cold start)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getModelForUser('user-cold')).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith('SELECT * FROM spam_models WHERE user_id = $1', ['user-cold']);
  });

  it('maps a DB row to the model shape', async () => {
    query.mockResolvedValueOnce({ rows: [row()] });
    const model = await getModelForUser('user-map');
    expect(model.vocabulary.viagra).toEqual({ spam: 5, ham: 0 });
    expect(model.vocabulary.meeting).toEqual({ spam: 0, ham: 3 });
    expect(model.totalSpam).toBe(5);
    expect(model.trainingRecords).toBe(8);
    expect(model.decayThresholdDays).toBe(90);
  });

  it('caches: second call for the same user does not hit the DB', async () => {
    query.mockResolvedValue({ rows: [row()] });
    await getModelForUser('user-cached');
    await getModelForUser('user-cached');
    expect(query).toHaveBeenCalledTimes(1); // DB once, cache hit on 2nd
  });
});

describe('saveModel', () => {
  it('UPSERTs the model and invalidates the cache', async () => {
    query.mockResolvedValue({ rows: [] });
    // Warm the cache first.
    query.mockResolvedValueOnce({ rows: [row()] });
    await getModelForUser('user-1');

    const model = row();
    await saveModel('user-1', model);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id) DO UPDATE'),
      expect.arrayContaining(['user-1', expect.any(String)]),
    );
    // Cache was invalidated → next read hits the DB again.
    query.mockResolvedValue({ rows: [row()] });
    await getModelForUser('user-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM spam_models'), ['user-1']);
  });
});

describe('updateIncrementalForUser', () => {
  it('trains a cold-start user and persists the model', async () => {
    tokenize.mockReturnValue(['viagra', 'click']);
    extractFlagFeatures.mockReturnValue({ dkim_pass: 0, has_attachment: 1 });
    query.mockResolvedValue({ rows: [] }); // no existing model

    await updateIncrementalForUser('user-1', { subject: 'x' }, 'spam');
    expect(tokenize).toHaveBeenCalledWith({ subject: 'x' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO spam_models'),
      expect.arrayContaining(['user-1', expect.stringContaining('viagra')]),
    );
  });

  it('is a no-op for invalid labels', async () => {
    tokenize.mockReturnValue(['x']);
    extractFlagFeatures.mockReturnValue({});
    query.mockResolvedValue({ rows: [] });
    await updateIncrementalForUser('user-1', { subject: 'x' }, 'neither');
    // No INSERT should have been issued.
    const inserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO spam_models'));
    expect(inserts).toHaveLength(0);
  });
});

describe('retrainUser', () => {
  it('returns no_training_data when the log has no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // training log empty
    const result = await retrainUser('user-retrain-empty');
    expect(result).toMatchObject({ ok: false, recordsUsed: 0, reason: 'no_training_data' });
    // No model SELECT, no UPSERT attempted.
    const upserts = query.mock.calls.filter(([sql]) => sql.includes('ON CONFLICT (user_id) DO UPDATE'));
    expect(upserts).toHaveLength(0);
  });

  it('rebuilds the model from training rows and upserts it', async () => {
    const now = new Date().toISOString();
    // 1. training-log SELECT. created_at is the test-run "now"; the retrain
    // applies a tiny decay factor (2^-age/90d), so count assertions must be
    // tolerant of sub-1e-9 weight drift.
    query.mockResolvedValueOnce({
      rows: [
        { label: 'spam', created_at: now, token_counts: { viagra: 2, click: 1 }, flag_features: { has_attachment: 1 }, subject: null, body_text: null },
        { label: 'ham', created_at: now, token_counts: { meeting: 1 }, flag_features: {}, subject: null, body_text: null },
      ],
    });
    // 2. getModelForUser → no existing model (cold start)
    query.mockResolvedValueOnce({ rows: [] });

    const result = await retrainUser('user-retrain');
    expect(result.ok).toBe(true);
    expect(result.recordsUsed).toBe(2);

    // The upsert carries the rebuilt vocabulary + derived priors + decay default.
    const upsert = query.mock.calls.find(([sql]) => sql.includes('ON CONFLICT (user_id) DO UPDATE'));
    expect(upsert).toBeDefined();
    const params = upsert[1];
    expect(params[0]).toBe('user-retrain');
    const vocab = JSON.parse(params[1]);
    expect(vocab.viagra.spam).toBeCloseTo(2, 5);
    expect(vocab.viagra.ham).toBe(0);
    expect(vocab.meeting.ham).toBeCloseTo(1, 5);
    expect(vocab.meeting.spam).toBe(0);
    expect(vocab.__has_attachment__.spam).toBeCloseTo(1, 5);
    // decayThresholdDays = default 90 (no existing model)
    expect(params[7]).toBe(90);
  });

  it('honours the decay threshold stored on an existing model', async () => {
    const now = new Date().toISOString();
    query.mockResolvedValueOnce({
      rows: [{ label: 'spam', created_at: now, token_counts: { viagra: 1 }, flag_features: {}, subject: null, body_text: null }],
    });
    // existing model row with decay_threshold_days = 30
    query.mockResolvedValueOnce({ rows: [row({ decay_threshold_days: 30 })] });

    await retrainUser('user-retrain-decay');
    const upsert = query.mock.calls.find(([sql]) => sql.includes('ON CONFLICT (user_id) DO UPDATE'));
    expect(upsert[1][7]).toBe(30); // decay carried through
  });
});

describe('getAllUsersWithTraining / getAllUsersWithTrainingLog', () => {
  it('returns user ids from spam_models', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await expect(getAllUsersWithTraining()).resolves.toEqual(['a', 'b']);
  });

  it('returns user ids from spam_training_log', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'c' }] });
    await expect(getAllUsersWithTrainingLog()).resolves.toEqual(['c']);
  });
});