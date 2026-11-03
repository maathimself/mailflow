import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'owner' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { prefetchFolderBodies: async () => {} } }));
import express from 'express';
import { query } from '../services/db.js';
import mailRoutes from './mail.js';

// #597: category tabs show how many messages each holds, not only how many are unread, counted
// from the rows the category lists show. Uses only connection-local temporary tables in an
// explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('category counts PostgreSQL', () => {
  let database, server, base;
  const work = '22222222-2222-4222-8222-222222222222';
  const home = '33333333-3333-4333-8333-333333333333';
  const optedOut = '44444444-4444-4444-8444-444444444444';
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    await database.query(`
      CREATE TEMP TABLE email_accounts (id uuid, user_id text, enabled boolean, include_in_unified_inbox boolean);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, folder text, message_id text,
        subject text, snippet text, category text, is_read boolean DEFAULT false, is_deleted boolean DEFAULT false)`);
    query.mockImplementation((sql, values) => database.query(sql, values));
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE messages, email_accounts');
    await database.query(`INSERT INTO email_accounts VALUES
      ($1,'owner',true,true), ($2,'owner',true,true), ($3,'owner',true,false)`, [work, home, optedOut]);
  });

  const insert = (account, { category = null, read = false, folder = 'INBOX', deleted = false, placeholder = false } = {}) =>
    database.query(
      'INSERT INTO messages VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id(), account, folder, placeholder ? null : `<${nextId}@t>`, placeholder ? null : 'Hello',
        placeholder ? null : 'text', category, read, deleted],
    );
  const counts = async (accountId) => {
    const r = await fetch(`${base}/api/mail/category-counts${accountId ? `?accountId=${accountId}` : ''}`);
    expect(r.status).toBe(200);
    return r.json();
  };

  it('counts a category whose mail is all read', async () => {
    await insert(work, { category: 'automated', read: true });
    await insert(work, { category: 'automated', read: true });
    await insert(work, { category: null });
    await insert(work, { category: 'primary', read: true });
    expect(await counts(work)).toEqual({
      counts: { automated: 0, primary: 1 },
      totals: { automated: 2, primary: 2 },
    });
  });

  it('counts only the Inbox, and leaves out deleted mail and rows not fetched yet', async () => {
    await insert(work, { category: 'social' });
    await insert(work, { category: 'social', folder: 'Archive' });
    await insert(work, { category: 'social', deleted: true });
    await insert(work, { category: 'social', placeholder: true });
    expect(await counts(work)).toEqual({ counts: { social: 1 }, totals: { social: 1 } });
  });

  it('counts one account when one is chosen, and All Inboxes without opted-out accounts', async () => {
    await insert(work, { category: 'newsletter', read: true });
    await insert(home, { category: 'newsletter' });
    await insert(optedOut, { category: 'newsletter' });
    expect((await counts(work)).totals).toEqual({ newsletter: 1 });
    expect((await counts(optedOut)).totals).toEqual({ newsletter: 1 });
    expect(await counts()).toEqual({ counts: { newsletter: 1 }, totals: { newsletter: 2 } });
  });
});
