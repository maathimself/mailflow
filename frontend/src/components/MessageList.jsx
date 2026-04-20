import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDistanceToNowStrict, format, isToday, isYesterday, isThisYear } from 'date-fns';
import { LAYOUTS } from '../layouts.js';
import ContextMenu from './ContextMenu.jsx';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isToday(d)) return format(d, 'h:mm a');
  if (isYesterday(d)) return 'Yesterday';
  if (isThisYear(d)) return format(d, 'MMM d');
  return format(d, 'MMM d, yyyy');
}

export default function MessageList() {
  const {
    selectedAccountId, selectedFolder, messages, setMessages,
    appendMessages, messagesTotal, setMessagesTotal, messagesOffset,
    setMessagesOffset, hasMoreMessages, setHasMoreMessages,
    loadingMessages, setLoadingMessages, selectedMessageId,
    setSelectedMessage, updateMessage, removeMessage, decrementUnread,
    searchQuery, setSearchQuery, isSearching, setIsSearching,
    searchResults, setSearchResults, openCompose, accountsReady, accounts,
    messagesRefreshToken, layout,
  } = useStore();

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;
  const isColumn = currentLayout.direction === 'column';
  const isNarrow = !isColumn && currentLayout.listWidth <= 260;

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [syncing, setSyncing] = useState(false);
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, message }
  const PAGE_SIZE = pageSize;
  const listRef = useRef(null);
  const searchTimer = useRef(null);

  // Reset and load fresh when account/folder/filter changes
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // Don't attempt to load until we know which accounts exist.
      // Without this guard, the unified inbox query fires before getAccounts()
      // resolves, finds no account IDs, and returns empty — causing the blank
      // "All Inboxes" on first load.
      if (!accountsReady) return;
      setLoadingMessages(true);
      setMessagesOffset(0);
      setHasMoreMessages(true);
      try {
        const params = { limit: PAGE_SIZE, offset: 0 };
        if (selectedAccountId) {
          params.accountId = selectedAccountId;
          params.folder = selectedFolder;
        }
        if (unreadOnly) params.unreadOnly = 'true';
        const data = await api.getMessages(params);
        if (cancelled) return;
        setMessagesTotal(data.total);
        setMessages(data.messages);
        setMessagesOffset(data.messages.length);
        setHasMoreMessages(data.messages.length < data.total);

        // If a specific non-INBOX folder opened empty, trigger an on-demand IMAP sync.
        // The backend will broadcast sync_complete → mailflow:refresh once done.
        if (data.messages.length === 0 && selectedAccountId && selectedFolder !== 'INBOX') {
          setFolderSyncing(true);
          api.syncFolder(selectedAccountId, selectedFolder)
            .catch(err => console.error('syncFolder failed:', err.message))
            .finally(() => { if (!cancelled) setFolderSyncing(false); });
        } else {
          setFolderSyncing(false);
        }
      } catch (err) {
        console.error('Failed to load messages:', err);
        setFolderSyncing(false);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, accountsReady, accounts.length, messagesRefreshToken]);

  // Load next page (called by scroll or button)
  const loadMore = useCallback(async () => {
    if (loadingMessages || !hasMoreMessages) return;
    setLoadingMessages(true);
    try {
      // Read current offset directly from store to avoid stale closure
      const currentOffset = useStore.getState().messagesOffset;
      const params = { limit: PAGE_SIZE, offset: currentOffset };
      if (selectedAccountId) {
        params.accountId = selectedAccountId;
        params.folder = selectedFolder;
      }
      if (unreadOnly) params.unreadOnly = 'true';
      const data = await api.getMessages(params);
      appendMessages(data.messages);
      setMessagesOffset(currentOffset + data.messages.length);
      setHasMoreMessages(currentOffset + data.messages.length < data.total);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, loadingMessages, hasMoreMessages]);

  // Listen for backfill refresh events from WebSocket
  useEffect(() => {
    const handler = () => {
      // Only refresh if we're not currently loading and not searching
      if (!useStore.getState().loadingMessages && !searchQuery.trim()) {
        const run = async () => {
          try {
            const currentOffset = useStore.getState().messagesOffset;
            const params = { limit: currentOffset || PAGE_SIZE, offset: 0 };
            if (selectedAccountId) {
              params.accountId = selectedAccountId;
              params.folder = selectedFolder;
            }
            if (unreadOnly) params.unreadOnly = 'true';
            const data = await api.getMessages(params);
            setMessagesTotal(data.total);
            setMessages(data.messages);
            setMessagesOffset(data.messages.length);
            setHasMoreMessages(data.messages.length < data.total);
          } catch (_) {}
        };
        run();
      }
    };
    window.addEventListener('mailflow:refresh', handler);
    return () => window.removeEventListener('mailflow:refresh', handler);
  }, [selectedAccountId, selectedFolder, unreadOnly, searchQuery]);

  // Search
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(searchQuery, selectedAccountId || undefined);
        setSearchResults(data.messages);
      } catch (err) {
        console.error('Search failed:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, selectedAccountId]);

  // Infinite scroll
  const handleScroll = useCallback(() => {
    if (!listRef.current || loadingMessages || !hasMoreMessages) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    if (scrollTop + clientHeight >= scrollHeight - 300) {
      loadMore();
    }
  }, [loadMore, loadingMessages, hasMoreMessages]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncNow(selectedAccountId || undefined);
      // The server will send sync_complete via WebSocket when done, which triggers
      // mailflow:refresh (list reload) and mailflow:sync_done (spinner off).
      // Safety fallback: stop spinner after 15s in case WS event never arrives.
      setTimeout(() => setSyncing(false), 15000);
    } catch (err) {
      console.error('Sync failed:', err);
      setSyncing(false);
    }
  };

  // Animate the sync icon on WS sync_complete — the actual list refresh is handled
  // by the mailflow:refresh listener above (also fired on sync_complete), so this
  // handler only needs to toggle the spinner. Having both handlers re-fetch the list
  // caused two concurrent setMessages() calls racing each other.
  useEffect(() => {
    const handler = async () => {
      setSyncing(true);
      setTimeout(() => setSyncing(false), 1200);
    };
    window.addEventListener('mailflow:sync_done', handler);
    return () => window.removeEventListener('mailflow:sync_done', handler);
  }, []);

  const handleMarkRead = async (e, message) => {
    e.stopPropagation();
    const newRead = !message.is_read;
    try {
      await api.markRead(message.id, newRead);
      updateMessage(message.id, { is_read: newRead });
      if (newRead) decrementUnread(message.account_id);
    } catch (err) {
      console.error(err);
    }
  };

  const handleStar = async (e, message) => {
    e.stopPropagation();
    try {
      const newVal = !message.is_starred;
      await api.markStarred(message.id, newVal);
      updateMessage(message.id, { is_starred: newVal });
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (e, message) => {
    e.stopPropagation();
    try {
      await api.deleteMessage(message.id);
      removeMessage(message.id);
    } catch (err) {
      console.error(err);
    }
  };

  const handleContextAction = async (action, message) => {
    switch (action) {
      case 'open':
        handleSelect(message);
        break;
      case 'markRead':
        if (!message.is_read) {
          updateMessage(message.id, { is_read: true });
          decrementUnread(message.account_id);
          api.markRead(message.id, true).catch(console.error);
        }
        break;
      case 'markUnread':
        if (message.is_read) {
          updateMessage(message.id, { is_read: false });
          api.markRead(message.id, false).catch(console.error);
        }
        break;
      case 'toggleStar': {
        const newVal = !message.is_starred;
        updateMessage(message.id, { is_starred: newVal });
        api.markStarred(message.id, newVal).catch(console.error);
        break;
      }
      case 'reply':
        openCompose({
          to: message.from_email ? [{ name: message.from_name, email: message.from_email }] : [],
          subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
          inReplyTo: message.message_id,
          accountId: message.account_id,
        });
        break;
      case 'replyAll':
        openCompose({
          to: message.from_email ? [{ name: message.from_name, email: message.from_email }] : [],
          subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
          inReplyTo: message.message_id,
          accountId: message.account_id,
        });
        break;
      case 'forward':
        openCompose({
          subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
          accountId: message.account_id,
        });
        break;
      case 'delete':
        removeMessage(message.id);
        api.deleteMessage(message.id).catch(console.error);
        break;
      default:
        break;
    }
  };

  const handleSelect = async (message) => {
    setSelectedMessage(message.id);
    // Always optimistically mark as read in UI immediately
    if (!message.is_read) {
      updateMessage(message.id, { is_read: true });
      decrementUnread(message.account_id);
      // Then sync to server — log errors instead of silently swallowing
      api.markRead(message.id, true).catch(err => {
        console.error('markRead failed:', err.message);
        // Revert optimistic update on failure
        updateMessage(message.id, { is_read: false });
      });
    }
  };

  const displayMessages = searchQuery.trim() ? searchResults : messages;
  const isUnified = selectedAccountId === null;

  const label = searchQuery.trim()
    ? `Search: "${searchQuery}"`
    : isUnified ? 'All Inboxes' : selectedFolder;

  return (
    <div style={{
      width: isColumn ? '100%' : currentLayout.listWidth,
      minWidth: isColumn ? undefined : Math.max(180, currentLayout.listWidth - 80),
      flex: isColumn ? '0 0 42%' : undefined,
      minHeight: isColumn ? 0 : undefined,
      borderRight: isColumn ? 'none' : '1px solid var(--border-subtle)',
      borderBottom: isColumn ? '1px solid var(--border-subtle)' : 'none',
      display: 'flex', flexDirection: 'column',
      height: isColumn ? undefined : '100vh',
      background: 'var(--bg-primary)',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 10px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        {/* Title row: label + count + sync (always fits) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isNarrow ? 6 : 10 }}>
          <h2 style={{
            margin: 0, fontSize: 15, fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            {label}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 6 }}>
            {messagesTotal > 0 && !searchQuery && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {messagesTotal}
              </span>
            )}
            {/* Sync button */}
            <button
              onClick={handleSync}
              disabled={syncing}
              title={selectedAccountId ? 'Sync this account' : 'Sync all accounts'}
              style={{
                background: 'none', border: '1px solid transparent',
                borderRadius: 6, padding: '4px 6px',
                color: syncing ? 'var(--accent)' : 'var(--text-tertiary)',
                cursor: syncing ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { if (!syncing) { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--border)'; }}}
              onMouseLeave={e => { if (!syncing) { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}}
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2"
                style={{ animation: syncing ? 'spin 0.8s linear infinite' : 'none' }}
              >
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
            {/* In wide layouts, keep filter + page size inline */}
            {!isNarrow && (
              <>
                {/* Filter unread */}
                <button
                  onClick={() => setUnreadOnly(!unreadOnly)}
                  title={unreadOnly ? 'Show all' : 'Unread only'}
                  style={{
                    background: unreadOnly ? 'var(--accent-dim)' : 'none',
                    border: `1px solid ${unreadOnly ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6, padding: '4px 8px',
                    color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
                    cursor: 'pointer', fontSize: 11, fontWeight: 500,
                  }}
                >
                  Unread
                </button>
                {/* Page size */}
                <select
                  value={pageSize}
                  onChange={e => setPageSize(parseInt(e.target.value))}
                  title="Messages per page"
                  style={{
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '4px 6px',
                    color: 'var(--text-tertiary)', cursor: 'pointer',
                    fontSize: 11, outline: 'none',
                  }}
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </>
            )}
          </div>
        </div>

        {/* Narrow layouts: filter + page size on their own row */}
        {isNarrow && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <button
              onClick={() => setUnreadOnly(!unreadOnly)}
              title={unreadOnly ? 'Show all' : 'Unread only'}
              style={{
                background: unreadOnly ? 'var(--accent-dim)' : 'none',
                border: `1px solid ${unreadOnly ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6, padding: '4px 8px',
                color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
                cursor: 'pointer', fontSize: 11, fontWeight: 500,
              }}
            >
              Unread
            </button>
            <select
              value={pageSize}
              onChange={e => setPageSize(parseInt(e.target.value))}
              title="Messages per page"
              style={{
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 6px',
                color: 'var(--text-tertiary)', cursor: 'pointer',
                fontSize: 11, outline: 'none',
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </div>
        )}

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 10, top: '50%',
            transform: 'translateY(-50%)', color: 'var(--text-tertiary)',
            pointerEvents: 'none',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <input
            type="text"
            placeholder="Search messages…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px 8px 32px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
              outline: 'none',
            }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: 'var(--text-tertiary)',
                cursor: 'pointer', padding: 2, display: 'flex',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflow: 'auto' }}
      >
        {loadingMessages && displayMessages.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
            <div style={{
              width: 24, height: 24, margin: '0 auto 12px',
              border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            Loading messages…
          </div>
        )}

        {!loadingMessages && displayMessages.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 14 }}>
            {folderSyncing ? (
              <>
                <div style={{
                  width: 20, height: 20, margin: '0 auto 10px',
                  border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                }} />
                Syncing folder…
              </>
            ) : searchQuery ? 'No results found' : 'No messages'}
          </div>
        )}

        {displayMessages.map(message => (
          <MessageRow
            key={message.id}
            message={message}
            selected={selectedMessageId === message.id}
            showAccount={isUnified}
            onSelect={handleSelect}
            onMarkRead={handleMarkRead}
            onStar={handleStar}
            onDelete={handleDelete}
            onContextMenu={(e, msg) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, message: msg });
            }}
          />
        ))}

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            message={contextMenu.message}
            onClose={() => setContextMenu(null)}
            onAction={(action) => handleContextAction(action, contextMenu.message)}
          />
        )}

        {loadingMessages && displayMessages.length > 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
            <div style={{
              width: 16, height: 16, margin: '0 auto 6px',
              border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block',
            }} />
            <div>Loading more…</div>
          </div>
        )}

        {!loadingMessages && hasMoreMessages && displayMessages.length > 0 && (
          <div style={{ padding: '12px 16px', textAlign: 'center' }}>
            <button
              onClick={loadMore}
              style={{
                padding: '7px 20px', background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 7,
                color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
                transition: 'all 0.1s',
              }}
              onMouseEnter={e => { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}
              onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = 'var(--text-secondary)'; }}
            >
              Load more
            </button>
          </div>
        )}

        {!loadingMessages && !hasMoreMessages && displayMessages.length > 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
            All {messagesTotal} messages loaded
          </div>
        )}
      </div>
    </div>
  );
}

