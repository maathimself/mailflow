import { useStore } from '../store/index.js';
import { shouldUseConversationPane } from '../utils/conversation.js';
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
  const selectedMessage = pool.find(message => message.id === selectedMessageId)
    || Object.values(threadMessages).flat().find(message => message.id === selectedMessageId);

  if (!selectedMessage || !shouldUseConversationPane({ mode: conversationMode, searchQuery, message: selectedMessage })) {
    return <MessagePane />;
  }

  return <ConversationPane key={selectedMessage.thread_id} message={selectedMessage} threadId={selectedMessage.thread_id} />;
}
