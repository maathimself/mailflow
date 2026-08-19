import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
  requireAdmin: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../services/spamTokenizer.js', () => ({
  tokenize: vi.fn(),
  extractFlagFeatures: vi.fn(),
}));
vi.mock('../services/spamRules.js', () => ({
  scoreRules: vi.fn(),
}));
vi.mock('../services/spamModel.js', () => ({
  classifyMessage: vi.fn(),
  blendScores: vi.fn(),
  extractTopTokens: vi.fn(),
}));
vi.mock('../services/spamModelStore.js', () => ({
  getModelForUser: vi.fn(),
  invalidateModelCache: vi.fn(),
  retrainUser: vi.fn(),
}));
vi.mock('../services/spamScheduler.js', () => ({
  runFullRetrain: vi.fn(),
}));

import express from 'express';
import spamRoutes, { accountSpamRouter } from './spam.js';
import { query } from '../services/db.js';
import { tokenize, extractFlagFeatures } from '../services/spamTokenizer.js';
import { scoreRules } from '../services/spamRules.js';
import { classifyMessage, extractTopTokens } from '../services/spamModel.js';
import { getModelForUser, invalidateModelCache } from '../services/spamModelStore.js';
import { runFullRetrain } from '../services/spamScheduler.js';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/spam', spamRoutes);
  app.use('/api/accounts', accountSpamRouter);
  return app;
}

function startServer() {
  return new Promise(resolve => {
    const server = buildApp().listen(0, () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

beforeEach(() => {
  query.mockReset();
  tokenize.mockReset();
  extractFlagFeatures.mockReset();
  scoreRules.mockReset();
  classifyMessage.mockReset();
  extractTopTokens.mockReset();
  getModelForUser.mockReset();
  invalidateModelCache.mockReset();
  runFullRetrain.mockReset();

  query.mockResolvedValue({ rows: [] });
  tokenize.mockReturnValue(['viagra']);
  extractFlagFeatures.mockReturnValue({});
  scoreRules.mockReturnValue({ score: 0.9, fired: [{ name: 'SUBJECT_PHARMA_KEYWORDS', weight: 0.5 }] });
  classifyMessage.mockReturnValue({ probability: 0.98, confidence: 3.9, verdict: 'spam' });
  extractTopTokens.mockReturnValue([{ token: 'viagra', contribution: 0.7 }]);
});

describe('GET /api/spam/status', () => {
  it('returns defaults when no model and no antispam accounts exist', async () => {
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] }); // accounts
    query.mockResolvedValueOnce({ rows: [{ preferences: {} }] }); // user prefs

    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/status`);
    const body = await res.json();
    await new Promise(r => server.close(r));

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.trainingRecords).toBe(0);
    expect(body.decayThresholdDays).toBe(90);
    expect(body.maturity).toBe('insufficient');
  });

  it('reports enabled when a matching account exists', async () => {
    getModelForUser.mockResolvedValue({
      modelVersion: 1, trainingRecords: 120, lastTrainedAt: '2026-08-18T00:00:00Z', decayThresholdDays: 90,
    });
    query.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    query.mockResolvedValueOnce({ rows: [{ preferences: {} }] });

    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/status`);
    const body = await res.json();
    await new Promise((r) => server.close(r));

    expect(body.enabled).toBe(true);
    expect(body.trainingRecords).toBe(120);
    expect(body.maturity).toBe('fresh');
  });
});

describe('GET/PATCH /api/spam/thresholds', () => {
  it('returns defaults when no stored thresholds exist', async () => {
    query.mockResolvedValueOnce({ rows: [{ preferences: {} }] });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/thresholds`);
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(body).toMatchObject({ minRecords: 50, spamThreshold: 0.85, autoMoveThreshold: 0.95 });
  });

  it('merges stored thresholds over defaults', async () => {
    query.mockResolvedValueOnce({
      rows: [{ preferences: { spam_thresholds: { spamThreshold: 0.9, autoMoveThreshold: 0.97 } } }],
    });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/thresholds`);
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(body.spamThreshold).toBe(0.9);
    expect(body.minRecords).toBe(50); // default preserved
  });

  it('PATCH validates the range', async () => {
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spamThreshold: 0.2 }),
    });
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(400);
  });

  it('PATCH writes and returns the merged thresholds', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // write
    query.mockResolvedValueOnce({ rows: [{ preferences: { spam_thresholds: { spamThreshold: 0.9 } } }] }); // read-back
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/thresholds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spamThreshold: 0.9 }),
    });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(200);
    expect(body.spamThreshold).toBe(0.9);
  });
});

