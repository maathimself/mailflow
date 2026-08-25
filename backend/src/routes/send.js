import { randomBytes, createHash, randomUUID } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import {
  revalidateLiveMessageSnapshotGroups,
  snapshotFromMessageRow,
} from '../services/messageSnapshots.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { generateVCard } from '../utils/vcard.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { loadPreparedSmtp, renderPreparedSmtp } from '../services/preparedSmtp.js';
import { imapManager } from '../index.js';
import { pluginRegistry } from '../plugins/registry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Map SMTP/connection errors to user-friendly messages that don't expose server internals.
function sanitizeSmtpError(err) {
  const msg = err.message || '';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return 'Could not connect to the mail server. Check your SMTP settings.';
  }
  if (/535|534|530|invalid.?login|authentication.?fail|bad.*credentials|username.*password|password.*username/i.test(msg)) {
    return 'Authentication failed. Check your email account credentials.';
  }
  if (/throttl|rate.?limit|too many|4\.2\.|4\.7\.94/i.test(msg)) {
    return 'The mail server is rate limiting sends. Please try again shortly.';
  }
  if (/550|5\.[13]\.|reject|blacklist|spam|not.?accept/i.test(msg)) {
    return 'Message was rejected by the mail server.';
  }
  if (/TLS|SSL|certificate|handshake/i.test(msg)) {
    return 'Secure connection to the mail server failed. Check your TLS settings.';
  }
  return 'Failed to send message. Please try again.';
}

// Extract name and email from an RFC 5322 address string.
// Handles "Name <email>", "Name<email>", bare "<email>", and bare "email" forms.
function parseAddress(str) {
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}

function mapRecipientList(list) {
  return (list || []).map(addr => parseAddress(addr));
}

function buildSentSnippet(body, bodyIsHtml) {
  return bodyToPlain(body, bodyIsHtml).replace(/\s+/g, ' ').trim().substring(0, 200);
}

// Reject any recipient address that contains newlines, null bytes, or looks
// malformed — these are the classic email header-injection vectors.
function normalizeRecipients(list, fieldName) {
  if (!Array.isArray(list)) throw Object.assign(new Error(`${fieldName} must be an array`), { status: 400 });
  return list.map((addr, i) => {
    if (typeof addr !== 'string' || !addr.trim()) {
      throw Object.assign(new Error(`${fieldName}[${i}] is empty or not a string`), { status: 400 });
    }
    const trimmed = addr.trim();
    if (/[\r\n\0]/.test(trimmed)) {
      throw Object.assign(new Error(`${fieldName}[${i}] contains invalid characters`), { status: 400 });
    }
    const at = trimmed.lastIndexOf('@');
    if (at < 1 || at === trimmed.length - 1) {
      throw Object.assign(new Error(`${fieldName}[${i}] is not a valid email address`), { status: 400 });
    }
    return trimmed;
  });
}

// Strip header-injection characters from single-line header values.
function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

function textToHtml(text) {
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    text.split('\n').map(l => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('') +
    '</div>';
}

function sigToPlainText(html) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

function bodyToPlain(body, isHtml) {
  if (!isHtml) return body;
  return sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} });
}

