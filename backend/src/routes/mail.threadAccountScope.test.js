// #476: one email delivered to two connected accounts is two mailbox items sharing a
// Message-ID. The thread query deduplicated on message_id alone, which dropped one copy --
// and because the grouped list already renders a single thread row for both, the dropped
// copy was not reachable ANYWHERE in the UI in conversation mode.
//
// These guard the shape of the SQL: the dedup happens inside Postgres, so a mocked query
// cannot observe the row-level behavior. The behavior itself is verified against a live
// database (the key change takes the test thread from 1 row to 2 while still collapsing the
// same-account Sent twin) and end to end in a browser.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.session = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';

function buildApp() {
  const app = express();
  app.use('/api/mail', mailRoutes);
  return app;
}

describe('GET /api/mail/thread/:threadId account scoping (#476)', () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  async function fetchThread() {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', include_in_unified_inbox: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/mail/thread/${encodeURIComponent('<m1@example.com>')}?unified=true`);
    expect(response.status).toBe(200);
    return query.mock.calls[1][0];
  }

  it('deduplicates per account, so a second account copy is not dropped', async () => {
    const sql = await fetchThread();
    expect(sql).toContain('DISTINCT ON (m.account_id, m.message_id)');
    expect(sql).not.toContain('DISTINCT ON (m.message_id)');
  });

  it('orders by the full DISTINCT ON key, which Postgres requires', async () => {
    // A DISTINCT ON whose ORDER BY does not start with its key is a runtime error, so this
    // would fail against a real database even though the mock happily returns rows.
    const sql = await fetchThread();
    const orderBy = sql.slice(sql.indexOf('ORDER BY'));
    expect(orderBy.indexOf('m.account_id')).toBeLessThan(orderBy.indexOf('m.message_id'));
  });

  it('still prefers the INBOX copy within an account, collapsing the Sent twin', async () => {
    const sql = await fetchThread();
    expect(sql).toContain("CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END");
  });

  it('breaks the outer date tie deterministically', async () => {
    // Two accounts' copies of one email carry the same Date; without a tiebreak their order
    // in the conversation varies between requests.
    const sql = await fetchThread();
    expect(sql).toContain('ORDER BY date ASC, account_id, id');
  });
});

// GitHub's Message-IDs contain slashes, and some reverse proxies reject or decode an encoded
// slash in a path, so the client sends the thread id as a query parameter (#509).
describe('GET /api/mail/thread?id=', () => {
  let server;
  let base;
  beforeAll(async () => {
    await new Promise(resolve => { server = buildApp().listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); });

  const GITHUB_ID = '<owner/repo/issues/454@github.com>';
  const threadParam = () => query.mock.calls[1][1][1];

  it('reads the id from the query string, slashes intact', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', include_in_unified_inbox: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/mail/thread?${new URLSearchParams({ id: GITHUB_ID, folder: 'INBOX' })}`);
    expect(response.status).toBe(200);
    expect(threadParam()).toBe(GITHUB_ID);
  });

  it('still serves the path form, for clients that use it', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'acct-1', include_in_unified_inbox: true }] });
    query.mockResolvedValueOnce({ rows: [] });
    const response = await fetch(`${base}/api/mail/thread/${encodeURIComponent(GITHUB_ID)}`);
    expect(response.status).toBe(200);
    expect(threadParam()).toBe(GITHUB_ID);
  });

  it('rejects a missing or repeated id without querying', async () => {
    expect((await fetch(`${base}/api/mail/thread`)).status).toBe(400);
    expect((await fetch(`${base}/api/mail/thread?id=a&id=b`)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
