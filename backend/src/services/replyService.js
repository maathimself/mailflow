import { dedupePreferNamed, parseAddress } from './mail/addresses.js';
import { AliasNotFoundError } from './mail/identity.js';

function addressObjects(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function selfAddressSet(account, aliases) {
  return new Set([
    account?.email_address,
    ...(aliases || []).flatMap(alias => [alias?.email, alias?.reply_to]),
  ].filter(Boolean).map(address => address.toLowerCase()));
}

export function pickReplyTarget(msg) {
  const replyTo = addressObjects(msg?.reply_to);
  if (replyTo[0]?.email) return replyTo[0];
  return { name: msg?.from_name || '', email: msg?.from_email || '' };
}

function parseRecipientInput(value) {
  return (Array.isArray(value) ? value : []).map(recipient => (
    typeof recipient === 'string' ? parseAddress(recipient) : recipient
  ));
}

function withoutEmails(recipients, emails) {
  return recipients.filter(recipient => !emails.has(recipient?.email?.toLowerCase()));
}

function serviceError(message, code) {
  return Object.assign(new Error(message), {
    status: 400,
    code,
    expose: true,
  });
}

export function computeReplyRecipients(msg, {
  account,
  aliases = [],
  replyAll = false,
  to: toOverride,
  cc: ccOverride,
  bcc: bccOverride,
  toAdd,
  ccAdd,
  bccAdd,
  remove,
}) {
  for (const [field, override, additive] of [
    ['to', toOverride, toAdd],
    ['cc', ccOverride, ccAdd],
    ['bcc', bccOverride, bccAdd],
  ]) {
    if (override !== undefined && additive !== undefined) {
      throw serviceError(`${field} and ${field}Add are mutually exclusive`, 'invalid_arguments');
    }
  }

  const replyTarget = pickReplyTarget(msg);
  let to = replyTarget.email ? [replyTarget] : [];
  let cc = [];
  let bcc = [];

  if (replyAll) {
    const self = selfAddressSet(account, aliases);
    const targetEmail = replyTarget.email?.toLowerCase();
    cc = dedupePreferNamed([
      ...addressObjects(msg?.to_addresses),
      ...addressObjects(msg?.cc_addresses),
    ].filter(recipient => {
      const email = recipient?.email?.toLowerCase();
      return email && !self.has(email) && email !== targetEmail;
    }));
  }

  if (toOverride !== undefined) {
    const explicitTo = parseRecipientInput(toOverride);
    const explicitToEmails = new Set(explicitTo.map(recipient => recipient?.email?.toLowerCase()));
    cc = withoutEmails(dedupePreferNamed([
      ...to,
      ...cc,
      ...parseRecipientInput(ccOverride),
    ]), explicitToEmails);
    to = explicitTo;
  } else if (ccOverride !== undefined) {
    cc = parseRecipientInput(ccOverride);
  }
  if (bccOverride !== undefined) bcc = parseRecipientInput(bccOverride);

  to.push(...parseRecipientInput(toAdd));
  cc.push(...parseRecipientInput(ccAdd));
  bcc.push(...parseRecipientInput(bccAdd));

  const removed = new Set(parseRecipientInput(remove).map(recipient => recipient?.email?.toLowerCase()));
  to = withoutEmails(to, removed);
  cc = withoutEmails(cc, removed);
  bcc = withoutEmails(bcc, removed);

  const explicitlyNamed = new Set([
    ...parseRecipientInput(toOverride),
    ...parseRecipientInput(ccOverride),
    ...parseRecipientInput(bccOverride),
    ...parseRecipientInput(toAdd),
    ...parseRecipientInput(ccAdd),
    ...parseRecipientInput(bccAdd),
  ].map(recipient => recipient?.email?.toLowerCase()).filter(Boolean));
  const self = selfAddressSet(account, aliases);
  const finalPass = recipients => recipients.filter(recipient => {
    const email = recipient?.email?.toLowerCase();
    return email && (!self.has(email) || explicitlyNamed.has(email));
  });
  to = finalPass(to);
  cc = finalPass(cc);
  bcc = finalPass(bcc);

  if (to.length + cc.length + bcc.length > 100) {
    throw serviceError('Too many recipients (max 100)', 'too_many_recipients');
  }
  return { to, cc, bcc };
}

const RE_PREFIX = /^\s*re\s*:/i;
const FWD_PREFIX = /^\s*(fwd?|fw)\s*:/i;
const MAX_ATTACHMENT_BYTES = 26_214_400;

export function replySubject(subject) {
  const value = typeof subject === 'string' ? subject.trim() : '';
  if (!value) return 'Re:';
  return RE_PREFIX.test(value) ? value : `Re: ${value}`;
}

export function forwardSubject(subject) {
  const value = typeof subject === 'string' ? subject.trim() : '';
  if (!value) return 'Fwd:';
  return FWD_PREFIX.test(value) ? value : `Fwd: ${value}`;
}

export function buildReferences(msg) {
  const inReplyTo = msg?.message_id || null;
  const ids = `${msg?.thread_references || ''} ${msg?.message_id || ''}`
    .split(/\s+/)
    .filter(id => id.startsWith('<') && id.endsWith('>'));
  const seen = new Set();
  const chain = ids.filter(id => !seen.has(id) && seen.add(id));
  const bounded = chain.length > 21 ? [chain[0], ...chain.slice(-20)] : chain;
  return {
    inReplyTo,
    references: bounded.join(' ') || inReplyTo,
  };
}

export function autoSelectAlias(msg, aliases) {
  if (!aliases?.length) return null;
  const originalRecipients = [
    ...addressObjects(msg?.to_addresses),
    ...addressObjects(msg?.cc_addresses),
  ].map(recipient => recipient?.email?.toLowerCase()).filter(Boolean);
  const fromEmail = (msg?.from_email || '').toLowerCase();
  const match = aliases.find(alias => {
    const aliasEmail = alias?.email?.toLowerCase();
    return aliasEmail && (
      originalRecipients.includes(aliasEmail) ||
      fromEmail === aliasEmail
    );
  });
  return match?.id || null;
}

function quoteAuthor(msg) {
  const safeName = (msg?.from_name || '').replace(/[\r\n]+/g, ' ');
  return safeName
    ? `${safeName} <${msg?.from_email || ''}>`
    : msg?.from_email || '';
}

function normalizeCid(value) {
  return String(value || '').replace(/^cid:/i, '').replace(/^<|>$/g, '').toLowerCase();
}

function rewriteCidImages(html, attachments) {
  const byCid = new Map(addressObjects(attachments).map(attachment => [
    normalizeCid(attachment?.cid || attachment?.content_id || attachment?.contentId),
    attachment,
  ]).filter(([cid]) => cid));
  return html.replace(
    /<img\b[^>]*\bsrc\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))[^>]*>/gi,
    (_tag, doubleQuoted, singleQuoted, unquoted) => {
      const cid = normalizeCid(doubleQuoted || singleQuoted || unquoted);
      const attachment = byCid.get(cid);
      return `[inline image: ${attachment?.filename || attachment?.name || 'attachment'}]`;
    },
  );
}

