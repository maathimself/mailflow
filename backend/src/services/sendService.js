import { randomBytes as defaultRandomBytes } from 'crypto';
import { sanitizeSignature } from './emailSanitizer.js';
import { embedInlineDataImages as defaultEmbedInlineDataImages } from '../utils/inlineImages.js';
import { redactEmail } from '../utils/redact.js';
import {
  mapRecipientList,
  normalizeRecipients,
  sanitizeHeaderValue,
} from './mail/addresses.js';
import { resolveFromIdentity as defaultResolveFromIdentity } from './mail/identity.js';
import {
  bodyToHtml,
  bodyToPlain,
  buildMailOptions as defaultBuildMailOptions,
  renderRaw as defaultRenderRaw,
  sigToPlainText,
  textToHtml,
} from './mail/mimeBuilder.js';
import { buildSmtpTransport as defaultBuildSmtpTransport } from './mail/smtp.js';
import {
  learnSentRecipients as defaultLearnSentRecipients,
  persistSentCopy as defaultPersistSentCopy,
  resolveSentFolder as defaultResolveSentFolder,
} from './mail/sentCopy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENT_BYTES = 26_214_400;
const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);

function serviceError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, expose: true, ...extra });
}

function estimatedBase64Bytes(content) {
  return typeof content === 'string' ? Math.ceil(content.length * 0.75) : 0;
}

function validateCompose(input) {
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) throw serviceError('attachments must be an array', 400);
    if (input.attachments.length > 100) throw serviceError('Too many attachments (max 100)', 400);
    const totalBytes = input.attachments.reduce((sum, attachment) => sum + estimatedBase64Bytes(attachment.content), 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) throw serviceError('Total attachment size exceeds 25 MB', 400);
    for (const [i, attachment] of input.attachments.entries()) {
      if (typeof attachment.filename !== 'string' || !attachment.filename.trim()) {
        throw serviceError(`attachments[${i}].filename is required`, 400);
      }
      if (typeof attachment.content !== 'string') {
        throw serviceError(`attachments[${i}].content must be a base64 string`, 400);
      }
    }
  }

  if (input.forwardedAttachments !== undefined) {
    if (!Array.isArray(input.forwardedAttachments)) {
      throw serviceError('forwardedAttachments must be an array', 400);
    }
    for (const [i, attachment] of input.forwardedAttachments.entries()) {
      if (typeof attachment.messageId !== 'string' || !UUID_RE.test(attachment.messageId)) {
        throw serviceError(`forwardedAttachments[${i}].messageId is invalid`, 400);
      }
      if (typeof attachment.part !== 'string' || !attachment.part.trim()) {
        throw serviceError(`forwardedAttachments[${i}].part is required`, 400);
      }
    }
  }

  try {
    return {
      to: normalizeRecipients(input.to, 'to'),
      cc: normalizeRecipients(input.cc || [], 'cc'),
      bcc: normalizeRecipients(input.bcc || [], 'bcc'),
      subject: sanitizeHeaderValue(input.subject || ''),
      priority: VALID_PRIORITIES.has(input.priority) ? input.priority : 'normal',
    };
  } catch (err) {
    err.expose = true;
    throw err;
  }
}

async function resolveForwardedAttachments(input, deps) {
  if (!input.forwardedAttachments?.length) return [];
  try {
    const resolved = await Promise.all(input.forwardedAttachments.map(async (forwarded) => {
      const msgResult = await deps.query(
        `SELECT m.uid, m.folder, m.attachments, to_jsonb(a) AS account FROM messages m
         JOIN email_accounts a ON m.account_id = a.id
         WHERE m.id = $1 AND a.user_id = $2`,
        [forwarded.messageId, input.userId],
      );
      if (!msgResult.rows.length) throw serviceError('Forwarded message not found', 404);
      const message = msgResult.rows[0];

      const storedAttachments = typeof message.attachments === 'string'
        ? JSON.parse(message.attachments || '[]')
        : (message.attachments || []);
      const attachment = storedAttachments.find(candidate => candidate.part === forwarded.part);
      if (!attachment) throw serviceError('Attachment not found in message', 404);

      const buffer = await deps.imapManager.fetchAttachment(
        message.account,
        message.uid,
        message.folder,
        forwarded.part,
      );
      if (!buffer) throw serviceError(`Could not fetch attachment: ${attachment.filename}`, 502);

      return {
        filename: sanitizeHeaderValue(attachment.filename || 'attachment'),
        content: buffer,
        contentType: attachment.type || 'application/octet-stream',
      };
    }));

    const uploadedBytes = (input.attachments || []).reduce(
      (sum, attachment) => sum + estimatedBase64Bytes(attachment.content),
      0,
    );
    const forwardedBytes = resolved.reduce((sum, attachment) => sum + (attachment.content?.length || 0), 0);
    if (uploadedBytes + forwardedBytes > MAX_ATTACHMENT_BYTES) {
      throw serviceError('Total attachment size exceeds 25 MB', 400);
    }
    return resolved;
  } catch (err) {
    if (err.expose) throw err;
    throw serviceError(err.message || 'Failed to fetch forwarded attachments', err.status || 500);
  }
}

