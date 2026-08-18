import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamTokenizer.js', () => ({
  tokenize: vi.fn(),
  extractFlagFeatures: vi.fn(),
}));

import { query } from './db.js';
import { tokenize, extractFlagFeatures } from './spamTokenizer.js';
import {
  getModelForUser,
  saveModel,
  updateIncrementalForUser,
  invalidateModelCache,
  getAllUsersWithTraining,
  getAllUsersWithTrainingLog,
} from './spamModelStore.js';

beforeEach(() => {
  query.mockReset();
  tokenize.mockReset();
  extractFlagFeatures.mockReset();
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