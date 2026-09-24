import { splitDraftSignature } from './draftSignature.js';

function addresses(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item;
    const email = item?.address || item?.email || '';
    return item?.name && email ? `${item.name} <${email}>` : email || item?.name || '';
  }).filter(Boolean);
}

export function savedDraftToComposeData(draft, bodyData, accounts = []) {
  const raw = bodyData?.html || bodyData?.text || '';
  const { body, signature, inline } = bodyData?.html
    ? splitDraftSignature(raw)
    : { body: raw, signature: null, inline: false };
  const externalAttachments = Array.isArray(bodyData?.attachments) ? bodyData.attachments : [];
  const knownAttachments = externalAttachments.filter(a => a?.part);
  const account = accounts.find(a => a.id === draft.account_id);
  const aliasId = account?.aliases?.find(alias =>
    alias.email?.toLowerCase() === draft.from_email?.toLowerCase())?.id;
  return {
    accountId: draft.account_id,
    ...(aliasId ? { aliasId } : {}),
    draftUid: draft.uid,
    draftFolder: draft.folder,
    sessionKey: `saved:${draft.id}`,
    persistedKey: `${draft.account_id}:${draft.folder}:${draft.uid}`,
    to: addresses(draft.to_addresses),
    cc: addresses(draft.cc_addresses),
    bcc: addresses(draft.bcc_addresses),
    subject: draft.subject || '',
    body,
    bodyIsHtml: Boolean(bodyData?.html),
    ...(signature !== null ? { signature } : inline ? { signature: '' } : {}),
    inReplyTo: draft.in_reply_to || undefined,
    references: draft.thread_references || undefined,
    threadId: draft.thread_id || undefined,
    isReply: Boolean(draft.in_reply_to),
    externalAttachments: externalAttachments.length || draft.has_attachments ? externalAttachments.length ? externalAttachments : [{}] : [],
    forwardedAttachments: knownAttachments.map(a => ({ messageId: draft.id, part: a.part, filename: a.filename, size: a.size })),
    unresolvedExternalAttachments: Boolean(draft.has_attachments && !externalAttachments.length)
      || knownAttachments.length !== externalAttachments.length,
  };
}
