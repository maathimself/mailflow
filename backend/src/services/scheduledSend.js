import { createHash, randomUUID } from 'crypto';
import { pool, query } from './db.js';
import { decryptBytes, encryptBytes } from './encryption.js';
import { findOwnedAccount } from './ownership.js';
import { sanitizeSignature } from './emailSanitizer.js';
import {
  buildMailOptions, deliverAndRecord, prepareDelivery, renderRawMessage, sanitizeSmtpError, serverAutoSavesSent,
  validateSendInput,
} from './outgoingMail.js';
import { sendPushToUser } from './pushNotifications.js';
import { noteTick } from './scheduledSendStatus.js';
import {
  CLAIM_CAP_MS, HEARTBEAT_MS, LATE_AFTER_MS, LEASE_MS, MAX_ATTEMPTS, MAX_TICK_MS, RETRY_CODES, ScheduledSendError, afterFailure,
  classifySendError, lateness, nextTickDelay, pushFor, recoveryAction,
} from './scheduledSendRules.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { imapManager } from '../index.js';

// The scheduled sender (#543): finds due scheduled messages, claims them, and sends each through
// the same pipeline as Send (services/outgoingMail.js), so threading, the Sent copy, recipient
// learning and plugin hooks behave as for any send.
//
// At most once, never silently zero. A claim is a row in 'sending' with this process's
// claim_token, and every later update of the row names that token, so a claim that recovery or
// a restore took away can no longer change the outcome. smtp_started_at is written before the
// message is handed to SMTP and smtp_accepted_at the moment SMTP accepted it; recovery reads
// them in that order (scheduledSendRules.js recoveryAction): an accepted message is only ever
// recorded, one that may have gone out becomes uncertain, and only one that never reached SMTP
// is sent again. A retry follows only a failure that certainly left the message unsent.
//
// A claim is a lease: the process refreshes claimed_at of its sends in flight every
// HEARTBEAT_MS, and recovery takes over only a claim not refreshed for LEASE_MS, so a live send
// in another process is never taken, and one whose process died is picked up within minutes.
//
// One send per account at a time (enforced by idx_scheduled_account_sending), at most
// MAX_IN_FLIGHT per process. A tick with nothing to do is one indexed query.

const PURPOSE = 'scheduled-send';
export const CHUNK_BYTES = 1024 * 1024;
// The limits of design 1.4. The API checks them, the counts under a lock on the user's row.
export const LIMITS = Object.freeze({
  pending: 100, // scheduled, editing, paused, failed, uncertain
  storedBytes: 250 * 1024 * 1024,
  payloadBytes: 10 * 1024 * 1024,
  attachmentBytes: 26_214_400,
  minAheadMs: 60 * 1000,
  maxAheadMs: 366 * 24 * 60 * 60 * 1000,
  createsPerMinute: 30,
});
// What counts against the pending limit: every message not yet sent or deleted, one being sent
// too, as it may come back scheduled for a retry.
export const PENDING_STATUSES = ['scheduled', 'editing', 'sending', 'paused', 'failed', 'uncertain'];
const MAX_IN_FLIGHT = 2;
const SENT_PURGE_INTERVAL = '7 days';
// Like the Sent metadata upsert after an immediate send (outgoingMail.js): an auto-saving
// server can take a while to show the copy.
const SENT_LOOKUP_DELAYS_MS = [3000, 10000, 20000];
const SENT_LOOKUP_TIMEOUT_MS = 20000;
const APPEND_TIMEOUT_MS = 20000;
const PURGE_BATCH = 100;
const LAG_BATCH = 100;
// Long enough for the slowest send or recovery. A send: the token refresh, the 45 s SMTP
// failover budget, the 20 s APPEND bound and the render. The recovery of an accepted message is
// the longest, about 115 s: three Sent lookups after waits of 3, 10 and 20 s, each bounded at
// 20 s (93 s), then one APPEND bounded at 20 s, plus decrypting and rendering. It holds its
// account's next claim that long, and the heartbeat keeps its lease.
const QUIESCE_MS = 150 * 1000;
// Recovery after a restore can run before the first sync has stored the account's folders again
// (a restore does not carry the folders table), and a sync stores them one by one, so INBOX can be
// there before Sent. "No Sent folder" is only concluded when the Sent folder still cannot be
// resolved at the end of the recovery's budget: from its claim, the claim cap less the time a
// stop may take and a margin, so a recovery that waits can never outlast its claim. It checks
// every FOLDER_WAIT_STEP_MS. The account's other scheduled messages wait that long too (one send
// per account at a time); other accounts do not, since recoveries have slots of their own.
const FOLDER_WAIT_STEP_MS = 5000;
const RECOVERY_MARGIN_MS = 60 * 1000;
const RECOVERY_BUDGET_MS = CLAIM_CAP_MS - QUIESCE_MS - RECOVERY_MARGIN_MS;
// Recoveries in flight at once, apart from the sends (MAX_IN_FLIGHT): a recovery waiting for
// folders never takes a send's slot.
const MAX_RECOVERING = 5;

const ms = n => `${Math.round(n)} milliseconds`;
// A column set to the database's clock plus a delay, for settle(). Every due time comes from
// NOW(), as the claim compares it with NOW().
const nowPlus = delayMs => ({ nowPlusMs: delayMs });

