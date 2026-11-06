import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { markAllReadImap: vi.fn(), scheduleCountRefresh: vi.fn(), broadcast: vi.fn() },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';

const ACCOUNT_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const ACCOUNT = { id: ACCOUNT_ID, user_id: 'user-1' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', mailRoutes);
  return app;
}

// The count refresh asks the IMAP server for UNSEEN. Mark all read answers before its \Seen
// write is done (a large folder is written in chunks), and the refresh used to be scheduled
// beside that write: its STATUS, 5s later, could find the folder still unread and put the old
// count back on the badge.
describe('POST /api/mail/mark-all-read', () => {
  let server, base;
  beforeAll(async () => { await new Promise(r => { server = buildApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation((sql) => Promise.resolve({ rows: sql.includes('FROM email_accounts') ? [ACCOUNT] : [] }));
    imapManager.markAllReadImap.mockReset();
    imapManager.scheduleCountRefresh.mockReset();
    imapManager.broadcast.mockReset();
  });

  const markAllRead = () => fetch(`${base}/api/mail/mark-all-read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT_ID, folder: 'INBOX' }),
  });

  it('answers without waiting for the IMAP write, and refreshes counts only once it is done', async () => {
    let finishWrite;
    imapManager.markAllReadImap.mockReturnValue(new Promise(resolve => { finishWrite = resolve; }));
    const res = await markAllRead();
    expect(res.status).toBe(200);
    expect(imapManager.markAllReadImap).toHaveBeenCalledWith(ACCOUNT, 'INBOX', { uidCeiling: undefined });
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'sync_complete', accountId: ACCOUNT_ID }, 'user-1');
    expect(imapManager.scheduleCountRefresh).not.toHaveBeenCalled();
    finishWrite();
    await vi.waitFor(() => expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['INBOX']));
  });

  it('still refreshes counts when the IMAP write fails', async () => {
    imapManager.markAllReadImap.mockRejectedValue(new Error('NO [THROTTLED]'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await markAllRead()).status).toBe(200);
      await vi.waitFor(() => expect(imapManager.scheduleCountRefresh).toHaveBeenCalledWith(ACCOUNT_ID, ['INBOX']));
      expect(warn).toHaveBeenCalledWith('markAllReadImap failed:', 'NO [THROTTLED]');
    } finally {
      warn.mockRestore();
    }
  });

  it('passes the highest uid it marked, so mail that arrives during the write stays unread', async () => {
    imapManager.markAllReadImap.mockResolvedValue();
    query.mockImplementation((sql) => Promise.resolve({ rows:
      sql.includes('FROM email_accounts') ? [ACCOUNT]
      : sql.includes('RETURNING m.id') ? [{ id: 'a', uid: 7, was_read: true }, { id: 'b', uid: 12, was_read: true }, { id: 'c', uid: 9, was_read: true }]
      : [] }));
    expect((await markAllRead()).status).toBe(200);
    expect(imapManager.markAllReadImap).toHaveBeenCalledWith(ACCOUNT, 'INBOX', { uidCeiling: 12 });
  });

  it('still writes \\Seen to the folder when the label copies step fails', async () => {
    imapManager.markAllReadImap.mockResolvedValue();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const active = vi.spyOn(pluginRegistry, 'hasActiveAsync').mockRejectedValue(new Error('connection reset'));
    query.mockImplementation((sql) => Promise.resolve({ rows:
      sql.includes('FROM email_accounts') ? [ACCOUNT]
      : sql.includes('RETURNING m.id') ? [{ id: 'a', uid: 5, message_id: '<m@x>', was_read: false }]
      : [] }));
    try {
      expect((await markAllRead()).status).toBe(200);
      expect(imapManager.markAllReadImap).toHaveBeenCalledWith(ACCOUNT, 'INBOX', { uidCeiling: 5 });
      expect(warn).toHaveBeenCalledWith('Mark-all-read label copies failed:', 'connection reset');
    } finally {
      warn.mockRestore();
      active.mockRestore();
    }
  });
});
