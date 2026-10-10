import { normalizeConversation } from './conversation.js';

export const conversationActionIds = messages => normalizeConversation(messages)
  .map(message => message.id)
  .filter(Boolean);

// Archiving, deleting or moving a conversation never mixes drafts with the rest of it (the thread
// route marks drafts is_draft). Acting on a message leaves the conversation's drafts alone: a
// deleted draft is expunged rather than moved to Trash, so an unsent reply would be lost with the
// thread it answers. Acting on a draft, as in the Drafts folder, touches only the drafts: discarding
// a reply must not take the conversation it answers. A thread with nothing on the other side keeps
// everything, so the action is never silently empty.
export function keepDraftsApart(messages, anchorId) {
  const list = Array.isArray(messages) ? messages : [];
  const anchorIsDraft = list.some(message => message?.id === anchorId && message.is_draft);
  const kept = list.filter(message => Boolean(message?.is_draft) === anchorIsDraft);
  return kept.length ? kept : list;
}

export function groupConversationMessagesByAccount(messages) {
  return normalizeConversation(messages).reduce((groups, message) => {
    if (!message.account_id) return groups;
    if (!groups[message.account_id]) groups[message.account_id] = [];
    groups[message.account_id].push(message);
    return groups;
  }, {});
}

function isSentMessage(message, accounts) {
  const account = accounts.find(item => item.id === message.account_id);
  const sentFolder = account?.folder_mappings?.sent;
  if (sentFolder && message.folder === sentFolder) return true;
  if (/^sent(?:\s+(?:items|mail|messages))?$/i.test(message.folder || '')) return true;

  const ownAddresses = new Set([
    message.account_email,
    account?.email_address,
    ...(account?.aliases || []).map(alias => alias.email),
  ].filter(Boolean).map(address => address.toLowerCase()));
  return ownAddresses.has((message.from_email || '').toLowerCase());
}

export const conversationSpamTargets = (messages, accounts = []) => normalizeConversation(messages)
  .filter(message => !isSentMessage(message, accounts));

export const newestSnoozeTarget = messages => normalizeConversation(messages)
  .filter(message => message.folder === 'INBOX')
  .at(-1) || null;