// The additional data each encrypted value is bound to (design 1.2). With the version in it, a
// payload or chunk from an earlier edit cannot be put back under a later one, and chunks cannot
// be reordered or moved between messages.
export const aad = {
  summary: row => `scheduled:${row.id}:${row.user_id}:summary:${row.version}`,
  payload: row => `scheduled:${row.id}:${row.user_id}:payload:${row.version}`,
  result: row => `scheduled:${row.id}:${row.user_id}:result`,
  meta: (id, attachmentIndex, version) => `scheduled:${id}:att:${attachmentIndex}:meta:${version}`,
  chunk: (id, attachmentIndex, chunkIndex, version) => `scheduled:${id}:att:${attachmentIndex}:${chunkIndex}:${version}`,
};

export function sealJson(value, additional) {
  return encryptBytes(Buffer.from(JSON.stringify(value), 'utf8'), { purpose: PURPOSE, aad: additional });
}

// The value, or null when it is missing, does not decrypt here, or is not JSON.
export function openJson(stored, additional) {
  if (!stored) return null;
  const bytes = decryptBytes(stored, { purpose: PURPOSE, aad: additional });
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

// The rows of scheduled_message_attachments for a message's attachments, in send order, each cut
// into chunks of at most CHUNK_BYTES and encrypted on its own. `attachments` are
// { filename, contentType, disposition, kind, content: Buffer }.
export function attachmentRows(id, version, attachments) {
  const rows = [];
  attachments.forEach((att, attachmentIndex) => {
    const content = att.content;
    const meta = {
      filename: att.filename,
      contentType: att.contentType || 'application/octet-stream',
      disposition: att.disposition || null,
      kind: att.kind || 'upload',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    const chunks = Math.max(1, Math.ceil(content.length / CHUNK_BYTES));
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
      const data = content.subarray(chunkIndex * CHUNK_BYTES, (chunkIndex + 1) * CHUNK_BYTES);
      rows.push({
        attachment_index: attachmentIndex,
        chunk_index: chunkIndex,
        meta_enc: chunkIndex === 0 ? sealJson(meta, aad.meta(id, attachmentIndex, version)) : null,
        data_enc: encryptBytes(data, { purpose: PURPOSE, aad: aad.chunk(id, attachmentIndex, chunkIndex, version) }),
      });
    }
  });
  return rows;
}

// Stores a scheduled message, its payload and summary encrypted and its attachments chunked, on
// `client` (inside the caller's transaction). `id` may be given (the caller built the payload
// for it); otherwise one is made. The same clientKey again returns the row the first
// call made and stores nothing. Limits are the caller's to check. Resolves { id, created }.
export async function storeScheduledMessage(client, { id = randomUUID(), userId, accountId, clientKey, sendAt, timeZone = null, payload, summary, attachments = [] }) {
  const row = { id, user_id: userId, version: 1 };
  const payloadJson = Buffer.from(JSON.stringify(payload), 'utf8');
  const { rows } = await client.query(
    `INSERT INTO scheduled_messages
       (id, user_id, account_id, client_key, send_at, due_at, time_zone, summary_enc, payload_enc, payload_bytes, attachment_bytes)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id, client_key) DO NOTHING RETURNING id`,
    [id, userId, accountId, clientKey, sendAt, timeZone, sealJson(summary, aad.summary(row)),
      encryptBytes(payloadJson, { purpose: PURPOSE, aad: aad.payload(row) }), payloadJson.length,
      attachments.reduce((sum, a) => sum + a.content.length, 0)],
  );
  if (!rows.length) {
    const existing = await client.query('SELECT id FROM scheduled_messages WHERE user_id = $1 AND client_key = $2', [userId, clientKey]);
    return { id: existing.rows[0].id, created: false };
  }
  for (const chunk of attachmentRows(id, 1, attachments)) {
    await client.query(
      `INSERT INTO scheduled_message_attachments (scheduled_id, attachment_index, chunk_index, meta_enc, data_enc)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, chunk.attachment_index, chunk.chunk_index, chunk.meta_enc, chunk.data_enc],
    );
  }
  return { id, created: true };
}

export const headerSafe = value => String(value ?? '').replace(/[\r\n\0]/g, '').trim();

// A message's attachments, decrypted and put back together, each as { index, meta, content }
// with the meta stored with it ({ filename, contentType, disposition, kind, size, sha256 }).
// Throws ScheduledSendError('decrypt_failed') when any chunk is missing, out of order, does not
// decrypt, or the whole does not match the size and hash stored with it. `only` limits it to
// one attachment index.
export async function readAttachments(db, row, { only } = {}) {
  const { rows } = await db.query(
    `SELECT attachment_index, chunk_index, meta_enc, data_enc FROM scheduled_message_attachments
      WHERE scheduled_id = $1 AND ($2::int IS NULL OR attachment_index = $2) ORDER BY attachment_index, chunk_index`,
    [row.id, only ?? null],
  );
  const byIndex = new Map();
  for (const r of rows) {
    if (!byIndex.has(r.attachment_index)) byIndex.set(r.attachment_index, []);
    byIndex.get(r.attachment_index).push(r);
  }
  const out = [];
  let expected = only ?? 0;
  for (const [attachmentIndex, chunks] of byIndex) {
    if (attachmentIndex !== expected++) throw new ScheduledSendError('decrypt_failed');
    const meta = openJson(chunks[0].meta_enc, aad.meta(row.id, attachmentIndex, row.version));
    if (!meta) throw new ScheduledSendError('decrypt_failed');
    const parts = chunks.map((c, i) => {
      if (c.chunk_index !== i) throw new ScheduledSendError('decrypt_failed');
      const data = decryptBytes(c.data_enc, { purpose: PURPOSE, aad: aad.chunk(row.id, attachmentIndex, i, row.version) });
      if (!data) throw new ScheduledSendError('decrypt_failed');
      return data;
    });
    const content = Buffer.concat(parts);
    if (content.length !== meta.size || createHash('sha256').update(content).digest('hex') !== meta.sha256) {
      throw new ScheduledSendError('decrypt_failed');
    }
    out.push({ index: attachmentIndex, meta, content });
  }
  return out;
}

// The attachments of a row as mailOptions.attachments wants them.
export async function loadAttachments(db, row) {
  return (await readAttachments(db, row)).map(({ meta, content }) => ({
    filename: headerSafe(meta.filename) || 'attachment',
    content,
    contentType: headerSafe(meta.contentType) || 'application/octet-stream',
    ...(meta.disposition ? { contentDisposition: meta.disposition === 'inline' ? 'inline' : 'attachment' } : {}),
  }));
}

// The stored meta of each attachment, without reading or decrypting the data.
export async function attachmentMetas(db, row) {
  const { rows } = await db.query(
    `SELECT attachment_index, meta_enc FROM scheduled_message_attachments
      WHERE scheduled_id = $1 AND chunk_index = 0 ORDER BY attachment_index`,
    [row.id],
  );
  return rows.map(r => {
    const meta = openJson(r.meta_enc, aad.meta(row.id, r.attachment_index, row.version));
    return meta && { index: r.attachment_index, filename: meta.filename, contentType: meta.contentType, size: meta.size, kind: meta.kind };
  });
}

// Replaces a row's content on `client` (inside the caller's transaction) under the next
// version: the payload, the summary and every attachment are encrypted again, so nothing of an
// earlier version can be put back under the new one. `attachments` are, as for
// storeScheduledMessage, { filename, contentType, disposition, kind, content }. Resolves the new
// version.
export async function replaceContent(client, row, { payload, summary, attachments }) {
  const version = row.version + 1;
  const next = { id: row.id, user_id: row.user_id, version };
  const payloadJson = Buffer.from(JSON.stringify(payload), 'utf8');
  await client.query(
    `UPDATE scheduled_messages
        SET version = $2, payload_enc = $3, summary_enc = $4, payload_bytes = $5, attachment_bytes = $6, updated_at = NOW()
      WHERE id = $1`,
    [row.id, version, encryptBytes(payloadJson, { purpose: PURPOSE, aad: aad.payload(next) }),
      sealJson(summary, aad.summary(next)), payloadJson.length, attachments.reduce((sum, a) => sum + a.content.length, 0)],
  );
  await client.query('DELETE FROM scheduled_message_attachments WHERE scheduled_id = $1', [row.id]);
  for (const chunk of attachmentRows(row.id, version, attachments)) {
    await client.query(
      `INSERT INTO scheduled_message_attachments (scheduled_id, attachment_index, chunk_index, meta_enc, data_enc)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, chunk.attachment_index, chunk.chunk_index, chunk.meta_enc, chunk.data_enc],
    );
  }
  return version;
}

