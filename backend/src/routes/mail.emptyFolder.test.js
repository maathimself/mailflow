import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { emptyFolder: vi.fn(), deleteFolder: vi.fn(), broadcast: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}
const tick = () => new Promise(r => setTimeout(r, 20));
const clearedDb = () => query.mock.calls.some(([sql]) => sql.includes('DELETE FROM messages WHERE account_id = $1 AND folder = $2'));
const emittedType = (type) => imapManager.broadcast.mock.calls.find(c => c[0]?.type === type)?.[0];

describe('POST /api/mail/folders/empty — async background empty', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset(); imapManager.emptyFolder.mockReset(); imapManager.broadcast.mockReset();
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      return Promise.resolve({ rows: [] });
    });
  });

  const empty = (path) => fetch(`${base}/api/mail/folders/empty`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, path }),
  });

  it('returns 202 immediately and finishes the delete in the background', async () => {
    imapManager.emptyFolder.mockResolvedValue(undefined);
    const res = await empty('Trash');
    expect(res.status).toBe(202);
    expect((await res.json()).started).toBe(true);
    await tick();
    expect(imapManager.emptyFolder).toHaveBeenCalledWith(ACCOUNT, 'Trash');
    expect(clearedDb()).toBe(true);
    expect(emittedType('folder_emptied')?.ok).toBe(true);
    expect(emittedType('sync_complete')).toBeTruthy();
  });

  it.each(['empty', 'delete'])('%s notifies only actual deleted keys after updating folder counts', async action => {
    imapManager.emptyFolder.mockResolvedValue();
    imapManager.deleteFolder.mockResolvedValue();
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.startsWith('DELETE FROM messages')) return { rows: [{ thread_key: 'deleted' }, { thread_key: 'deleted' }, { thread_key: null }] };
      return { rows: [] };
    });
    const hook = vi.spyOn(pluginRegistry, 'runHook').mockImplementation(async name => {
      if (name === 'messageRowsDeleted') expect(query.mock.calls.some(([sql]) => action === 'empty'
        ? sql.startsWith('UPDATE folders SET total_count = 0') : sql.startsWith('DELETE FROM folders'))).toBe(true);
    });
    try {
      const response = await fetch(`${base}/api/mail/folders/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: ACCOUNT_ID, path: 'Todo' }),
      });
      expect(response.status).toBe(action === 'empty' ? 202 : 200);
      await tick();
      expect(hook).toHaveBeenCalledWith('messageRowsDeleted', { account: ACCOUNT, folder: 'Todo', threadKeys: ['deleted'] });
      expect(query.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM messages'))[0]).toContain('RETURNING thread_key');
    } finally { hook.mockRestore(); }
  });

  it.each(['empty', 'delete'])('%s completes despite a deletion hook that never settles', async action => {
    imapManager.emptyFolder.mockResolvedValue();
    imapManager.deleteFolder.mockResolvedValue();
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.startsWith('DELETE FROM messages')) return { rows: [{ thread_key: 'removed' }] };
      return { rows: [] };
    });
    const hook = vi.spyOn(pluginRegistry, 'runHook').mockImplementation(name => name === 'messageRowsDeleted'
      ? new Promise(() => {}) : Promise.resolve([]));
    try {
      const response = await fetch(`${base}/api/mail/folders/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: ACCOUNT_ID, path: 'Todo' }),
      });
      expect(response.status).toBe(action === 'empty' ? 202 : 200);
      await tick();
      if (action === 'empty') {
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE folders SET total_count = 0'))).toBe(true);
        expect(emittedType('folder_emptied')?.ok).toBe(true);
      }
      expect(hook).toHaveBeenCalledWith('messageRowsDeleted', { account: ACCOUNT, folder: 'Todo', threadKeys: ['removed'] });
    } finally { hook.mockRestore(); }
  });

  it('notifies a committed empty even when the subsequent count update fails', async () => {
    imapManager.emptyFolder.mockResolvedValue();
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.startsWith('DELETE FROM messages')) return { rows: [{ thread_key: 'removed' }] };
      if (sql.startsWith('UPDATE folders')) throw new Error('recount failed');
      return { rows: [] };
    });
    const hook = vi.spyOn(pluginRegistry, 'runHook').mockResolvedValue([]);
    try {
      expect((await empty('Todo')).status).toBe(202);
      await tick();
      expect(hook).toHaveBeenCalledWith('messageRowsDeleted', { account: ACCOUNT, folder: 'Todo', threadKeys: ['removed'] });
      expect(emittedType('folder_emptied')?.ok).toBe(false);
    } finally { hook.mockRestore(); }
  });

  it('leaves the DB rows intact and reports failure when the IMAP empty throws', async () => {
    imapManager.emptyFolder.mockRejectedValue(new Error('throttled'));
    const res = await empty('Archive');
    expect(res.status).toBe(202);
    await tick();
    expect(clearedDb()).toBe(false);            // next sync reconciles instead
    expect(emittedType('folder_emptied')?.ok).toBe(false);
    expect(emittedType('sync_complete')).toBeUndefined();
  });

  it('rejects a concurrent empty of the same folder with 409', async () => {
    let release;
    imapManager.emptyFolder.mockImplementation(() => new Promise(r => { release = r; }));
    const first = await empty('Junk');
    expect(first.status).toBe(202);
    const second = await empty('Junk');   // same folder still in flight
    expect(second.status).toBe(409);
    release();                            // let the first complete so the guard clears
    await tick();
  });
});
