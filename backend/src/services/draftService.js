import { randomBytes as defaultRandomBytes } from 'crypto';
import { sanitizeSignature } from './emailSanitizer.js';
import { embedInlineDataImages as defaultEmbedInlineDataImages } from '../utils/inlineImages.js';
import { mapRecipientList, sanitizeHeaderValue } from './mail/addresses.js';
import { resolveFromIdentity as defaultResolveFromIdentity } from './mail/identity.js';
import {
  bodyToHtml,
  bodyToPlain,
  buildMailOptions as defaultBuildMailOptions,
  renderRaw as defaultRenderRaw,
  sigToPlainText,
  textToHtml,
} from './mail/mimeBuilder.js';

function serviceError(message, status) {
  return Object.assign(new Error(message), { status, expose: true });
}

async function resolveDraftsFolder(account, deps) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await deps.query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id],
  );
  return result.rows[0]?.path || null;
}

export async function buildRawDraft(input, deps) {
  if (!input.account) throw serviceError('Account not found', 404);

  const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
  const embedInlineDataImages = deps.embedInlineDataImages || defaultEmbedInlineDataImages;
  const buildMailOptions = deps.buildMailOptions || defaultBuildMailOptions;
  const renderRaw = deps.renderRaw || defaultRenderRaw;
  const makeRandomBytes = deps.randomBytes || defaultRandomBytes;

  const identity = await resolveFromIdentity(
    input.account,
    { aliasId: input.aliasId, aliasEmail: input.aliasEmail },
    deps,
  );

  const rawSignature = input.editedSignature !== undefined
    ? (input.editedSignature || null)
    : identity.signature;
  const effectiveSignature = rawSignature ? sanitizeSignature(rawSignature) : null;
  const signatureText = effectiveSignature ? sigToPlainText(effectiveSignature) : null;
  const bodyText = bodyToPlain(input.body || '', input.bodyIsHtml);
  const bodyHtml = bodyToHtml(input.body || '', input.bodyIsHtml);
  const rawHtml = bodyHtml +
    (effectiveSignature
      ? `<div style="margin-top:16px;color:#555;font-size:13px">${effectiveSignature}</div>`
      : '') +
    (input.quotedBodyHtml || (input.quotedBody ? textToHtml(input.quotedBody) : ''));
  const embedded = embedInlineDataImages(rawHtml);

  const uploadedAttachments = Array.isArray(input.attachments)
    ? input.attachments.map(attachment => ({
      filename: sanitizeHeaderValue(attachment.filename || 'attachment'),
      content: Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(attachment.content || '', 'base64'),
      contentType: typeof attachment.contentType === 'string'
        ? attachment.contentType
        : 'application/octet-stream',
    }))
    : [];
  const attachments = [...embedded.attachments, ...uploadedAttachments];

  // Stable Message-ID so the appended MIME and the local DB row reference the same message.
  const domain = identity.fromEmail.split('@')[1] || 'mailflow.local';
  const messageId = `<${makeRandomBytes(16).toString('hex')}@${domain}>`;
  const text = signatureText
    ? `${bodyText}\n\n-- \n${signatureText}${input.quotedBody || ''}`
    : `${bodyText}${input.quotedBody || ''}`;
  const replyTo = input.replyTo !== undefined ? input.replyTo : identity.fromReplyTo;
  const mailOptions = buildMailOptions({
    messageId,
    fromName: identity.fromName,
    fromEmail: identity.fromEmail,
    replyTo,
    to: Array.isArray(input.to) ? input.to : [input.to],
    cc: Array.isArray(input.cc) ? input.cc : [],
    bcc: Array.isArray(input.bcc) ? input.bcc : [],
    subject: input.subject || '',
    priority: input.priority,
    text,
    html: embedded.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
  });
  const rawMessage = await renderRaw(mailOptions);
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);

  // rawHtml (before CID embedding) is what the composer should reopen with so data:
  // image URIs remain editable.
  return {
    rawMessage,
    account: input.account,
    meta: {
      messageId,
      fromName: identity.fromName,
      fromEmail: identity.fromEmail,
      bodyHtml: rawHtml,
      bodyText: text,
      snippet,
      inReplyTo: input.inReplyTo || null,
      references: input.references || null,
    },
  };
}

export async function saveDraft(input, deps) {
  const { rawMessage, account, meta } = await buildRawDraft(input, deps);
  const draftsFolder = await resolveDraftsFolder(account, deps);
  if (!draftsFolder) throw serviceError('No Drafts folder found for this account', 422);

  // APPEND the new draft first so a failed update can never lose the message.
  const { uid } = await deps.imapManager.appendToFolder(
    account,
    draftsFolder,
    rawMessage,
    ['\\Draft', '\\Seen'],
  );

  // Local persistence is non-fatal because IMAP already holds the new draft.
  if (uid != null) {
    try {
      await deps.imapManager.upsertDraftMessageRecord(account, draftsFolder, uid, {
        messageId: meta.messageId,
        subject: input.subject,
        fromName: meta.fromName,
        fromEmail: meta.fromEmail,
        to: mapRecipientList(input.to),
        cc: mapRecipientList(input.cc),
        inReplyTo: meta.inReplyTo,
        references: meta.references,
        snippet: meta.snippet,
        bodyHtml: meta.bodyHtml,
        bodyText: meta.bodyText,
      });
    } catch (rowErr) {
      console.error(`Draft: failed to persist local row uid=${uid}: ${rowErr.message}`);
    }
  }

  // Delete the old draft only after append and local upsert have completed.
  if (input.existingUid && input.existingFolder) {
    try {
      await deps.imapManager.permanentDeleteMessage(account, input.existingUid, input.existingFolder);
      await deps.query(
        'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
        [account.id, input.existingUid, input.existingFolder],
      );
    } catch (delErr) {
      console.error(`Draft: failed to delete old uid=${input.existingUid}: ${delErr.message}`);
    }
  }

  return { uid, folder: draftsFolder, messageId: meta.messageId };
}

export async function deleteDraft({ account, uid, folder }, deps) {
  await deps.imapManager.permanentDeleteMessage(account, uid, folder);
  await deps.query(
    'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [account.id, uid, folder],
  );
  return { ok: true };
}

export async function listDrafts({ account, limit = 50, offset = 0 }, deps) {
  const folder = await resolveDraftsFolder(account, deps);
  if (!folder) return { drafts: [], total: 0 };
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const countResult = await deps.query(
    'SELECT COUNT(*)::int AS n FROM messages WHERE account_id = $1 AND folder = $2 AND is_deleted = false',
    [account.id, folder],
  );
  const result = await deps.query(
    `SELECT * FROM messages
     WHERE account_id = $1 AND folder = $2 AND is_deleted = false
     ORDER BY date DESC
     LIMIT $3 OFFSET $4`,
    [account.id, folder, safeLimit, safeOffset],
  );
  return { drafts: result.rows, total: countResult.rows[0]?.n ?? 0 };
}

export async function getDraft({ account, uid, folder }, deps) {
  const result = await deps.query(
    `SELECT * FROM messages
     WHERE account_id = $1 AND uid = $2 AND folder = $3 AND is_deleted = false
     LIMIT 1`,
    [account.id, uid, folder],
  );
  return result.rows[0] || null;
}
