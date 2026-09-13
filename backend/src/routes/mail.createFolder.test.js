import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { ensureFolder: vi.fn(), broadcast: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'd4d4d4d4-4444-4444-8444-d4d4d4d4d4d4';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

const insertedFolderCall = () =>
  query.mock.calls.find(([sql]) => sql.includes('INSERT INTO folders'));

describe('POST /api/mail/folders — create through ensureFolder', () => {
  let server, base;
  let accountDelimiter;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset(); imapManager.ensureFolder.mockReset();
    accountDelimiter = '.';
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('SELECT delimiter FROM folders')) {
        return Promise.resolve({ rows: accountDelimiter ? [{ delimiter: accountDelimiter }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  const create = (body) => fetch(`${base}/api/mail/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, ...body }),
  });

  it('joins parent and leaf with a slash and stores the real server path', async () => {
    // Dot-delimited, INBOX-prefixed server: the server's real path differs
    // from the requested one — the DB must store what the server created.
    imapManager.ensureFolder.mockResolvedValue({ path: 'INBOX.Foo.Bar', created: true });
    const res = await create({ name: 'Bar', parentPath: 'INBOX.Foo' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: 'INBOX.Foo.Bar' });
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(ACCOUNT, 'INBOX.Foo/Bar', { resolvePath: true });
    const [, params] = insertedFolderCall();
    expect(params).toEqual([ACCOUNT_ID, 'INBOX.Foo.Bar', 'Bar', '.']);
  });

  it('creates root folders from the bare name', async () => {
    accountDelimiter = '/';
    imapManager.ensureFolder.mockResolvedValue({ path: 'Projects', created: true });
    const res = await create({ name: 'Projects' });
    expect(res.status).toBe(200);
    expect(imapManager.ensureFolder).toHaveBeenCalledWith(ACCOUNT, 'Projects', { resolvePath: true });
    const [, params] = insertedFolderCall();
    expect(params).toEqual([ACCOUNT_ID, 'Projects', 'Projects', '/']);
  });

  it('stores a NULL delimiter when the account has no delimiter rows yet', async () => {
    accountDelimiter = null;
    imapManager.ensureFolder.mockResolvedValue({ path: 'Solo', created: true });
    const res = await create({ name: 'Solo' });
    expect(res.status).toBe(200);
    const [, params] = insertedFolderCall();
    expect(params).toEqual([ACCOUNT_ID, 'Solo', 'Solo', null]);
  });

  it('reports failure without inserting a DB row when the IMAP create throws', async () => {
    imapManager.ensureFolder.mockRejectedValue(new Error('NO create denied'));
    const res = await create({ name: 'Nope', parentPath: 'INBOX.Foo' });
    expect(res.status).toBe(500);
    expect(insertedFolderCall()).toBeUndefined();
  });
});
