import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

// The scheduled messages API without a database (scheduled.postgres.test.js runs it on one):
// the checks a request meets before anything is stored, and the 404 for a message that is not
// the user's on every route.
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: { broadcast: vi.fn() } }));
vi.mock('../services/ownership.js', () => ({
  findOwnedAccount: vi.fn(), findOwnedAlias: vi.fn(), findOwnedScheduledMessage: vi.fn(),
}));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn() }));
vi.mock('../services/draftCopies.js', () => ({ deleteSentDraft: vi.fn() }));
vi.mock('../services/outgoingMail.js', async importOriginal => ({
  ...(await importOriginal()),
  resolveIdentity: vi.fn(async (_u, input) => ({ account: { id: input.accountId }, fromEmail: 'me@example.com', signature: null, plaintextEmail: false })),
  resolveForwarded: vi.fn(async () => ({ attachments: [], messages: [] })),
}));

import 'express-async-errors';
import express from 'express';
import routes from './scheduled.js';
import { query, withTransaction } from '../services/db.js';
import { findOwnedAccount, findOwnedScheduledMessage } from '../services/ownership.js';
import { consume } from '../services/rateLimiter.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/mail/scheduled`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  consume.mockResolvedValue({ limited: false });
  findOwnedAccount.mockResolvedValue({ id: ACCOUNT, enabled: true });
  findOwnedScheduledMessage.mockResolvedValue(null);
  withTransaction.mockRejectedValue(new Error('no database here'));
});

const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
const createBody = extra => ({
  accountId: ACCOUNT, to: ['you@example.net'], subject: 'Hi', body: 'Hello',
  sendAt: new Date(Date.now() + 3_600_000).toISOString(), clientKey: randomUUID(), ...extra,
});