export class ScheduledSender {
  constructor({
    db = { query: (text, params) => query(text, params), connect: () => pool.connect() },
    imap = () => imapManager,
    push = sendPushToUser,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
    sentLookupDelaysMs = SENT_LOOKUP_DELAYS_MS,
    maxInFlight = MAX_IN_FLIGHT,
    folderWaitStepMs = FOLDER_WAIT_STEP_MS,
    recoveryBudgetMs = RECOVERY_BUDGET_MS,
    maxRecovering = MAX_RECOVERING,
    clock = () => Date.now(),
  } = {}) {
    this.folderWaitStepMs = folderWaitStepMs;
    this.recoveryBudgetMs = recoveryBudgetMs;
    this.maxRecovering = maxRecovering;
    this.clock = clock;
    // claim token -> promise: the recoveries in flight, kept apart from the sends' slots.
    this.recovering = new Map();
    this.db = db;
    this.imap = imap;
    this.push = push;
    this.sleep = sleep;
    this.sentLookupDelaysMs = sentLookupDelaysMs;
    this.maxInFlight = maxInFlight;
    this.running = false;
    this.timer = null;
    this.ticking = null;
    this.tickAgain = false;
    this.startedAt = null; // the database's clock at this sender's first tick
    this.inFlight = new Map(); // claim token -> promise
    // claim token -> { id, at }: the claims the heartbeat refreshes, until each is settled
    this.leases = new Map();
    this.heartbeatTimer = null;
    this.lagLogged = new Set();
  }

