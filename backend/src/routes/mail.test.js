import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Route-level coverage for the section-refresh emits added to the folder-mutation routes
// (mark-all-read, folders/delete|rename|empty). db + imapManager are stubbed; the GTD emit is
// a no-op so the right_sidebar broadcast is the only signal under test. sectionUpdates stays
// REAL (it owns the broadcast); rightSidebarConfig is mocked so the configured labels — and the
// invalidate call the rename asserts — are controllable. requireAuth injects a session.
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    broadcast: vi.fn(),
    markAllReadImap: vi.fn().mockResolvedValue(undefined),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    renameFolder: vi.fn().mockResolvedValue(undefined),
    emptyFolder: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/gtdSections.js', () => ({ emitGtdIfRelevant: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/rightSidebarConfig.js', () => ({
  getRightSidebarConfig: vi.fn(),
  invalidateRightSidebarConfig: vi.fn(),
}));

import express from 'express';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { getRightSidebarConfig, invalidateRightSidebarConfig } from '../services/rightSidebarConfig.js';
import mailRoutes from './mail.js';

const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const account = { id: ACCT, user_id: 'u1', right_sidebar_labels: ['Receipts'] };
const SIDEBAR = { type: 'right_sidebar_updated', accountId: ACCT };

// The section emits are fire-and-forget (kicked off before res.json), so let their
// mocked-async work settle before asserting on the broadcast.
const flush = () => new Promise(r => setTimeout(r, 20));

let server;
let base;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  query.mockReset();
  getRightSidebarConfig.mockReset();
  invalidateRightSidebarConfig.mockClear();
  Object.values(imapManager).forEach(fn => fn.mockClear());
});

describe('POST /api/mail/mark-all-read — section refresh', () => {
  it('broadcasts right_sidebar_updated when the marked folder is itself a configured section', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('UPDATE messages SET is_read')) return { rows: [{ id: 'm1', message_id: '<1>', thread_key: 't1' }] };
      return { rows: [] };
    });

    const res = await post('/api/mail/mark-all-read', { accountId: ACCT, folder: 'Receipts' });
    await flush();

    expect(res.status).toBe(200);
    // The flip restricts to is_read = false rows.
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE messages SET is_read'));
    expect(update[0]).toContain('AND is_read = false');
    expect(update[0]).toContain('RETURNING id, message_id, thread_key');
    expect(imapManager.broadcast).toHaveBeenCalledWith(SIDEBAR, 'u1');
  });

  it('broadcasts when marking INBOX all-read while a thread sibling sits in a configured folder', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('UPDATE messages SET is_read')) return { rows: [{ id: 'm1', message_id: '<1>', thread_key: 't1' }] };
      if (sql.includes('SELECT DISTINCT folder FROM messages')) return { rows: [{ folder: 'Receipts' }] };
      return { rows: [] };
    });

    const res = await post('/api/mail/mark-all-read', { accountId: ACCT, folder: 'INBOX' });
    await flush();

    expect(res.status).toBe(200);
    expect(imapManager.broadcast).toHaveBeenCalledWith(SIDEBAR, 'u1');
  });

  it('does not broadcast right_sidebar_updated for an unrelated folder with no configured overlap', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.startsWith('UPDATE messages SET is_read')) return { rows: [{ id: 'm1', message_id: '<1>', thread_key: 't1' }] };
      return { rows: [] }; // no sibling in a configured folder
    });

    const res = await post('/api/mail/mark-all-read', { accountId: ACCT, folder: 'Archive' });
    await flush();

    expect(res.status).toBe(200);
    expect(imapManager.broadcast).not.toHaveBeenCalledWith(SIDEBAR, 'u1');
  });
});

describe('POST /api/mail/folders/delete — section refresh', () => {
  it('broadcasts right_sidebar_updated when deleting a configured folder', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('SELECT DISTINCT message_id, thread_key')) return { rows: [{ message_id: '<1>', thread_key: 't1' }] };
      return { rows: [] };
    });

    const res = await post('/api/mail/folders/delete', { accountId: ACCT, path: 'Receipts' });
    await flush();

    expect(res.status).toBe(200);
    // The threads are captured before the DELETE removes the rows.
    expect(query.mock.calls.some(([sql]) => sql.includes('SELECT DISTINCT message_id, thread_key'))).toBe(true);
    expect(imapManager.broadcast).toHaveBeenCalledWith(SIDEBAR, 'u1');
  });
});

describe('POST /api/mail/folders/empty — section refresh', () => {
  it('broadcasts right_sidebar_updated when emptying a configured folder', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      if (sql.includes('SELECT DISTINCT message_id, thread_key')) return { rows: [{ message_id: '<1>', thread_key: 't1' }] };
      return { rows: [] };
    });

    const res = await post('/api/mail/folders/empty', { accountId: ACCT, path: 'Receipts' });
    await flush();

    expect(res.status).toBe(200);
    expect(imapManager.broadcast).toHaveBeenCalledWith(SIDEBAR, 'u1');
  });

  it('broadcasts via the captured-siblings path when emptying an unconfigured folder that held a configured thread sibling', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      // INBOX is not configured, but its threads have a captured sibling in Receipts.
      if (sql.includes('SELECT DISTINCT message_id, thread_key')) return { rows: [{ message_id: '<1>', thread_key: 't1' }] };
      if (sql.includes('SELECT DISTINCT folder FROM messages')) return { rows: [{ folder: 'Receipts' }] };
      return { rows: [] };
    });

    const res = await post('/api/mail/folders/empty', { accountId: ACCT, path: 'INBOX' });
    await flush();

    expect(res.status).toBe(200);
    expect(imapManager.broadcast).toHaveBeenCalledWith(SIDEBAR, 'u1');
  });
});

describe('POST /api/mail/folders/rename — sidebar config remap', () => {
  it('remaps the configured label to the new path and invalidates the config cache', async () => {
    getRightSidebarConfig.mockResolvedValue(['Bills']);
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT delimiter FROM folders')) return { rows: [{ delimiter: '/' }] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });

    const res = await post('/api/mail/folders/rename', { accountId: ACCT, oldPath: 'Receipts', newName: 'Bills' });
    await flush();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, newPath: 'Bills' });
    const remap = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE email_accounts SET right_sidebar_labels'));
    expect(remap).toBeTruthy();
    expect(remap[1]).toEqual(['["Bills"]', ACCT]);
    expect(invalidateRightSidebarConfig).toHaveBeenCalledWith(ACCT);
  });

  it('leaves the config untouched when the renamed folder is not a configured label', async () => {
    getRightSidebarConfig.mockResolvedValue(['Receipts']);
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT delimiter FROM folders')) return { rows: [{ delimiter: '/' }] };
      if (sql.startsWith('SELECT * FROM email_accounts')) return { rows: [account] };
      return { rows: [] };
    });

    const res = await post('/api/mail/folders/rename', { accountId: ACCT, oldPath: 'Newsletters', newName: 'News' });
    await flush();

    expect(res.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE email_accounts SET right_sidebar_labels'))).toBe(false);
    expect(invalidateRightSidebarConfig).not.toHaveBeenCalled();
  });
});
