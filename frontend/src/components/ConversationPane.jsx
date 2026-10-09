import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { useStore } from '../store/index.js';
import {
  normalizeConversation,
  initialExpandedMessageIds,
  conversationMembershipKey,
  newestConversationMessage,
} from '../utils/conversation.js';
import { archiveThread, deleteThread, spamThread, moveThread, snoozeThread } from '../utils/threadActions.js';
import { advanceSelectionAfterRemoval } from '../utils/listSelection.js';
import { buildPrintDocument, openPrintWindow, printInWindow } from '../utils/printMessage.js';
import ConversationMessageCard from './ConversationMessageCard.jsx';
import { aiReplyAvailable } from '../utils/aiReply.js';
import ContextMenu from './ContextMenu.jsx';

function ThreadBtn({ onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px',
        background: 'none', border: '1px solid var(--border)', borderRadius: 4,
        color: 'var(--text-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// The whole conversation, stacked, with only what the reader has opened rendered.
//
// The thread endpoint already returns every message across folders, Sent replies included,
// deduplicated by Message-ID preferring the INBOX copy, so this needs no scope parameter of
// its own.
//
// Design from #317 by YunQue0912.
export default function ConversationPane({ threadId, folder, unified = false, selectedMessageId = null }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const addNotification = useStore(s => s.addNotification);
  const accounts = useStore(s => s.accounts);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const updateMessage = useStore(s => s.updateMessage);
  const plaintextEmail = useStore(s => s.plaintextEmail);
  const [messages, setMessages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // { x, y, view } — the move and snooze pickers are ContextMenu's, opened straight
  // into the relevant sub-view rather than reimplemented here.
  const [picker, setPicker] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);

  useEffect(() => {
    api.ai.status().then(setAiStatus).catch(() => {});
  }, []);
  const aiEnabled = Boolean(aiStatus?.enabled && aiStatus?.features?.summarize);
  const aiReplyEnabled = aiReplyAvailable(aiStatus, plaintextEmail);

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getThread(threadId, folder, unified)
      .then(data => {
        if (cancelled) return;
        const ordered = normalizeConversation(data?.messages || []);
        setMessages(ordered);
        // Opens on the newest message, the way every threaded client does: the reader
        // almost always wants the latest reply, and expanding everything would render a
        // document per message.
        setExpanded(initialExpandedMessageIds(ordered));
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId, folder, unified]);

  // Opening a message from the list opens it here too. Picking a different message in the
  // same thread leaves threadId untouched, so the pane used to re-render with identical
  // props and nothing happened on screen, which read as the click being ignored.
  const stackRef = useRef(null);
  useEffect(() => {
    if (!selectedMessageId || !messages.some(message => message.id === selectedMessageId)) return;
    setExpanded(prev => (prev.has(selectedMessageId) ? prev : new Set(prev).add(selectedMessageId)));
    // Long threads run past the fold, so the message that was asked for is brought into
    // view rather than being opened somewhere off screen.
    const card = stackRef.current?.querySelector(`[data-message-id="${selectedMessageId}"]`);
    card?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedMessageId, messages]);

  const toggle = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const runAction = (action) => {
    // Every action here takes the conversation's row out of the list. Open what takes its place
    // (the afterRemove setting) while the row is still there to look up; with no row on screen,
    // fall back to clearing the pane.
    const { messages: listed, searchResults, searchQuery } = useStore.getState();
    const row = (searchQuery.trim() ? searchResults : listed).find(m => (m.thread_id || m.id) === threadId);
    if (row) advanceSelectionAfterRemoval(row.id, true);
    else setSelectedMessage(null);
    action(messages, {
      t,
      addNotification,
      accounts,
      // The authoritative list, re-read when the action actually commits, so a reply
      // that arrived while this conversation was open is not left behind.
      fetchThread: () => api.getThread(threadId, folder, unified),
      // Archive, delete and move keep drafts and the rest apart, by the selected message (keepDraftsApart).
      anchorId: selectedMessageId,
      // Archive moves only the copies in the folder being viewed, as the list's archive does: the
      // unified inbox is every account's INBOX, an account view is that account's folder.
      folder: unified ? 'INBOX' : folder,
      accountId: unified ? null : (messages.find(message => message.id === selectedMessageId)?.account_id ?? null),
    });
  };

  // A flag change on one card: the pane's copy of the thread and the list's copy both change.
  const updateConversationMessage = (id, patch) => {
    setMessages(prev => prev.map(message => (message.id === id ? { ...message, ...patch } : message)));
    updateMessage(id, patch);
  };

  // The window opens on the click, before any await, or the browser blocks it. Bodies are loaded
  // one at a time: collapsed messages have none yet, and a session-limited provider serves the
  // account over a single connection.
  const printConversation = async () => {
    const win = openPrintWindow(t('message.preparingPrint'));
    if (!win) return;
    const entries = [];
    for (const message of messages) {
      const body = await api.getMessageBody(message.id).catch(() => null);
      if (win.closed) return;
      entries.push({ message, body });
    }
    printInWindow(win, buildPrintDocument(entries));
  };

  const openPicker = (event, view) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPicker({ x: rect.left, y: rect.bottom + 4, view });
  };

  // Every branch that returns from here fills the reading area, for the same flex reason
  // as the stack below: a bare div would collapse to the width of its own text.
  const fill = { flex: 1, minWidth: 0, height: '100%', background: 'var(--bg-primary)' };

  // On a phone this pane replaces the message pane, and with it the only header the
  // reading area had. Without a bar of its own, the thread actions sat under the iOS
  // status bar — a standalone PWA draws its content behind it — and the conversation
  // could not be left at all, since a standalone PWA has no swipe-back either. Same bar
  // the message pane shows, safe-area padding included.
  const mobileBackBar = isMobile && (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      paddingTop: 'calc(var(--sat) + 10px)', paddingBottom: 10, paddingLeft: 14, paddingRight: 14,
      borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', flexShrink: 0,
    }}>
      <button
        onClick={() => history.back()}
        style={{
          background: 'none', border: 'none', color: 'var(--accent)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          gap: 2, padding: '4px 0', fontSize: 15, fontWeight: 500,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        {t('common.back')}
      </button>
      <div style={{
        flex: 1, minWidth: 0,
        fontSize: 14, fontWeight: 500, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {newestConversationMessage(messages)?.subject || ''}
      </div>
    </div>
  );

  if (error) return (
    <div style={fill}>
      {mobileBackBar}
      <div style={{ padding: 16, color: 'var(--red, #e03131)' }}>{error}</div>
    </div>
  );
  if (loading && !messages.length) {
    return (
      <div style={fill}>
        {mobileBackBar}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="skeleton-line" style={{ height: 13, width: '48%', borderRadius: 4 }} />
          <div className="skeleton-line" style={{ height: 13, width: '70%', borderRadius: 4 }} />
        </div>
      </div>
    );
  }
  if (!messages.length) return null;

  return (
    <div style={{ ...fill, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {mobileBackBar}
      <div
        // Remounts the stack when the thread's membership changes, so expansion state from a
        // previous conversation can never be applied to this one's message ids.
        key={conversationMembershipKey(messages)}
        ref={stackRef}
        // flex: 1 and minWidth: 0 are load-bearing. The reading area is a flex row, so
        // without them this pane is sized shrink-to-fit by its contents: collapsed cards
        // are narrow, an expanded newsletter is as wide as the newsletter, and the pane
        // jumped around as the reader opened and closed messages. minWidth: 0 is the other
        // half, since a flex item defaults to min-width:auto and a wide email would
        // otherwise push the pane past its share of the row.
        style={{
          flex: 1, minWidth: 0,
          padding: 12, overflowY: 'auto',
          background: 'var(--bg-primary)',
        }}
      >
        {/* Thread-level actions, the way Gmail does it: archiving a conversation archives
            all of it, so the reader does not file the same thread message by message. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <ThreadBtn onClick={() => runAction(archiveThread)} title={t('message.archive')}>
            {t('message.archive')}
          </ThreadBtn>
          <ThreadBtn onClick={() => runAction(deleteThread)} title={t('message.delete')}>
            {t('message.delete')}
          </ThreadBtn>
          <ThreadBtn onClick={() => runAction(spamThread)} title={t('contextMenu.markAsSpam')}>
            {t('contextMenu.markAsSpam')}
          </ThreadBtn>
          <ThreadBtn
            onClick={e => openPicker(e, 'move')}
            title={t('contextMenu.moveToFolder')}
          >
            {t('contextMenu.moveToFolder')}
          </ThreadBtn>
          <ThreadBtn
            onClick={e => openPicker(e, 'snooze')}
            title={t('contextMenu.snooze.label')}
          >
            {t('contextMenu.snooze.label')}
          </ThreadBtn>
          <ThreadBtn onClick={printConversation} title={t('message.printConversation')}>
            {t('message.printConversation')}
          </ThreadBtn>
        </div>

        {picker && (
          <ContextMenu
            x={picker.x}
            y={picker.y}
            message={newestConversationMessage(messages)}
            variant="conversation"
            defaultMoveView={picker.view === 'move'}
            defaultSnoozeView={picker.view === 'snooze'}
            onClose={() => setPicker(null)}
            onAction={(action, data) => {
              if (action === 'moveTo') runAction((list, opts) => moveThread(list, data, opts));
              else if (action === 'snooze') runAction((list, opts) => snoozeThread(list, data, opts));
              setPicker(null);
            }}
          />
        )}

        {messages.map(message => (
          <ConversationMessageCard
            key={message.id}
            message={message}
            expanded={expanded.has(message.id)}
            selected={message.id === selectedMessageId}
            onToggle={toggle}
            onUpdate={updateConversationMessage}
            aiEnabled={aiEnabled}
            aiReplyEnabled={aiReplyEnabled}
          />
        ))}
      </div>
    </div>
  );
}
