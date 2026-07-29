import { useStore } from '../store/index.js';
import { resolveConversationSelection, shouldUseConversationPane } from '../utils/conversation.js';
import MessagePane from './MessagePane.jsx';
import ConversationPane from './ConversationPane.jsx';

export default function ReadingPane() {
  const selectedMessageId = useStore(state => state.selectedMessageId);
  const messages = useStore(state => state.messages);
  const searchResults = useStore(state => state.searchResults);
  const searchQuery = useStore(state => state.searchQuery);
  const threadMessages = useStore(state => state.threadMessages);
  const conversationMode = useStore(state => state.conversationMode);
  const pool = searchQuery.trim() ? searchResults : messages;
  const { selectedMessage, conversationMessage, refreshKey } = resolveConversationSelection({
    selectedMessageId,
    pool,
    threadMessages,
  });

  if (!selectedMessage || !shouldUseConversationPane({ mode: conversationMode, searchQuery, message: conversationMessage })) {
    return <MessagePane />;
  }

  return <ConversationPane key={conversationMessage.thread_id} message={conversationMessage} threadId={conversationMessage.thread_id} refreshKey={refreshKey} />;
}
