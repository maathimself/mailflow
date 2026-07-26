export function normalizeConversation(messages = []) {
  const seen = new Set();
  return [...messages]
    .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    .filter(message => {
      const key = message.message_id || message.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const newestConversationMessage = messages => normalizeConversation(messages).at(-1) || null;

export const unreadConversationIds = messages => normalizeConversation(messages)
  .filter(message => !message.is_read)
  .map(message => message.id);

export const conversationUnreadCount = messages => normalizeConversation(messages)
  .filter(message => !message.is_read)
  .length;

export const conversationReadTargets = (messages, read) => normalizeConversation(messages)
  .filter(message => message.is_read !== read);

export const inboxConversationReadTargets = (messages, read) => conversationReadTargets(messages, read)
  .filter(message => message.folder === 'INBOX');

export const conversationMembershipKey = messages => normalizeConversation(messages)
  .map(message => message.id)
  .join('\u0000');

export const initialExpandedMessageIds = messages => {
  const newest = newestConversationMessage(messages);
  return new Set(newest ? [newest.id] : []);
};

export function reconcileExpandedMessageIds({ previousMessages = [], nextMessages = [], expandedIds = new Set(), automaticExpandedId = null }) {
  const previousIds = new Set(normalizeConversation(previousMessages).map(message => message.id));
  const normalizedNext = normalizeConversation(nextMessages);
  const newMessages = normalizedNext.filter(message => !previousIds.has(message.id));
  const newest = normalizedNext.at(-1);
  if (!newest || !newMessages.some(message => message.id === newest.id)) {
    return { expandedIds: new Set(expandedIds), automaticExpandedId };
  }

  const nextExpandedIds = new Set(expandedIds);
  if (automaticExpandedId) nextExpandedIds.delete(automaticExpandedId);
  nextExpandedIds.add(newest.id);
  return { expandedIds: nextExpandedIds, automaticExpandedId: newest.id };
}

export const shouldUseConversationPane = ({ mode, searchQuery, message }) =>
  mode === 'pane'
  && !searchQuery?.trim()
  && Boolean(message?.thread_id)
  && Number(message?.message_count) > 1;
