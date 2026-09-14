import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/inboxRules.js', () => ({
  applyInboxRules: vi.fn(),
  isDangerousRegex: () => false,
}));

import express from 'express';
import rulesRoutes from './rules.js';
import { query } from '../services/db.js';
import { applyInboxRules } from '../services/inboxRules.js';

const ACCOUNT_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };
const imapManager = { broadcast: vi.fn() };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('imapManager', imapManager);
  app.use('/api/rules', rulesRoutes);
  return app;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const completion = () => imapManager.broadcast.mock.calls.find(c => c[0]?.type === 'rules_run_complete');

describe('POST /api/rules/run — background sweep', () => {
  let server, base;
  let rulesCount;
  let messageBatches;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset(); applyInboxRules.mockReset(); imapManager.broadcast.mockReset();
    rulesCount = 1;
    messageBatches = [[{ id: 'm1', uid: 1, folder: 'INBOX' }, { id: 'm2', uid: 2, folder: 'INBOX' }]];
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE user_id = $1')) return Promise.resolve({ rows: [{ id: ACCOUNT_ID }] });
      if (sql.includes('FROM inbox_rules')) return Promise.resolve({ rows: [{ cnt: String(rulesCount) }] });
      if (sql.includes('FROM email_accounts WHERE id = $1')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('FROM messages')) return Promise.resolve({ rows: messageBatches.shift() || [] });
      return Promise.resolve({ rows: [] });
    });
  });

  const run = () => fetch(`${base}/api/rules/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });

  it('returns 202 immediately and broadcasts the totals when the sweep finishes', async () => {
    applyInboxRules.mockImplementation(async (messages) => ({ remaining: messages.slice(1), mutedIds: new Set() }));
    const res = await run();
    expect(res.status).toBe(202);
    expect((await res.json()).started).toBe(true);
    await tick();
    expect(applyInboxRules).toHaveBeenCalledTimes(1);
    expect(completion()?.[0]).toMatchObject({ type: 'rules_run_complete', ok: true, processed: 2, matched: 1 });
    expect(completion()?.[1]).toBe('user-1');   // scoped to the requesting user
  });

  it('rejects a second run while one is in flight with 409, then accepts again', async () => {
    let release;
    applyInboxRules.mockImplementation(() => new Promise(r => { release = r; }));
    const first = await run();
    expect(first.status).toBe(202);
    const second = await run();
    expect(second.status).toBe(409);
    release({ remaining: [], mutedIds: new Set() });
    await tick();
    expect(completion()).toBeTruthy();
    messageBatches = [[]];
    const third = await run();
    expect(third.status).toBe(202);
    await tick();
  });

  it('completes with zero totals and no rule evaluation when the user has no rules', async () => {
    rulesCount = 0;
    const res = await run();
    expect(res.status).toBe(202);
    await tick();
    expect(applyInboxRules).not.toHaveBeenCalled();
    expect(completion()?.[0]).toMatchObject({ ok: true, processed: 0, matched: 0 });
  });
});
