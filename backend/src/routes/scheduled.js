import { randomBytes, randomUUID } from 'crypto';
import { Router } from 'express';
import { query, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { findOwnedAccount, findOwnedAlias, findOwnedScheduledMessage } from '../services/ownership.js';
import {
  SendError, UUID_RE, missingSendFields, resolveForwarded, resolveIdentity, validateSendInput,
} from '../services/outgoingMail.js';
import { composeHtmlToText } from '../services/emailSanitizer.js';
import { deleteSentDraft } from '../services/draftCopies.js';
import { consume } from '../services/rateLimiter.js';
import {
  LIMITS, PENDING_STATUSES, aad, attachmentMetas, headerSafe, nudgeScheduledSender, openJson, readAttachments,
  replaceContent, sealJson, storeScheduledMessage,
} from '../services/scheduledSend.js';
import { attachmentDisposition } from '../utils/contentDisposition.js';
import { imapManager } from '../index.js';

// The scheduled messages API (#543, design section 2). Every route is the signed-in user's:
// a message is looked up through findOwnedScheduledMessage, and every change is one UPDATE that
// names the id, the user and the statuses it may change, so a race with the scheduler (a claim)
// or another tab loses cleanly: no row back, and a 409 that says what the message is doing.
// Every change reaches the user's tabs as scheduled_changed { id, status } and nudges the sender.

const router = Router();
router.use(requireAuth);

const EDIT_LEASE = '30 minutes';
const CANCEL_UNDO = '10 minutes';
// The list shows this many sent messages, the most recent, and says whether there are more.
const SENT_IN_LIST = 50;
// Send now waits this long, so its Undo has a window (UNDO_SEND_SECONDS in the composer).
const SEND_NOW_DELAY_MS = 10_000;
// Account error codes that mean the account cannot send until the user signs in again.
const REAUTH_CODES = new Set(['oauth_reauth', 'oauth_app_config', 'auth_failed']);
// Statuses the user can move to scheduled again.
const MOVABLE = ['scheduled', 'paused', 'failed', 'uncertain'];

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

// What the user is told when a message is not in a state an action allows.
function stateMessage(status) {
  return {
    sending: 'This message is being sent now.',
    sent: 'This message has already been sent.',
    cancelled: 'This message was deleted.',
    editing: 'This message is open for editing.',
    scheduled: 'This message is scheduled.',
    paused: 'This message is paused.',
    failed: 'This message failed to send.',
    uncertain: 'This message may already have been delivered.',
  }[status] || 'This message cannot be changed now.';
}

// An action that could send a message that may already have gone out, or one a restore paused
// while the old server may still send it, needs the user's explicit confirmation.
const CONFIRM = {
  uncertain: {
    code: 'confirm_uncertain',
    error: 'This message may already have been delivered: MailFlow stopped while sending it. Check the Sent folder first. Send it again anyway?',
  },
  restored: {
    code: 'confirm_restored',
    error: 'This was paused when a backup was restored. If the old server still runs, it may send it too. Send it from here?',
  },
};

function confirmFor(status, pauseReason, confirm) {
  if (confirm === true) return null;
  if (status === 'uncertain') return CONFIRM.uncertain;
  if (status === 'paused' && pauseReason === 'restored') return CONFIRM.restored;
  return null;
}
const needsConfirm = (row, confirm) => confirmFor(row.status, row.pause_reason, confirm);
// A message opened for editing keeps what made it need a confirmation: the hold saves its status
// in status_before and leaves pause_reason and smtp_started_at alone, so a save that would
// schedule it again asks as the other actions do.
const saveNeedsConfirm = (row, confirm) => confirmFor(row.status_before, row.pause_reason, confirm);

function changed(userId, id, status) {
  try {
    imapManager.broadcast({ type: 'scheduled_changed', id, status }, userId);
  } catch (err) {
    console.warn('[scheduled] broadcast failed:', err.message);
  }
  nudgeScheduledSender();
}

// The time a message is to go out, checked against this server's clock (design 3.7): at least a
// minute ahead, at most 366 days. Throws SendError with the server's time, so a client with a
// wrong clock can say "That time has already passed".
function checkSendAt(value) {
  const sendAt = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  const now = Date.now();
  if (!sendAt || Number.isNaN(sendAt.getTime())) throw new SendError(400, 'sendAt must be a date and time');
  if (sendAt.getTime() < now + LIMITS.minAheadMs) {
    throw Object.assign(new SendError(400, 'The scheduled time must be at least a minute from now.'), { code: 'too_soon', serverNow: new Date(now).toISOString() });
  }
  if (sendAt.getTime() > now + LIMITS.maxAheadMs) {
    throw Object.assign(new SendError(400, 'A message can be scheduled at most 366 days ahead.'), { code: 'too_far', serverNow: new Date(now).toISOString() });
  }
  return sendAt;
}

// An IANA zone the browser picked, kept for display only; anything else is stored as null.
function checkTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const answerSendError = (res, err) => {
  if (!(err instanceof SendError)) throw err;
  return fail(res, err.status, err.message, {
    ...(err.code ? { code: err.code } : {}), ...(err.serverNow ? { serverNow: err.serverNow } : {}),
  });
};

// The snippet the list shows: the body as text, on one line.
function snippetOf(input) {
  const text = input.bodyIsHtml ? composeHtmlToText(input.body || '') : String(input.body || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Everything the sender needs from a send body, checked as Send checks it, with forwarded
// parts and messages fetched now (open question 12) and the Message-ID fixed (design 4.1).
// `messageId` keeps an existing one unless From moved to another domain.
async function buildSpec(userId, body, { messageId } = {}) {
  const input = validateSendInput(body);
  if (!UUID_RE.test(String(input.accountId))) throw new SendError(400, 'accountId is invalid');
  if (input.aliasId && !UUID_RE.test(String(input.aliasId))) throw new SendError(400, 'aliasId is invalid');
  const account = await findOwnedAccount(userId, input.accountId, { enabled: true });
  if (!account) throw new SendError(404, 'Account not found');
  if (input.aliasId && !(await findOwnedAlias(userId, input.accountId, input.aliasId))) {
    throw new SendError(404, 'Alias not found');
  }
  const identity = await resolveIdentity(userId, input);
  const forwarded = await resolveForwarded(userId, input);
  const domain = identity.fromEmail.split('@')[1] || 'mailflow.local';
  const keepId = typeof messageId === 'string' && messageId.endsWith(`@${domain}>`);
  const payload = {
    v: 1,
    messageId: keepId ? messageId : `<${randomBytes(16).toString('hex')}@${domain}>`,
    aliasId: input.aliasId || null,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body ?? '',
    bodyIsHtml: input.bodyIsHtml === true,
    quotedBody: input.quotedBody ?? null,
    quotedBodyHtml: input.quotedBodyHtml ?? null,
    signature: identity.signature ?? null,
    plaintextEmail: identity.plaintextEmail === true,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    priority: input.priority,
    ...(body.compose && typeof body.compose === 'object' && !Array.isArray(body.compose) ? { compose: body.compose } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > LIMITS.payloadBytes) {
    throw Object.assign(new SendError(413, 'The message is too large to schedule: its text and inline images may take at most 10 MB.'), { code: 'payload_too_large' });
  }
  const attachments = [
    ...(input.attachments || []).map(a => ({
      filename: a.filename, contentType: (typeof a.contentType === 'string' && headerSafe(a.contentType)) || 'application/octet-stream',
      kind: 'upload', content: Buffer.from(a.content, 'base64'),
    })),
    ...forwarded.attachments.map(a => ({ ...a, kind: 'forwarded' })),
    ...forwarded.messages.map(a => ({ filename: a.filename, contentType: a.contentType, disposition: 'attachment', kind: 'message', content: a.content })),
  ];
  return { input, account, payload, attachments };
}

function summaryOf(input, attachmentCount) {
  return {
    subject: input.subject,
    to: input.to,
    ccCount: input.cc.length,
    bccCount: input.bcc.length,
    snippet: snippetOf(input),
    attachmentCount,
  };
}

// The per-user count and stored bytes, read under a lock on the user's row so that two creates
// at once cannot both slip under the limits (the pattern of openaiCodexAuth.js). `exceptId` leaves
// out the row an edit replaces.
async function checkUserLimits(client, userId, { adding, addingBytes, exceptId = null }) {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const { rows: [usage] } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status = ANY($2)) ::int AS pending,
            COALESCE(SUM(payload_bytes + attachment_bytes) FILTER (WHERE status <> 'sent'), 0)::bigint AS bytes
       FROM scheduled_messages WHERE user_id = $1 AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, PENDING_STATUSES, exceptId],
  );
  if (usage.pending + adding > LIMITS.pending) {
    throw Object.assign(new SendError(422, `You can have at most ${LIMITS.pending} scheduled messages. Send or delete some first.`), { code: 'too_many' });
  }
  if (Number(usage.bytes) + addingBytes > LIMITS.storedBytes) {
    throw Object.assign(new SendError(422, 'Your scheduled messages take up more than 250 MB. Send or delete some first.'), { code: 'too_much_storage' });
  }
}

const bytesOf = (payload, attachments) => Buffer.byteLength(JSON.stringify(payload), 'utf8')
  + attachments.reduce((sum, a) => sum + a.content.length, 0);

// What the row says the server answered, for its owner: the mail server's own reply line when it
// gave one (a refusal, a deferral, a failed sign-in); otherwise MailFlow's explanation, except the
// catch-all "Please try again", which says nothing, and which an uncertain message must never say:
// it may have been delivered, and must not be sent again blindly. A pause (overdue, account off)
// has no detail.
function failureDetailOf(status, result) {
  const reply = typeof result?.smtpResponse === 'string' ? result.smtpResponse.replace(/\s+/g, ' ').trim() : '';
  if (reply) return reply;
  const error = typeof result?.error === 'string' ? result.error.trim() : '';
  if (!error || status === 'uncertain' || /try again/i.test(error)) return null;
  return error;
}

// One message as the list and the reader show it: its summary and outcome decrypted, for the
// owner only (every caller found the row through the user).
function present(row) {
  const summary = openJson(row.summary_enc, aad.summary(row));
  const result = openJson(row.result_enc, aad.result(row));
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    sendAt: row.send_at,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    version: row.version,
    attempts: row.attempts,
    // A deleted (cancelled) message can be restored until then; null for every other one.
    restoreUntil: row.status === 'cancelled' ? row.purge_after : null,
    sentAt: row.sent_at,
    sentLate: row.sent_late,
    pauseReason: row.pause_reason,
    failureCode: row.failure_code,
    failureDetail: row.status === 'sent' ? null : failureDetailOf(row.status, result),
    summary,
    // What the sent notice shows: where the copy is, and who did not get it (refused) or not
    // yet (deferred).
    result: row.status === 'sent' && result ? {
      sentFolder: result.sentFolder ?? null,
      messageId: result.messageId ?? null,
      sentCopySaved: result.sentCopySaved ?? null,
      ...(result.sentCopyReason ? { sentCopyReason: result.sentCopyReason } : {}),
      rejected: result.rejected || [],
      deferred: result.deferred || [],
      ...(result.lateReason ? { lateReason: result.lateReason } : {}),
    } : null,
  };
}

