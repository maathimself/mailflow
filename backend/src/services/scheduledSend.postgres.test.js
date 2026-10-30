import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, sendMail: null, sent: null }));

// The sender on a real database, through the real send pipeline (outgoingMail.js). Only what
// would leave the process is faked: the SMTP transport, IMAP, push and the WebSocket.
vi.mock('./db.js', () => ({
  pool: { connect: (...a) => h.pool.connect(...a), query: (...a) => h.pool.query(...a) },
  query: (text, params) => h.pool.query(text, params),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    findUidByMessageId: vi.fn(),
    appendToSent: vi.fn(async () => ({ uid: 41 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    broadcast: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('./smtpTransport.js', () => ({
  createAccountSmtpTransport: vi.fn(async account => ({ account, transport: { sendMail: opts => h.sendMail(opts) } })),
}));
// The Sent folder as the folders table has it, as mailUtils resolves it without a mapping.
vi.mock('../utils/mailUtils.js', () => ({
  resolveSentFolder: vi.fn(async accountId => (await h.pool.query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1", [accountId])).rows[0]?.path ?? null),
}));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(async () => {}) } }));

import { runMigrations } from './migrations.js';
import { ScheduledSender, aad, openJson, storeScheduledMessage } from './scheduledSend.js';
import { renderRawMessage } from './outgoingMail.js';
import { imapManager } from '../index.js';
import { sendPushToUser } from './pushNotifications.js';

const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const MiB = 1024 * 1024;

const smtpError = (fields, stage) => Object.assign(new Error(fields.message || 'smtp'), fields, { smtpStage: stage });
const MAIL = { mailFromSent: true, bodyStarted: false };
const DATA = { mailFromSent: true, bodyStarted: true };
const dateHeader = raw => raw.toString().match(/^Date: (.+)$/m)?.[1].trim();
const messageIdHeader = raw => raw.toString().match(/^Message-ID: (.+)$/m)?.[1].trim();

describe.skipIf(!ADMIN_URL)('scheduled sender on PostgreSQL (#543)', () => {
  const dbName = `mailflow_543s_${randomBytes(4).toString('hex')}`;
  let admin;
  let user;
  let accountCount = 0;
  // to -> what the SMTP server does with a message for that address
  let behavior;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '5d'.repeat(32));
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    h.pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runMigrations();
    ({ rows: [user] } = await h.pool.query("INSERT INTO users (username) VALUES ('ann') RETURNING id"));
  });

  afterAll(async () => {
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await h.pool.query('DELETE FROM scheduled_messages');
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    behavior = new Map();
    h.sent = [];
    h.sendMail = vi.fn(async opts => {
      const raw = await renderRawMessage(opts);
      const act = behavior.get(opts.to);
      if (act) return act(opts);
      h.sent.push({ opts, raw });
      return { accepted: [opts.to], rejected: [] };
    });
    imapManager.findUidByMessageId.mockResolvedValue(null);
  });

  const addFolders = (account, { sent = true } = {}) => h.pool.query(
    `INSERT INTO folders (account_id, path, name, special_use) VALUES ($1, 'INBOX', 'INBOX', NULL)
     ${sent ? ", ($1, 'Sent', 'Sent', '\\Sent')" : ''} ON CONFLICT DO NOTHING`, [account.id]);
  const newAccount = async (extra = {}) => {
    accountCount++;
    const { rows: [account] } = await h.pool.query(
      `INSERT INTO email_accounts (user_id, name, email_address, imap_host, smtp_host, enabled)
       VALUES ($1, $2, $3, 'imap.example.com', 'smtp.example.com', $4) RETURNING *`,
      [user.id, `Ann ${accountCount}`, `ann${accountCount}@example.com`, extra.enabled ?? true],
    );
    // As after a sync; a restored account has none until its first one (folders: false).
    // 'inbox': a sync that stored INBOX but not Sent yet.
    if (extra.folders !== false) await addFolders(account, { sent: extra.folders !== 'inbox' });
    return account;
  };

  // A scheduled message, stored as the API will store it, then moved into `state` by hand.
  const schedule = async ({ account, to = `to${randomBytes(3).toString('hex')}@example.net`, sendAt = new Date(Date.now() - 1000), payload = {}, attachments = [], state = {} } = {}) => {
    account ??= await newAccount();
    const messageId = `<${randomBytes(8).toString('hex')}@example.com>`;
    const { id } = await storeScheduledMessage(h.pool, {
      userId: user.id, accountId: account.id, clientKey: randomUUID(), sendAt, timeZone: 'Europe/Berlin',
      payload: { v: 1, messageId, aliasId: null, to: [to], cc: [], bcc: [], subject: 'Q4 numbers', body: 'Hello', bodyIsHtml: false, signature: null, plaintextEmail: false, priority: 'normal', ...payload },
      summary: { subject: 'Q4 numbers' },
      attachments,
    });
    const cols = Object.keys(state);
    if (cols.length) {
      await h.pool.query(`UPDATE scheduled_messages SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(state)]);
    }
    return { id, account, to, messageId };
  };
  const rowOf = async id => (await h.pool.query('SELECT * FROM scheduled_messages WHERE id = $1', [id])).rows[0];
  const resultOf = row => openJson(row.result_enc, aad.result(row));
  const newSender = (opts = {}) => {
    const sender = new ScheduledSender({ sleep: async () => {}, sentLookupDelaysMs: [0, 0, 0], ...opts });
    sender.running = true;
    // Each test runs the ticks itself; a nudge must not start one behind its back.
    sender.arm = () => {};
    return sender;
  };
  const tick = async sender => {
    await sender.runTick();
    await sender.idle();
  };

  describe('the claim', () => {
    it('gives every due message to exactly one of two concurrent workers, one per account', async () => {
      const shared = await newAccount();
      const ids = [];
      for (let i = 0; i < 6; i++) ids.push((await schedule()).id);
      const pair = [(await schedule({ account: shared })).id, (await schedule({ account: shared })).id];
      const workers = [newSender(), newSender()];
      const claimedBy = await Promise.all(workers.map(async w => {
        const got = [];
        for (let i = 0; i < 10; i++) {
          const row = await w.claimOne();
          // A conflict (two claims for one account at once) is a symbol, not a row.
          if (row?.id) got.push(row.id);
        }
        return got;
      }));
      const all = claimedBy.flat();
      expect(new Set(all).size).toBe(all.length);
      expect(all.filter(id => !pair.includes(id)).sort()).toEqual(ids.sort());
      // One of the shared account's two messages, never both: when the two workers race for
      // that account, the unique index lets only one claim stand, whichever row it took.
      const fromPair = all.filter(id => pair.includes(id));
      expect(fromPair).toHaveLength(1);
      expect((await rowOf(pair.find(id => id !== fromPair[0]))).status).toBe('scheduled');
      const { rows } = await h.pool.query("SELECT DISTINCT claim_token, attempts FROM scheduled_messages WHERE status = 'sending'");
      expect(rows).toHaveLength(7);
      expect(rows.every(r => r.attempts === 1)).toBe(true);
    });

    it('skips a row another transaction holds instead of waiting for it', async () => {
      const first = await schedule({ sendAt: new Date(Date.now() - 60_000) });
      const next = await schedule();
      const holder = await h.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM scheduled_messages WHERE id = $1 FOR UPDATE', [first.id]);
        const row = await newSender().claimOne();
        expect(row.id).toBe(next.id);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('sends an account\'s messages in due order, even while another scheduler holds the first', async () => {
      const account = await newAccount();
      const first = await schedule({ account, sendAt: new Date(Date.now() - 60_000) });
      const later = await schedule({ account, sendAt: new Date(Date.now() - 30_000) });
      const holder = await h.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM scheduled_messages WHERE id = $1 FOR UPDATE', [first.id]);
        // The first is being claimed elsewhere: the later one is not taken past it.
        expect(await newSender().claimOne()).toBeNull();
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await newSender().claimOne()).id).toBe(first.id);
      expect((await rowOf(later.id)).status).toBe('scheduled');
    });

    it('takes nothing that is not due, or not scheduled', async () => {
      await schedule({ sendAt: new Date(Date.now() + 3_600_000) });
      await schedule({ state: { status: 'paused', pause_reason: 'overdue' } });
      await schedule({ state: { status: 'editing' } });
      expect(await newSender().claimOne()).toBeNull();
    });
  });

  describe('a send', () => {
    it('goes out once through the send pipeline, with its own Message-ID and the send time as Date', async () => {
      const big = randomBytes(2.5 * MiB);
      const msg = await schedule({ attachments: [
        { filename: 'report.pdf', contentType: 'application/pdf', kind: 'upload', content: big },
        { filename: 'note.txt', contentType: 'text/plain', kind: 'forwarded', content: Buffer.from('fwd') },
      ] });
      const before = Date.now();
      await tick(newSender());

      expect(h.sent).toHaveLength(1);
      const [{ opts, raw }] = h.sent;
      expect(opts.messageId).toBe(msg.messageId);
      expect(opts.date.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(opts.attachments.map(a => a.filename)).toEqual(['report.pdf', 'note.txt']);
      expect(opts.attachments[0].content.equals(big)).toBe(true);
      expect(imapManager.appendToSent).toHaveBeenCalledOnce();
      const sentCopy = imapManager.appendToSent.mock.calls[0][2];
      expect(messageIdHeader(sentCopy)).toBe(msg.messageId);
      expect(dateHeader(sentCopy)).toBe(dateHeader(raw));

      const row = await rowOf(msg.id);
      expect(row).toMatchObject({ status: 'sent', payload_enc: null, summary_enc: null, claim_token: null, sent_late: false, attempts: 1 });
      expect(row.smtp_started_at).not.toBeNull();
      expect(row.smtp_accepted_at).not.toBeNull();
      expect(row.purge_after.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      expect(resultOf(row)).toEqual({ ok: true, sentFolder: 'Sent', messageId: msg.messageId, sentCopySaved: true });
      expect((await h.pool.query('SELECT 1 FROM scheduled_message_attachments WHERE scheduled_id = $1', [msg.id])).rows).toHaveLength(0);
      expect(imapManager.broadcast.mock.calls.map(c => c[0])).toEqual([
        { type: 'scheduled_changed', id: msg.id, status: 'sending' },
        { type: 'scheduled_changed', id: msg.id, status: 'sent' },
      ]);
      expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('records which recipients the server deferred and which it refused', async () => {
      const msg = await schedule({ payload: { cc: ['later@example.org', 'bad@example.org'] } });
      behavior.set(msg.to, opts => ({
        accepted: [opts.to], rejected: ['later@example.org', 'bad@example.org'],
        rejectedErrors: [
          Object.assign(new Error('x'), { recipient: 'later@example.org', responseCode: 451 }),
          Object.assign(new Error('x'), { recipient: 'bad@example.org', responseCode: 550 }),
        ],
      }));
      await tick(newSender());
      const row = await rowOf(msg.id);
      expect(row.status).toBe('sent');
      expect(resultOf(row)).toMatchObject({ rejected: ['bad@example.org'], deferred: ['later@example.org'] });
    });

    it('goes out from the alias it was scheduled with, and fails when that alias is gone', async () => {
      const account = await newAccount();
      const { rows: [alias] } = await h.pool.query(
        "INSERT INTO account_aliases (account_id, name, email) VALUES ($1, 'Sales', 'sales@example.com') RETURNING id", [account.id]);
      const kept = await schedule({ account, payload: { aliasId: alias.id } });
      await tick(newSender());
      expect(h.sent[0].opts.from).toBe('Sales <sales@example.com>');
      expect((await rowOf(kept.id)).status).toBe('sent');

      const gone = await schedule({ account, payload: { aliasId: alias.id } });
      await h.pool.query('DELETE FROM account_aliases WHERE id = $1', [alias.id]);
      await tick(newSender());
      expect(h.sendMail).toHaveBeenCalledTimes(1);
      const row = await rowOf(gone.id);
      expect(row).toMatchObject({ status: 'failed', failure_code: 'alias_missing' });
      // Failed messages keep their content (open question 14).
      expect(row.payload_enc).not.toBeNull();
      expect(sendPushToUser).toHaveBeenCalledWith(user.id, expect.objectContaining({
        title: 'Q4 numbers', body: 'Not sent: The address it was to be sent from no longer exists.',
      }));
    });

    it('is held, not sent, more than 6 h late, and flagged late within that', async () => {
      const held = await schedule({ sendAt: new Date(Date.now() - 7 * 3_600_000) });
      const late = await schedule({ sendAt: new Date(Date.now() - 2 * 3_600_000) });
      await tick(newSender());
      expect(await rowOf(held.id)).toMatchObject({ status: 'paused', pause_reason: 'overdue' });
      expect(await rowOf(late.id)).toMatchObject({ status: 'sent', sent_late: true });
      expect(h.sent.map(s => s.opts.messageId)).toEqual([late.messageId]);
      expect(sendPushToUser).toHaveBeenCalledTimes(1);
      expect(sendPushToUser.mock.calls[0][1].body).toMatch(/^Not sent: was scheduled for .*MailFlow was offline/);
    });

    it('ends as the error says: retry, failed, paused or uncertain', async () => {
      const temporary = await schedule();
      const lost = await schedule();
      const rejected = await schedule();
      const auth = await schedule();
      const last = await schedule({ state: { attempts: 5 } });
      behavior.set(temporary.to, () => { throw smtpError({ responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO', response: '451 4.7.1 try later' }, MAIL); });
      behavior.set(lost.to, () => { throw smtpError({ code: 'ESOCKET', command: 'CONN' }, DATA); });
      behavior.set(rejected.to, () => { throw smtpError({ responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' }, MAIL); });
      behavior.set(auth.to, () => { throw smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN' }, { mailFromSent: false, bodyStarted: false }); });
      behavior.set(last.to, () => { throw smtpError({ code: 'ETIMEDOUT', command: 'CONN' }, { mailFromSent: false, bodyStarted: false }); });
      const sender = newSender({ maxInFlight: 10 });
      await tick(sender);

      const t = await rowOf(temporary.id);
      expect(t).toMatchObject({ status: 'scheduled', failure_code: 'smtp_temporary', smtp_started_at: null, claim_token: null, attempts: 1 });
      expect(t.due_at.getTime() - Date.now()).toBeGreaterThan(50_000);
      expect(t.due_at.getTime() - Date.now()).toBeLessThan(65_000);
      expect(resultOf(t)).toMatchObject({ code: 'smtp_temporary', smtpResponse: '451 4.7.1 try later', command: 'RCPT TO' });
      const l = await rowOf(lost.id);
      expect(l).toMatchObject({ status: 'uncertain', failure_code: 'connection_lost' });
      expect(l.smtp_started_at).not.toBeNull();
      expect(await rowOf(rejected.id)).toMatchObject({ status: 'failed', failure_code: 'smtp_rejected' });
      expect(await rowOf(auth.id)).toMatchObject({ status: 'paused', pause_reason: 'needs_reauth', failure_code: 'auth_failed' });
      expect(await rowOf(last.id)).toMatchObject({ status: 'failed', failure_code: 'gave_up', attempts: 6 });
      // A push for each one that needs the user, none for the retry.
      expect(sendPushToUser).toHaveBeenCalledTimes(4);
      // The uncertain one is never sent again by the scheduler.
      behavior.clear();
      await h.pool.query("UPDATE scheduled_messages SET due_at = NOW() WHERE id = $1", [temporary.id]);
      await tick(sender);
      expect(h.sent.map(s => s.opts.to)).toEqual([temporary.to]);
    });
  });

  it('a mailbox whose SMTP sending Outlook turned off fails for good, and is never a sign-in to redo', async () => {
    const msg = await schedule();
    const response = '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox. Visit https://aka.ms/smtp_auth_disabled for more information.';
    behavior.set(msg.to, () => { throw smtpError({ responseCode: 535, code: 'EAUTH', command: 'AUTH XOAUTH2', message: `Invalid login: ${response}`, response }, { mailFromSent: false, bodyStarted: false }); });
    const sender = newSender();
    await tick(sender);
    const row = await rowOf(msg.id);
    expect(row).toMatchObject({ status: 'failed', failure_code: 'smtp_auth_disabled', pause_reason: null, attempts: 1 });
    expect(resultOf(row)).toMatchObject({ code: 'smtp_auth_disabled', smtpResponse: response });
    expect(sendPushToUser).toHaveBeenCalledOnce();
    expect(sendPushToUser.mock.calls[0][1].body).toMatch(/^Not sent: Microsoft has turned off sending from mail apps \(SMTP\)/);
    // Not retried: nothing is due again.
    behavior.clear();
    await tick(sender);
    expect(h.sent).toEqual([]);
    expect((await rowOf(msg.id)).status).toBe('failed');
  });

  describe('recovery', () => {
    const left = (extra = {}) => ({ status: 'sending', claim_token: randomUUID(), claimed_at: new Date(Date.now() - 3_600_000), attempts: 1, ...extra });
    const started = new Date(Date.now() - 3_590_000);
    const accepted = new Date(Date.now() - 3_589_000);

    it('follows the recovery table, checking acceptance first', async () => {
      const unsent = await schedule({ state: left() });
      const startedFound = await schedule({ state: left({ smtp_started_at: started }) });
      const startedLost = await schedule({ state: left({ smtp_started_at: started }) });
      const acceptedFound = await schedule({ state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const acceptedMissing = await schedule({ state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      imapManager.findUidByMessageId.mockImplementation(async (_a, _f, id) => (
        [startedFound.messageId, acceptedFound.messageId].includes(id) ? 7 : null));
      await tick(newSender({ maxInFlight: 10 }));

      // Nothing had reached SMTP: claimed again and sent, once.
      expect(await rowOf(unsent.id)).toMatchObject({ status: 'sent' });
      expect(h.sent.map(s => s.opts.messageId)).toEqual([unsent.messageId]);
      expect(resultOf(await rowOf(startedFound.id))).toMatchObject({ sentCopySaved: true, recovered: true });
      expect(await rowOf(startedLost.id)).toMatchObject({ status: 'uncertain', failure_code: 'interrupted' });
      expect(resultOf(await rowOf(acceptedFound.id))).toMatchObject({ sentCopySaved: true, recovered: true });
      // Accepted but not in Sent: the Sent copy is made once, dated as the delivered message was.
      const missing = await rowOf(acceptedMissing.id);
      expect(missing.status).toBe('sent');
      expect(resultOf(missing)).toMatchObject({ sentFolder: 'Sent', messageId: acceptedMissing.messageId, sentCopySaved: true });
      const appended = imapManager.appendToSent.mock.calls.map(c => c[2]).filter(raw => messageIdHeader(raw) === acceptedMissing.messageId);
      expect(appended).toHaveLength(1);
      expect(dateHeader(appended[0])).toBe(started.toUTCString().replace(/GMT/, '+0000'));
      // None of the recovered ones went to SMTP again.
      expect(h.sendMail).toHaveBeenCalledTimes(1);
      expect(sendPushToUser).toHaveBeenCalledTimes(1);
    });

    it('always ends an accepted message sent, and never holds up its account', async () => {
      const account = await newAccount();
      const imapDown = await schedule({ account, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const waiting = await schedule({ account });
      const disabledAccount = await newAccount({ enabled: false });
      const disabled = await schedule({ account: disabledAccount, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      imapManager.findUidByMessageId.mockRejectedValue(new Error('AUTHENTICATIONFAILED'));
      const sender = newSender({ maxInFlight: 10 });
      await tick(sender);
      await tick(sender);

      const down = await rowOf(imapDown.id);
      expect(down.status).toBe('sent');
      expect(resultOf(down)).toMatchObject({ sentCopySaved: false, sentCopyReason: 'sent_lookup_failed' });
      const off = await rowOf(disabled.id);
      expect(off.status).toBe('sent');
      expect(resultOf(off)).toMatchObject({ sentCopySaved: false, sentCopyReason: 'account_disabled' });
      // The account's next message went out once the accepted one was recorded.
      expect(await rowOf(waiting.id)).toMatchObject({ status: 'sent' });
      expect(h.sent.map(s => s.opts.messageId)).toEqual([waiting.messageId]);
    });

    it('takes over a send a restore left unclaimed, but never a live claim, not even at boot', async () => {
      const restored = await schedule({ state: { status: 'sending', claim_token: null, claimed_at: null, smtp_started_at: started, smtp_accepted_at: accepted } });
      const live = await schedule({ state: { status: 'sending', claim_token: randomUUID(), claimed_at: new Date(Date.now() - 2 * 60_000) } });
      imapManager.findUidByMessageId.mockResolvedValue(7);
      await tick(newSender());
      expect((await rowOf(restored.id)).status).toBe('sent');
      expect((await rowOf(live.id)).status).toBe('sending');
      // A process that just started takes nothing whose lease is still running.
      const booting = new ScheduledSender({ sleep: async () => {}, sentLookupDelaysMs: [0] });
      booting.running = true;
      booting.arm = () => {};
      await tick(booting);
      expect((await rowOf(live.id)).status).toBe('sending');
    });

    it('never lets another worker take a claim its process keeps refreshing, until it stops', async () => {
      const msg = await schedule();
      let release;
      behavior.set(msg.to, opts => new Promise(resolve => { release = () => resolve({ accepted: [opts.to], rejected: [] }); }));
      const owner = newSender();
      await owner.runTick();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const other = () => {
        const s = new ScheduledSender({ sleep: async () => {}, sentLookupDelaysMs: [0] });
        s.running = true;
        s.arm = () => {};
        return s;
      };
      // Long past the lease, but refreshed by the owner's heartbeat: neither a booting worker
      // nor a running one takes it.
      await h.pool.query("UPDATE scheduled_messages SET claimed_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [msg.id]);
      await owner.heartbeat();
      const refreshed = await rowOf(msg.id);
      expect(Date.now() - refreshed.claimed_at.getTime()).toBeLessThan(60_000);
      await tick(other());
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sending', claim_token: refreshed.claim_token });

      // The owner stops refreshing (its process hung): once the lease lapses, a worker takes
      // the claim over. The owner's own writes then change nothing, and recovery decides.
      await h.pool.query("UPDATE scheduled_messages SET claimed_at = NOW() - INTERVAL '4 minutes' WHERE id = $1", [msg.id]);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await tick(other());
      // The owner's next heartbeat finds its claim gone and says so.
      await owner.heartbeat();
      expect(errors.mock.calls.some(c => String(c[0]).includes(`message ${msg.id} lost its claim`))).toBe(true);
      release();
      await owner.idle();
      const row = await rowOf(msg.id);
      // Handed to SMTP, not found in Sent by the new claimant: uncertain, never sent again.
      expect(row).toMatchObject({ status: 'uncertain', failure_code: 'interrupted', smtp_accepted_at: null });
      expect(h.sendMail).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls.some(c => String(c[0]).includes(`message ${msg.id} was delivered after its claim was taken over`))).toBe(true);
      errors.mockRestore();
    });

    // A fake clock the sender's sleeps move on, so a wait of minutes takes no time.
    const clocked = (opts = {}) => {
      const clock = { now: 1_000_000 };
      const onSleep = opts.onSleep || (() => {});
      const sender = newSender({
        clock: () => clock.now,
        sleep: async ms => { clock.now += ms; await onSleep(clock.now - 1_000_000); },
        sentLookupDelaysMs: [0], folderWaitStepMs: 5000, ...opts.sender,
      });
      return { sender, clock };
    };

    it('after a restore, waits for the Sent folder (INBOX alone is not enough), then appends the copy once', async () => {
      const account = await newAccount({ folders: 'inbox' });
      const msg = await schedule({ account, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const waiting = await schedule({ account });
      let sleeps = 0;
      const { sender } = clocked({ onSleep: async () => { sleeps++; if (sleeps === 3) await addFolders(account); } });
      await tick(sender);
      const row = await rowOf(msg.id);
      expect(row.status).toBe('sent');
      expect(resultOf(row)).toMatchObject({ sentFolder: 'Sent', sentCopySaved: true });
      expect(resultOf(row).sentCopyReason).toBeUndefined();
      expect(imapManager.appendToSent.mock.calls.filter(c => messageIdHeader(c[2]) === msg.messageId)).toHaveLength(1);
      // Three waits for Sent, then the Sent lookup's own.
      expect(sleeps).toBe(4);
      // The account's next message waited, and goes out once the recovery is done.
      await tick(sender);
      expect(await rowOf(waiting.id)).toMatchObject({ status: 'sent' });
    });

    it('concludes there is no Sent folder only when its budget from the claim is spent', async () => {
      const account = await newAccount({ folders: 'inbox' });
      const msg = await schedule({ account, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      let waitedMs = 0;
      const { sender } = clocked({ onSleep: ms => { waitedMs = ms; }, sender: { recoveryBudgetMs: 60_000 } });
      await tick(sender);
      expect(waitedMs).toBe(60_000);
      const row = await rowOf(msg.id);
      expect(row.status).toBe('sent');
      expect(resultOf(row)).toMatchObject({ sentCopySaved: false, sentCopyReason: 'no_sent_folder' });
      expect(console.warn.mock.calls.filter(c => String(c[0]).includes(`message ${msg.id}: its account's Sent folder is not known yet`))).toHaveLength(1);
      // The default budget ends well inside the claim cap, with a stop's time to spare.
      const plain = new ScheduledSender();
      expect(plain.recoveryBudgetMs).toBe(15 * 60_000 - 150_000 - 60_000);
    });

    it('a message handed to SMTP is looked for in Sent once Sent is known, not left uncertain', async () => {
      const account = await newAccount({ folders: 'inbox' });
      const msg = await schedule({ account, state: left({ smtp_started_at: started }) });
      let synced = false;
      imapManager.findUidByMessageId.mockImplementation(async () => (synced ? 9 : null));
      const { sender } = clocked({ onSleep: async () => { if (!synced) { synced = true; await addFolders(account); } } });
      await tick(sender);
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sent' });
      expect(resultOf(await rowOf(msg.id))).toMatchObject({ sentCopySaved: true, recovered: true });
    });

    it('recoveries waiting for Sent do not take the slots of other accounts\' sends', async () => {
      const a = await newAccount({ folders: false });
      const b = await newAccount({ folders: false });
      const one = await schedule({ account: a, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const two = await schedule({ account: b, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const due = await schedule();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const sender = newSender({ maxInFlight: 2, sleep: () => gate, sentLookupDelaysMs: [0] });
      await sender.runTick();
      expect(sender.recovering.size).toBe(2);
      // The third account's due message is claimed and sent while both recoveries wait.
      while (sender.inFlight.size) await Promise.allSettled([...sender.inFlight.values()]);
      expect(await rowOf(due.id)).toMatchObject({ status: 'sent' });
      expect((await rowOf(one.id)).status).toBe('sending');
      await addFolders(a);
      await addFolders(b);
      release();
      await sender.idle();
      expect((await rowOf(one.id)).status).toBe('sent');
      expect((await rowOf(two.id)).status).toBe('sent');
    });

    it('a recovery whose claim was taken over during its wait makes no Sent copy', async () => {
      const account = await newAccount({ folders: 'inbox' });
      const msg = await schedule({ account, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const other = randomUUID();
      const { sender } = clocked({
        onSleep: async () => {
          await addFolders(account);
          await h.pool.query('UPDATE scheduled_messages SET claim_token = $2 WHERE id = $1', [msg.id, other]);
        },
      });
      await tick(sender);
      expect(imapManager.appendToSent).not.toHaveBeenCalled();
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sending', claim_token: other, sent_at: null });
    });

    it('stopping while it waits for Sent leaves the message to the next process', async () => {
      const account = await newAccount({ folders: false });
      const msg = await schedule({ account, state: left({ smtp_started_at: started, smtp_accepted_at: accepted }) });
      const sender = newSender({ sleep: async () => { sender.running = false; } });
      await tick(sender);
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sending', sent_at: null });
      expect(imapManager.appendToSent).not.toHaveBeenCalled();
    });

    it('fails a message whose sends keep stopping their process, instead of claiming it for ever', async () => {
      const msg = await schedule({ state: { status: 'sending', claim_token: randomUUID(), claimed_at: new Date(Date.now() - 3_600_000), attempts: 6 } });
      await tick(newSender());
      expect(await rowOf(msg.id)).toMatchObject({ status: 'failed', failure_code: 'gave_up' });
      expect(h.sendMail).not.toHaveBeenCalled();
    });

    it('lets a claimant that lost its claim change nothing', async () => {
      const msg = await schedule();
      const sender = newSender();
      const row = await sender.claimOne();
      // Recovery elsewhere took the claim away.
      await h.pool.query('UPDATE scheduled_messages SET claim_token = $2 WHERE id = $1', [msg.id, randomUUID()]);
      await sender.send(row);
      expect(h.sendMail).not.toHaveBeenCalled();
      expect((await rowOf(msg.id)).status).toBe('sending');
    });
  });

  describe('the overdue grace and late sends', () => {
    it('sends on Send now, however old the message the grace held', async () => {
      const held = await schedule({ sendAt: new Date(Date.now() - 7 * 3_600_000) });
      await tick(newSender());
      expect(await rowOf(held.id)).toMatchObject({ status: 'paused', pause_reason: 'overdue', attempts: 1 });
      // Send now (design 2.4): send_at and due_at are now, status scheduled.
      await h.pool.query("UPDATE scheduled_messages SET status = 'scheduled', pause_reason = NULL, send_at = NOW(), due_at = NOW() WHERE id = $1", [held.id]);
      await tick(newSender());
      expect(await rowOf(held.id)).toMatchObject({ status: 'sent', sent_late: false });

      // Resume (design 2.4): send_at and due_at now, attempts back to 0, the pause cleared.
      const resumed = await schedule({ sendAt: new Date(Date.now() - 7 * 3_600_000) });
      await tick(newSender());
      await h.pool.query(`UPDATE scheduled_messages SET status = 'scheduled', pause_reason = NULL, failure_code = NULL,
        attempts = 0, send_at = NOW(), due_at = NOW() WHERE id = $1`, [resumed.id]);
      await tick(newSender());
      const row = await rowOf(resumed.id);
      expect(row).toMatchObject({ status: 'sent', sent_late: false });
      expect(resultOf(row).lateReason).toBeUndefined();
    });

    it('holds a retry that falls due more than 6 h late, and says why without calling it offline', async () => {
      const msg = await schedule({ sendAt: new Date(Date.now() - (6 * 3_600_000 - 60_000)) });
      behavior.set(msg.to, () => { throw smtpError({ responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO' }, MAIL); });
      await tick(newSender());
      expect(await rowOf(msg.id)).toMatchObject({ status: 'scheduled', failure_code: 'smtp_temporary' });
      // The retry falls due after an outage, when the message is more than 6 h late.
      behavior.clear();
      await h.pool.query("UPDATE scheduled_messages SET due_at = NOW(), send_at = NOW() - INTERVAL '7 hours' WHERE id = $1", [msg.id]);
      await tick(newSender());
      expect(await rowOf(msg.id)).toMatchObject({ status: 'paused', pause_reason: 'overdue', attempts: 2 });
      expect(h.sendMail).toHaveBeenCalledTimes(1);
      expect(sendPushToUser).toHaveBeenCalledOnce();
      expect(sendPushToUser.mock.calls[0][1].body).toMatch(/more than 6 hours late/);
      // Resume sets send_at to now: it goes, and is not held again.
      await h.pool.query(`UPDATE scheduled_messages SET status = 'scheduled', pause_reason = NULL, failure_code = NULL,
        attempts = 0, send_at = NOW(), due_at = NOW() WHERE id = $1`, [msg.id]);
      await tick(newSender());
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sent', sent_late: false });
    });

    it('sends a retry within the grace, late because of the retry', async () => {
      const msg = await schedule({ sendAt: new Date(Date.now() - 60_000) });
      behavior.set(msg.to, () => { throw smtpError({ responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO' }, MAIL); });
      await tick(newSender());
      behavior.clear();
      await h.pool.query("UPDATE scheduled_messages SET due_at = NOW(), send_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [msg.id]);
      await tick(newSender());
      const row = await rowOf(msg.id);
      expect(row).toMatchObject({ status: 'sent', sent_late: true });
      expect(resultOf(row).lateReason).toBe('retried');
      expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('a send a crash cut off before SMTP is late because MailFlow was offline, and held past the grace', async () => {
      const left = { status: 'sending', claim_token: randomUUID(), claimed_at: new Date(Date.now() - 3_600_000), attempts: 1 };
      const recent = await schedule({ sendAt: new Date(Date.now() - 20 * 60_000), state: left });
      const old = await schedule({ sendAt: new Date(Date.now() - 7 * 3_600_000), state: { ...left, claim_token: randomUUID() } });
      const sender = newSender({ maxInFlight: 10 });
      await tick(sender);
      await tick(sender);
      const sent = await rowOf(recent.id);
      expect(sent).toMatchObject({ status: 'sent', sent_late: true });
      expect(resultOf(sent).lateReason).toBe('offline');
      expect(await rowOf(old.id)).toMatchObject({ status: 'paused', pause_reason: 'overdue' });
      expect(h.sent.map(m => m.opts.messageId)).toEqual([recent.messageId]);
      expect(sendPushToUser).toHaveBeenCalledOnce();
      expect(sendPushToUser.mock.calls[0][1].body).toMatch(/MailFlow was offline/);
    });

    it('calls a late first send offline only when it fell due before the sender started', async () => {
      const msg = await schedule({ sendAt: new Date(Date.now() - 20 * 60_000) });
      const sender = newSender();
      await tick(sender);
      expect(resultOf(await rowOf(msg.id)).lateReason).toBe('offline');
      // Due while the sender ran, and late only because it waited: delayed, not offline.
      const queued = await schedule({ sendAt: new Date(Date.now() - 20 * 60_000) });
      sender.startedAt = new Date(Date.now() - 3_600_000);
      await tick(sender);
      expect(resultOf(await rowOf(queued.id)).lateReason).toBe('delayed');
    });
  });

  describe('bookkeeping', () => {
    it('still makes the Sent copy and ends sent when recording the acceptance fails', async () => {
      const msg = await schedule();
      const db = {
        query: (text, params) => (text.includes('SET smtp_accepted_at = NOW()')
          ? Promise.reject(new Error('connection terminated'))
          : h.pool.query(text, params)),
        connect: () => h.pool.connect(),
      };
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await tick(newSender({ db }));
      expect(imapManager.appendToSent).toHaveBeenCalledOnce();
      expect(imapManager.upsertSentMessageRecord).toHaveBeenCalledOnce();
      expect(await rowOf(msg.id)).toMatchObject({ status: 'sent', smtp_accepted_at: null });
      const logged = errors.mock.calls.map(c => String(c[0])).filter(l => l.includes(msg.id));
      expect(logged).toEqual([expect.stringContaining('its acceptance could not be recorded')]);
      expect(logged[0]).not.toMatch(/@/);
      errors.mockRestore();
    });
  });

  describe('the tick', () => {
    it('costs one query on an empty table', async () => {
      const spy = vi.spyOn(h.pool, 'query');
      await newSender().runTick();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('stops claiming at once on stop, and waits for the send in flight', async () => {
      const first = await schedule();
      const second = await schedule();
      let release;
      behavior.set(first.to, opts => new Promise(resolve => { release = () => resolve({ accepted: [opts.to], rejected: [] }); }));
      const sender = newSender({ maxInFlight: 1 });
      await sender.runTick();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      let stopped = false;
      const stopping = sender.stop(10_000).then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect((await rowOf(first.id)).status).toBe('sent');
      expect((await rowOf(second.id)).status).toBe('scheduled');
    });

    it('logs a due message it cannot get to once, not every tick', async () => {
      const account = await newAccount();
      await schedule({ account, state: { status: 'sending', claim_token: randomUUID(), claimed_at: new Date() } });
      const blocked = await schedule({ account, sendAt: new Date(Date.now() - 10 * 60_000) });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const sender = newSender();
      await tick(sender);
      await tick(sender);
      const lines = errors.mock.calls.map(c => String(c[0])).filter(l => l.includes(blocked.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/@/);
      errors.mockRestore();
    });

    it('releases lapsed edit holds, pausing what fell due meanwhile, and purges what is past keeping', async () => {
      const lapsed = new Date(Date.now() - 60_000);
      const ahead = await schedule({ sendAt: new Date(Date.now() + 3_600_000), state: { status: 'editing', edit_token: randomUUID(), edit_lease_until: lapsed, status_before: 'scheduled' } });
      const due = await schedule({ sendAt: new Date(Date.now() - 600_000), state: { status: 'editing', edit_token: randomUUID(), edit_lease_until: lapsed, status_before: 'scheduled' } });
      const wasFailed = await schedule({ state: { status: 'editing', edit_token: randomUUID(), edit_lease_until: lapsed, status_before: 'failed', failure_code: 'smtp_rejected' } });
      const purged = await schedule({ state: { status: 'cancelled', purge_after: new Date(Date.now() - 1000) } });
      await tick(newSender());
      expect(await rowOf(ahead.id)).toMatchObject({ status: 'scheduled', edit_token: null, status_before: null });
      expect(await rowOf(due.id)).toMatchObject({ status: 'paused', pause_reason: 'edit_abandoned' });
      expect(await rowOf(wasFailed.id)).toMatchObject({ status: 'failed', failure_code: 'smtp_rejected' });
      expect(await rowOf(purged.id)).toBeUndefined();
      expect(h.sendMail).not.toHaveBeenCalled();
      expect(sendPushToUser).toHaveBeenCalledTimes(1);
      expect(sendPushToUser.mock.calls[0][1].body).toBe('Not sent: It was open for editing when it was due.');
    });

    it('does not purge a message a restore revived while the purge waited for it', async () => {
      const msg = await schedule({ state: { status: 'cancelled', status_before: 'scheduled', purge_after: new Date(Date.now() - 1000) } });
      const restoring = await h.pool.connect();
      try {
        // A restore that read the message inside its window, holding the row until it commits.
        await restoring.query('BEGIN');
        await restoring.query("UPDATE scheduled_messages SET status = 'scheduled', status_before = NULL, purge_after = NULL WHERE id = $1", [msg.id]);
        const purging = newSender().purge();
        // The purge has picked the row (its snapshot still sees it expired) and waits for its lock.
        for (let i = 0; i < 100; i++) {
          const { rows } = await h.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM scheduled_messages%'");
          if (rows.length) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await restoring.query('COMMIT');
        await purging;
      } finally {
        restoring.release();
      }
      expect(await rowOf(msg.id)).toMatchObject({ status: 'scheduled', purge_after: null });
    });
  });
});
