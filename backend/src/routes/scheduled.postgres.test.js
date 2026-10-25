import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, userId: null }));

// The scheduled messages API on a real database, through the real send checks: only IMAP, the
// rate limiter's Redis and the WebSocket are faked.
vi.mock('../services/db.js', () => ({
  pool: { connect: (...a) => h.pool.connect(...a), query: (...a) => h.pool.query(...a) },
  query: (text, params) => h.pool.query(text, params),
  withTransaction: async fn => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-user') || h.userId }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: { broadcast: vi.fn(), fetchAttachment: vi.fn(), fetchRawMessage: vi.fn() },
}));
vi.mock('../services/draftCopies.js', () => ({ deleteSentDraft: vi.fn(async () => true) }));
vi.mock('../services/rateLimiter.js', () => ({ consume: vi.fn(async () => ({ limited: false, resetMs: 60_000 })) }));
vi.mock('../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));

import express from 'express';
import { runMigrations } from '../services/migrations.js';
import routes from './scheduled.js';
import { imapManager } from '../index.js';
import { deleteSentDraft } from '../services/draftCopies.js';
import { consume } from '../services/rateLimiter.js';
import { sendPushToUser } from '../services/pushNotifications.js';
import { ScheduledSender, aad, openJson, sealJson } from '../services/scheduledSend.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const MiB = 1024 * 1024;
const HOUR = 3_600_000;

describe.skipIf(!ADMIN_URL)('scheduled messages API on PostgreSQL (#543)', () => {
  const dbName = `mailflow_543a_${randomBytes(4).toString('hex')}`;
  let admin, server, base;
  let owner, stranger, account, strangerAccount;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '6e'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    ({ rows: [owner] } = await h.pool.query("INSERT INTO users (username) VALUES ('ann') RETURNING id"));
    ({ rows: [stranger] } = await h.pool.query("INSERT INTO users (username) VALUES ('eve') RETURNING id"));
    const acct = async (userId, email) => (await h.pool.query(
      `INSERT INTO email_accounts (user_id, name, email_address, imap_host, smtp_host)
       VALUES ($1, 'A', $2, 'imap.example.com', 'smtp.example.com') RETURNING *`, [userId, email])).rows[0];
    account = await acct(owner.id, 'ann@example.com');
    strangerAccount = await acct(stranger.id, 'eve@example.org');
    h.userId = owner.id;
    const app = express();
    app.use(express.json({ limit: '35mb' }));
    app.use('/api/mail', routes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/mail/scheduled`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await h.pool.query('DELETE FROM scheduled_messages');
    await h.pool.query('UPDATE email_accounts SET enabled = true, sync_error_code = NULL');
    vi.clearAllMocks();
    consume.mockResolvedValue({ limited: false, resetMs: 60_000 });
  });

  const call = (method, path = '', body, user) => fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async res => ({ status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), res }));
  const inAnHour = () => new Date(Date.now() + HOUR).toISOString();
  const draftBody = (extra = {}) => ({
    accountId: account.id, to: ['you@example.net'], cc: ['c@example.net'], subject: 'Q4 numbers', body: 'Hello there',
    sendAt: inAnHour(), timeZone: 'Europe/Berlin', clientKey: randomUUID(), ...extra,
  });
  const create = async (extra = {}, user) => {
    const r = await call('POST', '', draftBody(extra), user);
    expect([200, 201]).toContain(r.status);
    return r.body.id;
  };
  const rowOf = async id => (await h.pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [id])).rows[0];
  const set = (id, fields) => {
    const cols = Object.keys(fields);
    return h.pool.query(`UPDATE scheduled_messages SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(fields)]);
  };
  const broadcasts = () => imapManager.broadcast.mock.calls.map(c => c[0]);
  // A sender as the process runs one, for one tick, without timers.
  const tickSender = async () => {
    const sender = new ScheduledSender({ sleep: async () => {}, sentLookupDelaysMs: [0] });
    sender.running = true;
    sender.arm = () => {};
    await sender.runTick();
    await sender.idle();
  };

  describe('create', () => {
    it('stores the message encrypted, deletes the draft after the commit, and says so', async () => {
      const r = await call('POST', '', draftBody({ draft: { uid: 9, folder: 'Drafts', accountId: account.id } }));
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ id: expect.any(String), sendAt: expect.any(String), status: 'scheduled' });
      const row = await rowOf(r.body.id);
      expect(row).toMatchObject({ status: 'scheduled', time_zone: 'Europe/Berlin', attempts: 0, version: 1 });
      expect(row.due_at).toEqual(row.send_at);
      const payload = openJson(row.payload_enc, aad.payload(row));
      expect(payload).toMatchObject({ v: 1, to: ['you@example.net'], subject: 'Q4 numbers', aliasId: null });
      expect(payload.messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
      expect(row.payload_enc.includes(Buffer.from('Q4 numbers'))).toBe(false);
      expect(deleteSentDraft).toHaveBeenCalledWith(owner.id, expect.objectContaining({ id: account.id }), { uid: 9, folder: 'Drafts', accountId: account.id });
      expect(broadcasts()).toEqual([{ type: 'scheduled_changed', id: r.body.id, status: 'scheduled' }]);
    });

    it('is idempotent on clientKey, and a retry does not count against the rate', async () => {
      const body = draftBody();
      const first = await call('POST', '', body);
      const again = await call('POST', '', body);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(consume).toHaveBeenCalledTimes(1);
      expect((await h.pool.query('SELECT COUNT(*)::int AS n FROM scheduled_messages')).rows[0].n).toBe(1);
      expect(deleteSentDraft).not.toHaveBeenCalled();
    });

    it('answers the same 400s as Send, and its own for the schedule', async () => {
      expect((await call('POST', '', draftBody({ to: [] }))).body).toEqual({ error: 'accountId and to required' });
      expect((await call('POST', '', draftBody({ cc: ['bad\n@x.com'] }))).body).toEqual({ error: 'cc[0] contains invalid characters' });
      expect((await call('POST', '', draftBody({ attachments: 'x' }))).body).toEqual({ error: 'attachments must be an array' });
      expect((await call('POST', '', draftBody({ clientKey: 'nope' }))).body).toEqual({ error: 'clientKey must be a UUID' });
      expect((await call('POST', '', draftBody({ sendAt: 'soon' }))).body).toEqual({ error: 'sendAt must be a date and time' });
      expect((await call('POST', '', draftBody({ accountId: strangerAccount.id }))).status).toBe(404);
      expect((await call('POST', '', draftBody({ aliasId: randomUUID() }))).body).toEqual({ error: 'Alias not found' });
    });

    it('takes a time from a minute to 366 days ahead, and says the server\'s time when refusing', async () => {
      const soon = await call('POST', '', draftBody({ sendAt: new Date(Date.now() + 50_000).toISOString() }));
      expect(soon.status).toBe(400);
      expect(soon.body).toMatchObject({ code: 'too_soon', error: 'The scheduled time must be at least a minute from now.', serverNow: expect.any(String) });
      expect((await call('POST', '', draftBody({ sendAt: new Date(Date.now() + 70_000).toISOString() }))).status).toBe(201);
      expect((await call('POST', '', draftBody({ sendAt: new Date(Date.now() + 365 * 24 * HOUR).toISOString() }))).status).toBe(201);
      const far = await call('POST', '', draftBody({ sendAt: new Date(Date.now() + 366 * 24 * HOUR + 60_000).toISOString() }));
      expect(far.body).toMatchObject({ code: 'too_far', error: 'A message can be scheduled at most 366 days ahead.' });
    });

    it('stores only a time zone Intl knows', async () => {
      const id = await create({ timeZone: 'Mars/Olympus' });
      expect((await rowOf(id)).time_zone).toBeNull();
    });

    it('refuses more than 10 MB of text and inline images', async () => {
      const ok = await call('POST', '', draftBody({ body: 'a'.repeat(10 * MiB - 4096) }));
      expect(ok.status).toBe(201);
      const big = await call('POST', '', draftBody({ body: 'a'.repeat(10 * MiB + 1) }));
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('payload_too_large');
    });

    it('refuses the 101st pending message, and more than 250 MB stored', async () => {
      const ids = [];
      for (let i = 0; i < 99; i++) ids.push(await create());
      expect((await call('POST', '', draftBody())).status).toBe(201);
      const over = await call('POST', '', draftBody());
      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({ code: 'too_many', error: expect.stringContaining('at most 100') });
      // Sent and cancelled ones do not count as pending.
      await h.pool.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = ANY($1)", [ids.slice(0, 50)]);
      await h.pool.query('UPDATE scheduled_messages SET attachment_bytes = 0, payload_bytes = $2 WHERE id = $1', [ids[60], 250 * MiB - 2048]);
      const full = await call('POST', '', draftBody());
      expect(full.status).toBe(422);
      expect(full.body.code).toBe('too_much_storage');
      await h.pool.query('UPDATE scheduled_messages SET payload_bytes = $2 WHERE id = $1', [ids[60], 250 * MiB - 200_000]);
      expect((await call('POST', '', draftBody())).status).toBe(201);
    });

    it('holds the limit under concurrent creates, by the lock on the user\'s row', async () => {
      for (let i = 0; i < 98; i++) await create();
      const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '', draftBody())));
      expect(results.filter(r => r.status === 201)).toHaveLength(2);
      expect(results.filter(r => r.status === 422)).toHaveLength(4);
      expect((await h.pool.query('SELECT COUNT(*)::int AS n FROM scheduled_messages')).rows[0].n).toBe(100);
    });

    it('refuses creates past the rate', async () => {
      consume.mockResolvedValue({ limited: true, resetMs: 40_000 });
      const r = await call('POST', '', draftBody());
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('rate_limited');
      expect(consume).toHaveBeenCalledWith(`scheduled_create:${owner.id}`, 30, 60_000);
    });

    it('stores forwarded parts and messages now, so the send never fetches them', async () => {
      const { rows: [msg] } = await h.pool.query(
        `INSERT INTO messages (account_id, uid, folder, subject, attachments)
         VALUES ($1, 5, 'INBOX', 'Spam report', $2::jsonb) RETURNING id`,
        [account.id, JSON.stringify([{ part: '2', filename: 'a.pdf', type: 'application/pdf', size: 3 }])]);
      imapManager.fetchAttachment.mockResolvedValue(Buffer.from('pdf'));
      imapManager.fetchRawMessage.mockResolvedValue(Buffer.from('Subject: spam\r\n\r\nbuy'));
      const id = await create({
        attachments: [{ filename: 'up.txt', content: Buffer.from('upload').toString('base64') }],
        forwardedAttachments: [{ messageId: msg.id, part: '2' }],
        forwardedMessages: [msg.id],
      });
      const got = await call('GET', `/${id}`);
      expect(got.body.attachments).toEqual([
        { index: 0, filename: 'up.txt', contentType: 'application/octet-stream', size: 6, kind: 'upload' },
        { index: 1, filename: 'a.pdf', contentType: 'application/pdf', size: 3, kind: 'forwarded' },
        { index: 2, filename: 'Spam report.eml', contentType: 'message/rfc822', size: Buffer.byteLength('Subject: spam\r\n\r\nbuy'), kind: 'message' },
      ]);
      const file = await fetch(`${base}/${id}/attachments/1`);
      expect(file.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('pdf');
      expect(imapManager.fetchAttachment).toHaveBeenCalledTimes(1);
    });
  });

  describe('read', () => {
    it('lists the user\'s messages with their summary, and the sent notice\'s recipients', async () => {
      const id = await create();
      const sent = await create();
      const row = await rowOf(sent);
      await set(sent, {
        status: 'sent', payload_enc: null, summary_enc: null, sent_at: new Date(),
        result_enc: sealJson({ ok: true, sentFolder: 'Sent', messageId: '<m@example.com>', sentCopySaved: true, rejected: ['bad@x.net'], deferred: ['later@x.net'] }, aad.result(row)),
      });
      const list = await call('GET', '');
      expect(list.body.messages.map(m => m.id).sort()).toEqual([id, sent].sort());
      const item = list.body.messages.find(m => m.id === id);
      expect(item).toMatchObject({ status: 'scheduled', accountId: account.id, timeZone: 'Europe/Berlin', summary: {
        subject: 'Q4 numbers', to: ['you@example.net'], ccCount: 1, bccCount: 0, snippet: 'Hello there', attachmentCount: 0,
      } });
      expect(list.body.messages.find(m => m.id === sent).result).toMatchObject({ rejected: ['bad@x.net'], deferred: ['later@x.net'], sentFolder: 'Sent' });
    });

    it('gives another user\'s message to nobody else: 404 on every route', async () => {
      const id = await create({ accountId: strangerAccount.id }, stranger.id);
      const routes = [
        ['GET', `/${id}`], ['GET', `/${id}/attachments/0`], ['POST', `/${id}/hold`, {}], ['POST', `/${id}/release`, { editToken: randomUUID() }],
        ['PUT', `/${id}`, { ...draftBody(), editToken: randomUUID(), version: 1 }], ['PATCH', `/${id}`, { sendAt: inAnHour(), confirm: true }],
        ['POST', `/${id}/send-now`, { confirm: true }], ['POST', `/${id}/send-now/undo`, { undoToken: 'x' }],
        ['POST', `/${id}/resume`, { confirm: true }], ['POST', `/${id}/send-anyway`, { confirm: true }], ['POST', `/${id}/mark-sent`, {}],
        ['POST', `/${id}/cancel`, {}], ['POST', `/${id}/restore`, {}], ['DELETE', `/${id}`],
      ];
      for (const [method, path, body] of routes) {
        const r = await call(method, path, body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
      expect((await call('GET', `/count?accountId=${strangerAccount.id}`)).status).toBe(404);
      expect((await call('GET', '')).body.messages).toEqual([]);
      expect(await rowOf(id)).toMatchObject({ status: 'scheduled' });
    });

    it('says the mail server\'s reply when there is one, and never "try again" for an uncertain message', async () => {
      const cases = [
        ['failed', { code: 'smtp_rejected', error: 'Message was rejected by the mail server.', smtpResponse: '550 5.1.1 <x@y>: Recipient\r\n address rejected', command: 'RCPT TO' }, '550 5.1.1 <x@y>: Recipient address rejected'],
        ['failed', { code: 'tls', error: 'Secure connection to the mail server failed. Check your TLS settings.' }, 'Secure connection to the mail server failed. Check your TLS settings.'],
        ['failed', { code: 'alias_missing', error: 'The alias no longer exists.' }, 'The alias no longer exists.'],
        ['failed', { code: 'gave_up', lastCode: 'connection_failed', error: 'Failed to send message. Please try again.' }, null],
        ['uncertain', { code: 'connection_lost', error: 'Failed to send message. Please try again.', command: 'CONN' }, null],
        ['uncertain', { code: 'interrupted' }, null],
        ['paused', { code: 'needs_reauth', error: 'Authentication failed. Check your email account credentials.', smtpResponse: '535 5.7.8 Bad credentials' }, '535 5.7.8 Bad credentials'],
        ['paused', { code: 'overdue', offline: true }, null],
      ];
      for (const [status, result, expected] of cases) {
        const id = await create();
        const row = await rowOf(id);
        await set(id, { status, failure_code: result.code, result_enc: sealJson(result, aad.result(row)) });
        const item = (await call('GET', '')).body.messages.find(m => m.id === id);
        expect([result.code, item.failureDetail]).toEqual([result.code, expected]);
        await h.pool.query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
      }
    });

    it('lists the 50 most recent sent messages, and says there are more', async () => {
      const open = await create();
      const sent = [];
      for (let i = 0; i < 51; i++) sent.push(await create());
      await h.pool.query(`UPDATE scheduled_messages SET status = 'sent', payload_enc = NULL, summary_enc = NULL,
        sent_at = NOW() - (array_position($1::uuid[], id) || ' minutes')::interval WHERE id = ANY($1)`, [sent]);
      const list = await call('GET', '');
      expect(list.body.moreSent).toBe(true);
      expect(list.body.messages).toHaveLength(51);
      expect(list.body.messages[0].id).toBe(open);
      // The oldest sent one is the one left out.
      expect(list.body.messages.map(m => m.id)).not.toContain(sent[50]);
      await h.pool.query('DELETE FROM scheduled_messages WHERE id = $1', [sent[50]]);
      expect((await call('GET', '')).body.moreSent).toBe(false);
    });

    it('counts what deleting an account would delete', async () => {
      await create();
      const sent = await create();
      await set(sent, { status: 'sent' });
      expect((await call('GET', `/count?accountId=${account.id}`)).body).toEqual({ count: 1 });
    });
  });

  describe('edit', () => {
    it('holds, renews only with its token, and releases to what it was', async () => {
      const id = await create();
      await set(id, { status: 'failed', failure_code: 'smtp_rejected' });
      const held = await call('POST', `/${id}/hold`, {});
      expect(held.body).toMatchObject({ editToken: expect.any(String), version: 1, statusBefore: 'failed' });
      expect(await rowOf(id)).toMatchObject({ status: 'editing', status_before: 'failed' });
      const renewed = await call('POST', `/${id}/hold`, { editToken: held.body.editToken });
      expect(renewed.body.editToken).toBe(held.body.editToken);
      // Held by a live lease: another composer cannot take it, and a wrong token renews nothing.
      expect(await call('POST', `/${id}/hold`, {})).toMatchObject({ status: 409, body: { code: 'held_elsewhere', status: 'editing' } });
      expect(await call('POST', `/${id}/hold`, { editToken: randomUUID() })).toMatchObject({ status: 409, body: { code: 'hold_lost', status: 'editing' } });
      expect((await rowOf(id)).edit_token).toBe(held.body.editToken);
      expect((await call('POST', `/${id}/release`, { editToken: held.body.editToken })).body).toEqual({ status: 'failed' });
      expect(await rowOf(id)).toMatchObject({ status: 'failed', status_before: null, edit_token: null });
      // A renewal that arrives after the hold ended does not take the message back.
      expect(await call('POST', `/${id}/hold`, { editToken: held.body.editToken })).toMatchObject({ status: 409, body: { code: 'hold_lost', status: 'failed' } });
      expect(await rowOf(id)).toMatchObject({ status: 'failed', edit_token: null });
      expect((await call('POST', `/${id}/hold`, { editToken: 'nope' })).status).toBe(400);
    });

    it('takes a held message over when asked, keeping status_before and ending the old token', async () => {
      const id = await create();
      await set(id, { status: 'paused', pause_reason: 'overdue' });
      const first = await call('POST', `/${id}/hold`, {});
      expect((await call('POST', `/${id}/hold`, {})).body.code).toBe('held_elsewhere');
      expect((await call('POST', `/${id}/hold`, { takeover: true }, stranger.id)).status).toBe(404);
      const taken = await call('POST', `/${id}/hold`, { takeover: true });
      expect(taken.status).toBe(200);
      expect(taken.body).toMatchObject({ statusBefore: 'paused', version: 1 });
      expect(taken.body.editToken).not.toBe(first.body.editToken);
      expect(await rowOf(id)).toMatchObject({ status: 'editing', status_before: 'paused', pause_reason: 'overdue', edit_token: taken.body.editToken });
      expect(await call('POST', `/${id}/hold`, { editToken: first.body.editToken })).toMatchObject({ status: 409, body: { code: 'hold_lost' } });
      expect((await call('PUT', `/${id}`, { ...draftBody(), editToken: first.body.editToken, version: 1 })).body.code).toBe('hold_lost');
      expect((await call('POST', `/${id}/hold`, { editToken: taken.body.editToken })).status).toBe(200);
      expect((await call('POST', `/${id}/release`, { editToken: taken.body.editToken })).body).toEqual({ status: 'paused' });
      // Not being edited any more: a takeover is an ordinary hold.
      const again = await call('POST', `/${id}/hold`, { takeover: true });
      expect(again.body).toMatchObject({ statusBefore: 'paused' });
      expect(await rowOf(id)).toMatchObject({ status: 'editing', status_before: 'paused' });
      // A message being sent cannot be taken over.
      const busy = await create();
      await set(busy, { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() });
      expect(await call('POST', `/${busy}/hold`, { takeover: true })).toMatchObject({ status: 409, body: { status: 'sending' } });
    });

    it('lets a new composer take a hold whose lease lapsed, and the old one then has lost it', async () => {
      const id = await create();
      const first = await call('POST', `/${id}/hold`, {});
      await set(id, { edit_lease_until: new Date(Date.now() - 1000) });
      const second = await call('POST', `/${id}/hold`, {});
      expect(second.status).toBe(200);
      expect(second.body.editToken).not.toBe(first.body.editToken);
      expect(second.body.statusBefore).toBe('scheduled');
      expect(await rowOf(id)).toMatchObject({ status: 'editing', status_before: 'scheduled', edit_token: second.body.editToken });
      expect((await rowOf(id)).edit_lease_until.getTime()).toBeGreaterThan(Date.now());
      expect((await call('POST', `/${id}/hold`, { editToken: first.body.editToken })).body.code).toBe('hold_lost');
      expect((await call('PUT', `/${id}`, { ...draftBody(), editToken: first.body.editToken, version: 1 })).body.code).toBe('hold_lost');
      expect((await call('POST', `/${id}/release`, { editToken: second.body.editToken })).body).toEqual({ status: 'scheduled' });
    });

    it('keeps a message paused on release when asked (Keep paused), by the user, without a push', async () => {
      const id = await create();
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      expect(await call('POST', `/${id}/release`, { editToken: randomUUID(), keepPaused: true }))
        .toMatchObject({ status: 409, body: { code: 'hold_lost', status: 'editing' } });
      expect((await call('POST', `/${id}/release`, { editToken, keepPaused: true }, stranger.id)).status).toBe(404);
      expect(await rowOf(id)).toMatchObject({ status: 'editing', edit_token: editToken });
      imapManager.broadcast.mockClear();
      expect((await call('POST', `/${id}/release`, { editToken, keepPaused: true })).body).toEqual({ status: 'paused' });
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'paused', pause_reason: 'user', status_before: null, edit_token: null, edit_lease_until: null });
      expect(broadcasts()).toEqual([{ type: 'scheduled_changed', id, status: 'paused' }]);
      expect(sendPushToUser).not.toHaveBeenCalled();
      // The token is spent.
      expect((await call('POST', `/${id}/release`, { editToken, keepPaused: true })).body.code).toBe('hold_lost');
      // It goes on with Resume, which asks nothing for a pause the user chose: now, attempts reset.
      await set(id, { attempts: 2 });
      const resumed = await call('POST', `/${id}/resume`, {});
      expect(resumed.status).toBe(200);
      const after = await rowOf(id);
      expect(after).toMatchObject({ status: 'scheduled', pause_reason: null, attempts: 0 });
      expect(Math.abs(after.send_at.getTime() - Date.now())).toBeLessThan(60_000);
      expect(after.due_at).toEqual(after.send_at);
    });

    it('keepPaused leaves a paused message its reason, and a failed or uncertain one as it was', async () => {
      const release = async (id, fields) => {
        await set(id, fields);
        const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
        return (await call('POST', `/${id}/release`, { editToken, keepPaused: true })).body;
      };
      const restored = await create();
      expect(await release(restored, { status: 'paused', pause_reason: 'restored' })).toEqual({ status: 'paused' });
      expect(await rowOf(restored)).toMatchObject({ status: 'paused', pause_reason: 'restored' });
      expect((await call('POST', `/${restored}/resume`, {})).body.code).toBe('confirm_restored');
      const failed = await create();
      expect(await release(failed, { status: 'failed', failure_code: 'smtp_rejected' })).toEqual({ status: 'failed' });
      expect(await rowOf(failed)).toMatchObject({ status: 'failed', pause_reason: null, failure_code: 'smtp_rejected' });
      const uncertain = await create();
      expect(await release(uncertain, { status: 'uncertain', smtp_started_at: new Date() })).toEqual({ status: 'uncertain' });
      expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('cannot take a message that is being sent or was sent', async () => {
      const id = await create();
      await set(id, { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() });
      expect(await call('POST', `/${id}/hold`, {})).toMatchObject({ status: 409, body: { error: 'This message is being sent now.', status: 'sending' } });
      await set(id, { status: 'sent' });
      expect((await call('POST', `/${id}/hold`, {})).status).toBe(409);
    });

    it('saves under the next version, keeping and dropping attachments, and schedules it afresh', async () => {
      const id = await create({ attachments: [
        { filename: 'keep.txt', content: Buffer.from('kept').toString('base64') },
        { filename: 'drop.txt', content: Buffer.from('dropped').toString('base64') },
      ] });
      await set(id, { attempts: 4, failure_code: 'smtp_temporary' });
      const before = openJson((await rowOf(id)).payload_enc, aad.payload(await rowOf(id)));
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      const sendAt = new Date(Date.now() + 2 * HOUR).toISOString();
      const saved = await call('PUT', `/${id}`, { ...draftBody({ subject: 'Q4 numbers, final', sendAt }), editToken, version: 1, keepAttachments: [0],
        attachments: [{ filename: 'new.txt', content: Buffer.from('new').toString('base64') }] });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ version: 2, status: 'scheduled' });
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'scheduled', version: 2, attempts: 0, failure_code: null, edit_token: null, status_before: null });
      expect(row.due_at).toEqual(row.send_at);
      expect(row.send_at.toISOString()).toBe(sendAt);
      const payload = openJson(row.payload_enc, aad.payload(row));
      expect(payload.subject).toBe('Q4 numbers, final');
      expect(payload.messageId).toBe(before.messageId);
      const got = await call('GET', `/${id}`);
      expect(got.body.attachments.map(a => a.filename)).toEqual(['keep.txt', 'new.txt']);
      const kept = await fetch(`${base}/${id}/attachments/0`);
      expect(Buffer.from(await kept.arrayBuffer()).toString()).toBe('kept');
      // The old version's ciphertext no longer opens anything.
      expect(openJson(row.payload_enc, aad.payload({ ...row, version: 1 }))).toBeNull();
    });

    it('asks before a save schedules again what was uncertain or paused by a restore', async () => {
      for (const [state, code] of [
        [{ status: 'uncertain', failure_code: 'connection_lost', smtp_started_at: new Date() }, 'confirm_uncertain'],
        [{ status: 'paused', pause_reason: 'restored' }, 'confirm_restored'],
      ]) {
        const id = await create();
        await set(id, state);
        const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
        // The hold keeps what the confirmation depends on.
        const held = await rowOf(id);
        expect(held.status_before).toBe(state.status);
        if (state.pause_reason) expect(held.pause_reason).toBe('restored');
        if (state.smtp_started_at) expect(held.smtp_started_at).not.toBeNull();
        const asked = await call('PUT', `/${id}`, { ...draftBody(), editToken, version: 1 });
        expect(asked).toMatchObject({ status: 409, body: { code } });
        expect((await rowOf(id)).status).toBe('editing');
        const saved = await call('PUT', `/${id}`, { ...draftBody(), editToken, version: 1, confirm: true });
        expect(saved.status).toBe(200);
        expect(await rowOf(id)).toMatchObject({ status: 'scheduled', pause_reason: null, smtp_started_at: null });
      }
    });

    it('refuses a save with a lost hold or a stale version', async () => {
      const id = await create();
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      expect((await call('PUT', `/${id}`, { ...draftBody(), editToken: randomUUID(), version: 1 })).body.code).toBe('hold_lost');
      expect((await call('PUT', `/${id}`, { ...draftBody(), editToken, version: 7 })).body.code).toBe('version_conflict');
      expect((await rowOf(id)).status).toBe('editing');
    });
  });

  describe('reschedule, send now, resume', () => {
    it('reschedules a failed message with its attempts reset', async () => {
      const id = await create();
      await set(id, { status: 'failed', failure_code: 'gave_up', attempts: 6 });
      const sendAt = new Date(Date.now() + 3 * HOUR).toISOString();
      const r = await call('PATCH', `/${id}`, { sendAt, timeZone: 'America/Los_Angeles' });
      expect(r.status).toBe(200);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'scheduled', attempts: 0, failure_code: null, time_zone: 'America/Los_Angeles' });
      expect(row.send_at.toISOString()).toBe(sendAt);
      expect(row.due_at).toEqual(row.send_at);
    });

    it('asks before rescheduling what may have gone out, or what a restore paused', async () => {
      const id = await create();
      await set(id, { status: 'uncertain', failure_code: 'connection_lost', smtp_started_at: new Date() });
      expect(await call('PATCH', `/${id}`, { sendAt: inAnHour() })).toMatchObject({ status: 409, body: { code: 'confirm_uncertain' } });
      expect((await call('PATCH', `/${id}`, { sendAt: inAnHour(), confirm: true })).status).toBe(200);
      await set(id, { status: 'paused', pause_reason: 'restored' });
      expect((await call('PATCH', `/${id}`, { sendAt: inAnHour() })).body.code).toBe('confirm_restored');
      expect((await call('POST', `/${id}/send-now`, {})).body.code).toBe('confirm_restored');
      await set(id, { status: 'sending', pause_reason: null, claim_token: randomUUID(), claimed_at: new Date() });
      expect((await call('PATCH', `/${id}`, { sendAt: inAnHour(), confirm: true })).body).toMatchObject({ status: 'sending' });
    });

    it('sends now in 10 s, and its Undo puts everything back within them', async () => {
      const id = await create();
      await set(id, { status: 'failed', failure_code: 'smtp_rejected', attempts: 2 });
      const before = await rowOf(id);
      const now = await call('POST', `/${id}/send-now`, {});
      expect(now.status).toBe(200);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'scheduled', attempts: 0, failure_code: null });
      expect(row.send_at.getTime() - Date.now()).toBeGreaterThan(5000);
      expect(row.send_at.getTime() - Date.now()).toBeLessThan(11_000);
      expect(row.due_at).toEqual(row.send_at);
      const undo = await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken });
      expect(undo.status).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: 'failed', failure_code: 'smtp_rejected', attempts: 2, send_at: before.send_at, due_at: before.due_at });
      // Once is all: the same token no longer matches.
      expect((await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken })).status).toBe(409);
    });

    it('sends a message open for editing with its hold token, and Undo puts back the message as before the hold', async () => {
      const id = await create();
      await set(id, { status: 'failed', failure_code: 'smtp_rejected', attempts: 2 });
      const before = await rowOf(id);
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      // Without the token, or with another, nothing happens.
      expect(await call('POST', `/${id}/send-now`, {})).toMatchObject({ status: 409, body: { status: 'editing' } });
      expect(await call('POST', `/${id}/send-now`, { editToken: randomUUID() })).toMatchObject({ status: 409, body: { code: 'hold_lost' } });
      expect((await call('POST', `/${id}/send-now`, { editToken }, stranger.id)).status).toBe(404);
      expect((await rowOf(id)).status).toBe('editing');
      imapManager.broadcast.mockClear();
      const now = await call('POST', `/${id}/send-now`, { editToken });
      expect(now.status).toBe(200);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'scheduled', attempts: 0, failure_code: null, status_before: null, edit_token: null, edit_lease_until: null });
      expect(row.send_at.getTime() - Date.now()).toBeGreaterThan(5000);
      expect(row.send_at.getTime() - Date.now()).toBeLessThan(11_000);
      expect(row.due_at).toEqual(row.send_at);
      expect(broadcasts()).toEqual([{ type: 'scheduled_changed', id, status: 'scheduled' }]);
      // The hold is spent: its token sends nothing again.
      expect((await call('POST', `/${id}/send-now`, { editToken })).body.code).toBe('hold_lost');
      expect((await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken })).status).toBe(200);
      expect(await rowOf(id)).toMatchObject({
        status: 'failed', failure_code: 'smtp_rejected', attempts: 2, send_at: before.send_at, due_at: before.due_at, version: before.version,
      });
    });


    it('an Undo of Send now on a message that is due leaves it paused by the user, and the sender does not take it', async () => {
      const id = await create();
      const past = new Date(Date.now() - 60_000);
      await set(id, { send_at: past, due_at: past });
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      const now = await call('POST', `/${id}/send-now`, { editToken });
      imapManager.broadcast.mockClear();
      const undo = await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken });
      expect(undo.body).toMatchObject({ status: 'paused', pauseReason: 'user' });
      expect(await rowOf(id)).toMatchObject({ status: 'paused', pause_reason: 'user', send_at: past, due_at: past });
      expect(broadcasts()).toEqual([{ type: 'scheduled_changed', id, status: 'paused' }]);
      await tickSender();
      expect(await rowOf(id)).toMatchObject({ status: 'paused', claim_token: null, smtp_started_at: null, sent_at: null });

      // The plain Send now of a scheduled message whose time passes before the Undo, the same.
      const plain = await create();
      await set(plain, { send_at: past, due_at: past });
      const sent = await call('POST', `/${plain}/send-now`, {});
      expect((await call('POST', `/${plain}/send-now/undo`, { undoToken: sent.body.undoToken })).body.status).toBe('paused');
      expect(await rowOf(plain)).toMatchObject({ status: 'paused', pause_reason: 'user' });
    });

    it('an Undo of Send now on a message not yet due puts it back scheduled at its time', async () => {
      const id = await create();
      const before = await rowOf(id);
      const { body: { editToken } } = await call('POST', `/${id}/hold`, {});
      const now = await call('POST', `/${id}/send-now`, { editToken });
      const undo = await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken });
      expect(undo.body).toMatchObject({ status: 'scheduled' });
      expect(undo.body.pauseReason).toBeUndefined();
      expect(await rowOf(id)).toMatchObject({ status: 'scheduled', pause_reason: null, send_at: before.send_at, due_at: before.due_at });
    });

    it('an Undo of Send now on a message opened in another window says so', async () => {
      const id = await create();
      const now = await call('POST', `/${id}/send-now`, {});
      await call('POST', `/${id}/hold`, {});
      expect(await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken }))
        .toMatchObject({ status: 409, body: { code: 'held_elsewhere', error: 'This message is open in another window.' } });
    });

    it('a held message keeps its confirmations, and its Undo puts back a pause the user chose', async () => {
      const uncertain = await create();
      await set(uncertain, { status: 'uncertain', smtp_started_at: new Date() });
      let { body: { editToken } } = await call('POST', `/${uncertain}/hold`, {});
      expect((await call('POST', `/${uncertain}/send-now`, { editToken })).body.code).toBe('confirm_uncertain');
      expect((await rowOf(uncertain)).status).toBe('editing');
      expect((await call('POST', `/${uncertain}/send-now`, { editToken, confirm: true })).status).toBe(200);

      const restored = await create();
      await set(restored, { status: 'paused', pause_reason: 'restored' });
      ({ body: { editToken } } = await call('POST', `/${restored}/hold`, {}));
      expect((await call('POST', `/${restored}/send-now`, { editToken })).body.code).toBe('confirm_restored');

      const paused = await create();
      await set(paused, { status: 'paused', pause_reason: 'user' });
      const before = await rowOf(paused);
      ({ body: { editToken } } = await call('POST', `/${paused}/hold`, {}));
      const now = await call('POST', `/${paused}/send-now`, { editToken });
      expect(now.status).toBe(200);
      expect((await call('POST', `/${paused}/send-now/undo`, { undoToken: now.body.undoToken })).status).toBe(200);
      expect(await rowOf(paused)).toMatchObject({ status: 'paused', pause_reason: 'user', send_at: before.send_at, due_at: before.due_at, edit_token: null });
    });

    it('cannot undo Send now once it is claimed or its 10 s are over, or with a forged token', async () => {
      const id = await create();
      const now = await call('POST', `/${id}/send-now`, {});
      await set(id, { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() });
      expect((await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken })).body.code).toBe('undo_expired');
      await set(id, { status: 'scheduled', claim_token: null, claimed_at: null });
      expect((await call('POST', `/${id}/send-now/undo`, { undoToken: Buffer.from('forged').toString('base64url') })).body.code).toBe('undo_expired');
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 11_000);
        expect((await call('POST', `/${id}/send-now/undo`, { undoToken: now.body.undoToken })).body.code).toBe('undo_expired');
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes a paused message now with its attempts reset, once its account can send', async () => {
      const id = await create();
      await set(id, { status: 'paused', pause_reason: 'needs_reauth', failure_code: 'auth_failed', attempts: 3 });
      await h.pool.query("UPDATE email_accounts SET sync_error_code = 'oauth_reauth' WHERE id = $1", [account.id]);
      expect((await call('POST', `/${id}/resume`, {})).body).toMatchObject({ code: 'needs_reauth' });
      await h.pool.query('UPDATE email_accounts SET sync_error_code = NULL WHERE id = $1', [account.id]);
      expect((await call('POST', `/${id}/resume`, {})).status).toBe(200);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'scheduled', attempts: 0, pause_reason: null, failure_code: null });
      expect(Math.abs(row.send_at.getTime() - Date.now())).toBeLessThan(5000);
      expect(row.due_at).toEqual(row.send_at);

      await set(id, { status: 'paused', pause_reason: 'account_disabled' });
      await h.pool.query('UPDATE email_accounts SET enabled = false WHERE id = $1', [account.id]);
      expect((await call('POST', `/${id}/resume`, {})).body.code).toBe('account_disabled');
    });

    it('resumes a restored message only with the explicit confirmation, and nothing that is not paused or failed', async () => {
      const id = await create();
      await set(id, { status: 'paused', pause_reason: 'restored' });
      const asked = await call('POST', `/${id}/resume`, {});
      expect(asked).toMatchObject({ status: 409, body: { code: 'confirm_restored', error: expect.stringContaining('backup was restored') } });
      expect((await rowOf(id)).status).toBe('paused');
      expect((await call('POST', `/${id}/resume`, { confirm: true })).status).toBe(200);
      expect((await call('POST', `/${id}/resume`, { confirm: true })).body).toMatchObject({ status: 'scheduled' });
    });
  });

  describe('uncertain', () => {
    it('sends anyway only with the confirmation, and marks as sent when the user found it', async () => {
      const id = await create();
      await set(id, { status: 'uncertain', failure_code: 'connection_lost', smtp_started_at: new Date() });
      const asked = await call('POST', `/${id}/send-anyway`, {});
      expect(asked).toMatchObject({ status: 409, body: { code: 'confirm_uncertain', error: expect.stringContaining('may already have been delivered') } });
      expect((await call('POST', `/${id}/send-anyway`, { confirm: true })).status).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: 'scheduled', attempts: 0, smtp_started_at: null });
      expect((await call('POST', `/${id}/send-anyway`, { confirm: true })).status).toBe(409);

      const found = await create({ attachments: [{ filename: 'a.txt', content: 'YQ==' }] });
      await set(found, { status: 'uncertain', smtp_started_at: new Date() });
      expect((await call('POST', `/${found}/mark-sent`, {})).body).toEqual({ status: 'sent' });
      const row = await rowOf(found);
      expect(row).toMatchObject({ status: 'sent', payload_enc: null, summary_enc: null });
      expect(row.purge_after.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await h.pool.query('SELECT 1 FROM scheduled_message_attachments WHERE scheduled_id = $1', [found])).rows).toHaveLength(0);
      const notUncertain = await create();
      expect((await call('POST', `/${notUncertain}/mark-sent`, {})).status).toBe(409);
    });
  });

  describe('cancel, undo, delete', () => {
    it('cancels with an undo that puts back its status and time, and keeps the hold\'s status_before', async () => {
      const id = await create();
      const sendAt = (await rowOf(id)).send_at;
      const cancelled = await call('POST', `/${id}/cancel`, {});
      expect(cancelled.body).toMatchObject({ status: 'cancelled', undoUntil: expect.any(String) });
      expect(await rowOf(id)).toMatchObject({ status: 'cancelled', status_before: 'scheduled' });
      expect((await call('POST', `/${id}/restore`, {})).body).toMatchObject({ status: 'scheduled' });
      expect(await rowOf(id)).toMatchObject({ status: 'scheduled', status_before: null, purge_after: null, send_at: sendAt });

      await set(id, { status: 'paused', pause_reason: 'overdue' });
      await call('POST', `/${id}/hold`, {});
      await call('POST', `/${id}/cancel`, {});
      expect(await rowOf(id)).toMatchObject({ status: 'cancelled', status_before: 'paused', edit_token: null });
      // A second cancel changes nothing.
      const purgeAfter = (await rowOf(id)).purge_after;
      expect((await call('POST', `/${id}/cancel`, {})).body.status).toBe('cancelled');
      expect((await rowOf(id)).purge_after).toEqual(purgeAfter);
      expect((await call('POST', `/${id}/restore`, {})).body.status).toBe('paused');
      expect((await rowOf(id)).pause_reason).toBe('overdue');
    });

    it('lists a deleted message while it can be restored, and finds it, then neither', async () => {
      const id = await create();
      const theirs = await create({ accountId: strangerAccount.id }, stranger.id);
      await call('POST', `/${theirs}/cancel`, {}, stranger.id);
      const cancelled = await call('POST', `/${id}/cancel`, {});
      const list = await call('GET', '');
      expect(list.body.messages.map(m => m.id)).toEqual([id]);
      expect(list.body.messages[0]).toMatchObject({
        status: 'cancelled', restoreUntil: cancelled.body.undoUntil, summary: { subject: 'Q4 numbers' },
      });
      expect((await call('GET', `/${id}`)).body).toMatchObject({ id, status: 'cancelled', restoreUntil: cancelled.body.undoUntil, spec: { subject: 'Q4 numbers' } });
      // Every other message says it has no restore window.
      const open = await create();
      expect((await call('GET', '')).body.messages.find(m => m.id === open).restoreUntil).toBeNull();
      // Once the window closed (before the purge), it is gone from both.
      await set(id, { purge_after: new Date(Date.now() - 1000) });
      expect((await call('GET', '')).body.messages.map(m => m.id)).toEqual([open]);
      expect((await call('GET', `/${id}`)).status).toBe(404);
      // Another user's deleted message is theirs alone.
      expect((await call('GET', `/${theirs}`)).status).toBe(404);
      expect((await call('GET', '', undefined, stranger.id)).body.messages.map(m => m.id)).toEqual([theirs]);
    });

    it('a restore of a message whose time passed brings it back paused by the user, and the sender does not take it', async () => {
      const id = await create();
      await call('POST', `/${id}/cancel`, {});
      const past = new Date(Date.now() - 60_000);
      await set(id, { send_at: past, due_at: past });
      imapManager.broadcast.mockClear();
      const restored = await call('POST', `/${id}/restore`, {});
      expect(restored.body).toEqual({ status: 'paused', sendAt: past.toISOString(), pauseReason: 'user' });
      expect(await rowOf(id)).toMatchObject({ status: 'paused', pause_reason: 'user', send_at: past, due_at: past, status_before: null, purge_after: null });
      expect(broadcasts()).toEqual([{ type: 'scheduled_changed', id, status: 'paused' }]);
      await tickSender();
      expect(await rowOf(id)).toMatchObject({ status: 'paused', claim_token: null, smtp_started_at: null, sent_at: null });

      // Not yet due, it comes back scheduled at its time; a failed one comes back failed.
      const later = await create();
      await call('POST', `/${later}/cancel`, {});
      const back = await call('POST', `/${later}/restore`, {});
      expect(back.body.status).toBe('scheduled');
      expect(back.body.pauseReason).toBeUndefined();
      const failed = await create();
      await set(failed, { status: 'failed', failure_code: 'smtp_rejected', send_at: past, due_at: past });
      await call('POST', `/${failed}/cancel`, {});
      expect((await call('POST', `/${failed}/restore`, {})).body).toEqual({ status: 'failed', sendAt: past.toISOString() });
    });

    it('a restore may bring the pending count up to the limit, and the next create is refused', async () => {
      const id = await create();
      await call('POST', `/${id}/cancel`, {});
      for (let i = 0; i < 99; i++) await create();
      expect((await call('POST', `/${id}/restore`, {})).body.status).toBe('scheduled');
      const { rows: [{ pending }] } = await h.pool.query(
        "SELECT COUNT(*)::int AS pending FROM scheduled_messages WHERE user_id = $1 AND status <> 'cancelled' AND status <> 'sent'", [owner.id]);
      expect(pending).toBe(100);
      const next = await call('POST', '', draftBody());
      expect(next).toMatchObject({ status: 422, body: { code: 'too_many' } });
    });

    it('keeps the 100-pending limit on a restore', async () => {
      const later = await create();
      await call('POST', `/${later}/cancel`, {});
      for (let i = 0; i < 100; i++) await create();
      const full = await call('POST', `/${later}/restore`, {});
      expect(full).toMatchObject({ status: 422, body: { code: 'too_many' } });
      expect((await rowOf(later)).status).toBe('cancelled');
      // At the limit, a message that is not the user's, or whose window closed, is still 404 or 409.
      expect((await call('POST', `/${randomUUID()}/restore`, {})).status).toBe(404);
      await set(later, { purge_after: new Date(Date.now() - 1000) });
      expect(await call('POST', `/${later}/restore`, {})).toMatchObject({ status: 409, body: { error: 'This can no longer be undone.' } });
    });

    it('cannot cancel what is being sent or was sent, nor undo once the window closed', async () => {
      const id = await create();
      await set(id, { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() });
      expect((await call('POST', `/${id}/cancel`, {})).body).toMatchObject({ status: 'sending' });
      await set(id, { status: 'sent' });
      expect((await call('POST', `/${id}/cancel`, {})).status).toBe(409);
      const other = await create();
      await call('POST', `/${other}/cancel`, {});
      await set(other, { purge_after: new Date(Date.now() - 1000) });
      expect((await call('POST', `/${other}/restore`, {})).body.error).toBe('This can no longer be undone.');
    });

    it('deletes for good with its attachments, but not while it is being sent', async () => {
      const id = await create({ attachments: [{ filename: 'a.txt', content: 'YQ==' }] });
      await set(id, { status: 'failed', failure_code: 'smtp_rejected' });
      expect((await call('DELETE', `/${id}`)).status).toBe(204);
      expect(await rowOf(id)).toBeUndefined();
      expect((await h.pool.query('SELECT 1 FROM scheduled_message_attachments WHERE scheduled_id = $1', [id])).rows).toHaveLength(0);
      const busy = await create();
      await set(busy, { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() });
      expect((await call('DELETE', `/${busy}`)).status).toBe(409);
    });
  });

  it('broadcasts every change, with the id and status only', async () => {
    const id = await create();
    await call('POST', `/${id}/hold`, {});
    await call('POST', `/${id}/cancel`, {});
    await call('POST', `/${id}/restore`, {});
    await call('DELETE', `/${id}`);
    expect(broadcasts().map(b => b.status)).toEqual(['scheduled', 'editing', 'cancelled', 'scheduled', 'deleted']);
    expect(broadcasts().every(b => Object.keys(b).join() === 'type,id,status')).toBe(true);
  });
});