describe('POST /scheduled checks before storing anything', () => {
  it.each([
    [{ to: [] }, 400, 'accountId and to required'],
    [{ clientKey: undefined }, 400, 'clientKey must be a UUID'],
    [{ attachments: [{ filename: '', content: '' }] }, 400, 'attachments[0].filename is required'],
    [{ bcc: ['nobody'] }, 400, 'bcc[0] is not a valid email address'],
    [{ forwardedMessages: Array(21).fill(ID) }, 400, 'Too many forwarded messages (max 20)'],
    [{ sendAt: 'tomorrow-ish' }, 400, 'sendAt must be a date and time'],
    [{ accountId: 'not-an-id' }, 400, 'accountId is invalid'],
    [{ aliasId: 'not-an-id' }, 400, 'aliasId is invalid'],
  ])('%j: %i %s', async (extra, status, error) => {
    const r = await call('POST', '', createBody(extra));
    expect(r).toMatchObject({ status, body: { error } });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('takes 60 s ahead at the earliest and 366 days at the latest, by the server clock', async () => {
    const at = ms => new Date(Date.now() + ms).toISOString();
    expect((await call('POST', '', createBody({ sendAt: at(59_000) }))).body).toMatchObject({ code: 'too_soon', serverNow: expect.any(String) });
    expect((await call('POST', '', createBody({ sendAt: at(366 * 86_400_000 + 5000) }))).body).toMatchObject({ code: 'too_far' });
    // Within the window, the request goes on to the transaction (which fails here, no database).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const ms of [61_000, 366 * 86_400_000 - 5000]) {
      await call('POST', '', createBody({ sendAt: at(ms) }));
    }
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });

  it('refuses a disabled or foreign account, and an alias of another account', async () => {
    findOwnedAccount.mockResolvedValue(null);
    expect((await call('POST', '', createBody())).body).toEqual({ error: 'Account not found' });
    findOwnedAccount.mockResolvedValue({ id: ACCOUNT, enabled: true });
    expect((await call('POST', '', createBody({ aliasId: ID }))).body).toEqual({ error: 'Alias not found' });
    expect(findOwnedAccount).toHaveBeenCalledWith('u1', ACCOUNT, { enabled: true });
  });

  it('refuses more than 10 MB of payload, and the 31st create in a minute', async () => {
    expect((await call('POST', '', createBody({ body: 'x'.repeat(10 * 1024 * 1024) }))).body.code).toBe('payload_too_large');
    consume.mockResolvedValue({ limited: true });
    expect(await call('POST', '', createBody())).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
  });

  it('answers a retried create with the message the first one made, before anything else', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID, send_at: '2026-10-25T07:00:00.000Z', status: 'scheduled' }] });
    expect(await call('POST', '', createBody())).toEqual({ status: 200, body: { id: ID, sendAt: '2026-10-25T07:00:00.000Z', status: 'scheduled' } });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe('a message that is not the user\'s', () => {
  beforeEach(() => {
    withTransaction.mockImplementation(fn => fn({ query }));
    query.mockImplementation(async sql => {
      if (/COUNT\(\*\) FILTER/.test(sql)) return { rows: [{ pending: 0, bytes: 0 }] };
      if (/^SELECT NOW\(\)/.test(sql)) return { rows: [{ now: new Date() }] };
      return { rows: [] };
    });
  });
  it.each([
    ['GET', `/${ID}`], ['GET', `/${ID}/attachments/0`], ['POST', `/${ID}/hold`, {}],
    ['POST', `/${ID}/release`, { editToken: ID }], ['PUT', `/${ID}`, { ...createBody(), editToken: ID, version: 1 }],
    ['PATCH', `/${ID}`, { sendAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ['POST', `/${ID}/send-now`, {}], ['POST', `/${ID}/send-now/undo`, { undoToken: 'x' }], ['POST', `/${ID}/resume`, {}],
    ['POST', `/${ID}/send-anyway`, { confirm: true }], ['POST', `/${ID}/cancel`, {}], ['POST', `/${ID}/restore`, {}],
    ['DELETE', `/${ID}`], ['GET', '/not-a-uuid'],
    ['GET', `/${ID}/attachments/1000`], ['GET', `/${ID}/attachments/-1`], ['GET', `/${ID}/attachments/1e2`],
  ])('%s %s is 404', async (method, path, body) => {
    const r = await call(method, path, body);
    expect(r.status).toBe(404);
    // Every lookup and change names the signed-in user.
    for (const [, params] of query.mock.calls) expect(params).toContain('u1');
    for (const [userId] of findOwnedScheduledMessage.mock.calls) expect(userId).toBe('u1');
  });
});

describe('hold', () => {
  it('with a token only renews: a token that names no hold is 409 hold_lost, never a takeover', async () => {
    findOwnedScheduledMessage.mockResolvedValue({ id: ID, status: 'editing' });
    const token = randomUUID();
    expect(await call('POST', `/${ID}/hold`, { editToken: token })).toMatchObject({ status: 409, body: { code: 'hold_lost', status: 'editing' } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/status = 'editing'/);
    expect(sql).toMatch(/status = ANY\(\$3\)\s+AND edit_token = \$4::uuid/);
    expect(params.slice(0, 4)).toEqual([ID, 'u1', ['editing'], token]);
    expect((await call('POST', `/${ID}/hold`, { editToken: 'x' })).status).toBe(400);
  });

  it('without one takes only a message nobody holds, or whose lease lapsed', async () => {
    findOwnedScheduledMessage.mockResolvedValue({ id: ID, status: 'editing' });
    expect(await call('POST', `/${ID}/hold`, {})).toMatchObject({ status: 409, body: { code: 'held_elsewhere', status: 'editing' } });
    expect(query.mock.calls[0][0]).toMatch(/edit_lease_until < NOW\(\)/);
  });
});

describe('hold takeover', () => {
  it('drops only the lease condition: the user, the id and the statuses still guard it', async () => {
    query.mockResolvedValue({ rows: [{ id: ID, edit_token: ID, version: 1, status_before: 'scheduled' }] });
    expect(await call('POST', `/${ID}/hold`, { takeover: true })).toMatchObject({ status: 200, body: { statusBefore: 'scheduled' } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/edit_lease_until < NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = ANY\(\$3\)/);
    expect(sql).toMatch(/status_before = CASE WHEN status = 'editing' THEN status_before ELSE status END/);
    expect(params.slice(0, 3)).toEqual([ID, 'u1', ['scheduled', 'paused', 'failed', 'uncertain', 'editing']]);
  });

  it('takeover anything but true is an ordinary hold', async () => {
    findOwnedScheduledMessage.mockResolvedValue({ id: ID, status: 'editing' });
    expect((await call('POST', `/${ID}/hold`, { takeover: 'yes' })).body.code).toBe('held_elsewhere');
  });
});

describe('send now with an edit hold', () => {
  const token = '66666666-6666-4666-8666-666666666666';
  beforeEach(() => { withTransaction.mockImplementation(fn => fn({ query })); });
  const owned = row => findOwnedScheduledMessage.mockResolvedValue({ id: ID, user_id: 'u1', version: 1, ...row });

  it('a token that is not the hold is 409 hold_lost, and nothing is changed', async () => {
    owned({ status: 'editing', edit_token: randomUUID(), status_before: 'scheduled' });
    expect(await call('POST', `/${ID}/send-now`, { editToken: token })).toMatchObject({ status: 409, body: { code: 'hold_lost' } });
    owned({ status: 'scheduled', edit_token: null });
    expect((await call('POST', `/${ID}/send-now`, { editToken: token })).body.code).toBe('hold_lost');
    expect((await call('POST', `/${ID}/send-now`, { editToken: 'x' })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('asks as the status before the hold would', async () => {
    owned({ status: 'editing', edit_token: token, status_before: 'uncertain' });
    expect((await call('POST', `/${ID}/send-now`, { editToken: token })).body.code).toBe('confirm_uncertain');
    owned({ status: 'editing', edit_token: token, status_before: 'paused', pause_reason: 'restored' });
    expect((await call('POST', `/${ID}/send-now`, { editToken: token })).body.code).toBe('confirm_restored');
    expect(query).not.toHaveBeenCalled();
  });

  it('with the token, one UPDATE sends it and ends the hold', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '6e'.repeat(32));
    try {
      owned({ status: 'editing', edit_token: token, status_before: 'scheduled', send_at: new Date(), due_at: new Date(), attempts: 0 });
      query.mockResolvedValue({ rows: [{ id: ID, user_id: 'u1', version: 1, send_at: new Date(Date.now() + 10_000) }] });
      expect(await call('POST', `/${ID}/send-now`, { editToken: token })).toMatchObject({ status: 200, body: { status: 'scheduled', undoToken: expect.any(String) } });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toMatch(/edit_token = NULL, edit_lease_until = NULL/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('release', () => {
  beforeEach(() => { query.mockResolvedValue({ rows: [{ id: ID, status: 'paused' }] }); });

  it('with keepPaused pauses a scheduled message by the user, under the token and the editing guard', async () => {
    const token = randomUUID();
    expect(await call('POST', `/${ID}/release`, { editToken: token, keepPaused: true })).toMatchObject({ status: 200, body: { status: 'paused' } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = ANY\(\$3\)\s+AND edit_token = \$4::uuid/);
    expect(sql).toMatch(/ELSE 'paused' END/);
    expect(sql).toMatch(/ELSE 'user' END/);
    expect(params).toEqual([ID, 'u1', ['editing'], token]);
  });

  it('without it hands the message back to the status it had', async () => {
    await call('POST', `/${ID}/release`, { editToken: randomUUID(), keepPaused: 'yes' });
    expect(query.mock.calls[0][0]).toMatch(/status = COALESCE\(status_before, 'scheduled'\)/);
    expect(query.mock.calls[0][0]).not.toMatch(/'user'/);
  });

  it('a lost hold is 409, and no token is 400', async () => {
    query.mockResolvedValue({ rows: [] });
    findOwnedScheduledMessage.mockResolvedValue({ id: ID, status: 'scheduled' });
    expect(await call('POST', `/${ID}/release`, { editToken: randomUUID(), keepPaused: true }))
      .toMatchObject({ status: 409, body: { code: 'hold_lost', status: 'scheduled' } });
    expect((await call('POST', `/${ID}/release`, { keepPaused: true })).status).toBe(400);
  });
});

describe('what needs the user\'s confirmation', () => {
  beforeEach(() => { withTransaction.mockImplementation(fn => fn({ query })); });
  const owned = row => findOwnedScheduledMessage.mockResolvedValue({ id: ID, user_id: 'u1', account_id: ACCOUNT, version: 1, ...row });

  it('anything that could send an uncertain message again', async () => {
    owned({ status: 'uncertain' });
    for (const [method, path, body] of [
      ['POST', `/${ID}/send-anyway`, {}], ['POST', `/${ID}/send-now`, {}],
      ['PATCH', `/${ID}`, { sendAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ]) {
      const r = await call(method, path, body);
      expect(r).toMatchObject({ status: 409, body: { code: 'confirm_uncertain', error: expect.stringContaining('may already have been delivered') } });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('a message a restore paused', async () => {
    owned({ status: 'paused', pause_reason: 'restored' });
    expect((await call('POST', `/${ID}/resume`, {})).body.code).toBe('confirm_restored');
    expect((await call('POST', `/${ID}/send-now`, {})).body.code).toBe('confirm_restored');
    expect(query).not.toHaveBeenCalled();
  });

  it('saving an edit of a message held while uncertain, or paused by a restore', async () => {
    const token = '55555555-5555-4555-8555-555555555555';
    const save = { ...createBody(), editToken: token, version: 1 };
    owned({ status: 'editing', edit_token: token, status_before: 'uncertain' });
    expect((await call('PUT', `/${ID}`, save)).body.code).toBe('confirm_uncertain');
    owned({ status: 'editing', edit_token: token, status_before: 'paused', pause_reason: 'restored' });
    expect((await call('PUT', `/${ID}`, save)).body.code).toBe('confirm_restored');
    owned({ status: 'editing', edit_token: token, status_before: 'paused', pause_reason: 'overdue' });
    // No confirmation needed: it goes on to the save (which has no database to finish on here).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('PUT', `/${ID}`, save)).body?.code ?? '').not.toMatch(/^confirm_/);
  });

  it('sending anyway is only for uncertain messages', async () => {
    owned({ status: 'failed' });
    expect(await call('POST', `/${ID}/send-anyway`, { confirm: true })).toMatchObject({ status: 409, body: { status: 'failed' } });
  });
});

describe('deleted messages in their restore window', () => {
  const cancelled = purgeAfter => ({
    id: ID, user_id: 'u1', account_id: ACCOUNT, status: 'cancelled', status_before: 'scheduled', version: 1,
    send_at: new Date(), due_at: new Date(), purge_after: purgeAfter, payload_enc: null, summary_enc: null, result_enc: null,
  });

  it('the list asks for them only while they can be restored, and says until when', async () => {
    const until = new Date(Date.now() + 60_000);
    query.mockImplementation(async sql => (/status NOT IN \('cancelled', 'sent'\)/.test(sql) ? { rows: [cancelled(until)] } : { rows: [] }));
    const r = await call('GET', '');
    const [openSql] = query.mock.calls.find(([sql]) => /NOT IN \('cancelled', 'sent'\)/.test(sql));
    expect(openSql).toMatch(/status = 'cancelled' AND purge_after > NOW\(\)/);
    expect(r.body.messages).toEqual([expect.objectContaining({ id: ID, status: 'cancelled', restoreUntil: until.toISOString() })]);
  });

  it('GET /:id finds one in its window, and not after it', async () => {
    findOwnedScheduledMessage.mockResolvedValue(cancelled(new Date(Date.now() + 60_000)));
    expect((await call('GET', `/${ID}`)).body).toMatchObject({ id: ID, status: 'cancelled' });
    findOwnedScheduledMessage.mockResolvedValue(cancelled(new Date(Date.now() - 1000)));
    expect((await call('GET', `/${ID}`)).status).toBe(404);
  });

  it('a restore decides in its UPDATE, by the database clock, to come back paused when due', async () => {
    withTransaction.mockImplementation(fn => fn({ query }));
    query.mockImplementation(async sql => {
      if (/COUNT\(\*\) FILTER/.test(sql)) return { rows: [{ pending: 0, bytes: 0 }] };
      if (/^SELECT NOW\(\)/.test(sql)) return { rows: [{ now: new Date() }] };
      if (/^\s*UPDATE scheduled_messages/.test(sql)) return { rows: [{ ...cancelled(null), status: 'paused', pause_reason: 'user' }] };
      return { rows: [] };
    });
    findOwnedScheduledMessage.mockResolvedValue(cancelled(new Date(Date.now() + 60_000)));
    const r = await call('POST', `/${ID}/restore`, {});
    expect(r.body).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(r.body.sendsImmediately).toBeUndefined();
    const [sql] = query.mock.calls.find(([s]) => /^\s*UPDATE scheduled_messages/.test(s));
    // Within a minute of going, by the clock as it runs, not the transaction's start.
    expect(sql).toMatch(/LEAST\(send_at, due_at\) < clock_timestamp\(\) \+ '60 seconds'::interval/);
    expect(sql).toMatch(/THEN 'user'/);
  });
});