function referencedCids(html) {
  const matches = String(html || '').matchAll(
    /<img\b[^>]*\bsrc\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))[^>]*>/gi,
  );
  return [...new Set([...matches].map(match => (
    normalizeCid(match[1] || match[2] || match[3])
  )).filter(Boolean))];
}

async function fetchInlineAttachments(msg, account, deps) {
  const attachments = addressObjects(msg?.attachments);
  const byCid = new Map(attachments.map(attachment => [
    normalizeCid(attachment?.cid || attachment?.content_id || attachment?.contentId),
    attachment,
  ]).filter(([cid]) => cid));
  const resolved = [];
  let totalBytes = 0;
  for (const cid of referencedCids(msg?.body_html)) {
    const attachment = byCid.get(cid);
    if (!attachment?.part) continue;
    const content = await deps.imapManager.fetchAttachment(
      account,
      msg.uid,
      msg.folder,
      attachment.part,
    );
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
    totalBytes += buffer.length;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw serviceError('Total attachment size exceeds 25 MB', 'attachment_too_large');
    }
    resolved.push({
      filename: attachment.filename || attachment.name || 'attachment',
      content: buffer.toString('base64'),
      contentType: attachment.type || attachment.contentType || 'application/octet-stream',
      cid,
    });
  }
  return resolved;
}

function wrapQuoteHtml(header, html) {
  return `<div class="gmail_quote" style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">${header}</p>${html}</div>`;
}

export function buildQuote(msg, { includeInlineImages = false } = {}) {
  const localeDate = msg?.date ? new Date(msg.date).toLocaleString() : '';
  const author = quoteAuthor(msg);
  const quotedBody = msg?.body_text
    ? `\n\n---\nOn ${localeDate}, ${author} wrote:\n${msg.body_text.split('\n').map(line => `> ${line}`).join('\n')}`
    : '';
  const html = includeInlineImages
    ? msg?.body_html
    : rewriteCidImages(msg?.body_html || '', msg?.attachments);
  const quotedBodyHtml = msg?.body_html
    ? wrapQuoteHtml(`On ${localeDate}, ${author} wrote:`, html)
    : null;
  return { quotedBody, quotedBodyHtml };
}

