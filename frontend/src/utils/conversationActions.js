import { normalizeConversation } from './conversation.js';

export const conversationActionIds = messages => normalizeConversation(messages)
  .map(message => message.id)
  .filter(Boolean);

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