// Answers for a change that found no row: 404 for a message the user does not have, else 409
// with what it is doing.
async function noChange(res, userId, id) {
  const row = await findOwnedScheduledMessage(userId, id, { columns: 'id, status' });
  if (!row) return fail(res, 404, 'Scheduled message not found');
  return fail(res, 409, stateMessage(row.status), { status: row.status });
}

const validId = (req, res, next) => (UUID_RE.test(req.params.id) ? next() : fail(res, 404, 'Scheduled message not found'));

// One scoped change: SET `sets` WHERE id, user and status in `from` (plus `extra`), RETURNING
// the row. Params after the first three are $4 on.
async function update(userId, id, from, sets, params = [], extra = '') {
  const { rows } = await query(
    `UPDATE scheduled_messages SET ${sets}, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = ANY($3) ${extra} RETURNING *`,
    [id, userId, from, ...params],
  );
  return rows[0] || null;
}

// --- Create ------------------------------------------------------------------------------------

router.post('/scheduled', async (req, res) => {
  const userId = req.session.userId;
  const body = req.body || {};
  const missing = missingSendFields(body);
  if (missing) return fail(res, 400, missing);
  if (typeof body.clientKey !== 'string' || !UUID_RE.test(body.clientKey)) return fail(res, 400, 'clientKey must be a UUID');

  // A retried create gets the message the first one made, without counting against the rate.
  const answerExisting = row => res.status(200).json({ id: row.id, sendAt: row.send_at, status: row.status });
  const { rows: [existing] } = await query(
    'SELECT id, send_at, status FROM scheduled_messages WHERE user_id = $1 AND client_key = $2', [userId, body.clientKey]);
  if (existing) return answerExisting(existing);

  const rate = await consume(`scheduled_create:${userId}`, LIMITS.createsPerMinute, 60_000);
  if (rate.limited) return fail(res, 429, 'Too many messages scheduled in a short time. Try again in a minute.', { code: 'rate_limited' });

  let spec, sendAt;
  try {
    sendAt = checkSendAt(body.sendAt);
    spec = await buildSpec(userId, body);
  } catch (err) {
    return answerSendError(res, err);
  }
  const timeZone = checkTimeZone(body.timeZone);
  const id = randomUUID();

  let stored;
  try {
    stored = await withTransaction(async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const { rows: [again] } = await client.query(
        'SELECT id, send_at, status FROM scheduled_messages WHERE user_id = $1 AND client_key = $2', [userId, body.clientKey]);
      if (again) return { existing: again };
      await checkUserLimits(client, userId, { adding: 1, addingBytes: bytesOf(spec.payload, spec.attachments) });
      return storeScheduledMessage(client, {
        id, userId, accountId: spec.account.id, clientKey: body.clientKey, sendAt, timeZone,
        payload: spec.payload, summary: summaryOf(spec.input, spec.attachments.length), attachments: spec.attachments,
      });
    });
  } catch (err) {
    return answerSendError(res, err);
  }
  if (stored.existing) return answerExisting(stored.existing);
  if (!stored.created) {
    return answerExisting(await findOwnedScheduledMessage(userId, stored.id, { columns: 'id, send_at, status' }));
  }

  // Only now is the scheduled row the copy: the draft it was written in goes (design 2.2).
  const draft = body.draft && typeof body.draft === 'object' && !Array.isArray(body.draft)
    ? { uid: body.draft.uid, folder: body.draft.folder, accountId: body.draft.accountId } : null;
  if (draft) await deleteSentDraft(userId, spec.account, draft);
  changed(userId, id, 'scheduled');
  res.status(201).json({ id, sendAt: sendAt.toISOString(), status: 'scheduled' });
});

