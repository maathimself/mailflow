import nodemailer from 'nodemailer';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { query } from './db.js';
import { findOwnedAccount, findOwnedMessages } from './ownership.js';
import { sanitizeSignature, sanitizeComposeBody, composeHtmlToText } from './emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { redactEmail } from '../utils/redact.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { MAILER_ID } from './mailerIdentity.js';
import { generateVCard } from '../utils/vcard.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { imapManager } from '../index.js';
import { providerProfile, PROVIDERS } from './imapManager.js';
import { pluginRegistry } from '../plugins/registry.js';
import { deleteSentDraft } from './draftCopies.js';
import { truncateFilename, safeFilename } from '../utils/contentDisposition.js';

// The outgoing message pipeline: validate what the composer sent, resolve the From identity and
// any forwarded content, build the message, deliver it over SMTP and record it (Sent copy, Sent
// row, learned recipients, plugin hook). POST /send calls these in order; the route itself keeps
// only what belongs to the request: the idempotency key, the undo hold and the response.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 25 MB over uploads, forwarded parts and forwarded messages together.
const MAX_ATTACHMENT_BYTES = 26_214_400;

const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);

// A problem with the message itself (bad input, a missing account or forwarded message, an SMTP
// configuration the account cannot send with), answered with `status` and `message` as is.
export class SendError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SendError';
    this.status = status;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Map SMTP/connection errors to user-friendly messages that don't expose server internals.