function attachmentSize(attachment) {
  if (Buffer.isBuffer(attachment.content)) return attachment.content.length;
  return estimatedBase64Bytes(attachment.content);
}

export function buildReceipt({
  from,
  to,
  cc,
  bcc,
  subject,
  attachments,
  messageId,
  sentCopySaved,
  folder,
}) {
  return {
    from,
    to: mapRecipientList(to),
    cc: mapRecipientList(cc),
    bcc: mapRecipientList(bcc),
    subject,
    attachments: (attachments || []).map(attachment => ({
      filename: attachment.filename,
      size: attachmentSize(attachment),
    })),
    messageId,
    sentCopySaved,
    folder,
  };
}

export async function sendMessage(input, deps) {
  const normalized = validateCompose(input);
  if (!input.account) throw serviceError('Account not found', 404, { code: 'account_not_found' });

  const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
  const buildSmtpTransport = deps.buildSmtpTransport || defaultBuildSmtpTransport;
  const buildMailOptions = deps.buildMailOptions || defaultBuildMailOptions;
  const renderRaw = deps.renderRaw || defaultRenderRaw;
  const embedInlineDataImages = deps.embedInlineDataImages || defaultEmbedInlineDataImages;
  const learnSentRecipients = deps.learnSentRecipients || defaultLearnSentRecipients;
  const resolveSentFolder = deps.resolveSentFolder || defaultResolveSentFolder;
  const persistSentCopy = deps.persistSentCopy || defaultPersistSentCopy;
  const makeRandomBytes = deps.randomBytes || defaultRandomBytes;

  const identity = await resolveFromIdentity(
    input.account,
    { aliasId: input.aliasId, aliasEmail: input.aliasEmail },
    deps,
  );

  // Allow the caller to override the signature per-send (undefined means use DB value).
  // Sanitize client-supplied HTML to prevent scripts or tracking pixels in sent mail.
  const effectiveSignature = input.editedSignature !== undefined
    ? (input.editedSignature ? sanitizeSignature(input.editedSignature) : null)
    : identity.signature;

  // Fetch forwarded content before SMTP setup so these failures stay descriptive.
  const forwardedAttachments = await resolveForwardedAttachments(input, deps);
  const smtp = await buildSmtpTransport(input.account, deps);
  const account = smtp.account;

  const domain = identity.fromEmail.split('@')[1] || 'mailflow.local';
  const messageId = input.messageId || `<${makeRandomBytes(16).toString('hex')}@${domain}>`;
  const text = effectiveSignature
    ? bodyToPlain(input.body, input.bodyIsHtml) + '\n\n-- \n' +
      sigToPlainText(effectiveSignature) + (input.quotedBody || '')
    : bodyToPlain(input.body, input.bodyIsHtml) + (input.quotedBody || '');

  let html;
  let inlineImageAttachments = [];
  if (!input.plaintextEmail) {
    const rawHtml = bodyToHtml(input.body, input.bodyIsHtml) +
      (effectiveSignature
        ? '<div style="margin-top:16px;color:#555;font-size:13px">' + effectiveSignature + '</div>'
        : '') +
      (input.quotedBodyHtml || (input.quotedBody ? textToHtml(input.quotedBody) : ''));
    const embedded = embedInlineDataImages(rawHtml);
    html = embedded.html;
    inlineImageAttachments = embedded.attachments;
  }

  const uploadedAttachments = input.attachments?.length
    ? input.attachments.map(attachment => ({
      filename: sanitizeHeaderValue(attachment.filename),
      content: Buffer.from(attachment.content, 'base64'),
      contentType: typeof attachment.contentType === 'string'
        ? attachment.contentType
        : 'application/octet-stream',
      // replyService re-fetches quoted inline images with a cid so the reply's
      // <img src="cid:..."> keeps resolving; dropping it breaks those images.
      ...(typeof attachment.cid === 'string' && attachment.cid
        ? { cid: sanitizeHeaderValue(attachment.cid) }
        : {}),
    }))
    : [];
  const allAttachments = [
    ...inlineImageAttachments,
    ...uploadedAttachments,
    ...forwardedAttachments,
  ];
  const mailOptions = buildMailOptions({
    messageId,
    fromName: identity.fromName,
    fromEmail: identity.fromEmail,
    replyTo: identity.fromReplyTo,
    to: normalized.to,
    cc: normalized.cc,
    bcc: normalized.bcc,
    subject: normalized.subject,
    priority: normalized.priority,
    text,
    ...(html !== undefined ? { html } : {}),
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: allAttachments,
  });

  // OAuth providers save Sent automatically; other accounts need this exact raw MIME.
  const serverAutoSaves = !!account.oauth_provider;
  const rawMessage = serverAutoSaves ? null : await renderRaw(mailOptions);

  // Idempotent callers inject the Redis reservation here: after MIME rendering and
  // immediately before the delivery boundary.
  if (deps.beforeDelivery) await deps.beforeDelivery();
  await smtp.transport.sendMail(mailOptions);
  if (deps.afterDelivery) deps.afterDelivery();

  const recipients = [...normalized.to, ...normalized.cc, ...normalized.bcc];
  learnSentRecipients({ userId: input.userId, recipients }, deps);
  const sentFolder = await resolveSentFolder(account, deps);
  console.log(`Post-send: ${redactEmail(account.email_address)} sentFolder=${sentFolder} autoSaves=${serverAutoSaves}`);

  const sentMeta = sentFolder ? {
    messageId,
    subject: normalized.subject,
    fromName: identity.fromName,
    fromEmail: identity.fromEmail,
    to: mapRecipientList(normalized.to),
    cc: mapRecipientList(normalized.cc),
    snippet: bodyToPlain(input.body, input.bodyIsHtml).replace(/\s+/g, ' ').trim().substring(0, 200),
    date: new Date(),
  } : null;
  const { sentCopySaved } = await persistSentCopy({
    account,
    sentFolder,
    rawMessage,
    mailOptions,
    meta: sentMeta,
  }, deps);

  const receipt = buildReceipt({
    from: { name: identity.fromName, email: identity.fromEmail },
    to: normalized.to,
    cc: normalized.cc,
    bcc: normalized.bcc,
    subject: normalized.subject,
    attachments: allAttachments,
    messageId,
    sentCopySaved,
    folder: sentFolder,
  });
  return { ok: true, messageId, sentCopySaved, receipt };
}

