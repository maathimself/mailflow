import nodemailer from 'nodemailer';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { refreshMicrosoftToken } from './oauth.js';
import { decrypt } from '../services/encryption.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { redisClient } from '../services/redis.js';
import { redactEmail } from '../utils/redact.js';
import { generateVCard } from '../utils/vcard.js';
import { resolveForConnection } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { imapManager } from '../index.js';
import { runTransitionsForSentMessage } from '../services/gtdTransitions.js';

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
    ? req.headers['x-idempotency-key'].slice(0, 128)
    : null;
  const idemKeyRedis = idempotencyKey ? `send_idem:${req.session.userId}:${idempotencyKey}` : null;
  if (idemKeyRedis) {
    const cached = await redisClient.get(idemKeyRedis).catch(() => null);
    if (cached === '__inflight__') return res.status(409).json({ error: 'This message is already being sent.' });
    if (cached) return res.json(JSON.parse(cached));
  }

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

  const [result, prefResult] = await Promise.all([
    query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, req.session.userId]),
    query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]),
  ]);
  if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
  const plaintextEmail = prefResult.rows[0]?.preferences?.plaintextEmail === true;
  let account = result.rows[0];

  // Resolve the From identity — account by default, alias if requested
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
      // null (DB default) means inherit from account; only override when alias has an explicit signature set
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  // Allow the client to override the signature per-send (editedSignature === undefined means use DB value).
  // Sanitize client-supplied HTML to prevent injecting scripts or tracking pixels into sent mail.
  const effectiveSignature = editedSignature !== undefined
    ? (editedSignature ? sanitizeSignature(editedSignature) : null)
    : fromSignature;  // fromSignature from DB is already sanitized on write

  // Fetch forwarded attachment content from IMAP before entering the SMTP try-block so that
  // attachment errors return descriptive messages rather than being sanitized as SMTP errors.
  let resolvedFwdAttachments = [];
  if (forwardedAttachments?.length) {
    try {
      resolvedFwdAttachments = await Promise.all(forwardedAttachments.map(async (fa) => {
        const msgResult = await query(
          `SELECT m.uid, m.folder, m.attachments, m.account_id FROM messages m
           JOIN email_accounts a ON m.account_id = a.id
           WHERE m.id = $1 AND a.user_id = $2`,
          [fa.messageId, req.session.userId]
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

      // Combined size check: user uploads + forwarded content
      const uploadedBytes = (attachments || []).reduce(
        (sum, a) => sum + (typeof a.content === 'string' ? Math.ceil(a.content.length * 0.75) : 0), 0
      );
      const fwdBytes = resolvedFwdAttachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
      if (uploadedBytes + fwdBytes > 26_214_400) {
        return res.status(400).json({ error: 'Total attachment size exceeds 25 MB' });
      }
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Failed to fetch forwarded attachments' });
    }
  }

  let delivered = false; // true once transport.sendMail has actually handed off the message
  try {
    if (account.oauth_provider === 'microsoft') {
      // Only refresh when the token is near/at expiry (mirrors imapManager's
      // ensureFreshToken). Refreshing on every send needlessly rotates the AAD
      // refresh token and can invalidate it under concurrent sends.
      const expiryMs = account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : 0;
      if (expiryMs - Date.now() < 5 * 60 * 1000) {
        account = await refreshMicrosoftToken(account);
      }
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

    const policy = await getConnectionPolicy();
    const smtpResolved = await resolveForConnection(account.smtp_host, { allowPrivate: policy.allowPrivateHosts });
    const smtpPlain = account.smtp_tls !== 'STARTTLS' && account.smtp_tls !== 'SSL';
    if (!policy.allowInsecureTls && smtpPlain) {
      return res.status(403).json({ error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"' });
    }
    const smtpTls = { rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify) };
    if (smtpResolved.servername) smtpTls.servername = smtpResolved.servername;
    // For 'SSL': force direct TLS. For 'none': plain with no upgrade.
    // For 'STARTTLS' (or any other/legacy value): fall back to port-based detection
    // so existing accounts stored with the default 'STARTTLS' on port 465 keep working.
    const smtpSecure = account.smtp_tls === 'SSL' || (account.smtp_tls !== 'none' && account.smtp_port === 465);
    const transport = nodemailer.createTransport({
      host: smtpResolved.host,
      port: account.smtp_port,
      secure: smtpSecure,
      ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
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
      // Use the full prior references chain if available; fall back to just inReplyTo.
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
    if (allAttachments.length) {
      mailOptions.attachments = allAttachments;
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

    // Reserve the idempotency key atomically right before delivery so a concurrent
    // same-key submit cannot also send (the post-send cache alone can't stop concurrent
    // duplicates). Overwritten with the result on success; released in the catch only if
    // delivery never happened, so a genuine retry after a pre-send failure can proceed.
    if (idemKeyRedis) {
      // TTL comfortably above the worst-case send (large attachment over a slow SMTP
      // server) so the in-flight guard cannot lapse while this request is still running.
      const reserved = await redisClient.set(idemKeyRedis, '__inflight__', { NX: true, EX: 300 }).catch(() => 'OK');
      if (reserved === null) return res.status(409).json({ error: 'This message is already being sent.' });
    }

    await transport.sendMail(mailOptions);
    delivered = true;

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

    // Get the Sent folder path (manual mapping takes priority over special_use auto-detect)
    let sentFolder = account.folder_mappings?.sent || null;
    if (!sentFolder) {
      const folderResult = await query(
        "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1",
        [accountId]
      );
      sentFolder = folderResult.rows[0]?.path || null;
    }
    console.log(`Post-send: ${redactEmail(account.email_address)} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

    // sentCopySaved: null = not applicable (server auto-saves, or no Sent folder resolved);
    // true/false = whether OUR IMAP APPEND landed the Sent copy. Surfaced to the client so
    // it can warn when a delivered message could not be saved to Sent.
    let sentCopySaved = null;
    const sentMeta = sentFolder ? {
      messageId: mailOptions.messageId,
      subject: normalizedSubject,
      fromName,
      fromEmail,
      to: mapRecipientList(normalizedTo),
      cc: mapRecipientList(normalizedCc),
      snippet: buildSentSnippet(body, bodyIsHtml),
      date: new Date(),
    } : null;

    if (sentFolder) {
      if (rawMessage) {
        // Non-auto-saving account: APPEND the Sent copy ourselves — exactly ONCE. IMAP
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
              // Once the Sent copy is in the DB, re-run GTD transitions for its thread: a reply
              // to a Todo/Someday thread means the owner acted, so that label should drop. The
              // sent message reaches no other GTD hook (Sent isn't INBOX, and the tick watches
              // only the state folders), so this is the only trigger. Swallow on failure — the
              // next inbound sync / GTD tick self-heals.
              .then(() => runTransitionsForSentMessage(imapManager, account, mailOptions.messageId)
                .catch(e => console.warn(`Post-append GTD transition failed: ${e.message}`)))
              .catch(e => console.error(`Post-append sync failed: ${e.message}`));
          }, 1000);
        } catch (appendErr) {
          console.error(`IMAP append to Sent failed for ${redactEmail(account.email_address)}/${sentFolder}: ${appendErr.message}`);
          // The append may still have landed (or land shortly) — pull the folder so a
          // late-completing append self-corrects the DB rather than staying invisible.
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
        // attempt may miss (Sent copy not yet visible → empty thread set → no-op) and the 15s
        // attempt then catches it; if 3s already stripped, 15s is an idempotent no-op.
        const syncAttempt = (label) => imapManager.syncFolderOnDemand(account, sentFolder)
          .then(() => {
            console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`);
            return runTransitionsForSentMessage(imapManager, account, mailOptions.messageId)
              .catch(e => console.warn(`Post-send ${label} GTD transition failed: ${e.message}`));
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
    // Overwrite the in-flight reservation with the final result so a retry after a lost
    // response returns this instead of re-sending.
    if (idemKeyRedis) redisClient.set(idemKeyRedis, JSON.stringify(sendResult), { EX: 86400 }).catch(() => {});
    res.json(sendResult);
  } catch (err) {
    console.error('Send failed:', err.message);
    if (idemKeyRedis) {
      if (delivered) {
        // The message WAS delivered but a later step threw. Persist a DURABLE success
        // result (not just the short-lived reservation) so a retry at ANY time returns it
        // instead of re-running transport.sendMail — otherwise the reservation would lapse
        // and the same key could deliver a second copy.
        redisClient.set(idemKeyRedis, JSON.stringify({ ok: true }), { EX: 86400 }).catch(() => {});
      } else {
        // Delivery never happened — release so a genuine retry after a pre-send failure
        // can proceed immediately.
        redisClient.del(idemKeyRedis).catch(() => {});
      }
    }
    res.status(500).json({ error: sanitizeSmtpError(err) });
  }
});

export default router;