// --- Read --------------------------------------------------------------------------------------

// Everything not yet sent (at most the 100 pending), the deleted ones that can still be restored
// (each with its restoreUntil), and the most recent sent ones, with a flag when there are older
// sent ones the list leaves out.
router.get('/scheduled', async (req, res) => {
  const [open, sent] = await Promise.all([
    query(
      `SELECT * FROM scheduled_messages
        WHERE user_id = $1 AND (status NOT IN ('cancelled', 'sent') OR (status = 'cancelled' AND purge_after > NOW()))
        ORDER BY send_at, id`,
      [req.session.userId],
    ),
    query(
      `SELECT * FROM scheduled_messages WHERE user_id = $1 AND status = 'sent' ORDER BY sent_at DESC NULLS LAST, id LIMIT $2`,
      [req.session.userId, SENT_IN_LIST + 1],
    ),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    messages: [...open.rows, ...sent.rows.slice(0, SENT_IN_LIST)].map(present),
    moreSent: sent.rows.length > SENT_IN_LIST,
  });
});

// How many scheduled messages an account has that deleting it would delete with it (design 1.1).
router.get('/scheduled/count', async (req, res) => {
  const accountId = String(req.query.accountId || '');
  if (!UUID_RE.test(accountId) || !(await findOwnedAccount(req.session.userId, accountId, { columns: 'id' }))) {
    return fail(res, 404, 'Account not found');
  }
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS count FROM scheduled_messages
      WHERE user_id = $1 AND account_id = $2 AND status NOT IN ('sent', 'cancelled')`,
    [req.session.userId, accountId],
  );
  res.json({ count: r.count });
});

// Deleted messages are found too while they can be restored; after that they are gone.
const restorable = row => row.status === 'cancelled' && row.purge_after && new Date(row.purge_after).getTime() > Date.now();

router.get('/scheduled/:id', validId, async (req, res) => {
  const row = await findOwnedScheduledMessage(req.session.userId, req.params.id);
  if (!row || (row.status === 'cancelled' && !restorable(row))) return fail(res, 404, 'Scheduled message not found');
  const spec = row.payload_enc ? openJson(row.payload_enc, aad.payload(row)) : null;
  if (row.payload_enc && !spec) return fail(res, 500, 'This message could not be decrypted on this server.', { code: 'decrypt_failed' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...present(row), spec, attachments: row.payload_enc ? (await attachmentMetas({ query }, row)).filter(Boolean) : [] });
});

router.get('/scheduled/:id/attachments/:index', validId, async (req, res) => {
  // An attachment index is small: a message carries at most 220 (100 uploads, 100 parts, 20 messages).
  if (!/^\d{1,3}$/.test(req.params.index)) return fail(res, 404, 'Attachment not found');
  const index = Number(req.params.index);
  const row = await findOwnedScheduledMessage(req.session.userId, req.params.id);
  if (!row || row.status === 'cancelled') return fail(res, 404, 'Attachment not found');
  let att;
  try {
    [att] = await readAttachments({ query }, row, { only: index });
  } catch {
    return fail(res, 500, 'This attachment could not be decrypted on this server.', { code: 'decrypt_failed' });
  }
  if (!att) return fail(res, 404, 'Attachment not found');
  res.setHeader('Content-Type', att.meta.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', attachmentDisposition(att.meta.filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(att.content);
});

// --- Edit (design 2.3) -------------------------------------------------------------------------

// Takes or renews the edit hold. With an editToken it only renews: the token must name the hold,
// or the answer is 409 hold_lost, so a composer whose hold ended (a save, a release, another tab's
// takeover of a lapsed lease) can never take the message back unnoticed. Without one it takes a
// free message: one that is not being edited, or whose edit lease has lapsed (its composer went
// away before the sweep released it). One another composer holds is 409 held_elsewhere, unless
// the request says takeover: the user chose to edit it here instead (a stale tab, another
// device), and the hold moves to this composer with a new token, so the other one's next
// renewal or save is hold_lost.
router.post('/scheduled/:id/hold', validId, async (req, res) => {
  const userId = req.session.userId;
  const given = req.body?.editToken;
  if (given !== undefined && given !== null) {
    if (typeof given !== 'string' || !UUID_RE.test(given)) return fail(res, 400, 'editToken must be a UUID');
    const row = await update(userId, req.params.id, ['editing'],
      'edit_lease_until = NOW() + $5::interval', [given, EDIT_LEASE], 'AND edit_token = $4::uuid');
    if (!row) return lostHold(res, userId, req.params.id);
    return res.json({ editToken: row.edit_token, editLeaseUntil: row.edit_lease_until, version: row.version, statusBefore: row.status_before });
  }
  const takeover = req.body?.takeover === true;
  const row = await update(userId, req.params.id, [...MOVABLE, 'editing'],
    `status = 'editing',
     status_before = CASE WHEN status = 'editing' THEN status_before ELSE status END,
     edit_token = $4::uuid,
     edit_lease_until = NOW() + $5::interval`,
    [randomUUID(), EDIT_LEASE], takeover ? '' : "AND (status <> 'editing' OR edit_lease_until IS NULL OR edit_lease_until < NOW())");
  if (!row) {
    const current = await findOwnedScheduledMessage(userId, req.params.id, { columns: 'id, status' });
    if (current?.status === 'editing') {
      return fail(res, 409, 'This message is open for editing somewhere else.', { code: 'held_elsewhere', status: 'editing' });
    }
    return noChange(res, userId, req.params.id);
  }
  changed(userId, row.id, 'editing');
  res.json({ editToken: row.edit_token, editLeaseUntil: row.edit_lease_until, version: row.version, statusBefore: row.status_before });
});

// Hands the message back: to the status it had before the hold. With keepPaused (the composer's
// Keep paused, for a message that fell due while open, design 2.3) a scheduled message becomes
// paused with pause_reason 'user' instead, so it does not go out the moment it is released; it
// goes on with Resume. A message that was paused keeps its reason (a restored one still asks
// before it is sent), and one that failed or may have gone out stays so: neither would be sent
// by a release anyway, and uncertain must keep its question. No push: the user just chose this.
router.post('/scheduled/:id/release', validId, async (req, res) => {
  const editToken = String(req.body?.editToken || '');
  if (!UUID_RE.test(editToken)) return fail(res, 400, 'editToken is required');
  const keepPaused = req.body?.keepPaused === true;
  const row = await update(req.session.userId, req.params.id, ['editing'],
    keepPaused
      ? `status = CASE WHEN status_before IN ('failed', 'uncertain') THEN status_before ELSE 'paused' END,
         pause_reason = CASE WHEN status_before IN ('paused', 'failed', 'uncertain') THEN pause_reason ELSE 'user' END,
         status_before = NULL, edit_token = NULL, edit_lease_until = NULL`
      : `status = COALESCE(status_before, 'scheduled'), status_before = NULL, edit_token = NULL, edit_lease_until = NULL`,
    [editToken], 'AND edit_token = $4::uuid');
  if (!row) return lostHold(res, req.session.userId, req.params.id);
  changed(req.session.userId, row.id, row.status);
  res.json({ status: row.status });
});

async function lostHold(res, userId, id) {
  const row = await findOwnedScheduledMessage(userId, id, { columns: 'id, status' });
  if (!row) return fail(res, 404, 'Scheduled message not found');
  return fail(res, 409, 'This message is no longer open for editing here.', { code: 'hold_lost', status: row.status });
}

// Saves an edit: a new spec and send time, the stored attachments it keeps and new ones, all
// encrypted again under the next version (design 2.3). Back to scheduled, attempts reset.
router.put('/scheduled/:id', validId, async (req, res) => {
  const userId = req.session.userId;
  const body = req.body || {};
  const editToken = String(body.editToken || '');
  if (!UUID_RE.test(editToken)) return fail(res, 400, 'editToken is required');
  if (!Number.isInteger(body.version)) return fail(res, 400, 'version is required');
  const keep = Array.isArray(body.keepAttachments) ? body.keepAttachments : [];
  if (!keep.every(i => Number.isInteger(i) && i >= 0)) return fail(res, 400, 'keepAttachments must be attachment indexes');
  const missing = missingSendFields(body);
  if (missing) return fail(res, 400, missing);

  const current = await findOwnedScheduledMessage(userId, req.params.id);
  if (!current) return fail(res, 404, 'Scheduled message not found');
  if (current.status !== 'editing' || current.edit_token !== editToken) return lostHold(res, userId, req.params.id);
  if (current.version !== body.version) return fail(res, 409, 'This message was changed elsewhere. Open it again.', { code: 'version_conflict' });
  const ask = saveNeedsConfirm(current, body.confirm);
  if (ask) return fail(res, 409, ask.error, { code: ask.code });

  let spec, sendAt;
  try {
    sendAt = checkSendAt(body.sendAt);
    const before = openJson(current.payload_enc, aad.payload(current));
    spec = await buildSpec(userId, body, { messageId: before?.messageId });
  } catch (err) {
    return answerSendError(res, err);
  }
  const timeZone = checkTimeZone(body.timeZone);

  let saved;
  try {
    saved = await withTransaction(async client => {
      const row = await findOwnedScheduledMessage(userId, req.params.id, { client, forUpdate: true });
      if (!row || row.status !== 'editing' || row.edit_token !== editToken) return { lost: true };
      if (row.version !== body.version) return { conflict: true };
      const confirmation = saveNeedsConfirm(row, body.confirm);
      if (confirmation) return { confirmation };
      const kept = keep.length ? (await readAttachments(client, row)).filter(a => keep.includes(a.index)) : [];
      if (kept.length !== new Set(keep).size) throw new SendError(400, 'keepAttachments names an attachment the message does not have');
      const attachments = [
        ...kept.map(({ meta, content }) => ({ filename: meta.filename, contentType: meta.contentType, disposition: meta.disposition, kind: meta.kind, content })),
        ...spec.attachments,
      ];
      if (attachments.reduce((sum, a) => sum + a.content.length, 0) > LIMITS.attachmentBytes) {
        throw new SendError(400, 'Total attachment size exceeds 25 MB');
      }
      await checkUserLimits(client, userId, { adding: 1, addingBytes: bytesOf(spec.payload, attachments), exceptId: row.id });
      const version = await replaceContent(client, row, {
        payload: spec.payload, summary: summaryOf(spec.input, attachments.length), attachments,
      });
      await client.query(
        `UPDATE scheduled_messages
            SET status = 'scheduled', account_id = $4, send_at = $2, due_at = $2, time_zone = $3, attempts = 0,
                failure_code = NULL, pause_reason = NULL, status_before = NULL,
                edit_token = NULL, edit_lease_until = NULL, smtp_started_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [row.id, sendAt, timeZone, spec.account.id],
      );
      return { version };
    });
  } catch (err) {
    if (err?.scheduledCode === 'decrypt_failed') return fail(res, 500, 'This message could not be decrypted on this server.', { code: 'decrypt_failed' });
    return answerSendError(res, err);
  }
  if (saved.lost) return lostHold(res, userId, req.params.id);
  if (saved.confirmation) return fail(res, 409, saved.confirmation.error, { code: saved.confirmation.code });
  if (saved.conflict) return fail(res, 409, 'This message was changed elsewhere. Open it again.', { code: 'version_conflict' });
  changed(userId, req.params.id, 'scheduled');
  res.json({ id: req.params.id, version: saved.version, sendAt: sendAt.toISOString(), status: 'scheduled' });
});