export function sanitizeSmtpError(err) {
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

function scheduleSentMetadataUpsert(account, sentFolder, mailOptions, meta) {
  if (!sentFolder || !mailOptions.messageId) return;
  setImmediate(async () => {
    for (const delay of [3000, 10000, 20000]) {
      await new Promise(r => setTimeout(r, delay));
      try {
        const uid = await imapManager.findUidByMessageId(account, sentFolder, mailOptions.messageId);
        if (uid) {
          await imapManager.upsertSentMessageRecord(account, sentFolder, uid, meta);
          return;
        }
      } catch (err) {
        console.warn('Post-send sent metadata upsert failed:', err.message);
      }
    }
  });
}

// Reject any recipient address that contains newlines, null bytes, or looks
// malformed: these are the classic email header-injection vectors.
function normalizeRecipients(list, fieldName) {
  if (!Array.isArray(list)) throw new SendError(400, `${fieldName} must be an array`);
  return list.map((addr, i) => {
    if (typeof addr !== 'string' || !addr.trim()) {
      throw new SendError(400, `${fieldName}[${i}] is empty or not a string`);
    }
    const trimmed = addr.trim();
    if (/[\r\n\0]/.test(trimmed)) {
      throw new SendError(400, `${fieldName}[${i}] contains invalid characters`);
    }
    const at = trimmed.lastIndexOf('@');
    if (at < 1 || at === trimmed.length - 1) {
      throw new SendError(400, `${fieldName}[${i}] is not a valid email address`);
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
  return composeHtmlToText(html);
}

function bodyToPlain(body, isHtml) {
  if (!isHtml) return body;
  return composeHtmlToText(body);
}

function bodyToHtml(body, isHtml) {
  if (!isHtml) return textToHtml(body);
  return sanitizeComposeBody(body);
}

// Decoded size of the uploaded (base64) attachments.
function uploadedBytes(attachments) {
  return (attachments || []).reduce((sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0);
}

// The 400 for a send without an account or a recipient, or null. POST /send checks this before
// its idempotency lookup, and validateSendInput checks it again for every other caller.
export function missingSendFields(body) {
  const { accountId, to } = body || {};
  return !accountId || !to?.length ? 'accountId and to required' : null;
}

// Checks the composer's send body and returns it normalized: recipients trimmed and checked,
// subject made a safe header value, priority one of high/normal/low. Throws SendError (400).
// Nothing here reads the database or the mail server, so it is cheap to run before anything else.
export function validateSendInput(body) {
  const { accountId, aliasId, to, cc = [], bcc = [], subject, body: text, bodyIsHtml = false, quotedBody, quotedBodyHtml, inReplyTo, references, attachments, editedSignature, forwardedAttachments, forwardedMessages, priority } = body || {};
  const missing = missingSendFields(body);
  if (missing) throw new SendError(400, missing);

  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) throw new SendError(400, 'attachments must be an array');
    if (attachments.length > 100) throw new SendError(400, 'Too many attachments (max 100)');
    if (uploadedBytes(attachments) > MAX_ATTACHMENT_BYTES) throw new SendError(400, 'Total attachment size exceeds 25 MB');
    for (const [i, a] of attachments.entries()) {
      if (typeof a.filename !== 'string' || !a.filename.trim()) throw new SendError(400, `attachments[${i}].filename is required`);
      if (typeof a.content !== 'string') throw new SendError(400, `attachments[${i}].content must be a base64 string`);
    }
  }

  if (forwardedAttachments !== undefined) {
    if (!Array.isArray(forwardedAttachments)) throw new SendError(400, 'forwardedAttachments must be an array');
    if (forwardedAttachments.length > 100) throw new SendError(400, 'Too many forwarded attachments (max 100)');
    for (const [i, fa] of forwardedAttachments.entries()) {
      if (typeof fa.messageId !== 'string' || !UUID_RE.test(fa.messageId)) throw new SendError(400, `forwardedAttachments[${i}].messageId is invalid`);
      if (typeof fa.part !== 'string' || !fa.part.trim()) throw new SendError(400, `forwardedAttachments[${i}].part is required`);
    }
  }

  // Whole messages forwarded as attachments ("Forward as attachment", #466), as ids. 20 is the
  // most a SpamCop submission takes and bounds how many raw sources one send holds in memory.
  if (forwardedMessages !== undefined) {
    if (!Array.isArray(forwardedMessages)) throw new SendError(400, 'forwardedMessages must be an array');
    if (forwardedMessages.length > 20) throw new SendError(400, 'Too many forwarded messages (max 20)');
    for (const [i, id] of forwardedMessages.entries()) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) throw new SendError(400, `forwardedMessages[${i}] is invalid`);
    }
  }

  return {
    accountId,
    aliasId,
    to: normalizeRecipients(to, 'to'),
    cc: normalizeRecipients(cc, 'cc'),
    bcc: normalizeRecipients(bcc, 'bcc'),
    subject: sanitizeHeaderValue(subject || ''),
    body: text,
    bodyIsHtml,
    quotedBody,
    quotedBodyHtml,
    inReplyTo,
    references,
    attachments,
    editedSignature,
    forwardedAttachments,
    forwardedMessages,
    priority: VALID_PRIORITIES.has(priority) ? priority : 'normal',
  };
}

// The account the message goes out from and who it is from: the account by default, an alias of
// it if one was chosen, and the signature to use. Throws SendError (404) for an account the user
// does not own. `plaintextEmail` is the user's "send plain text only" preference.
export async function resolveIdentity(userId, input) {
  const { accountId, aliasId, editedSignature } = input;
  const [owned, prefResult] = await Promise.all([
    findOwnedAccount(userId, accountId),
    query('SELECT preferences FROM users WHERE id = $1', [userId]),
  ]);
  if (!owned) throw new SendError(404, 'Account not found');
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;

  // Resolve the From identity: account by default, alias if requested
  let fromName = owned.sender_name || owned.name;
  let fromEmail = owned.email_address;
  let fromSignature = owned.signature;
  let replyTo = null;

  if (aliasId) {
    const aliasResult = await query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      fromName = alias.name;
      fromEmail = alias.email;
      replyTo = alias.reply_to || null;
      // null (DB default) means inherit from account; only override when alias has an explicit signature set
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  // Allow the client to override the signature per-send (editedSignature === undefined means use DB value).
  // Sanitize client-supplied HTML to prevent injecting scripts or tracking pixels into sent mail.
  const signature = editedSignature !== undefined
    ? (editedSignature ? sanitizeSignature(editedSignature) : null)
    : fromSignature;  // fromSignature from DB is already sanitized on write

  return { account: owned, plaintextEmail, fromName, fromEmail, replyTo, signature };
}

// Fetches the forwarded attachments and the messages forwarded whole from IMAP, and checks the
// 25 MB total over them and the uploads. Returns { attachments, messages }, both ready for
// mailOptions.attachments. Throws SendError with the status and message the client gets.
// This runs before any SMTP work so that its errors return descriptive messages rather than
// being sanitized as SMTP errors.
export async function resolveForwarded(userId, input) {
  const { attachments, forwardedAttachments, forwardedMessages } = input;
  const resolvedFwdAttachments = [];
  if (forwardedAttachments?.length) {
    try {
      // Resolve every referenced message in a SINGLE ownership-scoped query so a large
      // forwardedAttachments array can't fan out into one DB round-trip per entry.
      const distinctMsgIds = [...new Set(forwardedAttachments.map(fa => fa.messageId))];
      const msgRows = await findOwnedMessages(userId, distinctMsgIds, {
        columns: 'm.id, m.uid, m.folder, m.attachments, m.account_id',
      });
      const msgById = new Map(msgRows.map(m => [m.id, m]));

      // Build the fetch plan (one entry per requested attachment, order preserved) and sum the
      // DECLARED sizes so an oversized batch is rejected BEFORE any IMAP fetch happens.
      const uploaded = uploadedBytes(attachments);
      let declaredFwdBytes = 0;
      const fetchPlan = forwardedAttachments.map((fa) => {
        const msg = msgById.get(fa.messageId);
        if (!msg) throw new SendError(404, 'Forwarded message not found');
        const storedAtts = typeof msg.attachments === 'string'
          ? JSON.parse(msg.attachments || '[]')
          : (msg.attachments || []);
        const att = storedAtts.find(a => a.part === fa.part);
        if (!att) throw new SendError(404, 'Attachment not found in message');
        declaredFwdBytes += Number(att.size) || 0;
        return { msg, att };
      });
      if (uploaded + declaredFwdBytes > MAX_ATTACHMENT_BYTES) {
        throw new SendError(400, 'Total attachment size exceeds 25 MB');
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
          if (!acct) throw new SendError(404, 'Account not found');
          const buffer = await imapManager.fetchAttachment(acct, msg.uid, msg.folder, att.part);
          if (!buffer) throw new SendError(502, `Could not fetch attachment: ${att.filename}`);
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
      if (uploaded + fwdBytes > MAX_ATTACHMENT_BYTES) {
        throw new SendError(400, 'Total attachment size exceeds 25 MB');
      }
    } catch (err) {
      throw asSendError(err, 'Failed to fetch forwarded attachments');
    }
  }

  // Each forwarded message is attached as its raw RFC 822 source, every original header intact,
  // which is what an inline forward loses and abuse desks such as SpamCop need (#466). message/*
  // goes out 7bit or 8bit (RFC 2046 rules out base64 for it) and nodemailer would mark it inline, so the
  // disposition is set explicitly. Its size is known only once fetched, so the 25 MB total is
  // checked as each one arrives.
  const resolvedFwdMessages = [];
  if (forwardedMessages?.length) {
    try {
      const ids = [...new Set(forwardedMessages)];
      const rows = await findOwnedMessages(userId, ids, {
        columns: 'm.id, m.uid, m.folder, m.subject, m.account_id',
        live: true,
      });
      const byId = new Map(rows.map(r => [r.id, r]));
      if (ids.some(id => !byId.has(id))) throw new SendError(404, 'Forwarded message not found');
      const accts = (await query('SELECT * FROM email_accounts WHERE id = ANY($1::uuid[])', [[...new Set(rows.map(r => r.account_id))]])).rows;
      const acctById = new Map(accts.map(a => [a.id, a]));
      let totalBytes = uploadedBytes(attachments)
        + resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
      for (const id of ids) {
        const msg = byId.get(id);
        const acct = acctById.get(msg.account_id);
        if (!acct) throw new SendError(404, 'Account not found');
        const source = await imapManager.fetchRawMessage(acct, msg.uid, msg.folder);
        if (!source) throw new SendError(502, 'Could not fetch the forwarded message');
        totalBytes += source.length;
        if (totalBytes > MAX_ATTACHMENT_BYTES) throw new SendError(400, 'Total attachment size exceeds 25 MB');
        resolvedFwdMessages.push({
          filename: safeFilename(`${truncateFilename(sanitizeHeaderValue(msg.subject || '') || 'message', 80)}.eml`),
          content: source,
          contentType: 'message/rfc822',
          contentDisposition: 'attachment',
        });
      }
    } catch (err) {
      throw asSendError(err, 'Failed to fetch forwarded messages');
    }
  }

  return { attachments: resolvedFwdAttachments, messages: resolvedFwdMessages };
}

// Any failure while fetching forwarded content is the client's answer: its status (500 when it
// has none) and its message (or `fallback`).
function asSendError(err, fallback) {
  if (err instanceof SendError) return err;
  return new SendError(err.status || 500, err.message || fallback);
}

// The nodemailer message for a validated input, its identity and its forwarded content. Every
// call gets a new random Message-ID and its own Date, both fixed here, so the SMTP copy and the
// Sent APPEND, two renders of the same object, carry the same ones. `options.messageId` replaces
// the random one, for a message whose Message-ID was fixed before (scheduled send reuses one on
// every attempt), and `options.date` the current time.
export function buildMailOptions(input, identity, forwarded = { attachments: [], messages: [] }, options = {}) {
  const { body, bodyIsHtml, quotedBody, quotedBodyHtml, inReplyTo, references, attachments, priority } = input;
  const { fromName, fromEmail, replyTo, signature, plaintextEmail } = identity;

  // Use a stable Message-ID so the SMTP copy and any IMAP APPEND reference the same message.
  const domain = fromEmail.split('@')[1] || 'mailflow.local';
  const messageId = options.messageId === undefined
    ? `<${randomBytes(16).toString('hex')}@${domain}>`
    : checkedMessageId(options.messageId);
  const mailOptions = {
    xMailer: MAILER_ID,
    messageId,
    // Set explicitly: left out, nodemailer dates each render on its own, and the Sent copy,
    // rendered before the SMTP round trip, was dated earlier than the copy recipients got.
    date: options.date === undefined ? new Date() : checkedDate(options.date),
    from: `${fromName} <${fromEmail}>`,
    ...(replyTo ? { replyTo } : {}),
    to: input.to.join(', '),
    cc: input.cc.join(', ') || undefined,
    bcc: input.bcc.join(', ') || undefined,
    subject: input.subject,
    ...(priority !== 'normal' ? { priority } : {}),
    text: signature
      ? bodyToPlain(body, bodyIsHtml) + '\n\n-- \n' + sigToPlainText(signature) + (quotedBody || '')
      : bodyToPlain(body, bodyIsHtml) + (quotedBody || ''),
  };

  let inlineImageAttachments = [];
  if (!plaintextEmail) {
    const rawHtml = bodyToHtml(body, bodyIsHtml) +
      (signature
        ? '<div style="margin-top:16px;color:#555;font-size:13px">' + signature + '</div>'
        : '') +
      (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
    const embedded = embedInlineDataImages(rawHtml);
    mailOptions.html = embedded.html;
    inlineImageAttachments = embedded.attachments;
  }

  if (inReplyTo) {
    mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
    // Use the full prior references chain if available; fall back to just inReplyTo.
    mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
  } else if (references) {
    mailOptions.references = sanitizeHeaderValue(references);
  }
  const allAttachments = [
    ...inlineImageAttachments,
    ...(attachments?.length ? attachments.map(a => ({
      filename: sanitizeHeaderValue(a.filename),
      content: Buffer.from(a.content, 'base64'),
      contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
    })) : []),
    ...forwarded.attachments,
    ...forwarded.messages,
  ];
  if (allAttachments.length) {
    mailOptions.attachments = allAttachments;
  }
  return mailOptions;
}

// A Message-ID given to buildMailOptions: <local@domain> of a bounded length, with no space,
// no control character and nothing else that could end the header or open another address.
// eslint-disable-next-line no-control-regex
const MESSAGE_ID_RE = /^<[^<>@\s\x00-\x1f\x7f]{1,200}@[^<>@\s\x00-\x1f\x7f]{1,255}>$/;

function checkedMessageId(messageId) {
  if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
    throw new TypeError('messageId must look like <local@domain>');
  }
  return messageId;
}

function checkedDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('date must be a valid Date');
  return date;
}

// OAuth providers (Gmail, Microsoft) save sent mail to IMAP automatically via their
// servers: skip APPEND and sync after a delay. All other accounts use direct IMAP
// APPEND so sent mail reliably appears regardless of what the SMTP server does.
// Gmail is the exception on the non-OAuth side too: its SMTP server always stores the
// Sent copy itself, even for app-password (IMAP) accounts, and APPENDing our own copy
// used to store every sent mail twice (#631). Only trust Gmail to auto-save when the
// account both reads Gmail IMAP and sends through Gmail's own SMTP with that mailbox's
// own credentials: a Gmail-IMAP account behind SendGrid/SES/smtp-relay.gmail.com never
// reaches Gmail's SMTP (the APPEND is then the only Sent copy), a non-Gmail IMAP
// account sending via smtp.gmail.com gets its copy in Gmail's mailbox rather than its
// own, and smtp_auth_user ≠ auth_user means the copy lands in whoever logged in to
// SMTP. A missing Sent copy is worse than a duplicate, so anything ambiguous APPENDs.
const isGmailSmtpHost = h => /^smtp\.(gmail|googlemail)\.com$/i.test(String(h || ''));

export function serverAutoSavesSent(account) {
  const smtpUser = String(account.smtp_auth_user || '').trim().toLowerCase();
  const imapUser = String(account.auth_user || '').trim().toLowerCase();
  return !!account.oauth_provider
    || (providerProfile(account) === PROVIDERS.google
      && isGmailSmtpHost(account.smtp_host)
      && (!smtpUser || smtpUser === imapUser));
}

// The raw MIME of a message, for the Sent APPEND of a server that does not auto-save.
// Use CRLF newlines ('windows'): RFC 5322 / IMAP APPEND require CRLF. A bare-LF message is
// stored verbatim by strict servers (e.g. PurelyMail/Dovecot), and downstream clients then
// mis-parse the headers: the reporter saw Subject and the To display-name dropped (#365). This
// only affects accounts whose server does not auto-save (OAuth and Gmail-over-Gmail accounts
// skip this path); the SMTP-delivered copy uses a separate transport that is already CRLF, so
// only the Sent copy was wrong.
export async function renderRawMessage(mailOptions) {
  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks = [];
  await new Promise((resolve, reject) => {
    streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    streamInfo.message.on('end', resolve);
    streamInfo.message.on('error', reject);
  });
  return Buffer.concat(chunks);
}

// Everything delivery needs, decided before anything is sent: the SMTP transport (which may
// refresh the account's OAuth token, hence the account it returns), the message, whether the
// server saves the Sent copy itself and, if not, the raw copy to APPEND. Throws SendError for an
// SMTP configuration the account cannot send with; any other error is an SMTP-side failure.
// `options` goes to buildMailOptions, whose fixed messageId and date are checked before anything
// connects, and `options.smtp` to createAccountSmtpTransport.
export async function prepareDelivery(input, identity, forwarded, options = {}) {
  if (options.messageId !== undefined) checkedMessageId(options.messageId);
  if (options.date !== undefined) checkedDate(options.date);
  const smtp = await createAccountSmtpTransport(identity.account, options.smtp);
  if (smtp.error) throw new SendError(smtp.status, smtp.error);
  const account = smtp.account;
  const mailOptions = buildMailOptions(input, identity, forwarded, options);
  const serverAutoSaves = serverAutoSavesSent(account);
  // For servers that don't auto-save, generate the raw MIME now so we can APPEND it.
  const rawMessage = serverAutoSaves ? null : await renderRawMessage(mailOptions);
  return { account, transport: smtp.transport, mailOptions, serverAutoSaves, rawMessage };
}

// The fields of a nodemailer SMTP error that say what failed: responseCode (e.g. 421, 550),
// code (e.g. EENVELOPE, ECONNECTION) and command (e.g. RCPT TO, DATA, CONN).
function smtpErrorFields(err) {
  const fields = {};
  for (const name of ['responseCode', 'code', 'command']) {
    if (err?.[name] !== undefined) fields[name] = err[name];
  }
  return fields;
}

// Adds the recipients of a sent message to the user's contacts, or bumps their send count, so
// they rank above inbound-only senders in autocomplete. Never rejects: errors are logged.
async function learnRecipients(userId, allRecipients, now) {
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
      // Upsert by (user_id, primary_email): bump send_count and promote from is_auto.
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
}

// Delivers a prepared message over SMTP and records it: deletes the draft it was written in,
// learns its recipients, stores the Sent copy exactly once and its Sent row, and runs the
// plugins' onSentMessage hook. Resolves the send result ({ ok, sentCopySaved?, rejected?,
// sentFolder?, messageId? }); rejects, only when SMTP did not accept the message, with an error
// whose publicMessage is safe to show the user, the SMTP error as its cause, and that error's
// responseCode, code and command where it has them.
//
// `sentDraft` is the draft to delete ({ uid, folder, accountId }) or null. The hooks:
// - onDelivered(early, { refusals }): awaited as soon as SMTP has accepted the message (see
//   sendHold.js). `refusals` lists each recipient the server refused at RCPT with its reply
//   code, so a caller can tell a deferral (4xx) from a rejection (5xx). With the hook, the result
//   also waits for recipient learning, since nobody is waiting on the response then; without it
//   the learning runs on after the result.
// - onResult(sendResult): called synchronously with the final result, before it resolves.
// - onFailure(): called synchronously when delivery failed, before the rejection.
export async function deliverAndRecord(
  { userId, input, identity, delivery, sentDraft = null },
  { onDelivered, onResult, onFailure } = {},
) {
  const { account, transport, mailOptions, serverAutoSaves, rawMessage } = delivery;
  const { fromName, fromEmail } = identity;
  let delivered = false; // true once transport.sendMail has actually handed off the message
  let rejected = [];
  let learning = Promise.resolve(); // never rejects: its errors are logged inside
  try {
    const info = await transport.sendMail(mailOptions);
    delivered = true;
    // A server that accepts some recipients and refuses others at RCPT still resolves, so
    // the refused ones must be reported or they are dropped without anyone knowing.
    if (Array.isArray(info?.rejected) && info.rejected.length) {
      rejected = info.rejected.map(String);
      // Codes only: the server's response text usually echoes the unredacted address.
      const codes = (info.rejectedErrors || []).map(e => e?.responseCode).filter(Boolean);
      console.warn(`SMTP refused ${rejected.length} recipient(s) for ${redactEmail(account.email_address)}: ${rejected.map(redactEmail).join(', ')}${codes.length ? ` (${codes.join(', ')})` : ''}`);
    }
    const refusals = (info?.rejectedErrors || [])
      .filter(e => e?.recipient)
      .map(e => ({ recipient: String(e.recipient), responseCode: Number(e.responseCode) || null }));
    await onDelivered?.({ ok: true, ...(rejected.length ? { rejected } : {}) }, { refusals });
    // Awaited, like the contact learning of a held send below: a shutdown delivers held sends
    // and waits for them to finish, and work left in a setImmediate would be cut off.
    if (sentDraft) await deleteSentDraft(userId, account, sentDraft);

    // Auto-learn sent recipients. A DB error here must never affect the send response. An
    // immediate send does not wait for it; a held send does, because nobody is waiting on that
    // response.
    const allRecipients = [...input.to, ...input.cc, ...input.bcc];
    if (allRecipients.length) {
      learning = learnRecipients(userId, allRecipients, mailOptions.date);
    }

    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect,
    // but a mapping pointing at a non-selectable folder is ignored in favor of \Sent, #386).
    const sentFolder = await resolveSentFolder(input.accountId, account.folder_mappings);
    console.log(`Post-send: ${redactEmail(account.email_address)} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

    // sentCopySaved: null = not applicable (server auto-saves, or no Sent folder resolved);
    // true/false = whether OUR IMAP APPEND landed the Sent copy. Surfaced to the client so
    // it can warn when a delivered message could not be saved to Sent.
    let sentCopySaved = null;
    const sentMeta = sentFolder ? {
      messageId: mailOptions.messageId,
      subject: input.subject,
      fromName,
      fromEmail,
      to: mapRecipientList(input.to),
      cc: mapRecipientList(input.cc),
      // The Sent copy carries a Bcc header, but the row did not, so the reading pane had no
      // Bcc to show for a message you sent (#585).
      bcc: mapRecipientList(input.bcc),
      snippet: buildSentSnippet(input.body, input.bodyIsHtml),
      date: mailOptions.date,
      // Carried so the Sent row threads into its conversation via the References chain
      // rather than orphaning at its own Message-ID (#378).
      inReplyTo: mailOptions.inReplyTo || null,
      references: mailOptions.references || null,
    } : null;

    if (sentFolder) {
      if (rawMessage) {
        // Non-auto-saving account: APPEND the Sent copy ourselves, exactly ONCE. IMAP
        // APPEND is NOT idempotent (unlike a \Seen flag), so we must not retry: a retry
        // whose first attempt merely timed out (but still lands on the server) would store
        // a SECOND copy. Bound the wait so a stalled connection can't hang the response;
        // the abandoned append can at worst still save the single copy. On failure, warn
        // the user and schedule a fallback sync in case the append landed late. Audit [2].
        sentCopySaved = false;
        try {
          const { uid } = await Promise.race([
            imapManager.appendToSent(account, sentFolder, rawMessage),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Sent APPEND timed out')), 20000)),
          ]);
          sentCopySaved = true;
          if (uid && sentMeta) {
            await imapManager.upsertSentMessageRecord(account, sentFolder, uid, sentMeta)
              .catch(err => console.warn('Sent metadata upsert failed:', err.message));
          }
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder)
              // Once the Sent copy is in the DB, notify label plugins the message synced: GTD
              // re-runs transitions for its thread (a reply to a Todo/Someday thread means the
              // owner acted, so that label should drop). The sent message reaches no other hook
              // (Sent isn't INBOX, and the tick watches only the state folders), so this is the
              // only trigger. The hook swallows per-plugin errors; the next inbound sync / tick
              // self-heals.
              .then(() => pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId }))
              .catch(e => console.error(`Post-append sync failed: ${e.message}`));
          }, 1000);
        } catch (appendErr) {
          console.error(`IMAP append to Sent failed for ${redactEmail(account.email_address)}/${sentFolder}: ${appendErr.message}`);
          // The append may still have landed (or land shortly), so pull the folder: a
          // late-completing append then self-corrects the DB rather than staying invisible.
          setTimeout(() => {
            imapManager.syncFolderOnDemand(account, sentFolder)
              .catch(e => console.error(`Post-append fallback sync failed: ${e.message}`));
          }, 8000);
        }
      } else {
        // Server auto-saves via SMTP; seed metadata once the Sent copy is searchable.
        if (sentMeta) scheduleSentMetadataUpsert(account, sentFolder, mailOptions, sentMeta);
        // Server auto-saves via SMTP; just sync after a delay. Two attempts because the
        // provider (e.g. Gmail) can be slow to expose the sent message; the 3s pass usually
        // catches it, the 15s pass is the safety net. GTD transitions run after each: the 3s
        // attempt may miss (Sent copy not yet visible, so an empty thread set and a no-op) and
        // the 15s attempt then catches it; if 3s already stripped, 15s is an idempotent no-op.
        const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder)
          .then(() => {
            console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`);
            return pluginRegistry.runHook('onSentMessage', { imapManager: imapManager.pluginFacade, account, messageId: mailOptions.messageId });
          })
          .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
        setTimeout(() => syncAttempt('3s'), 3000);
        setTimeout(() => syncAttempt('15s'), 15000);
      }
    }

    const sendResult = { ok: true };
    // Surface only the problem case so existing success handling is unchanged; the UI warns
    // when a delivered message could not be saved to the account's Sent folder.
    if (sentCopySaved === false) sendResult.sentCopySaved = false;
    if (rejected.length) sendResult.rejected = rejected;
    // Tell the client which Sent folder we actually resolved to, so its post-send "View"
    // navigates to the real folder rather than recomputing from a possibly-stale mapping (#386).
    if (sentFolder) {
      sendResult.sentFolder = sentFolder;
      // So "View" can open this message once its Sent copy is listed, not just the folder.
      sendResult.messageId = mailOptions.messageId;
    }
    onResult?.(sendResult);
    if (onDelivered) await learning;
    return sendResult;
  } catch (err) {
    if (delivered) {
      // SMTP already accepted this message. A Sent-folder or metadata failure
      // must not invite the user to send it again.
      console.error('Post-send processing failed:', err.message);
      const sendResult = { ok: true, sentCopySaved: false };
      if (rejected.length) sendResult.rejected = rejected;
      onResult?.(sendResult);
      if (onDelivered) await learning;
      return sendResult;
    }
    console.error('Send failed:', err.message);
    onFailure?.();
    // The SMTP error stays on it, as cause and its nodemailer fields, so a caller can tell a
    // temporary refusal (4xx) from a permanent one (5xx), and at which command it failed.
    throw Object.assign(new Error('Send failed', { cause: err }), {
      publicMessage: sanitizeSmtpError(err),
      ...smtpErrorFields(err),
    });
  }
}
