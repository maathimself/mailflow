// Compose-prefill helpers shared by the message list and the right-sidebar row menu.
// Callers inject openCompose and getMessageBody so the payload shape stays the sole
// contract; every field below mirrors what the composer expects for reply/forward.

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

// Prefill + open a reply / reply-all compose from a message row. Resolves the reply
// target from reply_to (array or JSON string), picks the sending alias by matching
// to/cc/from against the account's aliases, filters own addresses out of reply-all
// recipients, builds the quoted text/html body, and calls openCompose.
export async function openReplyFromMessage(message, { accounts, openCompose, getMessageBody, replyAll = false }) {
  const replyToArr = Array.isArray(message.reply_to)
    ? message.reply_to
    : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
  const replyTarget = (replyToArr.length && replyToArr[0].email)
    ? replyToArr[0]
    : { name: message.from_name || '', email: message.from_email || '' };
  const sender = replyTarget.email ? [replyTarget] : [];

  const myAccount = accounts.find(a => a.id === message.account_id);
  const myEmail = myAccount?.email_address || '';
  const myAddresses = new Set([
    myEmail.toLowerCase(),
    ...(myAccount?.aliases || []).map(al => al.email.toLowerCase()),
  ]);

  const replyAliasId = (() => {
    const aliases = myAccount?.aliases || [];
    if (!aliases.length) return null;
    try {
      const toArr = Array.isArray(message.to_addresses)
        ? message.to_addresses
        : JSON.parse(message.to_addresses || '[]');
      const ccArr = Array.isArray(message.cc_addresses)
        ? message.cc_addresses
        : JSON.parse(message.cc_addresses || '[]');
      const allEmails = [...toArr, ...ccArr].map(t => t.email?.toLowerCase()).filter(Boolean);
      const fromEmail = (message.from_email || '').toLowerCase();
      const match = aliases.find(al => {
        const aliasEmail = al.email.toLowerCase();
        return allEmails.includes(aliasEmail) || fromEmail === aliasEmail;
      });
      return match ? match.id : null;
    } catch { return null; }
  })();

  const allRecipients = (() => {
    try {
      const toArr = Array.isArray(message.to_addresses)
        ? message.to_addresses
        : JSON.parse(message.to_addresses || '[]');
      const ccArr = Array.isArray(message.cc_addresses)
        ? message.cc_addresses
        : JSON.parse(message.cc_addresses || '[]');
      return [...toArr, ...ccArr].filter(
        t => t.email && !myAddresses.has(t.email.toLowerCase()) && t.email !== replyTarget.email
      );
    } catch { return []; }
  })();

  const referencesChain = [message.in_reply_to, message.message_id]
    .filter(Boolean).join(' ').trim() || null;
  const rawSubject = (message.subject || '').trim();

  const replyBody = await getMessageBody(message.id).catch(() => null);
  const replyDate = message.date ? new Date(message.date).toLocaleString() : '';
  const replySafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const replyFromStr = replySafeName
    ? `${replySafeName} <${message.from_email}>`
    : message.from_email || '';
  const quotedText = replyBody?.text
    ? `\n\n---\nOn ${replyDate}, ${replyFromStr} wrote:\n${replyBody.text.split('\n').map(l => '> ' + l).join('\n')}`
    : '';
  const quotedBodyHtml = replyBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${replyDate}, ${replyFromStr} wrote:</p>${replyBody.html}</div>`
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
  });
}

// Prefill + open a forward compose: quoted forwarded header/body (text + html) and
// forwardedAttachments mapped from the fetched body's attachment parts.
export async function openForwardFromMessage(message, { openCompose, getMessageBody }) {
  const fwdBody = await getMessageBody(message.id).catch(() => null);
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
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${fwdFromStr}<br>Date: ${fwdDate}<br>Subject: ${safeSubject}${toStr ? `<br>To: ${toStr}` : ''}${ccStr ? `<br>Cc: ${ccStr}` : ''}</p>${fwdBody.html}</div>`
    : null;

  openCompose({
    subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    body: '',
    quotedBody: fwdText,
    quotedBodyHtml: fwdHtml,
    accountId: message.account_id,
    isForward: true,
    forwardedAttachments: (fwdBody?.attachments || []).map(att => ({
      messageId: message.id,
      part: att.part,
      filename: att.filename || 'attachment',
      type: att.type || 'application/octet-stream',
      size: att.size || 0,
    })),
  });
}