// --- Reschedule, send now, resume (design 2.4) ---------------------------------------------------

// The row an action reads first, for its confirmation check: 404 when it is not the user's.
async function ownedOr404(req, res) {
  const row = await findOwnedScheduledMessage(req.session.userId, req.params.id,
    { columns: 'id, user_id, account_id, status, pause_reason, version, send_at, due_at, attempts, failure_code' });
  if (!row) fail(res, 404, 'Scheduled message not found');
  return row;
}

// The confirmation must hold in the UPDATE too, in case the row changed after it was read.
const CONFIRMED = "AND (($4::boolean) OR (status <> 'uncertain' AND pause_reason IS DISTINCT FROM 'restored'))";

router.patch('/scheduled/:id', validId, async (req, res) => {
  const row = await ownedOr404(req, res);
  if (!row) return;
  const confirm = req.body?.confirm === true;
  let sendAt;
  try { sendAt = checkSendAt(req.body?.sendAt); } catch (err) { return answerSendError(res, err); }
  const ask = needsConfirm(row, confirm);
  if (ask) return fail(res, 409, ask.error, { code: ask.code });
  const updated = await update(req.session.userId, row.id, MOVABLE,
    `status = 'scheduled', send_at = $5, due_at = $5, time_zone = $6, attempts = 0, failure_code = NULL, pause_reason = NULL`,
    [confirm, sendAt, checkTimeZone(req.body?.timeZone)], CONFIRMED);
  if (!updated) return noChange(res, req.session.userId, row.id);
  changed(req.session.userId, row.id, 'scheduled');
  res.json({ status: 'scheduled', sendAt: updated.send_at });
});