  // Starts the ticks. The first one recovers what a previous process left in 'sending' with a
  // lapsed lease, before it claims anything.
  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => { this.heartbeat(); }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    this.arm(0);
  }

  // Stops claiming at once, then waits up to `timeoutMs` for the sends in flight to finish. A
  // send cut off later is left to recovery.
  async stop(timeoutMs = QUIESCE_MS) {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([
        (async () => {
          await this.ticking;
          await this.idle();
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      // The leases of sends still in flight lapse from here, and recovery takes them over.
      if (!this.running) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }
  }

  // Refreshes the lease of every send this process has in flight. A claim that is gone was
  // taken over (recovery elsewhere, a restore): the send's own writes name its token and change
  // nothing, so all that is left is to say so.
  //
  // A send still in flight CLAIM_CAP_MS after its claim is stuck past any budget it has (a hung
  // connection): its claim is no longer refreshed, so recovery settles the message (uncertain if
  // it reached SMTP) and frees the account, and its slot here is given up. Its own writes, if it
  // ever wakes, name a token that is gone and change nothing.
  async heartbeat() {
    const now = Date.now();
    for (const [token, lease] of this.leases) {
      if (now - lease.at <= CLAIM_CAP_MS) continue;
      this.leases.delete(token);
      this.inFlight.delete(token);
      this.recovering.delete(token);
      console.error(`[scheduledSend] message ${lease.id} has been in flight for more than ${CLAIM_CAP_MS / 60000} min; its claim is left to lapse for recovery`);
    }
    const tokens = [...this.leases.keys()];
    if (!tokens.length) return;
    try {
      const { rows } = await this.db.query(
        `UPDATE scheduled_messages SET claimed_at = NOW()
          WHERE claim_token = ANY($1::uuid[]) AND status = 'sending' RETURNING claim_token`,
        [tokens],
      );
      const kept = new Set(rows.map(r => r.claim_token));
      for (const token of tokens) {
        if (kept.has(token) || !this.leases.has(token)) continue;
        console.error(`[scheduledSend] message ${this.leases.get(token).id} lost its claim while this process was sending it; its outcome is left to the new claimant`);
      }
    } catch (err) {
      console.error('[scheduledSend] could not refresh the claims in flight:', err.message);
    }
  }

  // Looks for due messages now, for a caller that just made one due.
  nudge() {
    if (this.running) this.arm(0);
  }

  get inFlightCount() {
    return this.inFlight.size;
  }

  arm(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, delay);
    this.timer.unref?.();
  }

  tick() {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = this.runTick()
      .catch(err => {
        console.error('[scheduledSend] tick failed:', err.message);
        return MAX_TICK_MS;
      })
      .then(delay => {
        this.ticking = null;
        if (!this.running) return;
        const again = this.tickAgain;
        this.tickAgain = false;
        this.arm(again ? 0 : delay);
      });
    return this.ticking;
  }

  // One pass. Resolves the delay until the next one.
  async runTick() {
    // Everything the tick needs to know, in one statement on the partial indexes, so an empty
    // table costs one query. Recovery takes only sends whose lease ran out (their process
    // stopped refreshing it), never a live claim and never this process's own.
    const cutoff = ms(LEASE_MS);
    const own = [...this.leases.keys()];
    const { rows: [state] } = await this.db.query(
      `SELECT NOW() AS now,
              (SELECT MIN(due_at) FROM scheduled_messages WHERE status = 'scheduled') AS next_due,
              EXISTS (SELECT 1 FROM scheduled_messages
                       WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < NOW() - $1::interval)
                         AND (claim_token IS NULL OR NOT claim_token = ANY($2::uuid[]))) AS stale,
              EXISTS (SELECT 1 FROM scheduled_messages WHERE status = 'editing' AND edit_lease_until < NOW()) AS lapsed,
              EXISTS (SELECT 1 FROM scheduled_messages WHERE purge_after < NOW()) AS purgeable`,
      [cutoff, own],
    );
    this.startedAt ??= new Date(state.now);
    const now = new Date(state.now).getTime();
    let nextDue = state.next_due ? new Date(state.next_due).getTime() : null;
    // A send recovery or a lapsed edit put back is due at once.
    if (state.stale && await this.recoverStale(cutoff)) nextDue = now;
    if (state.lapsed && await this.releaseLapsedEdits()) nextDue = now;
    if (state.purgeable) await this.purge();

    let claimed = 0;
    if (nextDue != null && nextDue <= now) {
      // A claim another scheduler won for the same account at the same moment ends nothing but
      // that claim: the next one skips that account and goes on with the others.
      let conflicts = 0;
      while (this.running && this.inFlight.size < this.maxInFlight && conflicts < 5) {
        const row = await this.claimOne();
        if (row === CONFLICT) { conflicts++; continue; }
        if (!row) break;
        claimed++;
        this.track(row.claim_token, this.send(row), row.id);
      }
      if (nextDue < now - LATE_AFTER_MS) await this.logLag();
      if (claimed) {
        const { rows: [next] } = await this.db.query(
          "SELECT NOW() AS now, MIN(due_at) AS next_due FROM scheduled_messages WHERE status = 'scheduled'");
        nextDue = next.next_due ? new Date(next.next_due).getTime() : null;
        noteTick(new Date(next.now));
        return nextTickDelay(nextDue, new Date(next.now).getTime());
      }
    }
    noteTick(new Date(state.now));
    return nextTickDelay(nextDue, now);
  }

  // A send (in one of the maxInFlight slots) or, with `recovery`, a recovery (in recovering, which
  // the sends' slots do not count). The heartbeat refreshes the claim of either, and stop()
  // waits for both.
  track(token, promise, id = null, { recovery = false } = {}) {
    const slots = recovery ? this.recovering : this.inFlight;
    const tracked = promise
      .catch(err => console.error('[scheduledSend] send failed unexpectedly:', err.message))
      .finally(() => {
        slots.delete(token);
        this.leases.delete(token);
        // A slot is free, and an account may be free again.
        this.nudge();
      });
    slots.set(token, tracked);
    this.leases.set(token, { id, at: Date.now() });
    return tracked;
  }

  // Resolves once no send and no recovery of this process is in flight.
  async idle() {
    while (this.inFlight.size || this.recovering.size) {
      await Promise.allSettled([...this.inFlight.values(), ...this.recovering.values()]);
    }
  }

  // Claims the next due message of an account with no send in flight, or null. Two schedulers
  // never get the same row (SKIP LOCKED), and two that claim for one account at the same moment
  // cannot both succeed (idx_scheduled_account_sending): the loser gets CONFLICT. Only the
  // account's earliest due message can be claimed (due_at, then id), so a row another scheduler
  // has locked holds its later ones back, and an account's messages go out in due order. That
  // check reads the account's rows through idx_scheduled_account: at most its pending messages
  // and those kept for a few days after sending.
  async claimOne() {
    const token = randomUUID();
    try {
      const { rows } = await this.db.query(
        `WITH due AS (
           SELECT s.id FROM scheduled_messages s
            WHERE s.status = 'scheduled' AND s.due_at <= NOW()
              AND NOT EXISTS (SELECT 1 FROM scheduled_messages x WHERE x.account_id = s.account_id AND x.status = 'sending')
              AND NOT EXISTS (SELECT 1 FROM scheduled_messages e
                               WHERE e.account_id = s.account_id AND e.status = 'scheduled'
                                 AND (e.due_at, e.id) < (s.due_at, s.id))
            ORDER BY s.due_at, s.id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE scheduled_messages s
            SET status = 'sending', claim_token = $1, claimed_at = NOW(), attempts = s.attempts + 1,
                smtp_started_at = NULL, updated_at = NOW()
           FROM due WHERE s.id = due.id
         RETURNING s.*, EXTRACT(EPOCH FROM NOW() - s.send_at) * 1000 AS lag_ms,
                   (s.attempts = 1 AND s.due_at = s.send_at) AS first_attempt,
                   s.send_at < $2::timestamptz AS due_before_start`,
        [token, this.startedAt ?? new Date()],
      );
      const row = rows[0];
      if (!row) return null;
      // failure_code is still the last attempt's: set by a backoff retry, it is why this is late.
      // Its time is send_at, not due_at: recovery puts a send a crash cut off back due at once,
      // and it is late because MailFlow was down.
      Object.assign(row, lateness({
        lagMs: Number(row.lag_ms), dueBeforeStart: row.due_before_start,
        retried: !row.first_attempt && RETRY_CODES.has(row.failure_code),
      }));
      this.changed(row, 'sending');
      return row;
    } catch (err) {
      if (err.code === '23505') return CONFLICT;
      throw err;
    }
  }

  // A row of this claim, updated only while the claim is still ours. A value made by nowPlus()
  // is the database's clock plus that delay.
  async settle(row, fields) {
    const entries = Object.entries(fields);
    const sets = entries.map(([k, v], i) => (v?.nowPlusMs !== undefined ? `${k} = NOW() + $${i + 3}::interval` : `${k} = $${i + 3}`));
    const { rowCount } = await this.db.query(
      `UPDATE scheduled_messages SET ${sets.join(', ')},
              claim_token = NULL, claimed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
      [row.id, row.claim_token, ...entries.map(([, v]) => (v?.nowPlusMs !== undefined ? ms(v.nowPlusMs) : v))],
    );
    // Settled: the claim is gone, and the heartbeat must not look for it any more.
    if (rowCount) this.leases.delete(row.claim_token);
    return rowCount > 0;
  }

  async send(row) {
    if (row.overdue) {
      return this.end(row, { outcome: 'paused', pauseReason: 'overdue', code: 'overdue' },
        { code: 'overdue', offline: row.lateReason === 'offline' });
    }
    const account = await findOwnedAccount(row.user_id, row.account_id, { client: this.db });
    if (!account) return this.end(row, { outcome: 'failed', code: 'account_missing' });
    if (!account.enabled) return this.end(row, { outcome: 'paused', pauseReason: 'account_disabled', code: 'account_disabled' });

    let built, delivery;
    // The Date is the time of this attempt, and smtp_started_at records it, so a Sent copy
    // recovery has to make later carries the same Date as the delivered message.
    const date = new Date();
    try {
      built = await this.build(row, account);
      delivery = await prepareDelivery(built.input, built.identity, built.forwarded, {
        messageId: built.payload.messageId, date, smtp: { trackStage: true },
      });
    } catch (err) {
      return this.afterError(row, err, 'prepare');
    }

    const started = await this.db.query(
      `UPDATE scheduled_messages SET smtp_started_at = $3, updated_at = NOW()
        WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
      [row.id, row.claim_token, date],
    );
    // Recovery or a restore took the claim away: never send.
    if (!started.rowCount) return null;

    let result;
    // Recipients the server deferred (4xx at RCPT) while it took the message for the others. The
    // message went out, so it is not retried; the sent notice lists them (design 3.4).
    let deferred = [];
    try {
      result = await deliverAndRecord(
        { userId: row.user_id, input: built.input, identity: built.identity, delivery },
        {
          // Never throws: a failure to record the acceptance must not skip the bookkeeping that
          // follows (recipients, the Sent copy, the Sent row). The message then still ends sent
          // through markSent, or, if that fails too, through recovery, which finds its Sent copy.
          onDelivered: async (_early, { refusals = [] } = {}) => {
            deferred = refusals.filter(r => r.responseCode >= 400 && r.responseCode < 500).map(r => r.recipient);
            try {
              const accepted = await this.db.query(
                'UPDATE scheduled_messages SET smtp_accepted_at = NOW(), updated_at = NOW() WHERE id = $1 AND claim_token = $2',
                [row.id, row.claim_token],
              );
              if (!accepted.rowCount) console.error(`[scheduledSend] message ${row.id} was delivered after its claim was taken over`);
            } catch (err) {
              console.error(`[scheduledSend] message ${row.id} was delivered, but its acceptance could not be recorded: ${err.message}`);
            }
          },
        },
      );
    } catch (err) {
      return this.afterError(row, err, 'send');
    }
    return this.markSent(row, {
      sentFolder: result.sentFolder ?? null,
      messageId: result.messageId ?? built.payload.messageId,
      // false when our APPEND failed; otherwise whether there is a Sent folder for the copy.
      sentCopySaved: result.sentCopySaved === false ? false : !!result.sentFolder,
      ...refusedOnly(result.rejected, deferred),
      ...(deferred.length ? { deferred } : {}),
      ...(row.lateReason ? { lateReason: row.lateReason } : {}),
    }, row.late === true);
  }

  // The payload, the send input, the identity and the stored attachments of a row. The sender
  // never fetches forwarded content: it was stored at schedule time (open question 12).
  async build(row, account) {
    const payload = openJson(row.payload_enc, aad.payload(row));
    if (!payload || payload.v !== 1) throw new ScheduledSendError('decrypt_failed');
    // Stored data is still input, so it goes through the same checks as Send's.
    const input = validateSendInput({
      accountId: row.account_id,
      aliasId: payload.aliasId || undefined,
      to: payload.to,
      cc: payload.cc ?? [],
      bcc: payload.bcc ?? [],
      subject: payload.subject,
      body: payload.body ?? '',
      bodyIsHtml: payload.bodyIsHtml === true,
      quotedBody: payload.quotedBody,
      quotedBodyHtml: payload.quotedBodyHtml,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      priority: payload.priority,
    });
    const identity = await this.identityFor(account, payload);
    const attachments = await loadAttachments(this.db, row);
    return { payload, input, identity, forwarded: { attachments, messages: [] } };
  }

  // From is read at send time; the signature and the plain-text choice are what the composer
  // showed at schedule time (design 3.6). An alias that is gone fails the message: sending from
  // the account address would be another identity than the one the user picked (open question 13).
  async identityFor(account, payload) {
    let fromName = account.sender_name || account.name;
    let fromEmail = account.email_address;
    let replyTo = null;
    if (payload.aliasId) {
      const { rows } = await this.db.query(
        'SELECT name, email, reply_to FROM account_aliases WHERE id = $1 AND account_id = $2',
        [payload.aliasId, account.id],
      );
      if (!rows.length) throw new ScheduledSendError('alias_missing');
      fromName = rows[0].name;
      fromEmail = rows[0].email;
      replyTo = rows[0].reply_to || null;
    }
    return {
      account,
      plaintextEmail: payload.plaintextEmail === true,
      fromName,
      fromEmail,
      replyTo,
      signature: payload.signature ? sanitizeSignature(payload.signature) : null,
    };
  }

  afterError(row, err, phase) {
    const decision = afterFailure(classifySendError(err, { phase }), row.attempts);
    const smtp = err?.cause ?? err;
    const detail = {
      code: decision.code,
      ...(decision.lastCode ? { lastCode: decision.lastCode } : {}),
      error: err?.publicMessage
        || (err?.name === 'SendError' || err instanceof ScheduledSendError ? err.message : sanitizeSmtpError(smtp || {})),
      ...(typeof smtp?.response === 'string' ? { smtpResponse: smtp.response.slice(0, 500) } : {}),
      ...(smtp?.command ? { command: String(smtp.command) } : {}),
    };
    console.warn(`[scheduledSend] message ${row.id} attempt ${row.attempts}: ${decision.outcome} (${decision.code})`);
    return this.end(row, decision, detail);
  }

  // Ends this attempt as `decision` says: a retry later, or failed, paused or uncertain.
  async end(row, decision, detail = { code: decision.code }) {
    const result = sealJson(detail, aad.result(row));
    if (decision.outcome === 'retry') {
      const ok = await this.settle(row, {
        status: 'scheduled', due_at: nowPlus(decision.delayMs), smtp_started_at: null,
        failure_code: decision.code, result_enc: result,
      });
      if (ok) this.changed(row, 'scheduled');
      return ok;
    }
    const fields = {
      failed: { status: 'failed', failure_code: decision.code, result_enc: result, smtp_started_at: null },
      paused: { status: 'paused', pause_reason: decision.pauseReason, failure_code: decision.code, result_enc: result, smtp_started_at: null },
      // smtp_started_at stays: it is the evidence that the message may have gone out.
      uncertain: { status: 'uncertain', failure_code: decision.code, result_enc: result },
    }[decision.outcome];
    const ok = await this.settle(row, fields);
    if (ok) {
      this.changed(row, fields.status);
      await this.notify(row, fields.status, { failureCode: decision.code, pauseReason: decision.pauseReason, offline: detail.offline === true });
    }
    return ok;
  }

  // Records the message as sent and deletes its content, in one transaction (design 1.5). The
  // result stays, encrypted, for a client that was offline to learn the outcome.
  async markSent(row, result, late) {
    const client = await this.db.connect();
    let ok;
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE scheduled_messages
            SET status = 'sent', sent_at = NOW(), sent_late = $3, result_enc = $4, payload_enc = NULL,
                summary_enc = NULL, failure_code = NULL, purge_after = NOW() + $5::interval,
                claim_token = NULL, claimed_at = NULL, updated_at = NOW()
          WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
        [row.id, row.claim_token, late, sealJson({ ok: true, ...result }, aad.result(row)), SENT_PURGE_INTERVAL],
      );
      if (rowCount) await client.query('DELETE FROM scheduled_message_attachments WHERE scheduled_id = $1', [row.id]);
      await client.query('COMMIT');
      ok = rowCount > 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (ok) {
      this.leases.delete(row.claim_token);
      this.changed(row, 'sent');
    }
    return ok;
  }

  // Sends left in 'sending' by a process that stopped (or by a restore, which leaves them
  // unclaimed), each taken over with a new token first so the old claimant can change nothing.
  async recoverStale(cutoff) {
    const { rows } = await this.db.query(
      `SELECT id, claim_token FROM scheduled_messages
        WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at < NOW() - $1::interval)
          AND (claim_token IS NULL OR NOT claim_token = ANY($2::uuid[]))
        ORDER BY claimed_at NULLS FIRST LIMIT 20`,
      [cutoff, [...this.leases.keys()]],
    );
    let rescheduled = 0;
    for (const stale of rows) {
      // Recoveries have slots of their own; the rest wait for a later tick, still stale.
      if (this.recovering.size >= this.maxRecovering) break;
      const token = randomUUID();
      const { rows: [row] } = await this.db.query(
        `UPDATE scheduled_messages SET claim_token = $3, claimed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'sending' AND claim_token IS NOT DISTINCT FROM $2
            AND (claimed_at IS NULL OR claimed_at < NOW() - $4::interval)
         RETURNING *`,
        [stale.id, stale.claim_token, token, cutoff],
      );
      if (!row) continue;
      const action = recoveryAction(row);
      console.warn(`[scheduledSend] recovering message ${row.id}: ${action}`);
      if (action === 'reschedule' && row.attempts >= MAX_ATTEMPTS) {
        // A message whose sends keep stopping their process is not claimed for ever.
        await this.end(row, { outcome: 'failed', code: 'gave_up', lastCode: 'interrupted' });
      } else if (action === 'reschedule') {
        if (await this.settle(row, { status: 'scheduled', due_at: nowPlus(0), smtp_started_at: null })) {
          this.changed(row, 'scheduled');
          rescheduled++;
        }
      } else {
        // Its budget runs from this claim (awaitSentFolder).
        row.recoveryClaimedAt = this.clock();
        this.track(token, action === 'finish_accepted' ? this.finishAccepted(row) : this.checkSent(row), row.id, { recovery: true });
      }
    }
    return rescheduled;
  }

  // Looks for the message in the account's Sent folder, as the immediate send's metadata upsert
  // does, a few times. Resolves the uid or null; throws when the lookup itself cannot run.
  async findInSent(account, sentFolder, messageId) {
    for (const delay of this.sentLookupDelaysMs) {
      await this.sleep(delay);
      const uid = await withTimeout(
        this.imap().findUidByMessageId(account, sentFolder, messageId), SENT_LOOKUP_TIMEOUT_MS, 'Sent lookup timed out');
      if (uid) return uid;
    }
    return null;
  }

  // The account's Sent folder, waited for (see RECOVERY_BUDGET_MS): right after a restore, or
  // during a sync that stored INBOX but not Sent yet, it cannot be resolved although it exists.
  // Says so once. Resolves { path } (null once the budget, counted from the recovery's claim, is
  // spent: then there is no Sent folder), or { stopped: true } when the sender is stopping: the row
  // is left as it is, its claim lapses, and the next process recovers it.
  async awaitSentFolder(row, account) {
    const deadline = (row.recoveryClaimedAt ?? this.clock()) + this.recoveryBudgetMs;
    let waited = false;
    for (;;) {
      const path = await resolveSentFolder(account.id, account.folder_mappings);
      if (path) return { path };
      if (this.clock() + this.folderWaitStepMs > deadline) {
        if (waited) console.warn(`[scheduledSend] message ${row.id}: still no Sent folder for its account; recovering without one`);
        return { path: null };
      }
      if (!this.running) return { stopped: true };
      if (!waited) {
        console.warn(`[scheduledSend] message ${row.id}: its account's Sent folder is not known yet (folders not synced); waiting for it`);
        waited = true;
      }
      await this.sleep(this.folderWaitStepMs);
    }
  }

  // Whether this recovery still holds its claim: a long wait may have outlived it, and another
  // claimant then decides. Checked right before the APPEND, which cannot be taken back.
  async stillClaimed(row) {
    const { rows } = await this.db.query(
      "SELECT 1 FROM scheduled_messages WHERE id = $1 AND claim_token = $2 AND status = 'sending'", [row.id, row.claim_token]);
    return rows.length > 0;
  }

  // SMTP accepted it, and the process stopped during the bookkeeping. This always ends 'sent':
  // when the Sent copy cannot be checked or made (IMAP down, the account turned off or needing
  // a new sign-in), sentCopySaved is false and the reason is in the result. It is never sent again.
  async finishAccepted(row) {
    const result = { sentFolder: null, messageId: null, sentCopySaved: false, recovered: true };
    try {
      const account = await findOwnedAccount(row.user_id, row.account_id, { client: this.db });
      if (!account) throw new ScheduledSendError('account_missing');
      if (!account.enabled) throw new ScheduledSendError('account_disabled');
      const built = await this.build(row, account);
      result.messageId = built.payload.messageId;
      const found = await this.awaitSentFolder(row, account);
      // Stopping while it waits: left to the next process, which waits again.
      if (found.stopped) return false;
      const sentFolder = found.path;
      if (!sentFolder) throw new ScheduledSendError('no_sent_folder');
      result.sentFolder = sentFolder;
      const uid = await this.findInSent(account, sentFolder, built.payload.messageId);
      if (uid) {
        result.sentCopySaved = true;
      } else if (serverAutoSavesSent(account)) {
        throw new ScheduledSendError('not_in_sent');
      } else {
        const mailOptions = buildMailOptions(built.input, built.identity, built.forwarded, {
          messageId: built.payload.messageId, date: new Date(row.smtp_started_at),
        });
        const raw = await renderRawMessage(mailOptions);
        // Not ours any more (taken over after a long wait): the new claimant makes the copy.
        if (!(await this.stillClaimed(row))) {
          console.warn(`[scheduledSend] message ${row.id} lost its claim during recovery; its Sent copy is left to the new claimant`);
          return false;
        }
        // Exactly once, as for any send: APPEND is not idempotent, so it is not retried.
        await withTimeout(this.imap().appendToSent(account, sentFolder, raw), APPEND_TIMEOUT_MS, 'Sent APPEND timed out');
        result.sentCopySaved = true;
      }
    } catch (err) {
      result.sentCopyReason = err instanceof ScheduledSendError ? err.scheduledCode : 'sent_lookup_failed';
      console.warn(`[scheduledSend] message ${row.id} was delivered; its Sent copy: ${result.sentCopyReason}`);
    }
    const late = row.smtp_accepted_at && new Date(row.smtp_accepted_at) - new Date(row.send_at) > LATE_AFTER_MS;
    if (late) result.lateReason = 'delayed';
    return this.markSent(row, result, !!late);
  }

  // Handed to SMTP without an answer recorded: sent if its copy is in Sent, otherwise uncertain,
  // for the user to decide. Never sent again automatically.
  async checkSent(row) {
    let found = null;
    try {
      const payload = openJson(row.payload_enc, aad.payload(row));
      const account = await findOwnedAccount(row.user_id, row.account_id, { client: this.db });
      if (payload?.messageId && account?.enabled) {
        // A copy a lookup would find must not end uncertain because Sent was not known yet.
        const waited = await this.awaitSentFolder(row, account);
        if (waited.stopped) return false;
        const sentFolder = waited.path;
        if (sentFolder && await this.findInSent(account, sentFolder, payload.messageId)) {
          found = { sentFolder, messageId: payload.messageId };
        }
      }
    } catch (err) {
      console.warn(`[scheduledSend] message ${row.id}: Sent lookup failed: ${err.message}`);
    }
    if (found) return this.markSent(row, { ...found, sentCopySaved: true, recovered: true }, false);
    return this.end(row, { outcome: 'uncertain', code: 'interrupted' });
  }

  // Edit holds whose composer went away (design 2.3): back to what they were, or, for a message
  // that fell due meanwhile, paused, so it is never sent without the user confirming it.
  async releaseLapsedEdits() {
    const { rows } = await this.db.query(
      `UPDATE scheduled_messages
          SET status = CASE WHEN status_before IN ('paused', 'failed', 'uncertain') THEN status_before
                            WHEN send_at > NOW() THEN 'scheduled' ELSE 'paused' END,
              pause_reason = CASE WHEN status_before IN ('paused', 'failed', 'uncertain') THEN pause_reason
                                  WHEN send_at > NOW() THEN NULL ELSE 'edit_abandoned' END,
              due_at = CASE WHEN status_before IN ('paused', 'failed', 'uncertain') THEN due_at ELSE send_at END,
              edit_token = NULL, edit_lease_until = NULL, status_before = NULL, updated_at = NOW()
        WHERE status = 'editing' AND edit_lease_until < NOW()
        RETURNING id, user_id, version, status, pause_reason, summary_enc, send_at, time_zone`,
    );
    for (const row of rows) {
      this.changed(row, row.status);
      if (row.pause_reason === 'edit_abandoned') await this.notify(row, 'paused', { pauseReason: 'edit_abandoned' });
    }
    return rows.some(row => row.status === 'scheduled');
  }

  // The condition is checked again on each row as it is deleted: a restore (the Undo of a delete)
  // that revived a row after the batch was picked, but before it was deleted, keeps it.
  async purge() {
    await this.db.query(
      `DELETE FROM scheduled_messages WHERE id IN (
         SELECT id FROM scheduled_messages WHERE purge_after < NOW() LIMIT ${PURGE_BATCH})
         AND purge_after < NOW()`,
    );
  }

  // Due messages not claimed for more than LATE_AFTER_MS while the sender runs: it is lagging
  // or stuck, which must not pass silently. Logged once per message.
  async logLag() {
    const { rows } = await this.db.query(
      `SELECT id, EXTRACT(EPOCH FROM NOW() - due_at)::int AS lag FROM scheduled_messages
        WHERE status = 'scheduled' AND due_at < NOW() - $1::interval ORDER BY due_at LIMIT ${LAG_BATCH}`,
      [ms(LATE_AFTER_MS)],
    );
    const current = new Set(rows.map(r => r.id));
    for (const r of rows) {
      if (this.lagLogged.has(r.id)) continue;
      console.error(`[scheduledSend] message ${r.id} has been due for ${Math.round(r.lag / 60)} min and is not sent yet`);
    }
    this.lagLogged = current;
  }

  // Every state change reaches the user's tabs, with nothing of the message in it.
  changed(row, status) {
    try {
      this.imap().broadcast({ type: 'scheduled_changed', id: row.id, status }, row.user_id);
    } catch (err) {
      console.warn('[scheduledSend] broadcast failed:', err.message);
    }
  }

  // A push for a message that needs the user: failed, paused or uncertain.
  async notify(row, status, { failureCode, pauseReason, offline = false } = {}) {
    const summary = openJson(row.summary_enc, aad.summary(row));
    const payload = pushFor({
      id: row.id, status, failureCode, pauseReason,
      subject: typeof summary?.subject === 'string' ? summary.subject : null,
      sendAt: new Date(row.send_at), timeZone: row.time_zone, offline,
    });
    try {
      await this.push(row.user_id, payload);
    } catch (err) {
      console.warn('[scheduledSend] push failed:', err.message);
    }
  }
}

// The recipients the server refused for good, apart from the ones it only deferred.
function refusedOnly(rejected = [], deferred = []) {
  const refused = rejected.filter(r => !deferred.includes(r));
  return refused.length ? { rejected: refused } : {};
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

const CONFLICT = Symbol('claim conflict');

export const scheduledSender = new ScheduledSender();
export const startScheduledSender = () => scheduledSender.start();
export const stopScheduledSender = timeoutMs => scheduledSender.stop(timeoutMs);
export const nudgeScheduledSender = () => scheduledSender.nudge();
