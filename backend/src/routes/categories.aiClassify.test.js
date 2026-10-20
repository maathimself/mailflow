import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /categories/ai-classify/:messageId sends the message to the instance's AI provider, so it
// is refused when AI is off for the instance or for the user (#644), before the message is read.
const mocks = vi.hoisted(() => ({ query: vi.fn(), getAiStatus: vi.fn(), aiClassifyMessage: vi.fn() }));
vi.mock('../services/db.js', () => ({ query: mocks.query }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-test-user') }; next(); },
}));
vi.mock('../services/aiProvider.js', () => ({ getAiStatus: mocks.getAiStatus }));
vi.mock('../services/categorizer.js', () => ({
  aiClassifyMessage: mocks.aiClassifyMessage,
  backfillCategories: vi.fn(),
  invalidateSocialDomainCache: vi.fn(),
  BUILTIN_SETS: {},
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/safeFetch.js', () => ({ safeFetch: vi.fn() }));

import 'express-async-errors';
import express from 'express';
import categoryRoutes from './categories.js';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
let server, base, aiEnabled;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', categoryRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  aiEnabled = true;
  mocks.getAiStatus.mockReset().mockResolvedValue({ enabled: true, provider: 'api-key', features: { compose: true, summarize: true } });
  mocks.aiClassifyMessage.mockReset().mockResolvedValue('newsletter');
  mocks.query.mockReset().mockImplementation(async (sql, params) => {
    if (/SELECT ai_enabled, is_admin FROM users/.test(sql)) {
      return { rows: params[0] === 'u1' ? [{ ai_enabled: aiEnabled, is_admin: false }] : [] };
    }
    if (/SELECT m.subject/.test(sql)) return { rows: [{ subject: 'Weekly', from_email: 'news@example.com', snippet: 'Hi' }] };
    return { rows: [], rowCount: 1 };
  });
});

const classify = (user = 'u1') => fetch(`${base}/api/categories/ai-classify/${MESSAGE}`, {
  method: 'POST', headers: { 'x-test-user': user },
});
const messageReads = () => mocks.query.mock.calls.filter(([sql]) => /FROM messages/.test(sql));

describe('POST /categories/ai-classify/:messageId', () => {
  it('classifies and stores the category for a user with AI access', async () => {
    const response = await classify();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, category: 'newsletter' });
    expect(mocks.aiClassifyMessage).toHaveBeenCalledWith('Weekly', 'news@example.com', 'Hi');
  });

  it('refuses a user whose AI access is off, before reading the message or calling the provider', async () => {
    aiEnabled = false;
    const response = await classify();
    expect(response.status).toBe(403);
    expect(messageReads()).toHaveLength(0);
    expect(mocks.aiClassifyMessage).not.toHaveBeenCalled();
  });

  it('refuses when AI is off for the instance', async () => {
    mocks.getAiStatus.mockResolvedValue({ enabled: false, provider: 'api-key', features: {} });
    const response = await classify();
    expect(response.status).toBe(403);
    expect(mocks.aiClassifyMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the user row is missing or cannot be read', async () => {
    expect((await classify('unknown')).status).toBe(403);
    mocks.query.mockRejectedValue(new Error('connection terminated'));
    expect((await classify()).status).toBe(500);
    expect(mocks.aiClassifyMessage).not.toHaveBeenCalled();
  });
});