describe('PATCH /api/spam/decay-threshold', () => {
  it('rejects out-of-range values', async () => {
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/decay-threshold`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decayThresholdDays: 400 }),
    });
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(400);
  });

  it('upserts the value into spam_models', async () => {
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValue({ rows: [] });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/decay-threshold`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decayThresholdDays: 30 }),
    });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(200);
    expect(body.decayThresholdDays).toBe(30);
    expect(invalidateModelCache).toHaveBeenCalled();
  });
});

describe('POST /api/spam/retrain-now', () => {
  it('runs the full retrain and reports users/duration', async () => {
    runFullRetrain.mockResolvedValue({ usersProcessed: 3, totalDuration_ms: 1200 });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/retrain-now`, { method: 'POST' });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, usersProcessed: 3 });
    expect(runFullRetrain).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/spam/enable', () => {
  it('persists the per-user master switch', async () => {
    query.mockResolvedValue({ rows: [] });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(query.mock.calls[0][1][1]).toContain('"spamEnabled":true');
  });
});

describe('POST /api/spam/reset-training-all (GDPR)', () => {
  it('requires explicit confirm', async () => {
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/reset-training-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'confirmation_required' });
  });

  it('deletes training data, audits, and reports counts', async () => {
    query.mockResolvedValueOnce({ rowCount: 15 }); // log delete
    query.mockResolvedValueOnce({ rowCount: 1 }); // model delete
    query.mockResolvedValueOnce({ rows: [] }); // audit insert
    query.mockResolvedValueOnce({ rows: [{ n: 2, enabled_n: 1 }] }); // accounts
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/reset-training-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(body).toMatchObject({ ok: true, deletedTrainingRecords: 15, deletedModels: 1, affectedAccounts: 2 });
    expect(invalidateModelCache).toHaveBeenCalled();
  });
});

describe('GET /api/spam/deletions', () => {
  it('returns only the caller rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ scope: 'all', records_deleted: 5 }] });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/deletions`);
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(body).toHaveLength(1);
    expect(body[0].scope).toBe('all');
  });
});

describe('GET /api/spam/explain', () => {
  it('returns rules + ml tokens for an owned message', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: MESSAGE_ID, subject: 'Viagra', body_text: 'buy', from_email: 'a@b.c',
        attachments: [], spam_verdict: 'spam', spam_score_ml: 0.98, spam_details: null,
        owner_id: USER_ID,
      }],
    });
    getModelForUser.mockResolvedValue({
      vocabulary: {}, totalSpam: 10, totalHam: 10, priorSpam: 0.5, priorHam: 0.5,
      trainingRecords: 120, modelVersion: 1, lastTrainedAt: null, decayThresholdDays: 90,
    });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/explain?messageId=${MESSAGE_ID}`);
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(200);
    expect(body.verdict).toBe('spam');
    expect(body.method).toBe('blended');
    expect(body.rulesFired[0].name).toBe('SUBJECT_PHARMA_KEYWORDS');
    expect(body.mlTopTokens).toHaveLength(1);
  });

  it('404s for an unowned message', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/spam/explain?messageId=${MESSAGE_ID}`);
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/accounts/:id/spam/reset-training (GDPR per-account)', () => {
  it('requires ownership and confirm', async () => {
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/accounts/${ACCOUNT_ID}/spam/reset-training`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    });
    await new Promise((r) => server.close(r));
    expect(res.status).toBe(400); // confirm first (ownership check after)
  });

  it('deletes per-account rows and the model, with audit', async () => {
    query.mockResolvedValueOnce({ rows: [{}] }); // ownership
    query.mockResolvedValueOnce({ rowCount: 7 }); // log delete
    query.mockResolvedValueOnce({ rowCount: 1 }); // model delete
    query.mockResolvedValueOnce({ rows: [] }); // audit insert
    const { server, base } = await startServer();
    const res = await fetch(`${base}/api/accounts/${ACCOUNT_ID}/spam/reset-training`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const body = await res.json();
    await new Promise((r) => server.close(r));
    expect(body).toMatchObject({ ok: true, deletedTrainingRecords: 7, deletedModel: true });
  });
});