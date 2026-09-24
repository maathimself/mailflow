import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../services/inboxRules.js', () => ({
  applyInboxRules: vi.fn(), isDangerousRegex: () => false,
  createJevContext: vi.fn((...args) => ({ account: args[0], ...args[3] })),
  evaluateJevCondition: vi.fn(async () => ({ available: true, probability: 0.91, match: true })),
}));

import router from './rules.js';
import { query } from '../services/db.js';
import { applyInboxRules, createJevContext, evaluateJevCondition } from '../services/inboxRules.js';

let server;
let base;
const condition = { field: 'jev', question: 'Does it need a reply?', threshold: 0.8 };
const message = { id: '11111111-1111-4111-8111-111111111111', account_id: '22222222-2222-4222-8222-222222222222', subject: 'Question', from_email: 'a@example.org', body_text: 'Please reply', account: { id: '22222222-2222-4222-8222-222222222222', user_id: 'owner' } };
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
    expect(await response.json()).toEqual({ messages: [{ id: '11111111-1111-4111-8111-111111111111', subject: 'Question', fromEmail: 'a@example.org', accountId: '22222222-2222-4222-8222-222222222222' }] });
    expect(query.mock.calls[0][0]).toContain('a.user_id = $1');
    expect(query.mock.calls[0][0]).toContain('LIMIT 5');
  });

  it('tests a disabled unsaved condition on selected owned messages without applying actions', async () => {
    query.mockResolvedValue({ rows: [message] });
    const response = await post({ condition, messageIds: ['11111111-1111-4111-8111-111111111111'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ id: '11111111-1111-4111-8111-111111111111', subject: 'Question', probability: 0.91, match: true, available: true }] });
    expect(evaluateJevCondition).toHaveBeenCalledOnce();
    expect(applyInboxRules).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('a.user_id = $2');
    expect(createJevContext).toHaveBeenCalledWith(message.account, undefined, 6_000, { skipBackoff: true });
  });

  it('rejects oversized samples and foreign message IDs', async () => {
    const oversized = await post({ condition, messageIds: ['a', 'b', 'c', 'd'] });
    expect(oversized.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    const foreign = await post({ condition, messageIds: ['33333333-3333-4333-8333-333333333333'] });
    expect(foreign.status).toBe(404);
    expect(evaluateJevCondition).not.toHaveBeenCalled();
  });

  it('rejects malformed UUIDs before Postgres casts them', async () => {
    expect((await fetch(`${base}/api/rules/jev-samples?accountId=abc`)).status).toBe(400);
    expect((await post({ condition, messageIds: ['abc'] })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns unavailable without action when the key is missing', async () => {
    query.mockResolvedValue({ rows: [message] });
    evaluateJevCondition.mockResolvedValueOnce({ available: false, probability: null, match: false });
    const response = await post({ condition, messageIds: ['11111111-1111-4111-8111-111111111111'] });
    expect(await response.json()).toEqual({ results: [{ id: '11111111-1111-4111-8111-111111111111', subject: 'Question', probability: null, match: false, available: false }] });
    expect(applyInboxRules).not.toHaveBeenCalled();
  });

  it('returns a distinct retryable result when Jev is busy', async () => {
    query.mockResolvedValue({ rows: [message] });
    evaluateJevCondition.mockResolvedValueOnce({ available: false, probability: null, match: false, reason: 'busy' });

    const response = await post({ condition, messageIds: ['11111111-1111-4111-8111-111111111111'] });

    expect(await response.json()).toEqual({ results: [{
      id: '11111111-1111-4111-8111-111111111111', subject: 'Question', probability: null,
      match: false, available: false, reason: 'busy',
    }] });
    expect(applyInboxRules).not.toHaveBeenCalled();
  });
});
