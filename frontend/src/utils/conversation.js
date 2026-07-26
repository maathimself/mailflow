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

export const initialExpandedMessageIds = messages => {
  const newest = newestConversationMessage(messages);
  return new Set(newest ? [newest.id] : []);
};

export const shouldUseConversationPane = ({ mode, searchQuery, message }) =>
  mode === 'pane'
  && !searchQuery?.trim()
  && Boolean(message?.thread_id)
  && Number(message?.message_count) > 1;
