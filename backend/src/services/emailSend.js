import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';
import { redactEmail } from '../utils/redact.js';
import { refreshMicrosoftToken } from '../routes/oauth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function normalizeRecipients(list, fieldName) {
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

export function sanitizeHeaderValue(value) {
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
  return sanitizeHtml(body, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['u', 's']),
    allowedAttributes: { '*': ['style'], 'a': ['href', 'target', 'rel'] },
  });
}

export async function buildSmtpTransport(account) {
  let smtpAuth;
  if ((account.oauth_provider === 'microsoft' || account.oauth_provider === 'google') && account.oauth_access_token) {
    const accessToken = decrypt(account.oauth_access_token);
    if (!accessToken) {
      throw Object.assign(new Error('OAuth access token is corrupted — please reconnect your account.'), { status: 502 });
    }
    smtpAuth = { type: 'OAuth2', user: account.auth_user || account.email_address, accessToken };
  } else {
    const pass = decrypt(account.auth_pass);
    if (!pass) {
      throw Object.assign(new Error('SMTP password is corrupted or missing — please re-enter your account password in Settings.'), { status: 502 });
    }
    smtpAuth = { user: account.auth_user, pass };
  }
  const resolved = await resolveForConnection(account.smtp_host);
  const tls = { rejectUnauthorized: !account.imap_skip_tls_verify };
  if (resolved.servername) tls.servername = resolved.servername;
  return nodemailer.createTransport({
    host: resolved.host,
    port: account.smtp_port,
    secure: account.smtp_port === 465,
    auth: smtpAuth,
    tls,
  });
}