function bodyToHtml(body, isHtml) {
  if (!isHtml) return textToHtml(body);
  return sanitizeComposeBody(body);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseStoredJson(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function scheduleSentSync(account, sentFolder, messageId, delay, label) {
  setTimeout(() => {
    imapManager.syncFolderOnDemand(account, sentFolder)
      .then(() => pluginRegistry.runHook('onSentMessage', {
        imapManager: imapManager.pluginFacade, account, messageId,
      }))
      .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
  }, delay);
}

async function materializePreparedSent(account, operation, userId, idempotencyKey) {
  const sentFolder = operation.sent_folder;
  if (!sentFolder) return null;
  const sentMeta = parseStoredJson(operation.sent_metadata);
  if (!operation.message_id || !sentMeta || sentMeta.messageId !== operation.message_id) {
    throw new Error('Durable Sent recovery facts are incomplete');
  }

  if (operation.server_auto_saves) {
    const receipt = await imapManager.findUidByMessageIdReceipt(
      account, sentFolder, operation.message_id,
    );
    await imapManager.upsertSentMessageRecordFromReceipt(account, receipt, sentMeta);
    scheduleSentSync(account, sentFolder, operation.message_id, 3000, '3s');
    scheduleSentSync(account, sentFolder, operation.message_id, 15000, '15s');
    return null;
  }

  if (!operation.raw_message) throw new Error('Durable Sent MIME is unavailable');
  await Promise.race([
    imapManager.appendToSent(account, sentFolder, Buffer.from(operation.raw_message), {
      operationKey: `send:${userId}:${idempotencyKey}`,
      materialize: ({ uid: appendedUid }, tx) => (
        tx
          ? imapManager.upsertSentMessageRecord(
              account, sentFolder, appendedUid, sentMeta, { tx },
            )
          : imapManager.upsertSentMessageRecord(
              account, sentFolder, appendedUid, sentMeta,
            )
      ),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Sent APPEND timed out')), 20000)),
  ]);
  scheduleSentSync(account, sentFolder, operation.message_id, 1000, 'post-append');
  return true;
}

async function completeProviderAppliedSend({ account, operation, userId, idempotencyKey, payloadDigest }) {
  const sentCopySaved = await materializePreparedSent(
    account, operation, userId, idempotencyKey,
  );
  const sendResult = { ok: true };
  if (sentCopySaved === false) sendResult.sentCopySaved = false;
  if (operation.sent_folder) sendResult.sentFolder = operation.sent_folder;
  const completed = await query(
    `UPDATE send_operations
        SET state = 'completed', response = $4::jsonb,
            message_id = NULL, sent_folder = NULL, sent_metadata = NULL,
            raw_message = NULL, server_auto_saves = NULL,
            smtp_message = NULL, smtp_envelope = NULL,
            prepared_payload_digest = NULL, source_snapshots = NULL,
            completed_at = NOW(), updated_at = NOW()
      WHERE user_id = $1 AND operation_key = $2 AND payload_digest = $3
        AND state = 'provider_applied'
      RETURNING operation_key`,
    [userId, idempotencyKey, payloadDigest, JSON.stringify(sendResult)],
  );
  if (completed.rowCount !== 1) throw new Error('Durable send completion was not persisted');
  return sendResult;
}

async function revalidateForwardedSnapshots(forwardedSnapshots) {
  if (forwardedSnapshots.size === 0) return;
  const byAccount = new Map();
  for (const snapshot of forwardedSnapshots.values()) {
    const snapshots = byAccount.get(snapshot.accountId) || [];
    snapshots.push(snapshot);
    byAccount.set(snapshot.accountId, snapshots);
  }
  await revalidateLiveMessageSnapshotGroups(byAccount);
}

const router = Router();
router.use(requireAuth);


router.post('/send', async (req, res) => {
  const { accountId, aliasId, to, cc = [], bcc = [], subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, inReplyTo, references, attachments, editedSignature, forwardedAttachments, priority } = req.body;
  const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);
  const emailPriority = VALID_PRIORITIES.has(priority) ? priority : 'normal';
  if (!accountId || !to?.length) return res.status(400).json({ error: 'accountId and to required' });

  // Idempotency guard. The client sends a stable X-Idempotency-Key per logical send: a
  // sequential retry after a lost success response returns the cached result, and a
  // concurrent same-key submit is blocked by the reservation set just before delivery
  // (below). Neither can produce a duplicate email.
  const idempotencyKey = typeof req.headers['x-idempotency-key'] === 'string'
    ? req.headers['x-idempotency-key'].trim().slice(0, 128)
    : null;
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'X-Idempotency-Key required for send' });
  }
  const sendPayloadDigest = createHash('sha256').update(stableJson(req.body)).digest('hex');

  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return res.status(400).json({ error: 'attachments must be an array' });
    if (attachments.length > 100) return res.status(400).json({ error: 'Too many attachments (max 100)' });
    const totalBytes = attachments.reduce((sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0);
    if (totalBytes > 26_214_400) return res.status(400).json({ error: 'Total attachment size exceeds 25 MB' });
    for (const [i, a] of attachments.entries()) {
      if (typeof a.filename !== 'string' || !a.filename.trim()) return res.status(400).json({ error: `attachments[${i}].filename is required` });
      if (typeof a.content !== 'string') return res.status(400).json({ error: `attachments[${i}].content must be a base64 string` });
    }
  }

  if (forwardedAttachments !== undefined) {
    if (!Array.isArray(forwardedAttachments)) return res.status(400).json({ error: 'forwardedAttachments must be an array' });
    if (forwardedAttachments.length > 100) return res.status(400).json({ error: 'Too many forwarded attachments (max 100)' });
    for (const [i, fa] of forwardedAttachments.entries()) {
      if (typeof fa.messageId !== 'string' || !UUID_RE.test(fa.messageId)) return res.status(400).json({ error: `forwardedAttachments[${i}].messageId is invalid` });
      if (typeof fa.part !== 'string' || !fa.part.trim()) return res.status(400).json({ error: `forwardedAttachments[${i}].part is required` });
    }
  }

  let normalizedTo, normalizedCc, normalizedBcc;
  try {
    normalizedTo  = normalizeRecipients(to,  'to');
    normalizedCc  = normalizeRecipients(cc,  'cc');
    normalizedBcc = normalizeRecipients(bcc, 'bcc');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const normalizedSubject = sanitizeHeaderValue(subject || '');

  const result = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  let account = result.rows[0];

  let sendOperation;
  try {
    await query(
      `INSERT INTO send_operations (user_id, operation_key, payload_digest)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, operation_key) DO NOTHING`,
      [req.session.userId, idempotencyKey, sendPayloadDigest],
    );
    const sendOperationResult = await query(
      `SELECT state, payload_digest, response, message_id, sent_folder,
              sent_metadata, raw_message, server_auto_saves, smtp_message,
              smtp_envelope, prepared_payload_digest, source_snapshots
         FROM send_operations
        WHERE user_id = $1 AND operation_key = $2`,
      [req.session.userId, idempotencyKey],
    );
    sendOperation = sendOperationResult.rows[0];
  } catch (err) {
    console.error('Send reservation failed:', err.message);
    return res.status(500).json({
      error: 'Failed to reserve send operation.',
      operationKeyDisposition: 'rotate_on_payload_change',
    });
  }
  if (!sendOperation) return res.status(503).json({ error: 'Durable send ledger unavailable' });
  if (sendOperation.payload_digest !== sendPayloadDigest) {
    return res.status(409).json({
      error: 'Idempotency key is already bound to a different message.',
      operationKeyDisposition: sendOperation.state === 'ready'
        ? 'rotate_on_payload_change'
        : 'retain',
    });
  }
  if (sendOperation.state === 'completed') return res.json(sendOperation.response || { ok: true });
  if (['provider_started', 'uncertain'].includes(sendOperation.state)) {
    return res.status(409).json({
      error: 'The prior send outcome is uncertain; another SMTP delivery is blocked.',
      code: 'SEND_OUTCOME_UNCERTAIN', outcome: sendOperation.state, retryable: false,
      operationKeyDisposition: 'retain',
    });
  }
  if (!['ready', 'provider_applied'].includes(sendOperation.state)) {
    return res.status(409).json({ error: 'The prior send outcome cannot be resumed.' });
  }

  if (sendOperation.state === 'provider_applied') {
    try {
      const sendResult = await completeProviderAppliedSend({
        account, operation: sendOperation, userId: req.session.userId,
        idempotencyKey, payloadDigest: sendPayloadDigest,
      });
      return res.json(sendResult);
    } catch (err) {
      console.error('Sent materialization recovery failed:', err.message);
      return res.status(503).json({
        error: 'Message was delivered, but its Sent copy is still being recovered.',
        code: 'SENT_MATERIALIZATION_PENDING', outcome: 'provider_applied', retryable: true,
        operationKeyDisposition: 'retain',
      });
    }
  }

  const preparedReplay = Boolean(sendOperation.smtp_message);
  const plaintextEmail = preparedReplay
    ? false
    : (await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]))
      .rows[0]?.preferences?.plaintextEmail === true;
  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;
  let fromReplyTo = null;
  let effectiveSignature = null;
  let resolvedFwdAttachments = [];
  const forwardedSnapshots = new Map();

  if (preparedReplay) {
    for (const snapshot of parseStoredJson(sendOperation.source_snapshots) || []) {
      if (!snapshot?.id || !snapshot.accountId) {
        return res.status(409).json({
          error: 'Durable send source snapshot is unavailable.',
          operationKeyDisposition: 'rotate_on_payload_change',
        });
      }
      forwardedSnapshots.set(snapshot.id, snapshot);
    }
  } else {
  // Resolve the From identity — account by default, alias if requested

  if (aliasId) {
    const aliasResult = await query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      fromName = alias.name;
      fromEmail = alias.email;
      fromReplyTo = alias.reply_to || null;
      // null (DB default) means inherit from account; only override when alias has an explicit signature set
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  // Allow the client to override the signature per-send (editedSignature === undefined means use DB value).
  // Sanitize client-supplied HTML to prevent injecting scripts or tracking pixels into sent mail.
  effectiveSignature = editedSignature !== undefined
    ? (editedSignature ? sanitizeSignature(editedSignature) : null)
    : fromSignature;  // fromSignature from DB is already sanitized on write

  // Fetch forwarded attachment content from IMAP before entering the SMTP try-block so that
  // attachment errors return descriptive messages rather than being sanitized as SMTP errors.
  if (forwardedAttachments?.length) {
    try {
      // Resolve every referenced message in a SINGLE ownership-scoped query so a large
      // forwardedAttachments array can't fan out into one DB round-trip per entry.
      const distinctMsgIds = [...new Set(forwardedAttachments.map(fa => fa.messageId))];
      const msgRows = await query(
        `SELECT m.id, m.uid, m.folder, m.attachments, m.account_id,
                m.read_revision, m.star_revision,
                live_folder.uid_validity AS folder_uid_validity,
                live_folder.observation_generation AS folder_observation_generation
         FROM messages m
         JOIN email_accounts a ON m.account_id = a.id
         JOIN folders live_folder ON live_folder.account_id = m.account_id
           AND live_folder.path = m.folder AND live_folder.is_present = true
           AND live_folder.uid_validity IS NOT NULL
         WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2
           AND m.is_deleted = false AND m.metadata_complete = true`,
        [distinctMsgIds, req.session.userId]
      );
      const msgById = new Map(msgRows.rows.map(m => [m.id, m]));

      // Build the fetch plan (one entry per requested attachment, order preserved) and sum the
      // DECLARED sizes so an oversized batch is rejected BEFORE any IMAP fetch happens.
      const uploadedBytes = (attachments || []).reduce(
        (sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0
      );
      let declaredFwdBytes = 0;
      const fetchPlan = forwardedAttachments.map((fa) => {
        const msg = msgById.get(fa.messageId);
        if (!msg) throw Object.assign(new Error('Forwarded message not found'), { status: 404 });
        const storedAtts = typeof msg.attachments === 'string'
          ? JSON.parse(msg.attachments || '[]')
          : (msg.attachments || []);
        const att = storedAtts.find(a => a.part === fa.part);
        if (!att) throw Object.assign(new Error('Attachment not found in message'), { status: 404 });
        forwardedSnapshots.set(msg.id, snapshotFromMessageRow(msg));
        declaredFwdBytes += Number(att.size) || 0;
        return { msg, att };
      });
      if (uploadedBytes + declaredFwdBytes > 26_214_400) {
        return res.status(400).json({ error: 'Total attachment size exceeds 25 MB' });
      }

      // Load the owning accounts once, then fetch bodies with bounded concurrency so we never
      // open a burst of fresh IMAP connections (fetchAttachment opens a connection per call).
      const distinctAcctIds = [...new Set(fetchPlan.map(p => p.msg.account_id))];
      const acctRows = await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [distinctAcctIds]);
      const acctById = new Map(acctRows.rows.map(a => [a.id, a]));

      const FWD_FETCH_CONCURRENCY = 4;
      for (let i = 0; i < fetchPlan.length; i += FWD_FETCH_CONCURRENCY) {
        const batch = fetchPlan.slice(i, i + FWD_FETCH_CONCURRENCY);
        const fetched = await Promise.all(batch.map(async ({ msg, att }) => {
          const acct = acctById.get(msg.account_id);
          if (!acct) throw Object.assign(new Error('Account not found'), { status: 404 });
          const buffer = await imapManager.fetchAttachment(
            acct, msg.uid, msg.folder, att.part,
            { snapshot: snapshotFromMessageRow(msg) },
          );
          if (!buffer) throw Object.assign(new Error(`Could not fetch attachment: ${att.filename}`), { status: 502 });
          return {
            filename: sanitizeHeaderValue(att.filename || 'attachment'),
            content: buffer,
            contentType: att.type || 'application/octet-stream',
          };
        }));
        resolvedFwdAttachments.push(...fetched);
      }

      // Exact backstop: declared sizes can under-report, so re-check against fetched bytes.
      const fwdBytes = resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
      if (uploadedBytes + fwdBytes > 26_214_400) {
        return res.status(400).json({ error: 'Total attachment size exceeds 25 MB' });
      }
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message || 'Failed to fetch forwarded attachments',
        operationKeyDisposition: 'rotate_on_payload_change',
      });
    }
  }
  }

  let operationState = 'ready';
  try {
    // The Message-ID is prepared durably while the operation is still retryable, then reused
    // by SMTP and every Sent-materialization recovery attempt. A ready replay never rebuilds
    // these facts from mutable aliases, preferences, signatures, or attachment sources.
    const domain = fromEmail.split('@')[1] || 'mailflow.local';
    const messageId = sendOperation.message_id
      || `<${randomBytes(16).toString('hex')}@${domain}>`;
    let serverAutoSaves = sendOperation.server_auto_saves === true;
    let sentFolder = sendOperation.sent_folder;
    let sentMeta = parseStoredJson(sendOperation.sent_metadata);
    let rawMessage = sendOperation.raw_message;
    let preparedMail;

    if (preparedReplay) {
      preparedMail = loadPreparedSmtp({
        message: sendOperation.smtp_message,
        envelope: sendOperation.smtp_envelope,
        digest: sendOperation.prepared_payload_digest,
      });
    } else {
      const mailOptions = {
        messageId,
        from: `${fromName} <${fromEmail}>`,
        ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
        to: normalizedTo.join(', '),
        cc: normalizedCc.join(', ') || undefined,
        bcc: normalizedBcc.join(', ') || undefined,
        subject: normalizedSubject,
        ...(emailPriority !== 'normal' ? { priority: emailPriority } : {}),
        text: effectiveSignature
          ? bodyToPlain(body, bodyIsHtml) + '\n\n-- \n' + sigToPlainText(effectiveSignature) + (quotedBody || '')
          : bodyToPlain(body, bodyIsHtml) + (quotedBody || ''),
      };

      let inlineImageAttachments = [];
      if (!plaintextEmail) {
        const rawHtml = bodyToHtml(body, bodyIsHtml) +
          (effectiveSignature
            ? '<div style="margin-top:16px;color:#555;font-size:13px">' + effectiveSignature + '</div>'
            : '') +
          (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
        const embedded = embedInlineDataImages(rawHtml);
        mailOptions.html = embedded.html;
        inlineImageAttachments = embedded.attachments;
      }

      if (inReplyTo) {
        mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
        mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
      }
      const allAttachments = [
        ...inlineImageAttachments,
        ...(attachments?.length ? attachments.map(a => ({
          filename: sanitizeHeaderValue(a.filename),
          content: Buffer.from(a.content, 'base64'),
          contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
        })) : []),
        ...resolvedFwdAttachments,
      ];
      if (allAttachments.length) mailOptions.attachments = allAttachments;

      serverAutoSaves = !!account.oauth_provider;
      sentFolder = await resolveSentFolder(accountId, account.folder_mappings);
      sentMeta = sentFolder ? {
          messageId,
          subject: normalizedSubject,
          fromName,
          fromEmail,
          to: mapRecipientList(normalizedTo),
          cc: mapRecipientList(normalizedCc),
          snippet: buildSentSnippet(body, bodyIsHtml),
          date: new Date().toISOString(),
          inReplyTo: mailOptions.inReplyTo || null,
          references: mailOptions.references || null,
        } : null;
      const envelope = {
        from: fromEmail,
        to: [...normalizedTo, ...normalizedCc, ...normalizedBcc]
          .map(address => parseAddress(address).email),
      };
      const needsSentCopy = Boolean(sentFolder && !serverAutoSaves);
      const rendered = await renderPreparedSmtp(
        mailOptions,
        envelope,
        { includeBccInSentCopy: needsSentCopy },
      );
      rawMessage = needsSentCopy ? rendered.sentMessage : null;
      const prepared = await query(
        `UPDATE send_operations
            SET message_id = $4, sent_folder = $5, sent_metadata = $6::jsonb,
                raw_message = $7, server_auto_saves = $8,
                smtp_message = $9, smtp_envelope = $10::jsonb,
                prepared_payload_digest = $11, source_snapshots = $12::jsonb,
                prepared_at = NOW(), updated_at = NOW()
          WHERE user_id = $1 AND operation_key = $2 AND payload_digest = $3
            AND state = 'ready' AND smtp_message IS NULL
          RETURNING state, payload_digest, message_id, sent_folder,
                    sent_metadata, raw_message, server_auto_saves, smtp_message,
                    smtp_envelope, prepared_payload_digest, source_snapshots`,
        [
          req.session.userId, idempotencyKey, sendPayloadDigest, messageId,
          sentFolder, sentMeta ? JSON.stringify(sentMeta) : null, rawMessage, serverAutoSaves,
          rendered.message, JSON.stringify(rendered.envelope), rendered.digest,
          JSON.stringify([...forwardedSnapshots.values()]),
        ],
      );
      if (prepared.rowCount !== 1) {
        return res.status(409).json({ error: 'This message is already being prepared or sent.' });
      }
      sendOperation = {
        ...sendOperation, state: 'ready', message_id: messageId, sent_folder: sentFolder,
        sent_metadata: sentMeta, raw_message: rawMessage, server_auto_saves: serverAutoSaves,
        smtp_message: rendered.message, smtp_envelope: rendered.envelope,
        prepared_payload_digest: rendered.digest,
        source_snapshots: [...forwardedSnapshots.values()],
      };
      preparedMail = loadPreparedSmtp({
        message: sendOperation.smtp_message,
        envelope: sendOperation.smtp_envelope,
        digest: sendOperation.prepared_payload_digest,
      });
    }

    await revalidateForwardedSnapshots(forwardedSnapshots);

    const smtp = await createAccountSmtpTransport(account);
    if (smtp.error) return res.status(smtp.status).json({
      error: smtp.error,
      operationKeyDisposition: 'rotate_on_payload_change',
    });
    account = smtp.account;
    const transport = smtp.transport;

    const started = await query(
      `UPDATE send_operations
          SET state = 'provider_started', provider_started_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND operation_key = $2 AND payload_digest = $3
          AND state = 'ready' AND message_id = $4 AND prepared_payload_digest = $5
        RETURNING operation_key`,
      [
        req.session.userId, idempotencyKey, sendPayloadDigest, messageId,
        sendOperation.prepared_payload_digest,
      ],
    );
    if (started.rowCount !== 1) {
      return res.status(409).json({ error: 'This message is already being sent.' });
    }
    operationState = 'provider_started';
    await transport.sendMail(preparedMail);
    const applied = await query(
      `UPDATE send_operations
          SET state = 'provider_applied', provider_applied_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND operation_key = $2 AND payload_digest = $3
          AND state = 'provider_started'
        RETURNING operation_key`,
      [req.session.userId, idempotencyKey, sendPayloadDigest],
    );
    if (applied.rowCount !== 1) throw new Error('Durable send provider receipt was not persisted');
    operationState = 'provider_applied';
    await revalidateForwardedSnapshots(forwardedSnapshots);

    // Auto-learn sent recipients so they rank above inbound-only senders in autocomplete.
    // Fire-and-forget — a DB error here must never affect the send response.
    const allRecipients = [...normalizedTo, ...normalizedCc, ...normalizedBcc];
    if (allRecipients.length) {
      const userId = req.session.userId;
      const now = new Date();
      setImmediate(async () => {
        try {
          // Ensure the user's default address book exists
          const abResult = await query(
            `INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal')
             ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [userId]
          );
          const addressBookId = abResult.rows[0].id;

          const results = await Promise.allSettled(allRecipients.map(addr => {
            const { name, email } = parseAddress(addr);
            if (!email) return Promise.resolve();
            const primaryEmail = email.toLowerCase();
            const displayName = name || primaryEmail;
            const uid    = randomUUID();
            const emails = [{ value: primaryEmail, type: 'other', primary: true }];
            const vcard  = generateVCard({ uid, displayName, emails });
            const etag   = createHash('md5').update(vcard).digest('hex');
            // Upsert by (user_id, primary_email) — bump send_count and promote from is_auto.
            // On conflict, preserve an existing vcard; only fill it in if the row had none.
            return query(`
              INSERT INTO contacts (
                address_book_id, user_id, uid, vcard, etag,
                display_name, primary_email, emails, is_auto, send_count, last_sent
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, 1, $9)
              ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE
                SET send_count   = contacts.send_count + 1,
                    last_sent    = $9,
                    is_auto      = false,
                    display_name = CASE WHEN contacts.is_auto THEN $6 ELSE contacts.display_name END,
                    vcard        = COALESCE(contacts.vcard, EXCLUDED.vcard),
                    etag         = COALESCE(contacts.etag,  EXCLUDED.etag),
                    updated_at   = NOW()
              RETURNING address_book_id
            `, [addressBookId, userId, uid, vcard, etag, displayName, primaryEmail, JSON.stringify(emails), now]);
          }));

          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length) console.warn('Contact upsert errors:', failed.map(r => r.reason?.message));

          // Collect distinct address books actually modified (contacts may live in non-default books).
          const booksToSync = new Set();
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value?.rows?.[0]?.address_book_id) {
              booksToSync.add(r.value.rows[0].address_book_id);
            }
          }
          if (!booksToSync.size) booksToSync.add(addressBookId);

          await Promise.all([...booksToSync].map(bookId =>
            query('UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1', [bookId])
          ));
        } catch (err) {
          console.warn('Contact upsert setup error:', err.message);
        }
      });
    }

    const sendResult = await completeProviderAppliedSend({
      account, operation: sendOperation, userId: req.session.userId,
      idempotencyKey, payloadDigest: sendPayloadDigest,
    });
    operationState = 'completed';
    res.json(sendResult);
  } catch (err) {
    console.error('Send failed:', err.message);
    if (operationState === 'provider_started') {
      const uncertain = await query(
        `UPDATE send_operations
            SET state = 'uncertain', updated_at = NOW()
          WHERE user_id = $1 AND operation_key = $2 AND payload_digest = $3
            AND state = 'provider_started'
          RETURNING operation_key`,
        [req.session.userId, idempotencyKey, sendPayloadDigest],
      ).catch(() => null);
      if (uncertain?.rowCount === 1) operationState = 'uncertain';
    }
    if (operationState === 'provider_applied') {
      return res.status(503).json({
        error: 'Message was delivered, but its Sent copy is still being recovered.',
        code: 'SENT_MATERIALIZATION_PENDING', outcome: 'provider_applied', retryable: true,
        operationKeyDisposition: 'retain',
      });
    }
    if (err?.code === 'MESSAGE_SNAPSHOT_SUPERSEDED') {
      const uncertainOutcome = ['provider_started', 'uncertain'].includes(operationState);
      return res.status(409).json({
        error: err.message, code: err.code,
        outcome: uncertainOutcome ? operationState : 'not_sent',
        retryable: !uncertainOutcome,
        operationKeyDisposition: uncertainOutcome ? 'retain' : 'rotate_on_payload_change',
      });
    }
    if (operationState === 'provider_started' || operationState === 'uncertain') {
      return res.status(409).json({
        error: 'SMTP delivery may have occurred; another delivery is blocked.',
        code: 'SEND_OUTCOME_UNCERTAIN', outcome: operationState, retryable: false,
        operationKeyDisposition: 'retain',
      });
    }
    res.status(500).json({
      error: sanitizeSmtpError(err),
      operationKeyDisposition: 'rotate_on_payload_change',
    });
  }
});

export default router;
