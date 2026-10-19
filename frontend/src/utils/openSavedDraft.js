import { splitDraftSignature } from './draftSignature.js';

function addresses(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item;
    const email = item?.address || item?.email || '';
    return email ? { name: item?.name || '', email } : '';
  }).filter(Boolean);
}

export function savedDraftToComposeData(draft, bodyData, accounts = []) {
  const raw = bodyData?.html || bodyData?.text || '';
  const { body, signature } = bodyData?.html
    ? splitDraftSignature(raw)
    : { body: raw, signature: null, inline: false };
  const listed = Array.isArray(bodyData?.attachments) ? bodyData.attachments : [];
  // A file the draft's HTML also shows (#640) is kept by that HTML, which is saved and sent with
  // the image inline, so it is not attached again. It still accounts for the draft's paperclip.
  const shownInline = bodyData?.html ? listed.filter(a => a?.shownInline) : [];
  const externalAttachments = listed.filter(a => !shownInline.includes(a));
  const knownAttachments = externalAttachments.filter(a => a?.part);
  const account = accounts.find(a => a.id === draft.account_id);
  const aliasId = account?.aliases?.find(alias =>
    alias.email?.toLowerCase() === draft.from_email?.toLowerCase())?.id;
  const unsupportedFrom = draft.from_email && (!account || (!aliasId
    && draft.from_email.toLowerCase() !== account.email_address?.toLowerCase())) ? draft.from_email : null;
  return {
    accountId: draft.account_id,
    ...(aliasId ? { aliasId } : {}),
    draftUid: draft.uid,
    draftFolder: draft.folder,
    persistedKey: `${draft.account_id}:${draft.folder}:${draft.uid}:${draft.message_id || ''}:${draft.uid_validity || ''}`,
    draftMessageId: draft.message_id,
    draftUidValidity: draft.uid_validity,
    ...(unsupportedFrom ? { unsupportedFrom } : {}),
    to: addresses(draft.to_addresses),
    cc: addresses(draft.cc_addresses),
    bcc: addresses(draft.bcc_addresses),
    subject: draft.subject || '',
    body,
    bodyIsHtml: Boolean(bodyData?.html),
    signature: signature !== null ? signature : '',
    inReplyTo: draft.in_reply_to || undefined,
    references: draft.thread_references || undefined,
    threadId: draft.thread_id || undefined,
    isReply: Boolean(draft.in_reply_to || draft.thread_references),
    externalAttachments: externalAttachments.length || (draft.has_attachments && !shownInline.length) ? externalAttachments.length ? externalAttachments : [{}] : [],
    forwardedAttachments: knownAttachments.map(a => ({ messageId: draft.id, part: a.part, filename: a.filename, size: a.size })),
    unresolvedExternalAttachments: draft.attachments_complete !== true
      || Boolean(draft.has_attachments && !externalAttachments.length && !shownInline.length)
      || knownAttachments.length !== externalAttachments.length,
  };
}
