import { useStore } from '../store/index.js';
import { resolveConversationMode } from '../utils/conversationMode.js';
import { resolveConversationSelection, shouldUseConversationPane } from '../utils/conversation.js';
import ConversationPane from './ConversationPane.jsx';
import ReplyDraftIndicator from './ReplyDraftIndicator.jsx';
import MessagePane from './MessagePane.jsx';

// Chooses what the reading area shows.
//
// In 'pane' mode a selected row opens its whole conversation; in every other mode it opens
// the single message, exactly as before. The thread is taken from the selected message
// rather than tracked separately, so selecting a row needs no new behavior in MessageList.
//
// Pop-out windows deliberately keep MessagePane: a pop-out is one message by definition.
//
// Design from #317 by YunQue0912.
export default function ReadingPane() {
  const conversationMode = useStore(s => s.conversationMode);
  const selectedMessageId = useStore(s => s.selectedMessageId);
  const messages = useStore(s => s.messages);
  const searchResults = useStore(s => s.searchResults);
  const selectedFolder = useStore(s => s.selectedFolder);
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const searchQuery = useStore(s => s.searchQuery);
  const threadMessages = useStore(s => s.threadMessages);

  const replyDraft = useStore(state => state.replyDrafts[selectedMessageId]);

  const mode = resolveConversationMode({ conversationMode });
  if (!selectedMessageId) return <MessagePane />;

  // threadMessages is consulted too, because a message opened from a deep link or a
  // notification tap is parked there and never enters the list: looking only at the list
  // meant those always fell back to the single-message pane.
  const { selectedMessage: selected } = resolveConversationSelection({
    selectedMessageId,
    pool: [...(messages || []), ...(searchResults || [])],
    threadMessages: threadMessages || {},
  });

  // A message with no thread of its own is just a message, and a search deliberately shows
  // the one matched message rather than its conversation.
  const pane = !shouldUseConversationPane({ mode, searchQuery, message: selected }) ? <MessagePane /> : (

    <ConversationPane
      threadId={selected.thread_id}
      folder={selectedFolder}
      unified={!selectedAccountId}
      // Which message the reader picked. Selecting a different message inside the same
      // thread does not change threadId, so without this the pane had no way to know a
      // click had happened and nothing opened.
      selectedMessageId={selectedMessageId}
    />
  );
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', minHeight: 0 }}>
    {selectedFolder?.toUpperCase() === 'INBOX' && (replyDraft?.exists || replyDraft?.error) && <div style={{ flexShrink: 0, padding: '4px 12px' }}><ReplyDraftIndicator message={selected} /></div>}
    <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>{pane}</div>
  </div>;
}
