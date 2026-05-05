import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { refreshMicrosoftToken } from './oauth.js';
import { decrypt } from '../services/encryption.js';
import sanitizeHtml from 'sanitize-html';
import { redactEmail } from '../utils/redact.js';
import { resolveForConnection } from '../services/hostValidation.js';

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

const router = Router();
router.use(requireAuth);


router.post('/send', async (req, res) => {
  const { accountId, aliasId, to, cc = [], bcc = [], subject, body, quotedBody, inReplyTo, references } = req.body;
  if (!accountId || !to?.length) return res.status(400).json({ error: 'accountId and to required' });

  let normalizedTo, normalizedCc, normalizedBcc;
  try {
    normalizedTo  = normalizeRecipients(to,  'to');
    normalizedCc  = normalizeRecipients(cc,  'cc');
    normalizedBcc = normalizeRecipients(bcc, 'bcc');
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const normalizedSubject = sanitizeHeaderValue(subject || '');

  const [result, prefResult] = await Promise.all([
    query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]),
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
  ]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;
  let account = result.rows[0];

  // Resolve the From identity — account by default, alias if requested
  let fromName = account.name;
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
      // null (DB default) means inherit from account; only override when alias has an explicit signature set
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  try {
    if (account.oauth_provider === 'microsoft') {
      account = await refreshMicrosoftToken(account);
    }

    let smtpAuth;
    if ((account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
        && account.oauth_access_token) {
      const accessToken = decrypt(account.oauth_access_token);
      if (!accessToken) {
        return res.status(502).json({ error: 'OAuth access token is corrupted — please reconnect your account.' });
      }
      smtpAuth = {
        type: 'OAuth2',
        user: account.auth_user || account.email_address,
        accessToken,
      };
    } else {
      const pass = decrypt(account.auth_pass);
      if (!pass) {
        return res.status(502).json({ error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.' });
      }
      smtpAuth = { user: account.auth_user, pass };
    }

    const smtpResolved = await resolveForConnection(account.smtp_host);
    const smtpTls = { rejectUnauthorized: !account.imap_skip_tls_verify };
    if (smtpResolved.servername) smtpTls.servername = smtpResolved.servername;
    const transport = nodemailer.createTransport({
      host: smtpResolved.host,
      port: account.smtp_port,
      secure: account.smtp_port === 465,
      auth: smtpAuth,
      tls: smtpTls,
    });

    // Use a stable Message-ID so the SMTP copy and any IMAP APPEND reference the same message.
    const domain = fromEmail.split('@')[1] || 'mailflow.local';
    const mailOptions = {
      messageId: `<${randomBytes(16).toString('hex')}@${domain}>`,
      from: `${fromName} <${fromEmail}>`,
      ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
      to: normalizedTo.join(', '),
      cc: normalizedCc.join(', ') || undefined,
      bcc: normalizedBcc.join(', ') || undefined,
      subject: normalizedSubject,
      text: fromSignature
        ? body + '\n\n-- \n' + sigToPlainText(fromSignature) + (quotedBody || '')
        : body + (quotedBody || ''),
      ...(plaintextEmail ? {} : {
        html: textToHtml(body) +
          (fromSignature
            ? '<div style="margin-top:16px;color:#555;font-size:13px">' + fromSignature + '</div>'
            : '') +
          (quotedBody ? textToHtml(quotedBody) : ''),
      }),
    };
    if (inReplyTo) {
      mailOptions.inReplyTo = sanitizeHeaderValue(inReplyTo);
      // Use the full prior references chain if available; fall back to just inReplyTo.
      mailOptions.references = sanitizeHeaderValue(references || inReplyTo);
    }

    // OAuth providers (Gmail, Microsoft) save sent mail to IMAP automatically via their
    // servers — skip APPEND and sync after a delay.  All other accounts use direct IMAP
    // APPEND so sent mail reliably appears regardless of what the SMTP server does.
    const serverAutoSaves = !!account.oauth_provider;

    // For servers that don't auto-save, generate the raw MIME now so we can APPEND it.
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

    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect)
    const imapManager = req.app.get('imapManager');
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
          // APPEND directly to IMAP Sent, then run a sync to pull it into the DB
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
              // Fall back to delayed sync
              setTimeout(() => {
                imapManager.syncFolderOnDemand(account, sentFolder)
                  .catch(e => console.error(`Fallback sync failed: ${e.message}`));
              }, 5000);
            });
        } else {
          // Server auto-saves via SMTP; just sync after a delay
          const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder)
            .then(() => console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`))
            .catch(e => console.error(`Post-send ${label} sync failed: ${e.message}`));
          setTimeout(() => syncAttempt('3s'), 3000);
          setTimeout(() => syncAttempt('15s'), 15000);
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Send failed:', err.message);
    res.status(500).json({ error: sanitizeSmtpError(err) });
  }
});

export default router;
