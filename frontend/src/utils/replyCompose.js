import { wildcardCovers } from './senderIdentity.js';

function parseAddresses(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function buildReplyComposeData({ message, account, resolved, replyAll, body }) {
  const replyTo = parseAddresses(message.reply_to);
  const replyTarget = replyTo[0]?.email
    ? replyTo[0]
    : { name: message.from_name || '', email: message.from_email || '' };
  const replyRecipients = replyTarget.email ? [replyTarget] : [];

  const ownAddresses = new Set([
    account?.email_address,
    ...(account?.aliases || []).map(alias => alias.email),
    resolved.sender?.fromEmail,
    resolved.sender?.displayEmail,
  ].filter(Boolean).map(address => address.toLowerCase()));
  const ownWildcards = (account?.aliases || []).filter(alias => (
    alias.provenance === 'fastmail'
    && alias.fastmail_identity_id
    && alias.email.startsWith('*@')
  )).map(alias => alias.email);
  const replyTargetEmail = replyTarget.email?.toLowerCase();
  const allRecipients = [
    ...parseAddresses(message.to_addresses),
    ...parseAddresses(message.cc_addresses),
  ].filter(recipient => (
    recipient.email
    && !ownAddresses.has(recipient.email.toLowerCase())
    && !ownWildcards.some(pattern => wildcardCovers(pattern, recipient.email))
    && recipient.email.toLowerCase() !== replyTargetEmail
  ));

  const rawSubject = (message.subject || '').trim();
  const references = [message.in_reply_to, message.message_id]
    .filter(Boolean)
    .join(' ')
    .trim() || null;
  const date = message.date ? new Date(message.date).toLocaleString() : '';
  const safeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const from = safeName
    ? `${safeName} <${message.from_email}>`
    : message.from_email || '';
  const quotedBody = body?.text
    ? `\n\n---\nOn ${date}, ${from} wrote:\n${body.text.split('\n').map(line => `> ${line}`).join('\n')}`
    : '';
  const quotedBodyHtml = body?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${date}, ${from} wrote:</p>${body.html}</div>`
    : null;

  return {
    to: replyRecipients,
    cc: replyAll ? allRecipients : [],
    subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
    body: '',
    quotedBody,
    quotedBodyHtml,
    inReplyTo: message.message_id,
    references,
    sender: resolved.sender,
    senderRequired: resolved.requiresSelection,
    accountId: message.account_id,
    isReply: true,
    isReplyAll: replyAll,
    originalFrom: replyRecipients,
    allRecipients,
  };
}