function conflict(message) {
  return serviceError(message, 409, { code: 'idempotency_conflict' });
}

export async function sendMessageIdempotent({ idempotencyKey, ...input }, deps) {
  const boundedKey = typeof idempotencyKey === 'string' ? idempotencyKey.slice(0, 128) : null;
  const key = boundedKey ? `send_idem:${input.userId}:${boundedKey}` : null;
  if (!key) return sendMessage(input, deps);

  const cached = await deps.redisClient.get(key).catch(() => null);
  if (cached === '__inflight__') throw conflict('This message is already being sent.');
  if (cached) return JSON.parse(cached);

  let delivered = false;
  let reservationConflict = false;
  try {
    const result = await sendMessage(input, {
      ...deps,
      beforeDelivery: async () => {
        const reserved = await deps.redisClient
          .set(key, '__inflight__', { NX: true, EX: 300 })
          .catch(() => 'OK');
        if (reserved === null) {
          reservationConflict = true;
          throw conflict('This message is already being sent.');
        }
      },
      afterDelivery: () => {
        delivered = true;
      },
    });
    deps.redisClient.set(key, JSON.stringify(result), { EX: 86400 }).catch(() => {});
    return result;
  } catch (err) {
    if (reservationConflict) throw err;
    if (delivered) {
      deps.redisClient.set(key, JSON.stringify({ ok: true }), { EX: 86400 }).catch(() => {});
    } else {
      deps.redisClient.del(key).catch(() => {});
    }
    throw err;
  }
}

export async function sendOrEnqueue(input, deps) {
  if (!input.undoSeconds) {
    const immediateInput = { ...input };
    delete immediateInput.messageId;
    return sendMessageIdempotent(immediateInput, deps);
  }
  if (!input.account) throw serviceError('Account not found', 404, { code: 'account_not_found' });

  const normalized = validateCompose(input);
  const makeRandomBytes = deps.randomBytes || defaultRandomBytes;
  const resolveFromIdentity = deps.resolveFromIdentity || defaultResolveFromIdentity;
  const identity = await resolveFromIdentity(
    input.account,
    { aliasId: input.aliasId, aliasEmail: input.aliasEmail },
    deps,
  );
  const domain = identity.fromEmail.split('@')[1] || 'mailflow.local';
  const messageId = `<${makeRandomBytes(16).toString('hex')}@${domain}>`;
  const payload = {
    userId: input.userId,
    account_id: input.account.id,
    to: normalized.to,
    cc: normalized.cc,
    bcc: normalized.bcc,
    subject: normalized.subject,
    priority: normalized.priority,
    body: input.body,
    bodyIsHtml: input.bodyIsHtml,
    attachments: input.attachments,
    forwardedAttachments: input.forwardedAttachments,
    aliasId: input.aliasId,
    aliasEmail: input.aliasEmail,
    editedSignature: input.editedSignature,
    quotedBody: input.quotedBody,
    quotedBodyHtml: input.quotedBodyHtml,
    plaintextEmail: input.plaintextEmail,
    inReplyTo: input.inReplyTo,
    references: input.references,
    ...(input.deleteDraftOnSend
      ? { deleteDraftOnSend: input.deleteDraftOnSend }
      : {}),
    messageId,
  };

  const queued = await deps.outboxService.enqueue({
    userId: input.userId,
    accountId: input.account.id,
    payload,
    undoSeconds: input.undoSeconds,
    idempotencyKey: input.idempotencyKey,
    subject: normalized.subject,
    toPreview: normalized.to,
    messageId,
  }, deps);
  return {
    queued: true,
    outboxId: queued.outbox_id,
    sendAt: queued.send_at,
    undoSeconds: queued.undo_seconds,
  };
}
