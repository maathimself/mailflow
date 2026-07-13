import nodemailer from 'nodemailer';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { imapManager } from '../index.js';
import { authorizeSender } from '../services/senderAuthorization.js';

const router = Router();
router.use(requireAuth);

function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

function textToHtml(text) {
  return text.split('\n')
    .map(l => `<p style="margin:0">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</p>`)
    .join('');
}

async function buildRawDraft({ authorizedSender, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature }) {
  const { fromName, fromEmail, fromReplyTo, fromBcc = [], fromSignature } = authorizedSender;
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

  const mailOptions = {
    from: `${fromName} <${fromEmail}>`,
    ...(fromReplyTo ? { replyTo: fromReplyTo } : {}),
    to: (Array.isArray(to) ? to : [to]).filter(Boolean).join(', ') || undefined,
    cc: (Array.isArray(cc) ? cc : []).filter(Boolean).join(', ') || undefined,
    bcc: [
      ...(Array.isArray(bcc) ? bcc : []).filter(Boolean),
      ...fromBcc,
    ].filter(Boolean),
    subject: sanitizeHeaderValue(subject || ''),
    text: sigText ? `${bodyText}\n\n-- \n${sigText}${quotedBody || ''}` : `${bodyText}${quotedBody || ''}`,
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
  return Buffer.concat(chunks);
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
  const { sender, to, cc, bcc, subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, editedSignature, existingUid, existingFolder } = req.body;

  let authorizedSender;
  try {
    authorizedSender = await authorizeSender({ userId: req.session.userId, sender });
  } catch (err) {
    if (err?.code === 'SENDER_UNAVAILABLE') {
      return res.status(422).json({ error: 'Sender unavailable', code: 'SENDER_UNAVAILABLE' });
    }
    // Log only the safe error shape: an unexpected failure here can carry alias or DB
    // detail that must not reach logs (credential hygiene), so never log err.message.
    console.error('Draft sender authorization failed:', err?.name, err?.code);
    return res.status(500).json({ error: 'Failed to authorize sender' });
  }

  try {
    const { account } = authorizedSender;
    const rawMessage = await buildRawDraft({
      authorizedSender,
      to,
      cc,
      bcc,
      subject,
      body,
      bodyIsHtml,
      quotedBody,
      quotedBodyHtml,
      editedSignature,
    });

    const draftsFolder = await resolveDraftsFolder(account);
    if (!draftsFolder) return res.status(422).json({ error: 'No Drafts folder found for this account' });

    // APPEND the new draft first so we never lose the message
    const { uid } = await imapManager.appendToFolder(account, draftsFolder, rawMessage, ['\\Draft', '\\Seen']);

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
    res.status(err.status || 500).json({
      error: err.message || 'Failed to save draft',
      ...(err.code ? { code: err.code } : {}),
    });
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