// The Undo of Send now carries what Send now replaced, encrypted and bound to the message and
// its version, so the server can put it back without a column for it and without trusting the
// client with it.
const undoAad = row => `scheduled:${row.id}:${row.user_id}:undo:${row.version}`;

// The values the Undo puts back are read under a lock in the same transaction as the change, so
// they are exactly what it replaced.
//
// A message open for editing (design 2.4, as built in step 7) is sent from its composer with the
// hold's editToken: in the same UPDATE, so there is no moment in which it is released and due,
// for the sender to claim it without an Undo. What the Undo puts back is then the message as it
// was before the hold (status_before and its time), and the confirmation rules follow that
// status. Any token that is not the current hold's is 409 hold_lost.
router.post('/scheduled/:id/send-now', validId, async (req, res) => {
  const userId = req.session.userId;
  const confirm = req.body?.confirm === true;
  const given = req.body?.editToken;
  if (given !== undefined && given !== null && (typeof given !== 'string' || !UUID_RE.test(given))) {
    return fail(res, 400, 'editToken must be a UUID');
  }
  const done = await withTransaction(async client => {
    const row = await findOwnedScheduledMessage(userId, req.params.id, {
      client, forUpdate: true,
      columns: 'id, user_id, status, status_before, edit_token, pause_reason, version, send_at, due_at, attempts, failure_code',
    });
    if (!row) return { missing: true };
    const editing = row.status === 'editing';
    if (given && !(editing && row.edit_token === given)) return { lost: true };
    if (editing && !given) return { state: row.status };
    const previousStatus = editing ? (row.status_before || 'scheduled') : row.status;
    if (!MOVABLE.includes(previousStatus)) return { state: row.status };
    const ask = confirmFor(previousStatus, row.pause_reason, confirm);
    if (ask) return { ask };
    const { rows: [updated] } = await client.query(
      // To the millisecond, so the Undo token, which carries it as JSON, names it exactly.
      `UPDATE scheduled_messages
          SET status = 'scheduled', send_at = date_trunc('milliseconds', NOW() + $3::interval),
              due_at = date_trunc('milliseconds', NOW() + $3::interval), attempts = 0, failure_code = NULL,
              pause_reason = NULL, status_before = NULL, edit_token = NULL, edit_lease_until = NULL, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [row.id, userId, `${SEND_NOW_DELAY_MS} milliseconds`],
    );
    return { row: { ...row, status: previousStatus }, updated };
  });
  if (done.lost) return lostHold(res, userId, req.params.id);
  if (done.missing) return fail(res, 404, 'Scheduled message not found');
  if (done.state) return fail(res, 409, stateMessage(done.state), { status: done.state });
  if (done.ask) return fail(res, 409, done.ask.error, { code: done.ask.code });
  const { row, updated } = done;
  const undoUntil = new Date(updated.send_at).getTime();
  const undoToken = sealJson({
    sendAt: new Date(updated.send_at).toISOString(),
    until: undoUntil,
    previous: {
      status: row.status, sendAt: row.send_at, dueAt: row.due_at, attempts: row.attempts,
      failureCode: row.failure_code, pauseReason: row.pause_reason,
    },
  }, undoAad(updated)).toString('base64url');
  changed(userId, row.id, 'scheduled');
  res.json({ status: 'scheduled', sendAt: updated.send_at, undoToken, undoUntil: new Date(undoUntil).toISOString() });
});

// Puts back what Send now replaced, while the message still waits (it has not been claimed) and
// nothing else changed it since. A message that would come back scheduled at a time that has
// passed (by the database's clock) comes back paused by the user instead, its times kept:
// scheduled and due, the sender would claim it at once, and Undo would have sent it. One opened
// in another window meanwhile is said as such, not as too late.
router.post('/scheduled/:id/send-now/undo', validId, async (req, res) => {
  const row = await findOwnedScheduledMessage(req.session.userId, req.params.id, { columns: 'id, user_id, status, version, send_at' });
  if (!row) return fail(res, 404, 'Scheduled message not found');
  const elsewhere = () => fail(res, 409, 'This message is open in another window.', { code: 'held_elsewhere', status: 'editing' });
  if (row.status === 'editing') return elsewhere();
  let token = null;
  try { token = openJson(Buffer.from(String(req.body?.undoToken || ''), 'base64url'), undoAad(row)); } catch { /* not a token */ }
  if (!token?.previous) return fail(res, 409, 'This can no longer be undone.', { code: 'undo_expired', status: row.status });
  if (Date.now() >= token.until) return fail(res, 409, 'Too late to undo: the message is going out.', { code: 'undo_expired', status: row.status });
  const p = token.previous;
  const due = "$4::text = 'scheduled' AND $5::timestamptz <= NOW()";
  const updated = await update(req.session.userId, row.id, ['scheduled'],
    `status = CASE WHEN ${due} THEN 'paused' ELSE $4::text END, send_at = $5, due_at = $6, attempts = $7,
     failure_code = $8, pause_reason = CASE WHEN ${due} THEN 'user' ELSE $9::text END`,
    [p.status, p.sendAt, p.dueAt, p.attempts, p.failureCode, p.pauseReason, token.sendAt, row.version],
    'AND send_at = $10 AND version = $11');
  if (!updated) {
    const now = await findOwnedScheduledMessage(req.session.userId, row.id, { columns: 'id, status' });
    if (now?.status === 'editing') return elsewhere();
    return fail(res, 409, 'Too late to undo: the message is going out.', { code: 'undo_expired' });
  }
  changed(req.session.userId, row.id, updated.status);
  res.json({ status: updated.status, sendAt: updated.send_at, ...(updated.pause_reason ? { pauseReason: updated.pause_reason } : {}) });
});

router.post('/scheduled/:id/resume', validId, async (req, res) => {
  const row = await ownedOr404(req, res);
  if (!row) return;
  const confirm = req.body?.confirm === true;
  if (!['paused', 'failed'].includes(row.status)) return fail(res, 409, stateMessage(row.status), { status: row.status });
  const ask = needsConfirm(row, confirm);
  if (ask) return fail(res, 409, ask.error, { code: ask.code });
  // Paused because of the account: only once the account can send again (open question 7).
  if (row.pause_reason === 'needs_reauth' || row.pause_reason === 'account_disabled') {
    const account = await findOwnedAccount(req.session.userId, row.account_id, { columns: 'id, enabled, sync_error_code' });
    if (!account?.enabled) return fail(res, 409, 'Turn the account on again first.', { code: 'account_disabled' });
    if (REAUTH_CODES.has(account.sync_error_code)) return fail(res, 409, 'Sign in to the account again first.', { code: 'needs_reauth' });
  }
  const updated = await update(req.session.userId, row.id, ['paused', 'failed'],
    `status = 'scheduled', send_at = NOW(), due_at = NOW(), attempts = 0, failure_code = NULL, pause_reason = NULL`,
    [confirm], CONFIRMED);
  if (!updated) return noChange(res, req.session.userId, row.id);
  changed(req.session.userId, row.id, 'scheduled');
  res.json({ status: 'scheduled', sendAt: updated.send_at });
});

// --- Uncertain (design 3.2): never resent without the user ------------------------------------

router.post('/scheduled/:id/send-anyway', validId, async (req, res) => {
  const row = await ownedOr404(req, res);
  if (!row) return;
  if (row.status !== 'uncertain') return fail(res, 409, stateMessage(row.status), { status: row.status });
  if (req.body?.confirm !== true) return fail(res, 409, CONFIRM.uncertain.error, { code: CONFIRM.uncertain.code });
  const updated = await update(req.session.userId, row.id, ['uncertain'],
    `status = 'scheduled', send_at = NOW(), due_at = NOW(), attempts = 0, failure_code = NULL, smtp_started_at = NULL`);
  if (!updated) return noChange(res, req.session.userId, row.id);
  changed(req.session.userId, row.id, 'scheduled');
  res.json({ status: 'scheduled', sendAt: updated.send_at });
});

// The user found it in Sent: recorded as sent, its content deleted, and purged at once.
router.post('/scheduled/:id/mark-sent', validId, async (req, res) => {
  const userId = req.session.userId;
  const done = await withTransaction(async client => {
    const row = await findOwnedScheduledMessage(userId, req.params.id, { client, forUpdate: true, columns: 'id, user_id, status' });
    if (!row || row.status !== 'uncertain') return row ? { status: row.status } : null;
    await client.query(
      `UPDATE scheduled_messages
          SET status = 'sent', sent_at = NOW(), payload_enc = NULL, summary_enc = NULL, failure_code = NULL,
              result_enc = $2, purge_after = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [row.id, sealJson({ ok: true, markedSent: true }, aad.result(row))],
    );
    await client.query('DELETE FROM scheduled_message_attachments WHERE scheduled_id = $1', [row.id]);
    return { ok: true };
  });
  if (!done) return fail(res, 404, 'Scheduled message not found');
  if (!done.ok) return fail(res, 409, stateMessage(done.status), { status: done.status });
  changed(userId, req.params.id, 'sent');
  res.json({ status: 'sent' });
});

