import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
const imapManager = vi.hoisted(() => ({ findReplyDrafts: vi.fn(), fetchMessageBody: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import routes from './draft.js';
import { query } from '../services/db.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', enabled: true, include_in_unified_inbox: true, folder_mappings: { drafts: 'Custom' } };
const selected = { id: ID, account_id: ACCOUNT.id, folder: 'INBOX', message_id: '<parent@example.test>', thread_id: '<parent@example.test>', thread_key: '<parent@example.test>' };
const candidate = { id: '33333333-3333-4333-8333-333333333333', account_id: ACCOUNT.id,
  folder: 'Custom', uid: '9', message_id: '<reply@example.test>', in_reply_to: selected.message_id,
  thread_references: selected.message_id, subject: 'Re: hello', date: '2026-09-24T10:00:00Z' };

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  query.mockReset();
  imapManager.findReplyDrafts.mockReset();
  imapManager.fetchMessageBody.mockReset().mockResolvedValue({ text: 'fresh reply', html: null, attachments: [] });
  query.mockImplementation(async sql => {
    if (sql.includes('FROM folders')) return { rows: [{ account_id: ACCOUNT.id, path: 'Custom', special_use: null }, { account_id: ACCOUNT.id, path: 'ServerDrafts', special_use: '\\Drafts' }] };
    if (sql.includes('draft_candidates')) return { rows: [candidate] };
    if (sql.includes('FROM messages')) return { rows: [{ ...selected, account: ACCOUNT }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  imapManager.findReplyDrafts.mockResolvedValue([candidate]);
});

const lookup = (id = ID, options = '') => fetch(`${base}/api/mail/messages/${id}/reply-draft${options}`);
const indicators = body => fetch(`${base}/api/mail/reply-drafts/indicators`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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

  it('fetches fresh body and rechecks remote identity when opening', async () => {
    const response = await lookup(ID, '?open=true');
    expect(response.status).toBe(200);
    expect((await response.json()).body.text).toBe('fresh reply');
    expect(imapManager.fetchMessageBody).toHaveBeenCalledWith(ACCOUNT, candidate.uid, candidate.folder);
    expect(imapManager.findReplyDrafts).toHaveBeenCalledTimes(2);
  });

  it('does not open a draft removed or replaced during fresh body fetching', async () => {
    imapManager.findReplyDrafts.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]);
    expect((await lookup(ID, '?open=true')).status).toBe(409);
    imapManager.findReplyDrafts.mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([{ ...candidate, message_id: '<replacement@example.test>' }]);
    expect((await lookup(ID, '?open=true')).status).toBe(409);
  });

  it('rejects a missing body instead of treating it as an empty external reply', async () => {
    imapManager.fetchMessageBody.mockResolvedValueOnce({ html: null, text: null, attachments: [] });
    expect((await lookup(ID, '?open=true')).status).toBe(503);
  });
});

describe('cached row reply indicators', () => {
  it('rejects invalid or oversized batches before querying', async () => {
    expect((await indicators({ ids: ['bad'] })).status).toBe(400);
    expect((await indicators({ ids: Array(101).fill(ID) })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses cached exact headers without opening an IMAP connection', async () => {
    const response = await indicators({ ids: [ID], accountId: ACCOUNT.id, threaded: false });
    expect(response.status).toBe(200);
    expect((await response.json()).indicators[ID]).toMatchObject({ exists: true, accountId: ACCOUNT.id });
    expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
    expect(query.mock.calls.length).toBeLessThanOrEqual(4);
    expect(query.mock.calls[0][1]).toContain('user-1');
  });

  it('does not return indicators for another user or a subject-only candidate', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await (await indicators({ ids: [ID] })).json()).indicators).toEqual({});
    query.mockImplementation(async sql => {
      if (sql.includes('FROM folders')) return { rows: [{ account_id: ACCOUNT.id, path: 'Custom' }] };
      if (sql.includes('draft_candidates')) return { rows: [{ ...candidate, in_reply_to: '<other@example.test>', thread_references: null }] };
      return { rows: [{ ...selected, account: ACCOUNT }] };
    });
    expect((await (await indicators({ ids: [ID] })).json()).indicators[ID].exists).toBe(false);
  });

  it('finds a draft in another eligible account represented by a unified thread row', async () => {
    const otherAccount = { ...ACCOUNT, id: '44444444-4444-4444-8444-444444444444' };
    const member = { ...selected, id: '55555555-5555-4555-8555-555555555555', account_id: otherAccount.id, account: otherAccount };
    const otherDraft = { ...candidate, account_id: otherAccount.id };
    query.mockImplementation(async sql => {
      if (sql.includes('FROM folders')) return { rows: [ACCOUNT, otherAccount].map(a => ({ account_id: a.id, path: 'Custom' })) };
      if (sql.includes('draft_candidates')) return { rows: [otherDraft] };
      if (sql.includes('row_members')) return { rows: [{ ...selected, account: ACCOUNT }, member] };
      return { rows: [{ ...selected, account: ACCOUNT }, member] };
    });
    const result = await (await indicators({ ids: [ID], threaded: true, accountId: null })).json();
    expect(result.indicators[ID]).toMatchObject({ exists: true, accountId: otherAccount.id });
    const specific = await (await indicators({ ids: [ID], threaded: true, accountId: ACCOUNT.id })).json();
    expect(specific.indicators[ID].exists).toBe(false);
  });
});
