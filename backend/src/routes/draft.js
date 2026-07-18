import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { imapManager } from '../index.js';

const router = Router();
router.use(requireAuth);

function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

// Extract { name, email } from an RFC 5322 address string ("Name <email>",
// "<email>", or bare "email") for persisting to_addresses/cc_addresses.
function parseAddress(str) {
  if (typeof str !== 'string') return { name: '', email: '' };
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}
function mapRecipientList(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean).map(addr => parseAddress(addr));
}

function textToHtml(text) {
  return text.split('\n')
    .map(l => `<p style="margin:0">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</p>`)
    .join('');
}

async function buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature }) {
  const acctResult = await query(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!acctResult.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const account = acctResult.rows[0];

  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;

  if (aliasId) {
    const aliasResult = await query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      fromName = alias.name;
      fromEmail = alias.email;
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  const rawSignature = editedSignature !== undefined ? (editedSignature || null) : fromSignature;
  const effectiveSignature = rawSignature ? sanitizeSignature(rawSignature) : null;

  const sigText = effectiveSignature
    ? sanitizeHtml(effectiveSignature, { allowedTags: [], allowedAttributes: {} }).trim()
    : null;

  const bodyText = bodyIsHtml
    ? sanitizeHtml(body || '', { allowedTags: [], allowedAttributes: {} })
    : (body || '');

  const bodyHtml = bodyIsHtml
    ? sanitizeComposeBody(body || '')
    : textToHtml(body || '');

  const rawHtml = bodyHtml +
    (effectiveSignature ? `<div style="margin-top:16px;color:#555;font-size:13px">${effectiveSignature}</div>` : '') +
    (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
  const { html: draftHtml, attachments: inlineImageAttachments } = embedInlineDataImages(rawHtml);

  // Stable Message-ID so the appended MIME and the local DB row reference the same
  // message (and a later sync reconciles cleanly).
  const messageId = `<${randomBytes(16).toString('hex')}@${(fromEmail.split('@')[1] || 'mailflow.local')}>`;
  const textBody = sigText ? `${bodyText}\n\n-- \n${sigText}${quotedBody || ''}` : `${bodyText}${quotedBody || ''}`;

  const mailOptions = {
    messageId,
    from: `${fromName} <${fromEmail}>`,
    to: (Array.isArray(to) ? to : [to]).filter(Boolean).join(', ') || undefined,
    cc: (Array.isArray(cc) ? cc : []).filter(Boolean).join(', ') || undefined,
    bcc: (Array.isArray(bcc) ? bcc : []).filter(Boolean).join(', ') || undefined,
    subject: sanitizeHeaderValue(subject || ''),
    text: textBody,
    html: draftHtml,
    ...(inlineImageAttachments.length ? { attachments: inlineImageAttachments } : {}),
  };

  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks = [];
  await new Promise((resolve, reject) => {
    streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    streamInfo.message.on('end', resolve);
    streamInfo.message.on('error', reject);
  });
  // rawHtml (pre inline-image embedding) is what the composer should reopen with —
  // inline data: URIs stay editable and getMessageBody serves body_html from the DB.
  const snippet = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    rawMessage: Buffer.concat(chunks),
    account,
    meta: { messageId, fromName, fromEmail, bodyHtml: rawHtml, bodyText: textBody, snippet },
  };
}

async function resolveDraftsFolder(account) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id]
  );
  return result.rows[0]?.path || null;
}

router.post('/draft', async (req, res) => {
  const { accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, editedSignature, existingUid, existingFolder } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const ownerCheck = await query(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const { rawMessage, account, meta } = await buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature });

    const draftsFolder = await resolveDraftsFolder(account);
    if (!draftsFolder) return res.status(422).json({ error: 'No Drafts folder found for this account' });

    // APPEND the new draft first so we never lose the message
    const { uid } = await imapManager.appendToFolder(account, draftsFolder, rawMessage, ['\\Draft', '\\Seen']);

    // Persist a local Drafts row immediately so the composer can reopen this draft
    // (recipient/subject/body) even if the folder re-sync is delayed or fails on a
    // flaky connection. Non-fatal — the append already stored the message on IMAP.
    if (uid != null) {
      try {
        await imapManager.upsertDraftMessageRecord(account, draftsFolder, uid, {
          messageId: meta.messageId,
          subject,
          fromName: meta.fromName,
          fromEmail: meta.fromEmail,
          to: mapRecipientList(to),
          cc: mapRecipientList(cc),
          snippet: meta.snippet,
          bodyHtml: meta.bodyHtml,
          bodyText: meta.bodyText,
        });
      } catch (rowErr) {
        console.error(`Draft: failed to persist local row uid=${uid}: ${rowErr.message}`);
      }
    }

    // Delete the old draft only after the new one is safely stored
    if (existingUid && existingFolder) {
      try {
        await imapManager.permanentDeleteMessage(account, existingUid, existingFolder);
        await query(
          'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
          [account.id, existingUid, existingFolder]
        );
      } catch (delErr) {
        console.error(`Draft: failed to delete old uid=${existingUid}: ${delErr.message}`);
      }
    }

    res.json({ uid, folder: draftsFolder });
  } catch (err) {
    console.error('Save draft failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to save draft' });
  }
});

router.delete('/draft/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (!uid || !Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid uid' });

  const { accountId, folder } = req.query;
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });

  const ownerCheck = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const account = ownerCheck.rows[0];
    await imapManager.permanentDeleteMessage(account, uid, folder);
    await query(
      'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
      [account.id, uid, folder]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete draft failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

export default router;
