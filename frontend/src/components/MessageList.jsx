import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format, isToday, isYesterday, isThisYear } from 'date-fns';
import { LAYOUTS } from '../layouts.js';
import ContextMenu from './ContextMenu.jsx';
import { shortcutBus } from '../utils/shortcutBus.js';

// Folder icon for move picker
function FolderIcon({ specialUse, size = 13 }) {
  const s = (specialUse || '').toLowerCase();
  if (s.includes('sent'))   return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
  if (s.includes('trash'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
  if (s.includes('draft'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>;
  if (s.includes('spam') || s.includes('junk')) return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
}

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
    setSelectedMessage, updateMessage, removeMessage,
    decrementUnread, incrementUnread, addNotification,
    searchQuery, setSearchQuery, isSearching, setIsSearching,
    searchResults, setSearchResults, openCompose, accountsReady, accounts,
    messagesRefreshToken, layout, pageSize, setPageSize, scrollMode,
  } = useStore();

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;
  const isColumn = currentLayout.direction === 'column';
  const isNarrow = !isColumn && currentLayout.listWidth <= 260;

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [syncing, setSyncing] = useState(false);
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, message }
  const listRef = useRef(null);
  const searchInputRef = useRef(null); // for focusSearch shortcut

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [pickerFolders, setPickerFolders] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const folderPickerRef = useRef(null);

  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  const searchTimer = useRef(null);

  // Ref that always holds the latest values needed by shortcut handlers.
  // Updated synchronously on every render so handlers are never stale.
  const scRef = useRef({});
  scRef.current = { messages, selectedIds, setSelectedIds, updateMessage, decrementUnread, addNotification };

  // Clear selection whenever the message list resets (nav, folder change, etc.)
  useEffect(() => {
    setSelectedIds(new Set());
    setShowFolderPicker(false);
  }, [messagesRefreshToken]);

  // Escape clears selection; click-outside closes folder picker
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowFolderPicker(false);
        setSelectedIds(new Set());
      }
    };
    const onPointer = (e) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target)) {
        setShowFolderPicker(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

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
      setCurrentPage(1);
      try {
        const params = { limit: pageSize, offset: 0 };
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
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, scrollMode, accountsReady, accounts.length, messagesRefreshToken]);

  // Load next page (called by scroll or button)
  const loadMore = useCallback(async () => {
    if (loadingMessages || !hasMoreMessages) return;
    setLoadingMessages(true);
    try {
      // Read current offset directly from store to avoid stale closure
      const currentOffset = useStore.getState().messagesOffset;
      const params = { limit: pageSize, offset: currentOffset };
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
      if (!useStore.getState().loadingMessages && !searchQuery.trim()) {
        const run = async () => {
          try {
            const state = useStore.getState();
            const ps = state.pageSize;
            const sm = state.scrollMode;
            let params;
            if (sm === 'paginated') {
              const pg = currentPageRef.current;
              params = { limit: ps, offset: (pg - 1) * ps };
            } else {
              const currentOffset = state.messagesOffset;
              params = { limit: currentOffset || ps, offset: 0 };
            }
            if (selectedAccountId) { params.accountId = selectedAccountId; params.folder = selectedFolder; }
            if (unreadOnly) params.unreadOnly = 'true';
            const data = await api.getMessages(params);
            setMessagesTotal(data.total);
            // If the unread filter is on and the currently open message was just marked
            // read, the server won't return it — preserve it so the user can keep reading.
            let msgs = data.messages;
            const activeId = useStore.getState().selectedMessageId;
            if (unreadOnly && activeId && !msgs.some(m => m.id === activeId)) {
              const kept = useStore.getState().messages.find(m => m.id === activeId);
              if (kept) msgs = [kept, ...msgs];
            }
            setMessages(msgs);
            if (sm === 'paginated') {
              setHasMoreMessages(false);
            } else {
              setMessagesOffset(data.messages.length);
              setHasMoreMessages(data.messages.length < data.total);
            }
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
    if (scrollMode !== 'infinite') return;
    if (!listRef.current || loadingMessages || !hasMoreMessages) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    if (scrollTop + clientHeight >= scrollHeight - 300) {
      loadMore();
    }
  }, [scrollMode, loadMore, loadingMessages, hasMoreMessages]);

  // Load a specific page (paginated mode)
  const loadPage = useCallback(async (pageNum) => {
    if (loadingMessages) return;
    setLoadingMessages(true);
    setCurrentPage(pageNum);
    try {
      const params = { limit: pageSize, offset: (pageNum - 1) * pageSize };
      if (selectedAccountId) { params.accountId = selectedAccountId; params.folder = selectedFolder; }
      if (unreadOnly) params.unreadOnly = 'true';
      const data = await api.getMessages(params);
      setMessagesTotal(data.total);
      setMessages(data.messages);
      setMessagesOffset((pageNum - 1) * pageSize + data.messages.length);
      setHasMoreMessages(false);
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (err) {
      console.error('Failed to load page:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, loadingMessages]);

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

  // ── Bulk selection helpers ───────────────────────────────────
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((msgs) => {
    setSelectedIds(new Set(msgs.map(m => m.id)));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setShowFolderPicker(false);
  }, []);

  const handleBulkDelete = useCallback(async (ids, msgs) => {
    // Optimistically remove from UI
    ids.forEach(id => removeMessage(id));
    msgs.forEach(msg => { if (!msg.is_read) decrementUnread(msg.account_id); });
    setSelectedIds(new Set());
    setShowFolderPicker(false);
    try {
      await api.bulkDelete(ids);
    } catch (err) {
      console.error('Bulk delete failed:', err);
      addNotification({ title: 'Delete failed', body: `Could not delete ${ids.length} message(s).` });
    }
  }, [removeMessage, decrementUnread, addNotification]);

  const handleBulkMove = useCallback(async (ids, folder) => {
    ids.forEach(id => removeMessage(id));
    setSelectedIds(new Set());
    setShowFolderPicker(false);
    try {
      await api.bulkMove(ids, folder);
    } catch (err) {
      console.error('Bulk move failed:', err);
      addNotification({ title: 'Move failed', body: `Could not move ${ids.length} message(s).` });
    }
  }, [removeMessage, addNotification]);

  const handleBulkArchive = useCallback(async (ids, msgs) => {
    ids.forEach(id => removeMessage(id));
    msgs.forEach(msg => { if (!msg.is_read) decrementUnread(msg.account_id); });
    setSelectedIds(new Set());
    setShowFolderPicker(false);
    try {
      const result = await api.bulkArchive(ids);
      if (result.noArchiveFolder?.length) {
        addNotification({ title: 'No archive folder', body: 'One or more accounts have no archive folder configured. Set one in Settings → Accounts → Folder Mappings.' });
      }
    } catch (err) {
      console.error('Bulk archive failed:', err);
      addNotification({ title: 'Archive failed', body: `Could not archive ${ids.length} message(s).` });
    }
  }, [removeMessage, decrementUnread, addNotification]);

  // Keep refs to bulk handlers so the shortcut effect (registered once) is never stale
  const bulkDeleteRef  = useRef(handleBulkDelete);
  const bulkArchiveRef = useRef(handleBulkArchive);
  useEffect(() => { bulkDeleteRef.current  = handleBulkDelete;  }, [handleBulkDelete]);
  useEffect(() => { bulkArchiveRef.current = handleBulkArchive; }, [handleBulkArchive]);

  // Subscribe to keyboard shortcut actions that belong to the message list.
  // Registered once ([] deps); all live state is read through scRef/bulkDeleteRef/bulkArchiveRef.
  useEffect(() => {
    const getState = () => useStore.getState();

    const onNext = () => {
      const { messages, selectedMessageId, setSelectedMessage } = getState();
      if (!messages.length) return;
      const idx = messages.findIndex(m => m.id === selectedMessageId);
      const next = messages[idx + 1] ?? messages[0];
      setSelectedMessage(next.id);
    };

    const onPrev = () => {
      const { messages, selectedMessageId, setSelectedMessage } = getState();
      if (!messages.length) return;
      const idx = messages.findIndex(m => m.id === selectedMessageId);
      const prev = idx <= 0 ? messages[messages.length - 1] : messages[idx - 1];
      setSelectedMessage(prev.id);
    };

    const onOpen = () => {
      const { messages, selectedMessageId, setSelectedMessage } = getState();
      if (selectedMessageId || !messages.length) return;
      setSelectedMessage(messages[0].id);
    };

    const onSelect = () => {
      const { selectedMessageId } = getState();
      if (!selectedMessageId) return;
      scRef.current.setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(selectedMessageId)) next.delete(selectedMessageId);
        else next.add(selectedMessageId);
        return next;
      });
    };

    const onArchive = () => {
      const { messages, selectedMessageId, removeMessage, decrementUnread, addNotification } = getState();
      const ids = [...scRef.current.selectedIds];
      if (ids.length > 0) {
        const msgs = messages.filter(m => ids.includes(m.id));
        bulkArchiveRef.current(ids, msgs);
      } else if (selectedMessageId) {
        const msg = messages.find(m => m.id === selectedMessageId);
        if (!msg) return;
        removeMessage(selectedMessageId);
        if (!msg.is_read) decrementUnread(msg.account_id);
        api.bulkArchive([selectedMessageId]).then(result => {
          if (result.noArchiveFolder?.length) {
            addNotification({ title: 'No archive folder', body: 'No archive folder configured. Set one in Settings → Accounts → Folder Mappings.' });
          }
        }).catch(console.error);
      }
    };

    const onDelete = () => {
      const { messages, selectedMessageId } = getState();
      const ids = [...scRef.current.selectedIds];
      if (ids.length > 0) {
        const msgs = messages.filter(m => ids.includes(m.id));
        bulkDeleteRef.current(ids, msgs);
      } else if (selectedMessageId) {
        const msg = messages.find(m => m.id === selectedMessageId);
        if (!msg) return;
        const { removeMessage, decrementUnread } = getState();
        removeMessage(selectedMessageId);
        if (!msg.is_read) decrementUnread(msg.account_id);
        api.deleteMessage(selectedMessageId).catch(console.error);
      }
    };

    const onToggleRead = () => {
      const { messages, selectedMessageId, updateMessage, decrementUnread, incrementUnread } = getState();
      if (!selectedMessageId) return;
      const msg = messages.find(m => m.id === selectedMessageId);
      if (!msg) return;
      const newRead = !msg.is_read;
      updateMessage(selectedMessageId, { is_read: newRead });
      if (newRead) decrementUnread(msg.account_id);
      else         incrementUnread(msg.account_id);
      api.markRead(selectedMessageId, newRead).catch(console.error);
    };

    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    shortcutBus.on('nextMessage',   onNext);
    shortcutBus.on('prevMessage',   onPrev);
    shortcutBus.on('openMessage',   onOpen);
    shortcutBus.on('selectMessage', onSelect);
    shortcutBus.on('archive',       onArchive);
    shortcutBus.on('delete',        onDelete);
    shortcutBus.on('toggleRead',    onToggleRead);
    shortcutBus.on('focusSearch',   onFocusSearch);

    return () => {
      shortcutBus.off('nextMessage',   onNext);
      shortcutBus.off('prevMessage',   onPrev);
      shortcutBus.off('openMessage',   onOpen);
      shortcutBus.off('selectMessage', onSelect);
      shortcutBus.off('archive',       onArchive);
      shortcutBus.off('delete',        onDelete);
      shortcutBus.off('toggleRead',    onToggleRead);
      shortcutBus.off('focusSearch',   onFocusSearch);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenFolderPicker = useCallback(async (selectedMsgs) => {
    if (showFolderPicker) { setShowFolderPicker(false); return; }
    const accountIds = [...new Set(selectedMsgs.map(m => m.account_id))];
    if (accountIds.length !== 1) return;
    setShowFolderPicker(true);
    setPickerLoading(true);
    try {
      const data = await api.getFolders(accountIds[0]);
      setPickerFolders(Array.isArray(data) ? data : (data.folders || []));
    } catch (err) {
      console.error('Failed to load folders:', err);
    } finally {
      setPickerLoading(false);
    }
  }, [showFolderPicker]);
  // ─────────────────────────────────────────────────────────────

  const handleContextAction = async (action, message, data) => {
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
      case 'replyAll': {
        const replyAll = action === 'replyAll';

        const replyToArr = Array.isArray(message.reply_to)
          ? message.reply_to
          : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch (_) { return []; } })();
        const replyTarget = (replyToArr.length && replyToArr[0].email)
          ? replyToArr[0]
          : { name: message.from_name || '', email: message.from_email || '' };
        const sender = replyTarget.email ? [replyTarget] : [];

        const myEmail = accounts.find(a => a.id === message.account_id)?.email_address || '';

        const allRecipients = (() => {
          try {
            const toArr = Array.isArray(message.to_addresses)
              ? message.to_addresses
              : JSON.parse(message.to_addresses || '[]');
            const ccArr = Array.isArray(message.cc_addresses)
              ? message.cc_addresses
              : JSON.parse(message.cc_addresses || '[]');
            return [...toArr, ...ccArr].filter(
              t => t.email && t.email !== myEmail && t.email !== replyTarget.email
            );
          } catch (_) { return []; }
        })();

        const referencesChain = [message.in_reply_to, message.message_id]
          .filter(Boolean).join(' ').trim() || null;

        openCompose({
          to: sender,
          cc: replyAll ? allRecipients : [],
          subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
          body: '',
          quotedBody: '',
          inReplyTo: message.message_id,
          references: referencesChain,
          accountId: message.account_id,
          isReply: true,
          isReplyAll: replyAll,
          originalFrom: sender,
          allRecipients,
        });
        break;
      }
      case 'forward':
        openCompose({
          subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
          body: '',
          quotedBody: '',
          accountId: message.account_id,
          isForward: true,
        });
        break;
      case 'bulkSelect':
        setSelectedIds(new Set([message.id]));
        break;
      case 'archive': {
        removeMessage(message.id);
        if (!message.is_read) decrementUnread(message.account_id);
        try {
          const result = await api.bulkArchive([message.id]);
          if (result.noArchiveFolder?.length) {
            addNotification({ title: 'No archive folder', body: 'No archive folder configured for this account. Set one in Settings → Accounts → Folder Mappings.' });
          }
        } catch (err) {
          console.error('Archive failed:', err.message);
          addNotification({ title: 'Archive failed', body: 'Could not archive message. Please try again.' });
        }
        break;
      }
      case 'moveTo': {
        const folder = data;
        if (!folder) break;
        removeMessage(message.id);
        try {
          await api.bulkMove([message.id], folder);
        } catch (err) {
          console.error('Move failed:', err.message);
          addNotification({ title: 'Move failed', body: 'Could not move message. Please try again.' });
        }
        break;
      }
      case 'delete':
        try {
          await api.deleteMessage(message.id);
          removeMessage(message.id);
        } catch (err) {
          console.error('deleteMessage failed:', err.message);
          addNotification({ title: 'Delete failed', body: 'Could not delete message. Please try again.' });
        }
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
        updateMessage(message.id, { is_read: false });
        incrementUnread(message.account_id);
      });
    }
  };

  const displayMessages = searchQuery.trim() ? searchResults : messages;
  const isUnified = selectedAccountId === null;

  const label = searchQuery.trim()
    ? `Search: "${searchQuery}"`
    : isUnified ? 'All Inboxes' : selectedFolder;

  // Derived bulk-selection values (computed fresh each render, no stale closure risk)
  const selectionMode = selectedIds.size > 0;
  const selectedMsgs = displayMessages.filter(m => selectedIds.has(m.id));
  const selectedCount = selectedIds.size;
  const allSelected = displayMessages.length > 0 && selectedIds.size === displayMessages.length;
  const selectedAccountIds = [...new Set(selectedMsgs.map(m => m.account_id))];
  const canMove = selectedAccountIds.length === 1;

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
            ref={searchInputRef}
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

        {/* ── Bulk-action toolbar ───────────────────────────── */}
        {selectionMode && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 10px',
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}>
            {/* Select-all checkbox */}
            <input
              type="checkbox"
              checked={allSelected}
              onChange={e => e.target.checked ? selectAll(displayMessages) : clearSelection()}
              title={allSelected ? 'Deselect all' : 'Select all'}
              style={{ cursor: 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, userSelect: 'none' }}>
              {selectedCount} selected
            </span>

            {/* Archive button */}
            <BulkBtn
              title="Archive selected"
              onClick={() => handleBulkArchive([...selectedIds], selectedMsgs)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="5" rx="1"/>
                <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
                <polyline points="9 13 12 16 15 13"/>
                <line x1="12" y1="11" x2="12" y2="16"/>
              </svg>
              Archive
            </BulkBtn>

            {/* Delete button */}
            <BulkBtn
              title="Delete selected"
              onClick={() => handleBulkDelete([...selectedIds], selectedMsgs)}
              danger
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
              </svg>
              Delete
            </BulkBtn>

            {/* Move button + folder picker */}
            <div style={{ position: 'relative' }} ref={folderPickerRef}>
              <BulkBtn
                title={canMove ? 'Move to folder' : 'Select messages from one account to move'}
                onClick={() => handleOpenFolderPicker(selectedMsgs)}
                disabled={!canMove}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
                Move
              </BulkBtn>

              {showFolderPicker && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                  minWidth: 200, maxWidth: 280,
                  maxHeight: 320, overflowY: 'auto',
                  zIndex: 100,
                }}>
                  {pickerLoading ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      Loading folders…
                    </div>
                  ) : pickerFolders.length === 0 ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      No folders found
                    </div>
                  ) : (
                    <>
                      <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Move to folder
                      </div>
                      {pickerFolders
                        .filter(f => f.path !== selectedFolder)
                        .map(f => (
                          <button
                            key={f.path}
                            onClick={() => handleBulkMove([...selectedIds], f.path)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              width: '100%', padding: '8px 12px',
                              background: 'none', border: 'none',
                              color: 'var(--text-primary)', fontSize: 13,
                              cursor: 'pointer', textAlign: 'left',
                              transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'none'}
                          >
                            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
                              <FolderIcon specialUse={f.special_use} />
                            </span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {f.name}
                            </span>
                          </button>
                        ))
                      }
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Clear selection */}
            <button
              onClick={clearSelection}
              title="Clear selection"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center',
                padding: 4, borderRadius: 4,
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        )}

        {displayMessages.map(message => (
          <MessageRow
            key={message.id}
            message={message}
            selected={selectedMessageId === message.id}
            isChecked={selectedIds.has(message.id)}
            selectionMode={selectionMode}
            showAccount={isUnified}
            onSelect={handleSelect}
            onToggleSelect={toggleSelect}
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
            onAction={(action, data) => handleContextAction(action, contextMenu.message, data)}
          />
        )}

        {/* Infinite scroll footer */}
        {scrollMode === 'infinite' && (<>
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
        </>)}

        {/* Pagination footer */}
        {scrollMode === 'paginated' && !loadingMessages && messagesTotal > 0 && (() => {
          const totalPages = Math.ceil(messagesTotal / pageSize) || 1;
          const btnStyle = (disabled) => ({
            padding: '5px 14px', fontSize: 12, borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
            background: disabled ? 'transparent' : 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            transition: 'all 0.1s',
          });
          return (
            <div style={{
              padding: '10px 16px', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', borderTop: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}>
              <button
                onClick={() => loadPage(currentPage - 1)}
                disabled={currentPage <= 1}
                style={btnStyle(currentPage <= 1)}
                onMouseEnter={e => { if (currentPage > 1) { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}}
                onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = currentPage <= 1 ? 'var(--text-tertiary)' : 'var(--text-secondary)'; }}
              >← Prev</button>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => loadPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                style={btnStyle(currentPage >= totalPages)}
                onMouseEnter={e => { if (currentPage < totalPages) { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}}
                onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = currentPage >= totalPages ? 'var(--text-tertiary)' : 'var(--text-secondary)'; }}
              >Next →</button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function MessageRow({ message, selected, isChecked, selectionMode, showAccount, onSelect, onToggleSelect, onMarkRead, onStar, onDelete, onContextMenu }) {
  const [hovered, setHovered] = useState(false);

  const bg = (selected && !selectionMode)
    ? 'var(--bg-elevated)'
    : (isChecked ? 'var(--accent-dim)' : (hovered ? 'var(--bg-tertiary)' : 'transparent'));

  const showCheckbox = selectionMode;

  const handleClick = () => {
    if (selectionMode) {
      onToggleSelect(message.id);
    } else {
      onSelect(message);
    }
  };

  return (
    <div
      onClick={handleClick}
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
      {/* Left indicator: checkbox on hover/selection-mode, unread dot otherwise */}
      {showCheckbox ? (
        <div style={{
          position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center',
        }}>
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => {}}
            onClick={e => { e.stopPropagation(); onToggleSelect(message.id); }}
            style={{ cursor: 'pointer', width: 14, height: 14, accentColor: 'var(--accent)' }}
          />
        </div>
      ) : (
        !message.is_read && (
          <div style={{
            position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--accent)',
          }} />
        )
      )}

      <div style={{ paddingLeft: showCheckbox ? 22 : (message.is_read ? 0 : 6) }}>
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

function BulkBtn({ children, onClick, title, disabled, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => { if (!disabled) setHov(true); }}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${hov && !disabled ? (danger ? 'var(--red, #ef4444)' : 'var(--accent)') : 'var(--border)'}`,
        background: hov && !disabled ? (danger ? 'rgba(239,68,68,0.1)' : 'var(--accent-dim)') : 'var(--bg-tertiary)',
        color: disabled ? 'var(--text-tertiary)' : (hov && danger ? 'var(--red, #ef4444)' : (hov ? 'var(--accent)' : 'var(--text-secondary)')),
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