function formatAddressField(value) {
  return addressObjects(value).map(recipient => (
    recipient?.name
      ? `${recipient.name} <${recipient.email}>`
      : recipient?.email
  )).filter(Boolean).join(', ');
}

export function buildForwardQuote(msg) {
  const localeDate = msg?.date ? new Date(msg.date).toLocaleString() : '';
  const author = quoteAuthor(msg);
  const subject = (msg?.subject || '').replace(/[\r\n]+/g, ' ');
  const to = formatAddressField(msg?.to_addresses);
  const cc = formatAddressField(msg?.cc_addresses);
  const headers = `From: ${author}\nDate: ${localeDate}\nSubject: ${subject}${to ? `\nTo: ${to}` : ''}${cc ? `\nCc: ${cc}` : ''}`;
  const quotedBody = `\n\n---------- Forwarded message ----------\n${headers}\n\n${msg?.body_text || ''}`;
  const html = rewriteCidImages(msg?.body_html || '', msg?.attachments);
  const htmlHeaders = `---------- Forwarded message ----------<br>From: ${author}<br>Date: ${localeDate}<br>Subject: ${subject}${to ? `<br>To: ${to}` : ''}${cc ? `<br>Cc: ${cc}` : ''}`;
  const quotedBodyHtml = msg?.body_html
    ? wrapQuoteHtml(htmlHeaders, html)
    : null;
  return { quotedBody, quotedBodyHtml };
}

function formatRecipient(recipient) {
  return recipient.name
    ? `${recipient.name} <${recipient.email}>`
    : recipient.email;
}

async function selectAliasId(message, account, aliases, alias, deps) {
  if (alias === undefined || alias === null) {
    return autoSelectAlias(message, aliases);
  }
  const resolved = deps?.resolveAlias
    ? await deps.resolveAlias(account.id, alias)
    : aliases.find(candidate => candidate?.email?.toLowerCase() === alias.toLowerCase());
  if (!resolved) throw new AliasNotFoundError();
  return resolved.id;
}

export async function buildReply({
  message,
  account,
  aliases = [],
  replyAll = false,
  body = '',
  bodyIsHtml = false,
  to,
  cc,
  bcc,
  toAdd,
  ccAdd,
  bccAdd,
  remove,
  noQuote = false,
  includeInlineImages = false,
  alias,
}, deps = {}) {
  const recipients = computeReplyRecipients(message, {
    account,
    aliases,
    replyAll,
    to,
    cc,
    bcc,
    toAdd,
    ccAdd,
    bccAdd,
    remove,
  });
  const aliasId = await selectAliasId(message, account, aliases, alias, deps);
  const threading = buildReferences(message);
  const quote = noQuote
    ? { quotedBody: '', quotedBodyHtml: null }
    : buildQuote(message, { includeInlineImages });
  const inlineAttachments = includeInlineImages && !noQuote
    ? await fetchInlineAttachments(message, account, deps)
    : [];

  return {
    account,
    aliasId,
    userId: account.user_id,
    to: recipients.to.map(formatRecipient),
    cc: recipients.cc.map(formatRecipient),
    bcc: recipients.bcc.map(formatRecipient),
    subject: replySubject(message.subject),
    body,
    bodyIsHtml,
    quotedBody: quote.quotedBody,
    quotedBodyHtml: quote.quotedBodyHtml,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    ...(inlineAttachments.length ? { attachments: inlineAttachments } : {}),
  };
}

export async function buildForward({
  message,
  account,
  aliases = [],
  to = [],
  note = '',
  skipAttachments = false,
  alias,
}, deps = {}) {
  if (to.length > 100) {
    throw serviceError('Too many recipients (max 100)', 'too_many_recipients');
  }
  const aliasId = await selectAliasId(message, account, aliases, alias, deps);
  const quote = buildForwardQuote(message);
  const forwardedAttachments = addressObjects(message?.attachments)
    .filter(attachment => attachment?.part)
    .map(attachment => ({
      messageId: message.id,
      part: attachment.part,
    }));

  return {
    account,
    aliasId,
    userId: account.user_id,
    to,
    cc: [],
    bcc: [],
    subject: forwardSubject(message.subject),
    body: note,
    bodyIsHtml: false,
    quotedBody: quote.quotedBody,
    quotedBodyHtml: quote.quotedBodyHtml,
    ...(!skipAttachments ? { forwardedAttachments } : {}),
  };
}
