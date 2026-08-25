import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: { removeMessageCopy: vi.fn(), broadcast: vi.fn() } }));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const ACCOUNT_ID = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };
const ROW = {
  id: 'row-1', account_id: ACCOUNT_ID, uid: 17, folder: 'Trash',
  folder_uid_validity: '101', folder_observation_generation: '4',
  read_revision: 0, star_revision: 0,
};

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
    query.mockReset(); imapManager.removeMessageCopy.mockReset(); imapManager.broadcast.mockReset();
    query.mockImplementation((sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('FROM folders WHERE account_id = $1 AND path = $2')) {
        return Promise.resolve({ rows: [{ backfill_incomplete: false }] });
      }
      if (sql.includes('FROM messages m')) return Promise.resolve({ rows: [{ ...ROW, folder: params[1] }] });
      return Promise.resolve({ rows: [] });
    });
  });

  const empty = (path) => fetch(`${base}/api/mail/folders/empty`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, path }),
  });

  it('returns 202 immediately and finishes the delete in the background', async () => {
    imapManager.removeMessageCopy.mockResolvedValue(1);
    const res = await empty('Trash');
    expect(res.status).toBe(202);
    expect((await res.json()).started).toBe(true);
    await tick();
    expect(imapManager.removeMessageCopy).toHaveBeenCalledWith(
      ACCOUNT_ID, 17, 'Trash', expect.objectContaining({
        expectedId: 'row-1', expectedUidValidity: '101', snapshot: expect.objectContaining({ id: 'row-1' }),
      }),
    );
    expect(clearedDb()).toBe(false);
    expect(emittedType('folder_emptied')?.ok).toBe(true);
    expect(emittedType('sync_complete')).toBeTruthy();
  });

  it('leaves the DB rows intact and reports failure when the IMAP empty throws', async () => {
    imapManager.removeMessageCopy.mockRejectedValue(new Error('throttled'));
    const res = await empty('Archive');
    expect(res.status).toBe(202);
    await tick();
    expect(clearedDb()).toBe(false);            // next sync reconciles instead
    expect(emittedType('folder_emptied')?.ok).toBe(false);
    expect(emittedType('sync_complete')).toBeUndefined();
  });

  it('rejects a concurrent empty of the same folder with 409', async () => {
    let release;
    imapManager.removeMessageCopy.mockImplementation(() => new Promise(r => { release = r; }));
    const first = await empty('Junk');
    expect(first.status).toBe(202);
    const second = await empty('Junk');   // same folder still in flight
    expect(second.status).toBe(409);
    release();                            // let the first complete so the guard clears
    await tick();
  });

  it('refuses to empty a folder until its exact backfill is complete', async () => {
    query.mockImplementation((sql) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) {
        return Promise.resolve({ rows: [ACCOUNT] });
      }
      if (sql.includes('FROM folders WHERE account_id = $1 AND path = $2')) {
        return Promise.resolve({ rows: [{ backfill_incomplete: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await empty('Trash');

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/sync is incomplete/i);
    expect(imapManager.removeMessageCopy).not.toHaveBeenCalled();
    expect(imapManager.broadcast).not.toHaveBeenCalled();
  });
});
