// The Snoozed view (#269): changing when a snoozed conversation comes back, and bringing it back now.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
const imapManager = vi.hoisted(() => ({
  snoozedRows: vi.fn(), wakeSnoozed: vi.fn(), isWakingSnooze: vi.fn(() => false), broadcast: vi.fn(), scheduleCountRefresh: vi.fn(), pluginFacade: {},
}));
vi.mock('../index.js', () => ({ imapManager }));

import express from 'express';
import mailRoutes, { parseSnoozeUntil } from './mail.js';
import { query } from '../services/db.js';

const ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const MSG = { id: ID, account_id: 'acct-1', folder: 'Snoozed', message_id: '<a@x>', thread_id: '<t@x>', user_id: 'user-1' };
const rowOf = (n, overrides = {}) => ({ snooze_id: `sz-${n}`, user_id: 'user-1', account_id: 'acct-1', message_id_header: `<${n}@x>`,
  original_folder: 'INBOX', snoozed_folder: 'Snoozed', uid: n, is_read: true, ...overrides });
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('parseSnoozeUntil', () => {
  it('takes a date in the future within 30 days', () => {
    expect(parseSnoozeUntil(inDays(2)).date).toBeInstanceOf(Date);
    expect(parseSnoozeUntil(undefined).error).toMatch(/required/);
    expect(parseSnoozeUntil('soon').error).toMatch(/valid/);
    expect(parseSnoozeUntil(inDays(-1)).error).toMatch(/future/);
    expect(parseSnoozeUntil(inDays(31)).error).toMatch(/30 days/);
  });
});

describe('PATCH /messages/:id/snooze and POST /messages/:id/unsnooze', () => {
  let server, base;
  beforeAll(async () => {
    await new Promise(resolve => { server = express().use(express.json()).use('/api/mail', mailRoutes).listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql) => (sql.includes('FROM messages m') ? { rows: [MSG] } : { rows: [] }));
    imapManager.isWakingSnooze.mockReturnValue(false);
  });
  const call = (method, path, body) => fetch(`${base}/api/mail/messages/${ID}/${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });

  it('changes the time of every message snoozed together', async () => {
    imapManager.snoozedRows.mockResolvedValue([rowOf(1), rowOf(2)]);
    const until = inDays(3);
    const res = await call('PATCH', 'snooze', { until });
    expect(res.status).toBe(200);
    const [where, params] = imapManager.snoozedRows.mock.calls[0];
    expect(where).toContain('m.message_id = ANY($5::text[])');
    expect(params).toEqual(['user-1', 'acct-1', 'Snoozed', '<a@x>', ['<a@x>']]);
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE snoozed_messages'));
    expect(update[1]).toEqual([new Date(until).toISOString(), ['sz-1', 'sz-2']]);
    expect(imapManager.broadcast).toHaveBeenCalledWith({ type: 'folder_updated', folder: 'Snoozed', accountId: 'acct-1' }, 'user-1');
  });

  // thread_id groups by subject too. Snoozing takes the reply chain only, and so does changing or
  // ending the snooze: a separately snoozed notification with the same subject stays as it is.
  it('acts on the reply chain the snooze took, not on everything sharing its subject', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('thread_references')) {
        return { rows: [
          { ...MSG, in_reply_to: null, thread_references: null },
          { id: 'b', account_id: 'acct-1', folder: 'Snoozed', message_id: '<b@x>', in_reply_to: '<a@x>', thread_references: '<a@x>' },
          { id: 'c', account_id: 'acct-1', folder: 'Snoozed', message_id: '<c@x>', in_reply_to: null, thread_references: null },
        ] };
      }
      return sql.includes('FROM messages m') ? { rows: [MSG] } : { rows: [] };
    });
    imapManager.snoozedRows.mockResolvedValue([rowOf(1)]);
    expect((await call('PATCH', 'snooze', { until: inDays(2) })).status).toBe(200);
    const [, params] = imapManager.snoozedRows.mock.calls[0];
    expect([...params[4]].sort()).toEqual(['<a@x>', '<b@x>']);
  });

  it("refuses a bad time, another user's message, or one that is not snoozed", async () => {
    expect((await call('PATCH', 'snooze', { until: inDays(-1) })).status).toBe(400);
    expect((await call('PATCH', 'snooze', { until: inDays(40) })).status).toBe(400);
    imapManager.snoozedRows.mockResolvedValue([]);
    expect((await call('PATCH', 'snooze', { until: inDays(1) })).status).toBe(404);
    query.mockResolvedValue({ rows: [] });
    expect((await call('PATCH', 'snooze', { until: inDays(1) })).status).toBe(404);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });

  it('brings every message snoozed together back now, keeping its read state', async () => {
    imapManager.snoozedRows.mockResolvedValue([rowOf(1), rowOf(2)]);
    imapManager.wakeSnoozed.mockResolvedValue(true);
    const res = await call('POST', 'unsnooze');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restored: 2 });
    expect(imapManager.wakeSnoozed.mock.calls.map(([row, opts]) => [row.snooze_id, opts])).toEqual([
      ['sz-1', { markUnread: false }], ['sz-2', { markUnread: false }],
    ]);
  });

  it('says so when nothing came back, and when it was not snoozed', async () => {
    imapManager.snoozedRows.mockResolvedValue([rowOf(1)]);
    imapManager.wakeSnoozed.mockResolvedValue(false);
    expect((await call('POST', 'unsnooze')).status).toBe(500);
    imapManager.snoozedRows.mockResolvedValue([]);
    expect((await call('POST', 'unsnooze')).status).toBe(404);
  });

  // The message's own wake-up can take it between this request reading the snooze and waking it.
  it('counts a message its own wake-up brought back first, or is bringing back now', async () => {
    imapManager.snoozedRows.mockResolvedValueOnce([rowOf(1), rowOf(2)]).mockResolvedValueOnce([rowOf(2)]);
    imapManager.wakeSnoozed.mockResolvedValueOnce(false).mockResolvedValueOnce(null);
    imapManager.isWakingSnooze.mockImplementation(id => id === 'sz-2');
    const res = await call('POST', 'unsnooze');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, restored: 2 });
    const [where, params] = imapManager.snoozedRows.mock.calls[1];
    expect(where).toContain('sm.id = ANY');
    expect(params).toEqual([['sz-1', 'sz-2']]);
  });
});
