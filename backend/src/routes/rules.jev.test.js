import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../services/inboxRules.js', () => ({
  applyInboxRules: vi.fn(), isDangerousRegex: () => false,
  createJevContext: vi.fn(account => ({ account })),
  evaluateJevCondition: vi.fn(async () => ({ available: true, probability: 0.91, match: true })),
}));

import router from './rules.js';
import { query } from '../services/db.js';
import { applyInboxRules, evaluateJevCondition } from '../services/inboxRules.js';

let server;
let base;
const condition = { field: 'jev', question: 'Does it need a reply?', threshold: 0.8 };
const message = { id: 'message-a', account_id: 'account-a', subject: 'Question', from_email: 'a@example.org', body_text: 'Please reply', account: { id: 'account-a', user_id: 'owner' } };
const post = (body) => fetch(`${base}/api/rules/test-jev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/rules', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { vi.clearAllMocks(); query.mockReset(); });

describe('no-action Jev test mode', () => {
  it('returns a bounded recent owned sample without body content', async () => {
    query.mockResolvedValue({ rows: [message] });
    const response = await fetch(`${base}/api/rules/jev-samples`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [{ id: 'message-a', subject: 'Question', fromEmail: 'a@example.org', accountId: 'account-a' }] });
    expect(query.mock.calls[0][0]).toContain('a.user_id = $1');
    expect(query.mock.calls[0][0]).toContain('LIMIT 5');
  });

  it('tests a disabled unsaved condition on selected owned messages without applying actions', async () => {
    query.mockResolvedValue({ rows: [message] });
    const response = await post({ condition, messageIds: ['message-a'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ id: 'message-a', subject: 'Question', probability: 0.91, match: true, available: true }] });
    expect(evaluateJevCondition).toHaveBeenCalledOnce();
    expect(applyInboxRules).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('a.user_id = $2');
  });

  it('rejects oversized samples and foreign message IDs', async () => {
    const oversized = await post({ condition, messageIds: ['a', 'b', 'c', 'd'] });
    expect(oversized.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    const foreign = await post({ condition, messageIds: ['foreign'] });
    expect(foreign.status).toBe(404);
    expect(evaluateJevCondition).not.toHaveBeenCalled();
  });

  it('returns unavailable without action when the key is missing', async () => {
    query.mockResolvedValue({ rows: [message] });
    evaluateJevCondition.mockResolvedValueOnce({ available: false, probability: null, match: false });
    const response = await post({ condition, messageIds: ['message-a'] });
    expect(await response.json()).toEqual({ results: [{ id: 'message-a', subject: 'Question', probability: null, match: false, available: false }] });
    expect(applyInboxRules).not.toHaveBeenCalled();
  });
});
