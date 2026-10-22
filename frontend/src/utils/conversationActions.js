import { normalizeConversation } from './conversation.js';
import { useStore } from '../store/index.js';
import { folderRole } from './folderDisplay.js';

export const conversationActionIds = messages => normalizeConversation(messages)
  .map(message => message.id)
  .filter(Boolean);

// Archiving, deleting or moving a conversation never mixes drafts with the rest of it (the thread
// route marks drafts is_draft). Acting on a message leaves the conversation's drafts alone: a
// deleted draft is expunged rather than moved to Trash, so an unsent reply would be lost with the
// thread it answers. Acting on a draft, as in the Drafts folder, touches only the drafts: discarding
// a reply must not take the conversation it answers. A thread with nothing on the other side keeps
// everything, so the action is never silently empty.
//
// Trash and Spam are left alone the same way. The thread route returns a conversation from every
// folder, so deleting one from the Inbox also took its copies already in Trash, and a delete in
// Trash expunges for good: a message deleted earlier was gone, though the reader only meant the
// newer ones. Moving it pulled them back out. Acting from Trash or Spam itself, as before, takes it all.
export function keepDraftsApart(messages, anchorId) {
  const list = Array.isArray(messages) ? messages : [];
  const anchor = list.find(message => message?.id === anchorId);
  const anchorIsDraft = Boolean(anchor?.is_draft);
  const anchorBinned = Boolean(anchor) && isBinned(anchor);
  const kept = list.filter(message => Boolean(message?.is_draft) === anchorIsDraft
    && (anchorBinned || !isBinned(message)));
  return kept.length ? kept : list;
}

// Trash or Spam, as the account's folder list or folder mappings say, else by the usual names.
const BIN_NAMES = /^(?:\[gmail\]\/|\[google mail\]\/)?(?:trash|bin|deleted items|deleted messages|spam|junk|junk e-?mail|junk mail|bulk mail)$/i;
function isBinned(message) {
  if (!message?.folder) return false;
  const { folders, accounts } = useStore.getState();
  const folder = (folders?.[message.account_id] || []).find(f => f.path === message.folder);
  const mappings = (accounts || []).find(a => a.id === message.account_id)?.folder_mappings;
  const role = folderRole(folder || { path: message.folder }, mappings);
  if (role) return role === 'trash' || role === 'spam';
  return BIN_NAMES.test(message.folder);
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
