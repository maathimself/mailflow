import { pickReplyAlias } from './replyAlias.js';
import { api } from './api.js';

export function initialComposeFocus({ isReply = false, isForward = false } = {}) {
  return isReply && !isForward ? 'editor' : 'to';
}

export function isComposeSendShortcut(event) {
  return event?.key === 'Enter' && !event.repeat && !event.shiftKey && !event.altKey
    && (!!event.ctrlKey !== !!event.metaKey);
}

// Ctrl/Cmd+Shift+Enter opens Send later (#543, design 5.1); it schedules nothing by itself.
export function isSendLaterShortcut(event) {
  return event?.key === 'Enter' && !event.repeat && !!event.shiftKey && !event.altKey
    && (!!event.ctrlKey !== !!event.metaKey);
}

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

// The quote header of a reply or forward is HTML, and the names, addresses and subject in it
// come from the message, which the sender wrote. Unescaped, "Ann <ann@x.com>" lost its address
// (read as a tag), and a display name could carry markup, such as a remote image that loaded in
// the composer and travelled on in the reply. The plain-text quote keeps them as written.
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const emailKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function arrayField(raw) {
  try {
    const list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

const addressList = raw => arrayField(raw).filter(a => a && emailKey(a.email));

const replySender = message => Object.hasOwn(message, 'reply_from_email')
  ? { email: message.reply_from_email, name: message.reply_from_name || '' }
  : { email: message.from_email, name: message.from_name || '' };

export function pickMessageReplyAlias(message, account) {
  const { email } = replySender(message);
  return pickReplyAlias({
    aliases: account?.aliases || [],
    deliveryAddresses: arrayField(message.delivery_addresses).filter(a => typeof a === 'string'),
    toAddresses: addressList(message.to_addresses),
    ccAddresses: addressList(message.cc_addresses),
    fromEmail: typeof email === 'string' ? email : '',
  });
}

export function resolveReplyRecipients(message, account) {
  const owned = new Set([account?.email_address, ...(account?.aliases || []).map(a => a?.email)].map(emailKey).filter(Boolean));
  const unique = (list, excluded = new Set()) => list.filter(a => {
    const key = emailKey(a.email);
    if (excluded.has(key)) return false;
    excluded.add(key);
    return true;
  });
  const to = unique(addressList(message.to_addresses));
  const cc = unique(addressList(message.cc_addresses));
  const external = list => list.filter(a => !owned.has(emailKey(a.email)));
  const from = addressList([replySender(message)]);
  const externalTo = external(to);
  const externalCc = external(cc);
  const externalReplyTo = external(addressList(message.reply_to)).slice(0, 1);
  // Authorship belongs to this account, even when its sent copy carries a team Reply-To. With
  // nobody else in To or Cc, as on a contact form that mails itself, its Reply-To is who to answer.
  const targets = owned.has(emailKey(from[0]?.email))
    ? (externalTo.length ? externalTo : externalCc.length ? externalCc
      : externalReplyTo.length ? externalReplyTo : to.length ? to : cc)
    : addressList(message.reply_to).slice(0, 1);
  const replyTo = targets.length ? targets : from;
  const extras = unique([...externalTo, ...externalCc], new Set(replyTo.map(a => emailKey(a.email))));
  return { to: replyTo, cc: extras, originalFrom: replyTo, allRecipients: extras };
}

// `aiReply` opens the composer with "Reply with AI" ready for the user's instruction.
export async function openReplyFromMessage(message, { accounts, openCompose, getMessageBody, replyAll = false, aiReply = false }) {
  const myAccount = accounts.find(a => a.id === message.account_id);
  const { to: sender, allRecipients } = resolveReplyRecipients(message, myAccount);

  const replyAliasId = pickMessageReplyAlias(message, myAccount);

  const referencesChain = [message.in_reply_to, message.message_id]
    .filter(Boolean).join(' ').trim() || null;
  const rawSubject = (message.subject || '').trim();

  const replyBody = await getMessageBody(message.id).catch(() => null);
  const replyDate = message.date ? new Date(message.date).toLocaleString() : '';
  const replyAuthor = replySender(message);
  const replyEmail = replyAuthor.email || '';
  const replySafeName = replyAuthor.name.replace(/[\r\n]+/g, ' ');
  const replyFromStr = replySafeName
    ? `${replySafeName} <${replyEmail}>`
    : replyEmail;
  const quotedText = replyBody?.text
    ? `\n\n---\nOn ${replyDate}, ${replyFromStr} wrote:\n${replyBody.text.split('\n').map(l => '> ' + l).join('\n')}`
    : '';
  // Quoted as shown, images through MailFlow's proxy, so opening the composer never loads them
  // from the sender; ComposeModal puts the email's own references back when it saves or sends.
  const quotedBodyHtml = replyBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${escapeHtml(replyDate)}, ${escapeHtml(replyFromStr)} wrote:</p>${replyBody.html}</div>`
    : null;

  openCompose({
    to: sender,
    cc: replyAll ? allRecipients : [],
    subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
    body: '',
    quotedBody: quotedText,
    quotedBodyHtml,
    inReplyTo: message.message_id,
    references: referencesChain,
    accountId: message.account_id,
    aliasId: replyAliasId,
    isReply: true,
    isReplyAll: replyAll,
    originalFrom: sender,
    allRecipients,
    threadId: message.thread_id,
    ...(aiReply ? { aiReply: true } : {}),
  });
}

export async function openForwardFromMessage(message, { openCompose, getMessageBody }) {
  let fwdBody = await getMessageBody(message.id).catch(() => null);
  // Large inline images are fitted for reading; a recipient gets them as they were sent.
  if (fwdBody?.inlineImagesFitted) {
    fwdBody = await api.getMessageBody(message.id, Boolean(fwdBody.remoteImagesProxied), { original: true }).catch(() => fwdBody);
  }
  const fwdDate = message.date ? new Date(message.date).toLocaleString() : '';
  const fwdSafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const fwdFromStr = fwdSafeName
    ? `${fwdSafeName} <${message.from_email}>`
    : message.from_email || '';
  const safeSubject = (message.subject || '').replace(/[\r\n]+/g, ' ');
  const toStr = parseAddressField(message.to_addresses);
  const ccStr = parseAddressField(message.cc_addresses);

  const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fwdFromStr}\nDate: ${fwdDate}\nSubject: ${safeSubject}${toStr ? `\nTo: ${toStr}` : ''}${ccStr ? `\nCc: ${ccStr}` : ''}\n\n${fwdBody?.text || ''}`;
  const fwdHtml = fwdBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${escapeHtml(fwdFromStr)}<br>Date: ${escapeHtml(fwdDate)}<br>Subject: ${escapeHtml(safeSubject)}${toStr ? `<br>To: ${escapeHtml(toStr)}` : ''}${ccStr ? `<br>Cc: ${escapeHtml(ccStr)}` : ''}</p>${fwdBody.html}</div>`
    : null;

  openCompose({
    subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    body: '',
    quotedBody: fwdText,
    quotedBodyHtml: fwdHtml,
    accountId: message.account_id,
    isForward: true,
    // A file the HTML also shows (#640) travels in the quoted body, which the server sends as an
    // inline image, so it is not attached a second time. A text-only forward still attaches it.
    forwardedAttachments: (fwdBody?.attachments || []).filter(att => !(fwdBody?.html && att?.shownInline)).map(att => ({
      messageId: message.id,
      part: att.part,
      filename: att.filename || 'attachment',
      type: att.type || 'application/octet-stream',
      size: att.size || 0,
    })),
  });
}

// "Forward as attachment" (#466): the original goes as an .eml attachment with every header
// intact, which is what abuse desks such as SpamCop and IT teams need; an inline forward keeps
// only the body. The server fetches the raw source at send time, so its size is not known here.
export function openForwardAsAttachmentFromMessage(message, { openCompose }) {
  const subject = (message.subject || '').replace(/[\r\n]+/g, ' ');
  openCompose({
    subject: subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`,
    body: '',
    accountId: message.account_id,
    isForward: true,
    forwardedAttachments: [{
      messageId: message.id,
      asMessage: true,
      // Named as the server will name it: a slash or backslash in the subject becomes "_".
      filename: `${subject.trim().replace(/[/\\]/g, '_') || 'message'}.eml`,
      type: 'message/rfc822',
      size: null,
    }],
  });
}
