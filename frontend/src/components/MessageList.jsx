import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format, isToday, isYesterday, isThisYear } from 'date-fns';
import { LAYOUTS } from '../layouts.js';
import { useMobile } from '../hooks/useMobile.js';
import ContextMenu from './ContextMenu.jsx';
import { shortcutBus } from '../utils/shortcutBus.js';

// Folder icon for move picker
function FolderIcon({ specialUse, size = 13 }) {
  const s = (specialUse || '').toLowerCase();
  if (s.includes('sent'))   return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
  if (s.includes('trash'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
  if (s.includes('draft'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>;
  if (s.includes('spam') || s.includes('junk')) return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
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
    setMobileSidebarOpen,
  } = useStore();

  const isMobile = useMobile();

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;
  const isColumn = currentLayout.direction === 'column';
  const isNarrow = !isColumn && currentLayout.listWidth <= 260;

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [syncing, setSyncing] = useState(false);
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, message }
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
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
  const SEARCH_PAGE = 50;
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      setSearchHasMore(false);
      return;
    }
    setIsSearching(true);
    setSearchHasMore(false);
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(searchQuery, selectedAccountId || undefined, { offset: 0 });
        setSearchResults(data.messages);
        setSearchHasMore(data.messages.length === SEARCH_PAGE);
      } catch (err) {
        console.error('Search failed:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, selectedAccountId]);

  const loadMoreSearch = useCallback(async () => {
    if (searchLoadingMore) return;
    const qSnapshot = searchQuery; // capture before async gap
    setSearchLoadingMore(true);
    try {
      const offset = useStore.getState().searchResults.length;
      const data = await api.search(qSnapshot, selectedAccountId || undefined, { offset });
      // Discard results if the query changed while we were fetching
      if (useStore.getState().searchQuery !== qSnapshot) return;
      const current = useStore.getState().searchResults;
      useStore.setState({ searchResults: [...current, ...data.messages] });
      setSearchHasMore(data.messages.length === SEARCH_PAGE);
    } catch (err) {
      console.error('Search load more failed:', err);
    } finally {
      setSearchLoadingMore(false);
    }
  }, [searchQuery, selectedAccountId, searchLoadingMore]);

  // Infinite scroll + scroll-to-top visibility
  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setShowScrollTop(scrollTop > 400);
    if (scrollMode !== 'infinite' || loadingMessages || !hasMoreMessages) return;
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

  // Mobile swipe action handlers (no event object needed)
  const handleSwipeDelete = useCallback(async (message) => {
    removeMessage(message.id);
    if (!message.is_read) decrementUnread(message.account_id);
    try {
      await api.deleteMessage(message.id);
    } catch (err) {
      console.error('swipe delete failed:', err.message);
      addNotification({ title: 'Delete failed', body: 'Could not delete message.' });
    }
  }, [removeMessage, decrementUnread, addNotification]);

  const handleSwipeToggleRead = useCallback(async (message) => {
    const newRead = !message.is_read;
    updateMessage(message.id, { is_read: newRead });
    if (newRead) decrementUnread(message.account_id);
    else incrementUnread(message.account_id);
    try {
      await api.markRead(message.id, newRead);
    } catch (err) {
      console.error('swipe toggle read failed:', err.message);
      updateMessage(message.id, { is_read: !newRead });
      if (newRead) incrementUnread(message.account_id);
      else decrementUnread(message.account_id);
    }
  }, [updateMessage, decrementUnread, incrementUnread]);

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
      width: isMobile ? '100%' : (isColumn ? '100%' : currentLayout.listWidth),
      minWidth: isMobile ? undefined : (isColumn ? undefined : Math.max(180, currentLayout.listWidth - 80)),
      flex: isMobile ? 1 : (isColumn ? '0 0 42%' : undefined),
      minHeight: isColumn && !isMobile ? 0 : undefined,
      borderRight: (isMobile || isColumn) ? 'none' : '1px solid var(--border-subtle)',
      borderBottom: (!isMobile && isColumn) ? '1px solid var(--border-subtle)' : 'none',
      display: 'flex', flexDirection: 'column',
      height: (isMobile || isColumn) ? undefined : '100vh',
      background: 'var(--bg-primary)',
    }}>

      {/* ── Mobile header ───────────────────────────────────────────────── */}
      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          paddingTop: 'calc(var(--sat) + 10px)',
          paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          {/* Hamburger */}
          <button
            onClick={() => setMobileSidebarOpen(true)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', padding: '6px', borderRadius: 7,
              display: 'flex', alignItems: 'center',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>

          {/* Folder / account title */}
          <h2 style={{
            flex: 1, margin: 0, fontSize: 16, fontWeight: 600,
            color: 'var(--text-primary)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {label}
          </h2>

          {/* Unread filter */}
          <button
            onClick={() => setUnreadOnly(!unreadOnly)}
            title={unreadOnly ? 'Show all' : 'Unread only'}
            style={{
              background: unreadOnly ? 'var(--accent-dim)' : 'none',
              border: `1px solid ${unreadOnly ? 'var(--accent)' : 'transparent'}`,
              borderRadius: 6, padding: '5px 7px',
              color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
              cursor: 'pointer', fontSize: 11, fontWeight: 500,
            }}
          >
            Unread
          </button>

          {/* Sync */}
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync"
            style={{
              background: 'none', border: 'none',
              color: syncing ? 'var(--accent)' : 'var(--text-tertiary)',
              cursor: syncing ? 'not-allowed' : 'pointer',
              padding: '6px', borderRadius: 7, display: 'flex',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ animation: syncing ? 'spin 0.8s linear infinite' : 'none' }}>
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>

          {/* Compose */}
          <button
            onClick={() => openCompose()}
            title="Compose"
            style={{
              background: 'var(--accent)', border: 'none',
              color: 'white', cursor: 'pointer',
              padding: '6px 8px', borderRadius: 7, display: 'flex', alignItems: 'center',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        </div>
      )}

      {/* ── Desktop header ──────────────────────────────────────────────── */}
      {!isMobile && <div style={{
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
            placeholder="Search…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px 8px 32px',
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
              outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--accent)'; setSearchFocused(true); }}
            onBlur={e => { e.target.style.borderColor = 'var(--border)'; setSearchFocused(false); }}
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

          {/* Operator hints — shown when focused with an empty query */}
          {searchFocused && !searchQuery && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 100,
              background: 'var(--bg-elevated, var(--bg-secondary))',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
              padding: '10px 12px',
            }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', marginBottom: 8 }}>
                Search operators
              </div>
              {[
                { op: 'from:amazon',      desc: 'From sender' },
                { op: 'subject:invoice',  desc: 'In subject' },
                { op: 'to:john',          desc: 'To / CC' },
                { op: 'has:attachment',   desc: 'Has attachment' },
                { op: 'is:unread',        desc: 'Unread only' },
                { op: 'is:starred',       desc: 'Starred only' },
                { op: 'after:2024-01-01', desc: 'After date' },
                { op: 'before:2024-12-31',desc: 'Before date' },
              ].map(({ op, desc }) => (
                <div
                  key={op}
                  onMouseDown={e => { e.preventDefault(); setSearchQuery(op.endsWith(':') ? op : op.split(':')[0] + ':'); searchInputRef.current?.focus(); }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '3px 0', cursor: 'pointer', borderRadius: 4,
                  }}
                >
                  <code style={{ fontSize: 12, color: 'var(--accent)', fontFamily: 'monospace' }}>{op}</code>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{desc}</span>
                </div>
              ))}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-tertiary)' }}>
                Combine operators with keywords · e.g. <code style={{ fontFamily: 'monospace' }}>from:amazon invoice</code>
              </div>
            </div>
          )}
        </div>
      </div>}

      {/* Mobile search bar (rendered outside the scrollable list so it stays pinned) */}
      {isMobile && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
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
              placeholder="Search…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%', padding: '8px 10px 8px 32px',
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
                outline: 'none', boxSizing: 'border-box',
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
      )}

      {/* Message list */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{ height: '100%', overflow: 'auto' }}
        >
        {loadingMessages && displayMessages.length === 0 && (
          <div>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)',
                opacity: 1 - i * 0.1,
              }}>
                <div className="skeleton-line" style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="skeleton-line" style={{ height: 12, width: `${55 + (i % 3) * 15}%`, marginBottom: 8 }} />
                  <div className="skeleton-line" style={{ height: 11, width: `${70 + (i % 2) * 20}%` }} />
                </div>
                <div className="skeleton-line" style={{ width: 36, height: 11, flexShrink: 0, borderRadius: 4 }} />
              </div>
            ))}
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
            isMobile={isMobile}
            onSwipeLeft={handleSwipeDelete}
            onSwipeRight={handleSwipeToggleRead}
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
          {/* Search mode: load more search results */}
          {searchQuery.trim() ? (<>
            {searchLoadingMore && (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                <div style={{
                  width: 16, height: 16, margin: '0 auto 6px',
                  border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block',
                }} />
                <div>Loading more…</div>
              </div>
            )}
            {!searchLoadingMore && searchHasMore && displayMessages.length > 0 && (
              <div style={{ padding: '12px 16px', textAlign: 'center' }}>
                <button
                  onClick={loadMoreSearch}
                  style={{
                    padding: '7px 20px', background: 'transparent',
                    border: '1px solid var(--border)', borderRadius: 7,
                    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
                    transition: 'all 0.1s',
                  }}
                  onMouseEnter={e => { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}
                  onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = 'var(--text-secondary)'; }}
                >
                  Load more results
                </button>
              </div>
            )}
            {!searchLoadingMore && !searchHasMore && displayMessages.length > 0 && (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                {displayMessages.length} result{displayMessages.length !== 1 ? 's' : ''}
              </div>
            )}
          </>) : (<>
            {/* Regular message list: load more normal messages */}
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

        {/* Scroll-to-top button */}
        {showScrollTop && (
          <button
            onClick={() => { if (listRef.current) listRef.current.scrollTo({ top: 0, behavior: 'smooth' }); }}
            title="Back to top"
            style={{
              position: 'absolute', bottom: 20, right: 16, zIndex: 20,
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
              transition: 'color 0.15s, border-color 0.15s',
              animation: 'fade-in 0.15s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function MessageRow({ message, selected, isChecked, selectionMode, showAccount, onSelect, onToggleSelect, onMarkRead, onStar, onDelete, onContextMenu, isMobile, onSwipeLeft, onSwipeRight }) {
  const [hovered, setHovered] = useState(false);
  const contentRef = useRef(null);
  const swipeBgLeftRef = useRef(null);
  const swipeBgRightRef = useRef(null);
  const swipeRef = useRef({ active: false, startX: 0, startY: 0, dir: null, x: 0 });

  const SWIPE_THRESHOLD = 72;

  const springBack = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = 'transform 0.25s cubic-bezier(0.25,0.46,0.45,0.94)';
    el.style.transform = 'translateX(0)';
    setTimeout(() => {
      if (swipeBgLeftRef.current)  swipeBgLeftRef.current.style.display  = 'none';
      if (swipeBgRightRef.current) swipeBgRightRef.current.style.display = 'none';
    }, 260);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const el = contentRef.current;
    if (!el) return;

    const showBgs = () => {
      if (swipeBgLeftRef.current)  swipeBgLeftRef.current.style.display  = 'flex';
      if (swipeBgRightRef.current) swipeBgRightRef.current.style.display = 'flex';
    };
    const hideBgs = () => {
      if (swipeBgLeftRef.current)  swipeBgLeftRef.current.style.display  = 'none';
      if (swipeBgRightRef.current) swipeBgRightRef.current.style.display = 'none';
    };

    const onStart = (e) => {
      const t = e.touches[0];
      swipeRef.current = { active: false, startX: t.clientX, startY: t.clientY, dir: null, x: 0 };
      showBgs();
    };

    const onMove = (e) => {
      const s = swipeRef.current;
      const t = e.touches[0];
      const dx = t.clientX - s.startX;
      const dy = t.clientY - s.startY;
      if (!s.dir) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        s.dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
      if (s.dir === 'v') return;
      e.preventDefault();
      s.active = true;
      s.x = Math.max(-160, Math.min(160, dx));
      el.style.transition = 'none';
      el.style.transform = `translateX(${s.x}px)`;
    };

    const onEnd = () => {
      const s = swipeRef.current;
      if (!s.active) { s.dir = null; hideBgs(); return; }
      const x = s.x;
      s.active = false; s.dir = null; s.x = 0;
      springBack();
      if (x < -SWIPE_THRESHOLD) {
        onSwipeLeft && onSwipeLeft(message);
      } else if (x > SWIPE_THRESHOLD) {
        onSwipeRight && onSwipeRight(message);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', springBack, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', springBack);
    };
  }, [isMobile, message, onSwipeLeft, onSwipeRight, springBack]);

  // On mobile the row content must be opaque — swipe action panels sit behind it
  // and would show through a transparent background.
  const bgDefault = isMobile ? 'var(--bg-primary)' : 'transparent';
  const bg = (selected && !selectionMode)
    ? 'var(--bg-elevated)'
    : (isChecked ? 'var(--accent-dim)' : (hovered ? 'var(--bg-tertiary)' : bgDefault));

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
      onMouseEnter={() => !isMobile && setHovered(true)}
      onMouseLeave={() => !isMobile && setHovered(false)}
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {/* Swipe background: left side — mark read/unread (revealed by right swipe) */}
      {isMobile && (
        <div ref={swipeBgLeftRef} style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: '50%',
          background: 'var(--accent)',
          display: 'none', alignItems: 'center', justifyContent: 'flex-start',
          paddingLeft: 20, gap: 6,
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24"
            fill={message.is_read ? 'none' : 'white'} stroke="white" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span style={{ color: 'white', fontSize: 12, fontWeight: 600 }}>
            {message.is_read ? 'Unread' : 'Read'}
          </span>
        </div>
      )}

      {/* Swipe background: right side — delete (revealed by left swipe) */}
      {isMobile && (
        <div ref={swipeBgRightRef} style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '50%',
          background: 'var(--red, #ef4444)',
          display: 'none', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: 20, gap: 6,
        }}>
          <span style={{ color: 'white', fontSize: 12, fontWeight: 600 }}>Delete</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
        </div>
      )}

      {/* Foreground row content */}
      <div
        ref={isMobile ? contentRef : undefined}
        onClick={handleClick}
        onContextMenu={!isMobile ? (e => onContextMenu(e, message)) : undefined}
        style={{
          padding: 'var(--layout-row-py, 11px) var(--layout-row-px, 14px)',
          cursor: 'pointer', background: bg, transition: 'background 0.1s',
          position: 'relative',
          willChange: isMobile ? 'transform' : undefined,
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