// --- Cancel, undo, delete ----------------------------------------------------------------------

// Cancel ("Delete" with Undo): kept for the undo window, then purged. From editing it keeps the
// status_before the hold saved; an already cancelled message stays as it is.
router.post('/scheduled/:id/cancel', validId, async (req, res) => {
  const userId = req.session.userId;
  const row = await update(userId, req.params.id, [...MOVABLE, 'editing'],
    `status = 'cancelled', status_before = CASE WHEN status = 'editing' THEN status_before ELSE status END,
     purge_after = NOW() + $4::interval, edit_token = NULL, edit_lease_until = NULL`,
    [CANCEL_UNDO]);
  if (!row) {
    const current = await findOwnedScheduledMessage(userId, req.params.id, { columns: 'id, status, purge_after' });
    if (!current) return fail(res, 404, 'Scheduled message not found');
    if (current.status === 'cancelled') return res.json({ status: 'cancelled', undoUntil: current.purge_after });
    return fail(res, 409, stateMessage(current.status), { status: current.status });
  }
  changed(userId, row.id, 'cancelled');
  res.json({ status: 'cancelled', undoUntil: row.purge_after });
});

// Undo of a cancel, within its window: back to the status it had, its send time unchanged.
// It counts as pending again, so it is checked against the limit under the user's lock, as a
// create is. One that would come back scheduled at a time that has passed (by the database's
// clock) comes back paused by the user instead, as an Undo of Send now does: scheduled and due,
// the sender would claim it at once, and a restore would send it.
router.post('/scheduled/:id/restore', validId, async (req, res) => {
  const userId = req.session.userId;
  let row;
  try {
    row = await withTransaction(async client => {
      // The message first, under the user's lock, so a foreign, missing or expired one is
      // answered as such and never counted against the limit.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const current = await findOwnedScheduledMessage(userId, req.params.id, { client, forUpdate: true, columns: 'id, status, purge_after' });
      if (!current) return { missing: true };
      const { rows: [{ now }] } = await client.query('SELECT NOW() AS now');
      if (current.status !== 'cancelled') return { state: current.status };
      if (!current.purge_after || current.purge_after <= now) return { expired: true };
      await checkUserLimits(client, userId, { adding: 1, addingBytes: 0, exceptId: req.params.id });
      const due = "COALESCE(status_before, 'scheduled') = 'scheduled' AND (send_at <= NOW() OR due_at <= NOW())";
      const { rows: [restored] } = await client.query(
        `UPDATE scheduled_messages
            SET status = CASE WHEN ${due} THEN 'paused' ELSE COALESCE(status_before, 'scheduled') END,
                pause_reason = CASE WHEN ${due} THEN 'user' ELSE pause_reason END,
                status_before = NULL, purge_after = NULL, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status = 'cancelled' AND purge_after > NOW()
          RETURNING *`,
        [req.params.id, userId],
      );
      return restored || { expired: true };
    });
  } catch (err) {
    return answerSendError(res, err);
  }
  if (row.missing) return fail(res, 404, 'Scheduled message not found');
  if (row.state) return fail(res, 409, stateMessage(row.state), { status: row.state });
  if (row.expired) return fail(res, 409, 'This can no longer be undone.', { status: 'cancelled' });
  changed(userId, row.id, row.status);
  res.json({ status: row.status, sendAt: row.send_at, ...(row.status === 'paused' && row.pause_reason ? { pauseReason: row.pause_reason } : {}) });
});

// Deletes a message for good, with its attachments: anything but one being sent. Failed
// messages stay until this (open question 14).
router.delete('/scheduled/:id', validId, async (req, res) => {
  const { rows } = await query(
    "DELETE FROM scheduled_messages WHERE id = $1 AND user_id = $2 AND status <> 'sending' RETURNING id",
    [req.params.id, req.session.userId],
  );
  if (!rows.length) return noChange(res, req.session.userId, req.params.id);
  changed(req.session.userId, req.params.id, 'deleted');
  res.status(204).end();
});

export default router;