function MessageRow({ message, selected, showAccount, onSelect, onMarkRead, onStar, onDelete, onContextMenu }) {
  const [hovered, setHovered] = useState(false);

  const bg = selected
    ? 'var(--bg-elevated)'
    : hovered ? 'var(--bg-tertiary)' : 'transparent';

  return (
    <div
      onClick={() => onSelect(message)}
      onContextMenu={e => onContextMenu(e, message)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: 'var(--layout-row-py, 11px) var(--layout-row-px, 14px)',
        cursor: 'pointer', background: bg, transition: 'background 0.1s',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'relative',
      }}
    >
      {/* Unread indicator — fixed accent color so it's always distinct from the account dot */}
      {!message.is_read && (
        <div style={{
          position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--accent)',
        }} />
      )}

      <div style={{ paddingLeft: message.is_read ? 0 : 6 }}>
        {/* Row 1: From + date */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
            {showAccount && (
              <div style={{
                width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                background: message.account_color || '#6366f1',
                opacity: 0.55,
              }} />
            )}
            <span style={{
              fontSize: 13, fontWeight: message.is_read ? 400 : 600,
              color: message.is_read ? 'var(--text-secondary)' : 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}>
              {message.from_name || message.from_email || 'Unknown'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 8 }}>
            {message.has_attachments && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
              </svg>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {formatDate(message.date)}
            </span>
          </div>
        </div>

        {/* Row 2: Subject */}
        <div style={{
          fontSize: 13, fontWeight: message.is_read ? 400 : 500,
          color: message.is_read ? 'var(--text-secondary)' : 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 3,
        }}>
          {message.subject || '(no subject)'}
        </div>

        {/* Row 3: Snippet */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{
            fontSize: 12, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {message.snippet || '\u00a0'}
          </span>
        </div>
      </div>

      {/* Hover actions — absolutely positioned so they never affect row height */}
      {hovered && (
        <div style={{
          position: 'absolute', bottom: 6, right: 8,
          display: 'flex', alignItems: 'center', gap: 2,
          background: bg,
          borderRadius: 5,
          padding: '1px 2px',
        }}>
          {/* Mark read/unread */}
          <ActionBtn
            title={message.is_read ? 'Mark unread' : 'Mark read'}
            onClick={e => onMarkRead(e, message)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill={message.is_read ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </ActionBtn>

          {/* Star */}
          <ActionBtn title={message.is_starred ? 'Unstar' : 'Star'} onClick={e => onStar(e, message)}>
            <svg width="13" height="13" viewBox="0 0 24 24"
              fill={message.is_starred ? 'var(--amber)' : 'none'}
              stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </ActionBtn>

          {/* Delete */}
          <ActionBtn title="Delete" onClick={e => onDelete(e, message)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </ActionBtn>
        </div>
      )}
    </div>
  );
}

function ActionBtn({ children, onClick, title }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? 'var(--bg-hover)' : 'none',
        border: 'none', padding: '3px', borderRadius: 4,
        color: 'var(--text-tertiary)', cursor: 'pointer',
        display: 'flex', alignItems: 'center',
        transition: 'background 0.1s, color 0.1s',
      }}
    >
      {children}
    </button>
  );
}
