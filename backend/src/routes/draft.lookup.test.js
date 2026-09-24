import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
const imapManager = vi.hoisted(() => ({ findReplyDrafts: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import routes from './draft.js';
import { query } from '../services/db.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', folder_mappings: { drafts: 'Custom' } };
const selected = { id: ID, account_id: ACCOUNT.id, message_id: '<parent@example.test>', thread_id: '<parent@example.test>' };
const candidate = { id: '33333333-3333-4333-8333-333333333333', account_id: ACCOUNT.id,
  folder: 'Custom', uid: '9', message_id: '<reply@example.test>', in_reply_to: selected.message_id,
  thread_references: selected.message_id, subject: 'Re: hello', date: '2026-09-24T10:00:00Z' };

let server, base;
beforeAll(async () => {
  const app = express();
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  query.mockReset();
  imapManager.findReplyDrafts.mockReset();
  query.mockImplementation(async sql => {
    if (sql.includes('JOIN email_accounts')) return { rows: [{ ...selected, account: ACCOUNT }] };
    if (sql.includes('FROM folders')) return { rows: [{ path: 'Custom' }, { path: 'ServerDrafts' }] };
    if (sql.includes('FROM messages')) return { rows: [selected] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  imapManager.findReplyDrafts.mockResolvedValue([candidate]);
});

const lookup = (id = ID) => fetch(`${base}/api/mail/messages/${id}/reply-draft`);

describe('GET /messages/:id/reply-draft', () => {
  it('rejects invalid and other-user message IDs before touching IMAP', async () => {
    expect((await lookup('not-a-uuid')).status).toBe(400);
    query.mockResolvedValueOnce({ rows: [] });
    expect((await lookup()).status).toBe(404);
    expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
  });

  it('finds a live external reply in either real Drafts folder', async () => {
    const response = await lookup();
    expect(response.status).toBe(200);
    expect((await response.json()).draft.id).toBe(candidate.id);
    expect(imapManager.findReplyDrafts).toHaveBeenCalledWith(ACCOUNT, ['Custom', 'ServerDrafts'], [selected.message_id]);
  });

  it('does not reopen a cached draft if live search says it was deleted', async () => {
    imapManager.findReplyDrafts.mockResolvedValueOnce([]);
    const response = await lookup();
    expect(await response.json()).toEqual({ draft: null });
  });

  it('discovers a draft outside the most recent 100 by exact UID', async () => {
    imapManager.findReplyDrafts.mockResolvedValueOnce([{ ...candidate, folder: 'ServerDrafts', uid: '1' }]);
    const response = await lookup();
    expect((await response.json()).draft.uid).toBe('1');
    expect(imapManager.findReplyDrafts).toHaveBeenCalledWith(ACCOUNT, ['Custom', 'ServerDrafts'], [selected.message_id]);
  });

  it('returns an error rather than a false negative if IMAP search fails', async () => {
    imapManager.findReplyDrafts.mockRejectedValueOnce(new Error('search incomplete'));
    const response = await lookup();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Could not check reply drafts' });
  });
});
