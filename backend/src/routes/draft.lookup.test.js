import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); } }));
const imapManager = vi.hoisted(() => ({ findReplyDrafts: vi.fn(), fetchMessageBody: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import routes from './draft.js';
import { query } from '../services/db.js';
import { savedDraftToComposeData } from '../../../frontend/src/utils/openSavedDraft.js';

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

it('returns synced negatives before loading a conversation when no drafts exist', async () => {
  const baseline = query.getMockImplementation();
  query.mockImplementation(async sql => {
    if (sql.includes('draft_candidates')) return { rows: [] };
    if (sql.includes('FROM messages WHERE account_id')) throw new Error('conversation must not be loaded');
    return baseline(sql);
  });
  const response = await indicators({ ids: [ID], threaded: false });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ indicators: { [ID]: { exists: false } } });
  expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
});

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

  it('sanitizes raw HTML before signature extraction and preserves text and attachments', async () => {
    const attachments = [{ part: '2', filename: 'note.txt', size: 3 }];
    imapManager.findReplyDrafts.mockResolvedValue([{ ...candidate, has_attachments: true, attachments_complete: true }]);
    imapManager.fetchMessageBody.mockResolvedValue({ text: 'plain fallback', attachments,
      html: '<p>Reply</p><div data-mailflow-signature="1" onclick="alert(1)"><strong>Thanks</strong><img src="javascript:alert(2)" onerror="alert(3)"><script>alert(4)</script><style>body button{display:none!important}</style></div><blockquote>Quoted text</blockquote>' });
    const response = await lookup(ID, '?open=true');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.body.html).not.toMatch(/onclick|onerror|javascript:|<script|<style|body button|alert\(4\)/i);
    expect(payload.body.html.match(/data-mailflow-signature/g)).toHaveLength(1);
    expect(payload.body.text).toBe('plain fallback');
    expect(payload.body.attachments).toEqual(attachments);
    const compose = savedDraftToComposeData(payload.draft, payload.body);
    expect(compose.signature).toContain('<strong>Thanks</strong>');
    expect(compose.signature).not.toMatch(/onerror|onclick|javascript:|<script|<style/i);
    expect(compose.body).toBe('<p>Reply</p><blockquote>Quoted text</blockquote>');
    expect(compose.forwardedAttachments).toEqual([{ messageId: candidate.id, part: '2', filename: 'note.txt', size: 3 }]);
    expect(compose.unresolvedExternalAttachments).toBe(false);
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
  for (const size of [1000, 2000, 10000]) it(`batches ${size} conversation members without rebuilding a graph per row`, async () => {
    let reads = 0;
    let graphQueries = 0;
    const rows = Array.from({ length: size }, (_, i) => ({ ...selected,
      id: `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      message_id: `<${i}@example.test>`, account: ACCOUNT,
      get in_reply_to() { reads++; return i ? `<${i - 1}@example.test>` : null; },
      get thread_references() { reads++; return null; } }));
    const page = size === 10000 ? rows.slice(0, 100) : rows.slice(0, 1);
    query.mockImplementation(async sql => {
      if (sql.includes('FROM folders')) return { rows: [{ account_id: ACCOUNT.id, path: 'Custom' }] };
      if (sql.includes('draft_candidates')) return { rows: [{ ...candidate, in_reply_to: '<0@example.test>', thread_references: null }] };
      if (sql.includes('row_members')) return { rows };
      if (sql.includes('FROM messages WHERE account_id')) { graphQueries++; return { rows }; }
      return { rows: page };
    });
    const response = await indicators({ ids: page.map(row => row.id), threaded: size !== 10000 });
    expect(response.status).toBe(200);
    expect(Object.values((await response.json()).indicators)).toEqual(page.map(() => ({ exists: true, accountId: ACCOUNT.id })));
    expect(reads).toBeLessThanOrEqual(size * 6);
    expect(graphQueries).toBe(1);
    expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
  });

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

for (const connected of [false, true]) it(`pages more than 5000 ${connected ? 'matching' : 'mostly unrelated'} cached reply drafts without losing late connectors`, async () => {
  const baseline = query.getMockImplementation();
  let reads = 0;
  const count = 6002;
  const rows = Array.from({ length: count }, (_, i) => ({ ...candidate,
    id: `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    message_id: `<draft-${i}@example.test>`, uid: i + 1,
    thread_id: '<different-root@example.test>', thread_key: '<different-root@example.test>',
    get in_reply_to() { reads++; return connected ? selected.message_id : `<unrelated-${i}@example.test>`; },
    get thread_references() { reads++; return null; },
  }));
  if (!connected) {
    rows[count - 2] = { ...rows[count - 2], in_reply_to: '<late-target@example.test>', date: '2026-10-07' };
    rows[count - 1] = { ...rows[count - 1], in_reply_to: selected.message_id,
      thread_references: `${selected.message_id} <late-target@example.test>`, date: '2026-09-01' };
  }
  reads = 0;
  const seen = []; const sizes = []; let graphQueries = 0;
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('draft_candidates')) {
      const after = params[2]; const limit = params[3] || rows.length;
      const page = rows.filter(row => !after || row.id > after).slice(0, limit);
      seen.push(...page.map(row => row.id)); sizes.push(page.length);
      return { rows: page };
    }
    if (sql.includes('FROM messages WHERE account_id')) graphQueries++;
    return baseline(sql, params);
  });
  const response = await indicators({ ids: [ID], threaded: false });
  expect(response.status).toBe(200);
  expect((await response.json()).indicators[ID]).toEqual({ exists: true, accountId: ACCOUNT.id });
  expect(seen).toEqual(rows.map(row => row.id));
  expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
  expect(sizes.length).toBeGreaterThan(1);
  expect(reads).toBeLessThanOrEqual(count * 2);
  expect(graphQueries).toBe(1);
  expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
});

it('returns a negative live lookup without querying a graph when no unified thread members are eligible', async () => {
  const baseline = query.getMockImplementation();
  query.mockImplementation(async (sql, params) => {
    if (sql.includes('row_members')) return { rows: [] };
    if (sql.includes('FROM messages WHERE account_id')) throw new Error('empty eligible account set must not query a conversation');
    return baseline(sql, params);
  });
  const response = await lookup(ID, '?threaded=true');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ draft: null });
  expect(imapManager.findReplyDrafts).not.toHaveBeenCalled();
});