// Core send logic — used by both the HTTP route and MCP tools.
// `to`, `cc`, `bcc` may each be a string (single address) or array of strings.
// Throws on validation/auth/SMTP errors; errors with a `.status` property are
// safe to surface directly to callers (validation, not-found, auth failures).
export async function sendEmail({
  accountId, aliasId,
  to, cc = [], bcc = [], subject, body = '', bodyIsHtml = false,
  quotedBody, quotedBodyHtml, inReplyTo, references,
  attachments, editedSignature, forwardedAttachments,
}, userId, imapManager) {
  if (!accountId || !to?.length) {
    throw Object.assign(new Error('accountId and to required'), { status: 400 });
  }

  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) throw Object.assign(new Error('attachments must be an array'), { status: 400 });
    const totalBytes = attachments.reduce((sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0);
    if (totalBytes > 26_214_400) throw Object.assign(new Error('Total attachment size exceeds 25 MB'), { status: 400 });
    for (const [i, a] of attachments.entries()) {
      if (typeof a.filename !== 'string' || !a.filename.trim()) throw Object.assign(new Error(`attachments[${i}].filename is required`), { status: 400 });
      if (typeof a.content !== 'string') throw Object.assign(new Error(`attachments[${i}].content must be a base64 string`), { status: 400 });
    }
  }

  if (forwardedAttachments !== undefined) {
    if (!Array.isArray(forwardedAttachments)) throw Object.assign(new Error('forwardedAttachments must be an array'), { status: 400 });
    for (const [i, fa] of forwardedAttachments.entries()) {
      if (typeof fa.messageId !== 'string' || !UUID_RE.test(fa.messageId)) throw Object.assign(new Error(`forwardedAttachments[${i}].messageId is invalid`), { status: 400 });
      if (typeof fa.part !== 'string' || !fa.part.trim()) throw Object.assign(new Error(`forwardedAttachments[${i}].part is required`), { status: 400 });
    }
  }

  const toArr  = Array.isArray(to)  ? to  : [to];
  const ccArr  = Array.isArray(cc)  ? cc  : (cc  ? [cc]  : []);
  const bccArr = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);
  const normalizedTo  = normalizeRecipients(toArr,  'to');
  const normalizedCc  = normalizeRecipients(ccArr,  'cc');
  const normalizedBcc = normalizeRecipients(bccArr, 'bcc');
  const normalizedSubject = sanitizeHeaderValue(subject || '');

  const [result, prefResult] = await Promise.all([
    query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]),
    query('SELECT preferences FROM users WHERE id = $1', [userId]),
  ]);
  if (!result.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;
  let account = result.rows[0];

  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;
  let fromReplyTo = null;

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
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  const effectiveSignature = editedSignature !== undefined ? (editedSignature || null) : fromSignature;

  let resolvedFwdAttachments = [];
  if (forwardedAttachments?.length) {
    resolvedFwdAttachments = await Promise.all(forwardedAttachments.map(async (fa) => {
      const msgResult = await query(
        `SELECT m.uid, m.folder, m.attachments, m.account_id FROM messages m
         JOIN email_accounts a ON m.account_id = a.id
         WHERE m.id = $1 AND a.user_id = $2`,
        [fa.messageId, userId]
      );
      if (!msgResult.rows.length) throw Object.assign(new Error('Forwarded message not found'), { status: 404 });
      const msg = msgResult.rows[0];
      const storedAtts = typeof msg.attachments === 'string'
        ? JSON.parse(msg.attachments || '[]')
        : (msg.attachments || []);
      const att = storedAtts.find(a => a.part === fa.part);
      if (!att) throw Object.assign(new Error('Attachment not found in message'), { status: 404 });
      const accResult = await query('SELECT * FROM email_accounts WHERE id = $1', [msg.account_id]);
      if (!accResult.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
      const buffer = await imapManager.fetchAttachment(accResult.rows[0], msg.uid, msg.folder, fa.part);
      if (!buffer) throw Object.assign(new Error(`Could not fetch attachment: ${att.filename}`), { status: 502 });
      return {
        filename: sanitizeHeaderValue(att.filename || 'attachment'),
        content: buffer,
        contentType: att.type || 'application/octet-stream',
      };
    }));

    const uploadedBytes = (attachments || []).reduce(
      (sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0
    );
    const fwdBytes = resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
    if (uploadedBytes + fwdBytes > 26_214_400) {
      throw Object.assign(new Error('Total attachment size exceeds 25 MB'), { status: 400 });
    }
  }

  if (account.oauth_provider === 'microsoft') {
    account = await refreshMicrosoftToken(account);
  }
  const transport = await buildSmtpTransport(account);

  const domain = fromEmail.split('@')[1] || 'mailflow.local';
  const mailOptions = {
    messageId: `<${randomBytes(16).toString('hex')}@${domain}>`,
    from: `${fromName} <${fromEmail}>`,
    ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
    to: normalizedTo.join(', '),
    cc: normalizedCc.join(', ') || undefined,
    bcc: normalizedBcc.join(', ') || undefined,
    subject: normalizedSubject,
    text: effectiveSignature
      ? bodyToPlain(body, bodyIsHtml) + '\n\n-- \n' + sigToPlainText(effectiveSignature) + (quotedBody || '')
      : bodyToPlain(body, bodyIsHtml) + (quotedBody || ''),
    ...(plaintextEmail ? {} : {
      html: bodyToHtml(body, bodyIsHtml) +
        (effectiveSignature
          ? '<div style="margin-top:16px;color:#555;font-size:13px">' + effectiveSignature + '</div>'
          : '') +
        (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : '')),
    }),
  };
  if (inReplyTo) {
    mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
    mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
  }
  const allAttachments = [
    ...(attachments?.length ? attachments.map(a => ({
      filename: sanitizeHeaderValue(a.filename),
      content: Buffer.from(a.content, 'base64'),
      contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
    })) : []),
    ...resolvedFwdAttachments,
  ];
  if (allAttachments.length) mailOptions.attachments = allAttachments;

  // OAuth providers (Gmail, Microsoft) save sent mail automatically via their SMTP servers.
  // All other accounts use direct IMAP APPEND so sent mail reliably appears.
  const serverAutoSaves = !!account.oauth_provider;
  let rawMessage = null;
  if (!serverAutoSaves) {
    const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
    const streamInfo = await streamTransport.sendMail(mailOptions);
    const chunks = [];
    await new Promise((resolve, reject) => {
      streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      streamInfo.message.on('end', resolve);
      streamInfo.message.on('error', reject);
    });
    rawMessage = Buffer.concat(chunks);
  }

  await transport.sendMail(mailOptions);

  if (imapManager) {
    let sentFolder = account.folder_mappings?.sent || null;
    if (!sentFolder) {
      const folderResult = await query(
        "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1",
        [accountId]
      );
      sentFolder = folderResult.rows[0]?.path || null;
    }
    console.log(`Post-send: ${redactEmail(account.email_address)} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

    if (sentFolder) {
      if (rawMessage) {
        imapManager.appendToSent(account, sentFolder, rawMessage)
          .then(() => {
            setTimeout(() => {
              imapManager.syncFolderOnDemand(account, sentFolder)
                .then(() => console.log(`Post-append sync done: ${redactEmail(account.email_address)}/${sentFolder}`))
                .catch(e => console.error(`Post-append sync failed: ${e.message}`));
            }, 1000);
          })
          .catch(err => {
            console.error(`IMAP append failed for ${redactEmail(account.email_address)}/${sentFolder}: ${err.message}`);
            setTimeout(() => {
              imapManager.syncFolderOnDemand(account, sentFolder)
                .catch(e => console.error(`Fallback sync failed: ${e.message}`));
            }, 5000);
          });
      } else {
        const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder)
          .then(() => console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`))
          .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
        setTimeout(() => syncAttempt('3s'), 3000);
        setTimeout(() => syncAttempt('15s'), 15000);
      }
    }
  }
}
