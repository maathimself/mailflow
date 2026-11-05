import { useRef } from 'react';
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

  // The message last shown, for a conversation whose row changed under it (below).
  const shownRef = useRef(null);

  const mode = resolveConversationMode({ conversationMode });
  if (!selectedMessageId) return <MessagePane />;

  // threadMessages is consulted too, because a message opened from a deep link or a
  // notification tap is parked there and never enters the list: looking only at the list
  // meant those always fell back to the single-message pane.
  const pool = [...(messages || []), ...(searchResults || [])];
  let { selectedMessage: selected, listed, parked } = resolveConversationSelection({
    selectedMessageId,
    pool,
    threadMessages: threadMessages || {},
  });
  // A conversation row stands for its newest message, so a reply that arrives gives the row a new
  // id and the one the reader opened leaves the list: the conversation they were reading closed
  // under them. While a row of that conversation is still listed, it stays open.
  const shown = shownRef.current;
  if (!selected && shown?.id === selectedMessageId && shown.thread_id) {
    const row = pool.find(message => message.thread_id === shown.thread_id && message.account_id === shown.account_id);
    if (row) ({ selected, listed, parked } = { selected: shown, listed: true, parked: false });
  }
  shownRef.current = selected;

  // A message with no thread of its own is just a message, and a search deliberately shows
  // the one matched message rather than its conversation.
  const pane = !shouldUseConversationPane({ mode, searchQuery, message: selected }) ? <MessagePane /> : (

    <ConversationPane
      threadId={selected.thread_id}
      folder={selectedFolder}
      unified={!selectedAccountId}
      // The account whose copies the conversation's actions take. In a single-account view a list
      // row speaks for its own account, as the list's actions on it do: the selected account,
      // except for another account's message that an undone or failed action added to the list.
      // A message expanded under a row speaks for the selected account, even when the reader
      // clicked the other account's identical copy: #476 shows both, and neither the sub-rows nor
      // the cards say which is which. A parked message is not a row, so it speaks for its own
      // account. A unified-inbox row stands for every unified account's copies, so null there, for
      // a parked message too: a refresh can list it at any moment, and what the same buttons act
      // on must not change when it does.
      accountId={selectedAccountId ? (listed || parked ? selected.account_id : selectedAccountId) : null}
      // Which message the reader picked. Selecting a different message inside the same
      // thread does not change threadId, so without this the pane had no way to know a
      // click had happened and nothing opened.
      selectedMessageId={selectedMessageId}
      // A row of the list opens the conversation as a whole, on its newest message (#707).
      openedFromRow={listed}
    />
  );
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', minHeight: 0 }}>
    {selectedFolder?.toUpperCase() === 'INBOX' && (replyDraft?.exists || replyDraft?.error) && <div style={{ flexShrink: 0, padding: '4px 12px' }}><ReplyDraftIndicator message={selected} /></div>}
    <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>{pane}</div>
  </div>;
}
