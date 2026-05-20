import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format, isToday, isYesterday, isThisYear } from 'date-fns';
import { LAYOUTS } from '../layouts.js';
import { senderColor } from '../themes.js';
import { useMobile } from '../hooks/useMobile.js';
import { useSwipeRow } from '../hooks/useSwipeRow.js';
import ContextMenu from './ContextMenu.jsx';
import { shortcutBus } from '../utils/shortcutBus.js';
import { pendingMarkReadMap, completedMarkReadMap, setPending } from '../utils/pendingReads.js';
import { applyDeleteGuard, clearDeleteGuard, clearPendingDelete, setCompletedDelete, setPendingDelete } from '../utils/pendingDeletes.js';

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

const SWIPE_ACTIONS = {
  archive: { color: 'var(--amber, #d97706)' },
  delete: { color: 'var(--red, #ef4444)' },
  star: { color: 'var(--amber, #d97706)' },
  markRead: { color: 'var(--accent)' },
  reply: { color: 'var(--green, #22c55e)' },
  replyAll: { color: '#3b82f6' },
  disabled: { color: 'transparent' },
};

function getSwipeActionView(action, message, t, unreadCount = null) {
  const unread = unreadCount != null ? unreadCount > 0 : !message.is_read;
  if (action === 'archive') return { label: t('message.archive'), color: SWIPE_ACTIONS.archive.color, icon: 'archive' };
  if (action === 'delete') return { label: t('contextMenu.delete'), color: SWIPE_ACTIONS.delete.color, icon: 'delete' };
  if (action === 'star') return { label: message.is_starred ? t('messageList.swipeUnstar') : t('messageList.swipeStar'), color: SWIPE_ACTIONS.star.color, icon: 'star' };
  if (action === 'markRead') return { label: unread ? t('contextMenu.markRead') : t('contextMenu.markUnread'), color: SWIPE_ACTIONS.markRead.color, icon: unread ? 'unread' : 'read' };
  if (action === 'reply') return { label: t('message.reply'), color: SWIPE_ACTIONS.reply.color, icon: 'reply' };
  if (action === 'replyAll') return { label: t('message.replyAll'), color: SWIPE_ACTIONS.replyAll.color, icon: 'replyAll' };
  return null;
}

function SwipeActionSvg({ icon, fill = 'none' }) {
  if (icon === 'delete') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
  if (icon === 'star') return <svg width="18" height="18" viewBox="0 0 24 24" fill={fill} stroke="white" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (icon === 'markRead') return <svg width="18" height="18" viewBox="0 0 24 24" fill={fill} stroke="white" strokeWidth="2"><path style={{strokeLinecap: 'round'}} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9"/><polyline points="2 9 12 2 22 9"/></svg>;
  if (icon === 'unread') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path style={{ strokeLinecap: 'round' }} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9" /><polyline points="2 9 12 2 22 9" /></svg>;
  if (icon === 'read') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path style={{ strokeLinecap: 'round' }} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{ strokeLinecap: 'round' }} points="16.36 9.95 12 13 2 6"/><circle style={{ strokeMiterlimit: 10, fill: 'white' }} cx="19.96" cy="6" r="3"/></svg>;
  if (icon === 'reply') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>;
  if (icon === 'replyAll') return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>;
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>;
}

function SwipeBackground({ side, actionView, innerRef }) {
  if (!actionView) return null;
  const isLeft = side === 'left';
  return (
    <div ref={innerRef} style={{
      position: 'absolute', [isLeft ? 'left' : 'right']: 0, top: 0, bottom: 0, width: '50%',
      background: actionView.color,
      display: 'none', alignItems: 'center', justifyContent: isLeft ? 'flex-start' : 'flex-end',
      paddingLeft: isLeft ? 20 : undefined, paddingRight: isLeft ? undefined : 20, gap: 6,
    }}>
      {isLeft && <SwipeActionSvg icon={actionView.icon} fill={actionView.fill} />}
      <span style={{ color: 'white', fontSize: 12, fontWeight: 600 }}>{actionView.label}</span>
      {!isLeft && <SwipeActionSvg icon={actionView.icon} fill={actionView.fill} />}
    </div>
  );
}

export default function MessageList() {
  const { t } = useTranslation();
  const {
    selectedAccountId, selectedFolder, messages, setMessages,
    appendMessages, messagesTotal, setMessagesTotal, messagesOffset,
    setMessagesOffset, hasMoreMessages, setHasMoreMessages,
    loadingMessages, setLoadingMessages, selectedMessageId, lastViewedMessageId,
    setSelectedMessage, updateMessage, removeMessage,
    decrementUnread, incrementUnread, addNotification, notifications, removeNotification,
    searchQuery, setSearchQuery, isSearching, setIsSearching,
    searchResults, setSearchResults, openCompose, accountsReady, accounts,
    messagesRefreshToken, layout, setLayout, pageSize, setPageSize, scrollMode,
    setMobileSidebarOpen,
    threadedView, expandedThreadId, setExpandedThreadId,
    threadMessages, setThreadMessages, loadingThread, setLoadingThread,
    hoverQuickActions,
    swipeActions,
  } = useStore();

  const isMobile = useMobile();
  const undoableNotifications = notifications.filter(n => n.onUndo);

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;
  const isColumn = currentLayout.direction === 'column';
  const isNarrow = !isColumn && currentLayout.listWidth <= 260;

  // Apply optimistic read guard to a batch of messages from the server.
  // Prevents a concurrent sync refresh from reverting a pending or recently-completed
  // mark-read before the IMAP flag has propagated back to the DB.
  const applyReadGuard = useCallback((msgs) => {
    msgs = applyDeleteGuard(msgs);
    if (pendingMarkReadMap.size === 0 && completedMarkReadMap.size === 0) return msgs;
    return msgs.map(m => {
      const inFlight = pendingMarkReadMap.has(m.id);
      const inGrace  = completedMarkReadMap.has(m.id);
      if (!inFlight && !inGrace) return m;
      if (!m.is_read) return { ...m, is_read: true };
      if (inGrace) completedMarkReadMap.delete(m.id);
      return m;
    });
  }, []);

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [syncing, setSyncing] = useState(false);
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [listScrolled, setListScrolled] = useState(false);
  const [fabVisible, setFabVisible] = useState(true);
  const lastScrollTopRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartYRef = useRef(null);
  const pullDistRef = useRef(0);
  const handleSyncRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, message }
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const listRef = useRef(null);
  const searchInputRef = useRef(null); // for focusSearch shortcut
  const pendingDeleteTimers = useRef(new Map()); // id/thread key -> pending delete metadata

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [pickerFolders, setPickerFolders] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const folderPickerRef = useRef(null);
  // Tracks the index of the last toggled row for shift-click range selection
  const lastSelectIdxRef = useRef(-1);

  // Layout picker
  const [showLayoutPicker, setShowLayoutPicker] = useState(false);
  const [layoutPickerPos, setLayoutPickerPos] = useState(null);
  const layoutPickerRef = useRef(null);

  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);

  // Ref that always holds the latest values needed by shortcut handlers.
  // Updated synchronously on every render so handlers are never stale.
  const scRef = useRef({});
  scRef.current = { messages, selectedIds, setSelectedIds, updateMessage, decrementUnread, addNotification };
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Clear selection whenever the message list resets (nav, folder change, etc.)
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    lastSelectIdxRef.current = -1;
  }, [messagesRefreshToken]);

  // Escape clears selection; click-outside closes folder picker
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowFolderPicker(false);
        setShowLayoutPicker(false);
        setSelectedIds(new Set());
        setSelectionModeActive(false);
      }
    };
    const onPointer = (e) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target)) {
        setShowFolderPicker(false);
      }
      if (layoutPickerRef.current && !layoutPickerRef.current.contains(e.target)) {
        setShowLayoutPicker(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  // Collapse any open thread when the message list resets
  useEffect(() => {
    setExpandedThreadId(null);
  }, [messagesRefreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (threadedView) params.threaded = 'true';
        const data = await api.getMessages(params);
        if (cancelled) return;
        setMessagesTotal(data.total);
        setMessages(applyReadGuard(data.messages));
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
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, scrollMode, accountsReady, accounts.length, messagesRefreshToken, threadedView]);

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
      if (useStore.getState().threadedView) params.threaded = 'true';
      const data = await api.getMessages(params);
      appendMessages(applyReadGuard(data.messages));
      setMessagesOffset(currentOffset + data.messages.length);
      setHasMoreMessages(currentOffset + data.messages.length < data.total);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, loadingMessages, hasMoreMessages, applyReadGuard]);

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
              // Backend caps limit at 500 — don't request more or the list silently shrinks
              params = { limit: Math.min(currentOffset || ps, 500), offset: 0 };
            }
            if (selectedAccountId) { params.accountId = selectedAccountId; params.folder = selectedFolder; }
            if (unreadOnly) params.unreadOnly = 'true';
            if (state.threadedView) params.threaded = 'true';
            const data = await api.getMessages(params);
            setMessagesTotal(data.total);
            // If the unread filter is on and the currently open message was just marked
            // read, the server won't return it — preserve it so the user can keep reading.
            let msgs = applyReadGuard(data.messages);
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
  }, [selectedAccountId, selectedFolder, unreadOnly, searchQuery, applyReadGuard]);

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
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(searchQuery, selectedAccountId || undefined, { offset: 0 });
        if (searchSeq.current !== seq) return;
        setSearchResults(applyReadGuard(data.messages));
        setSearchHasMore(data.messages.length === SEARCH_PAGE);
      } catch (err) {
        if (searchSeq.current === seq) console.error('Search failed:', err);
      } finally {
        if (searchSeq.current === seq) setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, selectedAccountId, applyReadGuard]);

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
      useStore.setState({ searchResults: [...current, ...applyReadGuard(data.messages)] });
      setSearchHasMore(data.messages.length === SEARCH_PAGE);
    } catch (err) {
      console.error('Search load more failed:', err);
    } finally {
      setSearchLoadingMore(false);
    }
  }, [searchQuery, selectedAccountId, searchLoadingMore, applyReadGuard]);

  // Infinite scroll + scroll-to-top visibility
  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setShowScrollTop(scrollTop > 400);
    setListScrolled(scrollTop > 2);
    // FAB: hide when scrolling down, show when scrolling up or near top
    const delta = scrollTop - lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    if (Math.abs(delta) > 4) setFabVisible(delta < 0 || scrollTop < 60);
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
      if (threadedView) params.threaded = 'true';
      const data = await api.getMessages(params);
      setMessagesTotal(data.total);
      setMessages(applyReadGuard(data.messages));
      setMessagesOffset((pageNum - 1) * pageSize + data.messages.length);
      setHasMoreMessages(false);
      setExpandedThreadId(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (err) {
      console.error('Failed to load page:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedAccountId, selectedFolder, unreadOnly, pageSize, loadingMessages, threadedView, applyReadGuard]);

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
  // Always keep ref current so touch handlers never go stale
  handleSyncRef.current = handleSync;

  // Pull-to-refresh touch listeners (mobile only)
  useEffect(() => {
    if (!isMobile) return;
    const el = listRef.current;
    if (!el) return;
    const THRESHOLD = 64;
    const MAX_PULL = 80;

    const onTouchStart = (e) => {
      if (el.scrollTop === 0) pullStartYRef.current = e.touches[0].clientY;
    };

    const onTouchMove = (e) => {
      if (pullStartYRef.current === null) return;
      const delta = e.touches[0].clientY - pullStartYRef.current;
      if (delta > 0 && el.scrollTop === 0) {
        e.preventDefault();
        const d = Math.min(delta * 0.5, MAX_PULL);
        pullDistRef.current = d;
        setPullDistance(d);
      } else if (el.scrollTop > 0) {
        pullStartYRef.current = null;
        pullDistRef.current = 0;
        setPullDistance(0);
      }
    };

    const onTouchEnd = () => {
      if (pullStartYRef.current === null) return;
      const dist = pullDistRef.current;
      pullStartYRef.current = null;
      pullDistRef.current = 0;
      setPullDistance(0);
      if (dist >= THRESHOLD) handleSyncRef.current?.();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const isThreadListRow = useCallback((message) => {
    const messageCount = Number.parseInt(message.message_count, 10);
    return threadedView && !searchQuery.trim() && message.thread_id && messageCount > 1;
  }, [threadedView, searchQuery]);

  const resolveMessagesForThreadAction = useCallback(async (message) => {
    const tid = message.thread_id || message.id;
    if (!isThreadListRow(message)) return [message];
    if (Array.isArray(threadMessages[tid]) && threadMessages[tid].length > 0) {
      return threadMessages[tid];
    }
    const effectiveFolder = selectedAccountId ? selectedFolder : 'INBOX';
    const data = await api.getThread(tid, effectiveFolder);
    return data.messages?.length ? data.messages : [message];
  }, [isThreadListRow, threadMessages, selectedAccountId, selectedFolder]);

  const setCachedThreadRead = useCallback((message, read) => {
    const tid = message.thread_id || message.id;
    if (threadMessages[tid]) {
      setThreadMessages(tid, threadMessages[tid].map(msg => ({ ...msg, is_read: read })));
    }
  }, [threadMessages, setThreadMessages]);

  const setCachedThreadStarred = useCallback((message, starred) => {
    const tid = message.thread_id || message.id;
    if (threadMessages[tid]) {
      setThreadMessages(tid, threadMessages[tid].map(msg => ({ ...msg, is_starred: starred })));
    }
  }, [threadMessages, setThreadMessages]);

  const setMessagesReadState = useCallback(async (message, read) => {
    let actionMessages = [message];
    try {
      actionMessages = await resolveMessagesForThreadAction(message);
    } catch (err) {
      console.error('Failed to load thread for read state change:', err.message);
      return;
    }

    const isThreadRow = isThreadListRow(message);
    const unreadCount = Number.parseInt(message.unread_count, 10);
    const unreadDelta = read
      ? (isThreadRow && Number.isFinite(unreadCount) ? unreadCount : actionMessages.filter(msg => !msg.is_read).length)
      : actionMessages.filter(msg => msg.is_read).length;

    if (isThreadRow) {
      updateMessage(message.id, { is_read: read, unread_count: read ? 0 : actionMessages.length });
      setCachedThreadRead(message, read);
    } else {
      updateMessage(message.id, { is_read: read, unread_count: read ? 0 : 1 });
    }

    if (read) {
      if (unreadDelta > 0) decrementUnread(message.account_id, unreadDelta);
      actionMessages.forEach(msg => setPending(msg.id, msg.account_id));
    } else {
      if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
      actionMessages.forEach(msg => {
        pendingMarkReadMap.delete(msg.id);
        completedMarkReadMap.delete(msg.id);
      });
    }

    try {
      await api.bulkRead(actionMessages.map(msg => msg.id), read);
      if (read) {
        actionMessages.forEach(msg => {
          pendingMarkReadMap.delete(msg.id);
          completedMarkReadMap.set(msg.id, msg.account_id);
          setTimeout(() => completedMarkReadMap.delete(msg.id), 10000);
        });
      }
    } catch (err) {
      console.error('markRead failed:', err);
      if (isThreadRow) {
        updateMessage(message.id, { is_read: !read, unread_count: read ? unreadDelta : 0 });
        setCachedThreadRead(message, !read);
      } else {
        updateMessage(message.id, { is_read: !read, unread_count: read ? 1 : 0 });
      }
      if (read) {
        if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
        actionMessages.forEach(msg => pendingMarkReadMap.delete(msg.id));
      } else if (unreadDelta > 0) {
        decrementUnread(message.account_id, unreadDelta);
      }
    }
  }, [
    resolveMessagesForThreadAction, isThreadListRow, updateMessage, setCachedThreadRead,
    decrementUnread, incrementUnread,
  ]);

  const handleMarkRead = (e, message) => {
    e.stopPropagation();
    setMessagesReadState(message, !message.is_read);
  };

  const setMessagesStarredState = useCallback(async (message, starred) => {
    let actionMessages = [message];
    try {
      actionMessages = await resolveMessagesForThreadAction(message);
    } catch (err) {
      console.error('Failed to load thread for star state change:', err.message);
      return;
    }

    const isThreadRow = isThreadListRow(message);
    updateMessage(message.id, { is_starred: starred });
    if (isThreadRow) setCachedThreadStarred(message, starred);

    try {
      await Promise.all(actionMessages.map(msg => api.markStarred(msg.id, starred)));
    } catch (err) {
      console.error('markStarred failed:', err.message);
      updateMessage(message.id, { is_starred: !starred });
      if (isThreadRow) setCachedThreadStarred(message, !starred);
    }
  }, [resolveMessagesForThreadAction, isThreadListRow, updateMessage, setCachedThreadStarred]);

  const handleStar = (e, message) => {
    e.stopPropagation();
    setMessagesStarredState(message, !message.is_starred);
  };

  // Undo-able delete: optimistically remove, delay the API call by 4.5s so user can undo
  const scheduleDelete = useCallback(async (message) => {
    const tid = message.thread_id || message.id;
    const isThreadRow = isThreadListRow(message);
    const key = isThreadRow ? `thread:${tid}` : message.id;
    if (pendingDeleteTimers.current.has(key)) return;

    let deleteMessages = [message];
    try {
      deleteMessages = await resolveMessagesForThreadAction(message);
    } catch (err) {
      console.error('Failed to load thread for delete:', err.message);
      addNotification({ type: 'error', title: t('messageList.deleted.failTitle'), body: t('messageList.deleted.failBody') });
      return;
    }

    const ids = [...new Set(deleteMessages.map(msg => msg.id).filter(Boolean))];
    const visibleMessage = message;
    ids.forEach((id) => setPendingDelete(id));
    removeMessage(visibleMessage.id);
    if (expandedThreadId === tid) setExpandedThreadId(null);

    const unreadCount = Number.parseInt(message.unread_count, 10);
    const unreadDelta = Number.isFinite(unreadCount)
      ? unreadCount
      : deleteMessages.filter(msg => !msg.is_read).length;
    if (unreadDelta > 0) decrementUnread(message.account_id, unreadDelta);

    const timer = setTimeout(async () => {
      pendingDeleteTimers.current.delete(key);
      try {
        if (ids.length > 1) {
          const result = await api.bulkDelete(ids);
          const deletedSet = new Set(result.deleted ?? []);
          ids.forEach(id => (deletedSet.has(id) ? setCompletedDelete(id) : clearDeleteGuard(id)));
          const failedIds = ids.filter(id => !deletedSet.has(id));
          if (failedIds.length > 0) {
            const idToMsg = new Map(deleteMessages.map(m => [m.id, m]));
            const failedUnreadDelta = failedIds.filter(id => idToMsg.has(id) && !idToMsg.get(id).is_read).length;
            const state = useStore.getState();
            state.setMessages([...state.messages, visibleMessage].sort((a, b) => new Date(b.date) - new Date(a.date)));
            if (failedUnreadDelta > 0) incrementUnread(message.account_id, failedUnreadDelta);
            addNotification({
              type: 'error',
              title: t('messageList.bulkDeleted.failTitle'),
              body: t('messageList.bulkDeleted.failBody', { count: failedIds.length }),
            });
          }
        } else {
          await api.deleteMessage(ids[0] || visibleMessage.id);
          ids.forEach((id) => setCompletedDelete(id));
        }
      } catch {
        ids.forEach((id) => clearDeleteGuard(id));
        const state = useStore.getState();
        state.setMessages([...state.messages, visibleMessage].sort((a, b) => new Date(b.date) - new Date(a.date)));
        if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
        addNotification({
          type: 'error',
          title: ids.length > 1 ? t('messageList.bulkDeleted.failTitle') : t('messageList.deleted.failTitle'),
          body: ids.length > 1 ? t('messageList.bulkDeleted.failBody', { count: ids.length }) : t('messageList.deleted.failBody'),
        });
      }
    }, 4500);
    pendingDeleteTimers.current.set(key, { timer, message: visibleMessage, ids });
    addNotification({
      title: ids.length > 1 ? t('messageList.bulkDeleted.title', { count: ids.length }) : t('messageList.deleted.title'),
      body: ids.length > 1 ? t('messageList.bulkDeleted.body') : t('messageList.deleted.body'),
      onUndo: () => {
        const pending = pendingDeleteTimers.current.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDeleteTimers.current.delete(key);
        ids.forEach((id) => clearPendingDelete(id));
        const state = useStore.getState();
        state.setMessages([...state.messages, visibleMessage].sort((a, b) => new Date(b.date) - new Date(a.date)));
        if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
      },
    });
  }, [
    isThreadListRow, expandedThreadId, resolveMessagesForThreadAction,
    removeMessage, setExpandedThreadId, decrementUnread, incrementUnread,
    addNotification, t,
  ]);

  // On unmount, immediately fire any pending deletes rather than cancelling them.
  // Navigating away during the 4.5s undo window should still delete the message —
  // cancelling the timer would silently leave it on the server.
  useEffect(() => () => {
    pendingDeleteTimers.current.forEach(({ timer, message, ids }) => {
      clearTimeout(timer);
      const deleteIds = ids?.length ? ids : [message.id];
      const deletePromise =
        deleteIds.length > 1
          ? api.bulkDelete(deleteIds)
          : api.deleteMessage(deleteIds[0]);
      deletePromise
        .then(result => {
          const actuallyDeleted = new Set(result?.deleted ?? deleteIds);
          deleteIds.forEach(id => (actuallyDeleted.has(id) ? setCompletedDelete(id) : clearDeleteGuard(id)));
        })
        .catch(() => { deleteIds.forEach((id) => clearDeleteGuard(id)); });
    });
  }, []);

  const handleDelete = (e, message) => {
    e.stopPropagation();
    scheduleDelete(message);
  };

  // Mobile swipe action handlers (no event object needed)
  const handleSwipeDelete = useCallback((message) => {
    scheduleDelete(message);
  }, [scheduleDelete]);

  const handleSwipeToggleRead = useCallback(async (message) => {
    const unreadCount = Number.parseInt(message.unread_count, 10);
    const hasThreadUnreadCount = Number.isFinite(unreadCount);
    const isUnread = hasThreadUnreadCount ? unreadCount > 0 : !message.is_read;
    await setMessagesReadState(message, isUnread);
  }, [setMessagesReadState]);

  const handleSwipeArchive = useCallback(async (message) => {
    removeMessage(message.id);
    if (!message.is_read) decrementUnread(message.account_id);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.bulkArchive([message.id]);
      } catch (err) {
        console.error('swipe archive failed:', err.message);
      }
    }, 4500);
    addNotification({
      title: t('messageList.bulkArchived.title', { count: 1 }),
      body: message.subject || '',
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        const state = useStore.getState();
        state.setMessages([...state.messages, message].sort((a, b) => new Date(b.date) - new Date(a.date)));
        if (!message.is_read) incrementUnread(message.account_id);
      },
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  const handleSwipeStar = useCallback((message) => {
    setMessagesStarredState(message, !message.is_starred);
  }, [setMessagesStarredState]);

  const handleSwipeReply = useCallback((message, replyAll = false) => {
    const replyToArr = Array.isArray(message.reply_to)
      ? message.reply_to
      : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch (_) { return []; } })();
    const replyTarget = (replyToArr.length && replyToArr[0].email)
      ? replyToArr[0]
      : { name: message.from_name || '', email: message.from_email || '' };
    const sender = replyTarget.email ? [replyTarget] : [];

    const myAccount = accounts.find(a => a.id === message.account_id);
    const myEmail = myAccount?.email_address || '';
    const myAddresses = new Set([
      myEmail.toLowerCase(),
      ...(myAccount?.aliases || []).map(al => al.email.toLowerCase()),
    ]);

    const replyAliasId = (() => {
      const aliases = myAccount?.aliases || [];
      if (!aliases.length) return null;
      try {
        const toArr = Array.isArray(message.to_addresses)
          ? message.to_addresses
          : JSON.parse(message.to_addresses || '[]');
        const ccArr = Array.isArray(message.cc_addresses)
          ? message.cc_addresses
          : JSON.parse(message.cc_addresses || '[]');
        const allEmails = [...toArr, ...ccArr].map(t => t.email?.toLowerCase()).filter(Boolean);
        const match = aliases.find(al => allEmails.includes(al.email.toLowerCase()));
        return match ? match.id : null;
      } catch (_) { return null; }
    })();

    const allRecipients = (() => {
      try {
        const toArr = Array.isArray(message.to_addresses)
          ? message.to_addresses
          : JSON.parse(message.to_addresses || '[]');
        const ccArr = Array.isArray(message.cc_addresses)
          ? message.cc_addresses
          : JSON.parse(message.cc_addresses || '[]');
        return [...toArr, ...ccArr].filter(
          t => t.email && !myAddresses.has(t.email.toLowerCase()) && t.email !== replyTarget.email
        );
      } catch (_) { return []; }
    })();

    const referencesChain = [message.in_reply_to, message.message_id]
      .filter(Boolean).join(' ').trim() || null;
    const rawSubject = (message.subject || '').trim();

    openCompose({
      to: sender,
      cc: replyAll ? allRecipients : [],
      subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
      body: '',
      quotedBody: '',
      inReplyTo: message.message_id,
      references: referencesChain,
      accountId: message.account_id,
      aliasId: replyAliasId,
      isReply: true,
      isReplyAll: replyAll,
      originalFrom: sender,
      allRecipients,
    });
  }, [accounts, openCompose]);
  
  const runSwipeAction = useCallback((action, message) => {
    switch (action) {
      case 'archive':
        handleSwipeArchive(message);
        break;
      case 'delete':
        handleSwipeDelete(message);
        break;
      case 'star':
        handleSwipeStar(message);
        break;
      case 'markRead':
        handleSwipeToggleRead(message);
        break;
      case 'reply':
        handleSwipeReply(message, false);
        break;
      case 'replyAll':
        handleSwipeReply(message, true);
        break;
      default:
        break;
    }
  }, [handleSwipeArchive, handleSwipeDelete, handleSwipeReply, handleSwipeStar, handleSwipeToggleRead]);

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
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    lastSelectIdxRef.current = -1;
  }, []);

  // Derived from store — must be declared before callbacks that use it in dependency arrays
  const displayMessages = searchQuery.trim() ? searchResults : messages;

  // Called when the avatar is clicked: enters selection mode and selects that message
  const handleAvatarClick = useCallback((id) => {
    const idx = displayMessages.findIndex(m => m.id === id);
    lastSelectIdxRef.current = idx;
    setSelectionModeActive(true);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [displayMessages]);

  // Called for normal (non-shift) row checkbox toggles — tracks anchor for range select
  const handleRowToggleSelect = useCallback((id) => {
    const idx = displayMessages.findIndex(m => m.id === id);
    lastSelectIdxRef.current = idx;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [displayMessages]);

  // Called on shift-click: selects all rows between anchor and current index
  const handleRangeSelect = useCallback((id) => {
    const msgs = displayMessages;
    const clickedIdx = msgs.findIndex(m => m.id === id);
    if (clickedIdx === -1) return;
    const anchor = lastSelectIdxRef.current >= 0 ? lastSelectIdxRef.current : clickedIdx;
    const lo = Math.min(anchor, clickedIdx);
    const hi = Math.max(anchor, clickedIdx);
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(msgs[i].id);
      return next;
    });
    lastSelectIdxRef.current = clickedIdx;
  }, [displayMessages]);

  const handleBulkDelete = useCallback((ids, msgs) => {
    ids.forEach(id => setPendingDelete(id));
    ids.forEach(id => removeMessage(id));
    msgs.forEach(msg => { if (!msg.is_read) decrementUnread(msg.account_id); });
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      const chunks = [];
      for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
      const results = await Promise.allSettled(chunks.map(chunk => api.bulkDelete(chunk)));
      results
        .filter(r => r.status === 'rejected')
        .forEach(r => console.error('Bulk delete failed:', r.reason?.message));
      const deleted = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value.deleted ?? []);
      const deletedSet = new Set(deleted);
      ids.forEach(id => (deletedSet.has(id) ? setCompletedDelete(id) : clearDeleteGuard(id)));
      const failedIds = ids.filter(id => !deletedSet.has(id));
      if (failedIds.length > 0) {
        const failedSet = new Set(failedIds);
        const failedMsgs = msgs.filter(msg => failedSet.has(msg.id));
        const state = useStore.getState();
        state.setMessages([...state.messages, ...failedMsgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
        failedMsgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
        addNotification({ type: 'error', title: t('messageList.bulkDeleted.failTitle'), body: t('messageList.bulkDeleted.failBody', { count: failedIds.length }) });
      }
    }, 4500);
    addNotification({
      title: t('messageList.bulkDeleted.title', { count: ids.length }),
      body: t('messageList.bulkDeleted.body'),
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        ids.forEach(id => clearPendingDelete(id));
        const state = useStore.getState();
        state.setMessages([...state.messages, ...msgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
        msgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
      },
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  const handleBulkMove = useCallback((ids, msgs, folder) => {
    ids.forEach(id => removeMessage(id));
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        const result = await api.bulkMove(ids, folder);
        const movedSet = new Set(result.moved ?? []);
        const failedMsgs = msgs.filter(msg => !movedSet.has(msg.id));
        if (failedMsgs.length > 0) {
          const state = useStore.getState();
          state.setMessages([...state.messages, ...failedMsgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
          addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: failedMsgs.length }) });
        }
      } catch (err) {
        console.error('Bulk move failed:', err);
        const state = useStore.getState();
        state.setMessages([...state.messages, ...msgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
        addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: ids.length }) });
      }
    }, 4500);
    addNotification({
      title: t('messageList.bulkMoved.title', { count: ids.length }),
      body: folder,
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        const state = useStore.getState();
        state.setMessages([...state.messages, ...msgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
      },
    });
  }, [removeMessage, addNotification, t]);

  const handleBulkArchive = useCallback((ids, msgs) => {
    ids.forEach(id => removeMessage(id));
    msgs.forEach(msg => { if (!msg.is_read) decrementUnread(msg.account_id); });
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        const result = await api.bulkArchive(ids);
        const archivedSet = new Set(result.archived ?? []);
        const failedMsgs = msgs.filter(msg => !archivedSet.has(msg.id));
        if (failedMsgs.length > 0) {
          const state = useStore.getState();
          state.setMessages([...state.messages, ...failedMsgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
          failedMsgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
          if (result.noArchiveFolder?.length) {
            addNotification({ title: t('messageList.bulkArchived.noFolderTitle'), body: t('messageList.bulkArchived.noFolderBody') });
          } else {
            addNotification({ title: t('messageList.bulkArchived.failTitle'), body: t('messageList.bulkArchived.failBody', { count: failedMsgs.length }) });
          }
        }
      } catch (err) {
        console.error('Bulk archive failed:', err);
        const state = useStore.getState();
        state.setMessages([...state.messages, ...msgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
        msgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
        addNotification({ title: t('messageList.bulkArchived.failTitle'), body: t('messageList.bulkArchived.failBody', { count: ids.length }) });
      }
    }, 4500);
    addNotification({
      title: t('messageList.bulkArchived.title', { count: ids.length }),
      body: t('messageList.bulkArchived.body'),
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        const state = useStore.getState();
        state.setMessages([...state.messages, ...msgs].sort((a, b) => new Date(b.date) - new Date(a.date)));
        msgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
      },
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  // Keep refs to bulk handlers so the shortcut effect (registered once) is never stale
  const bulkDeleteRef    = useRef(handleBulkDelete);
  const bulkArchiveRef   = useRef(handleBulkArchive);
  const scheduleDeleteRef = useRef(scheduleDelete);
  useEffect(() => { bulkDeleteRef.current    = handleBulkDelete;  }, [handleBulkDelete]);
  useEffect(() => { bulkArchiveRef.current   = handleBulkArchive; }, [handleBulkArchive]);
  useEffect(() => { scheduleDeleteRef.current = scheduleDelete;   }, [scheduleDelete]);

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
            addNotification({ title: tRef.current('messageList.noArchiveFolder.title'), body: tRef.current('messageList.noArchiveFolder.body') });
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
        scheduleDeleteRef.current(msg);
      }
    };

    const onToggleRead = () => {
      const { messages, selectedMessageId, updateMessage, decrementUnread, incrementUnread } = getState();
      if (!selectedMessageId) return;
      const msg = messages.find(m => m.id === selectedMessageId);
      if (!msg) return;
      const newRead = !msg.is_read;
      updateMessage(selectedMessageId, { is_read: newRead });
      if (newRead) {
        decrementUnread(msg.account_id);
        setPending(selectedMessageId, msg.account_id);
        api.bulkRead([selectedMessageId], true)
          .then(() => {
            pendingMarkReadMap.delete(selectedMessageId);
            completedMarkReadMap.set(selectedMessageId, msg.account_id);
            setTimeout(() => completedMarkReadMap.delete(selectedMessageId), 10000);
          })
          .catch(err => {
            console.error('markRead failed:', err);
            pendingMarkReadMap.delete(selectedMessageId);
          });
      } else {
        incrementUnread(msg.account_id);
        pendingMarkReadMap.delete(selectedMessageId);
        completedMarkReadMap.delete(selectedMessageId);
        api.bulkRead([selectedMessageId], false).catch(console.error);
      }
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
      case 'markRead': {
        const uc = parseInt(message.unread_count);
        const threadUnread = Number.isFinite(uc) && uc > 0;
        if (!message.is_read || threadUnread) {
          await setMessagesReadState(message, true);
        }
        break;
      }
      case 'markUnread': {
        const uc = parseInt(message.unread_count);
        const needsMarkUnread = message.is_read || (Number.isFinite(uc) && uc === 0);
        if (needsMarkUnread) {
          await setMessagesReadState(message, false);
        }
        break;
      }
      case 'toggleStar': {
        const newVal = !message.is_starred;
        await setMessagesStarredState(message, newVal);
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
        const archived = message;
        removeMessage(archived.id);
        if (!archived.is_read) decrementUnread(archived.account_id);
        let archiveUndone = false;
        const archiveTimer = setTimeout(async () => {
          if (archiveUndone) return;
          try {
            const result = await api.bulkArchive([archived.id]);
            if (result.noArchiveFolder?.length) {
              addNotification({ title: t('message.archived.noFolderTitle'), body: t('message.archived.noFolderBody') });
            }
          } catch (err) {
            console.error('Archive failed:', err.message);
            addNotification({ title: t('message.archived.failTitle'), body: t('message.archived.failBody') });
          }
        }, 4500);
        addNotification({
          title: t('message.archived.title'),
          body: archived.subject || t('common.noSubject'),
          onUndo: () => {
            archiveUndone = true;
            clearTimeout(archiveTimer);
            const state = useStore.getState();
            state.setMessages([...state.messages, archived].sort((a, b) => new Date(b.date) - new Date(a.date)));
            if (!archived.is_read) incrementUnread(archived.account_id);
          },
        });
        break;
      }
      case 'moveTo': {
        const folder = data;
        if (!folder) break;
        const moved = message;
        let moveMessages = [message];
        try {
          moveMessages = await resolveMessagesForThreadAction(message);
        } catch (err) {
          console.error('Failed to load thread for move:', err.message);
          addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
          break;
        }
        const moveIds = [...new Set(moveMessages.map(msg => msg.id).filter(Boolean))];
        removeMessage(moved.id);
        let moveUndone = false;
        const moveTimer = setTimeout(async () => {
          if (moveUndone) return;
          try {
            await api.bulkMove(moveIds, folder);
          } catch (err) {
            console.error('Move failed:', err.message);
            addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
          }
        }, 4500);
        addNotification({
          title: t('message.moved.title'),
          body: folder,
          onUndo: () => {
            moveUndone = true;
            clearTimeout(moveTimer);
            const state = useStore.getState();
            state.setMessages([...state.messages, moved].sort((a, b) => new Date(b.date) - new Date(a.date)));
          },
        });
        break;
      }
      case 'snooze': {
        const snoozedMsg = message;
        const untilIso = data;
        if (!untilIso) break;
        removeMessage(snoozedMsg.id);
        if (!snoozedMsg.is_read) decrementUnread(snoozedMsg.account_id);
        addNotification({ title: t('message.snoozed.title'), body: snoozedMsg.subject || t('common.noSubject') });
        api.snoozeMessage(snoozedMsg.id, untilIso).catch(err => {
          console.error('Snooze failed:', err.message);
          const state = useStore.getState();
          state.setMessages([...state.messages, snoozedMsg].sort((a, b) => new Date(b.date) - new Date(a.date)));
          if (!snoozedMsg.is_read) incrementUnread(snoozedMsg.account_id);
          addNotification({ title: t('message.snoozed.failTitle'), body: t('message.snoozed.failBody') });
        });
        break;
      }
      case 'delete':
        scheduleDelete(message);
        break;
      default:
        break;
    }
  };

  const handleThreadMarkRead = (e, message) => {
    e.stopPropagation();
    const uc = parseInt(message.unread_count);
    const hasUnreadInThread = Number.isFinite(uc) && uc > 0;
    handleContextAction(hasUnreadInThread ? 'markRead' : 'markUnread', message);
  };

  const handleSelect = async (message) => {
    setSelectedMessage(message.id);
    if (!message.is_read) {
      updateMessage(message.id, { is_read: true });
      decrementUnread(message.account_id);
      setPending(message.id, message.account_id);
      api.bulkRead([message.id], true)
        .then(() => {
          pendingMarkReadMap.delete(message.id);
          completedMarkReadMap.set(message.id, message.account_id);
          setTimeout(() => completedMarkReadMap.delete(message.id), 10000);
        })
        .catch(e => {
          console.error('markRead failed:', e.message);
          updateMessage(message.id, { is_read: false });
          incrementUnread(message.account_id);
          pendingMarkReadMap.delete(message.id);
        });
    }
  };

  const handleThreadClick = async (message) => {
    const tid = message.thread_id || message.id;
    if (!message.thread_id || (message.message_count || 1) <= 1) {
      handleSelect(message);
      return;
    }
    if (expandedThreadId === tid) {
      setExpandedThreadId(null);
      return;
    }
    setExpandedThreadId(tid);
    if (!threadMessages[tid]) {
      setLoadingThread(tid);
      try {
        const effectiveFolder = selectedAccountId ? selectedFolder : 'INBOX';
        const data = await api.getThread(tid, effectiveFolder);
        const msgs = data.messages || [];
        setThreadMessages(tid, msgs);
        if (!isMobile && msgs.length > 0) handleSelect(msgs[msgs.length - 1]);
      } catch (err) {
        console.error('Failed to load thread:', err);
      } finally {
        setLoadingThread(null);
      }
    } else {
      const msgs = threadMessages[tid];
      if (!isMobile && msgs.length > 0) handleSelect(msgs[msgs.length - 1]);
    }
  };

  const isUnified = selectedAccountId === null;

  const label = searchQuery.trim()
    ? `Search: "${searchQuery}"`
    : isUnified ? t('sidebar.allInboxes') : selectedFolder;

  // Derived bulk-selection values (computed fresh each render, no stale closure risk)
  const selectionMode = selectedIds.size > 0 || selectionModeActive;
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
          boxShadow: listScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
          transition: 'box-shadow 0.2s ease',
          background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          {/* Hamburger */}
          <button
            onClick={() => setMobileSidebarOpen(true)}
            aria-label={t('messageList.menu', 'Menu')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', padding: 0, borderRadius: 7,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 44, minHeight: 44,
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
            title={unreadOnly ? t('messageList.showAll') : t('messageList.unreadOnly')}
            style={{
              background: unreadOnly ? 'var(--accent-dim)' : 'none',
              border: `1px solid ${unreadOnly ? 'var(--accent)' : 'transparent'}`,
              borderRadius: 6, padding: '5px 7px',
              color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
              cursor: 'pointer', fontSize: 11, fontWeight: 500,
              minHeight: 44, display: 'flex', alignItems: 'center',
            }}
          >
            {t('messageList.unread')}
          </button>

          {/* Sync */}
          <button
            onClick={handleSync}
            disabled={syncing}
            aria-label={t('messageList.sync')}
            style={{
              background: 'none', border: 'none',
              color: syncing ? 'var(--accent)' : 'var(--text-tertiary)',
              cursor: syncing ? 'not-allowed' : 'pointer',
              padding: 0, borderRadius: 7, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              minWidth: 44, minHeight: 44,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ animation: syncing ? 'spin 0.8s linear infinite' : 'none' }}>
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>

          {/* Select / Cancel — replaces compose button; FAB is the primary compose affordance */}
          {selectionMode ? (
            <button
              onClick={clearSelection}
              style={{
                background: 'none', border: 'none',
                color: 'var(--accent)', cursor: 'pointer',
                fontSize: 14, fontWeight: 500,
                padding: '0 4px', minWidth: 52, minHeight: 44,
                display: 'flex', alignItems: 'center',
              }}
            >
              {t('common.cancel')}
            </button>
          ) : (
            <button
              onClick={() => setSelectionModeActive(true)}
              aria-label={t('messageList.selectMessages')}
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-secondary)', cursor: 'pointer',
                padding: 0, borderRadius: 7,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 44, minHeight: 44,
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <polyline points="9 11 12 14 22 4"/>
              </svg>
            </button>
          )}
        </div>
      )}

      {/* ── Desktop header ──────────────────────────────────────────────── */}
      {!isMobile && <div style={{
        padding: '14px 16px 10px', borderBottom: '1px solid var(--border-subtle)',
        boxShadow: listScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
        transition: 'box-shadow 0.2s ease',
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
              title={selectedAccountId ? t('messageList.syncAccount') : t('messageList.syncAll')}
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

            {/* Layout picker — wide layouts only; narrow layouts render it in the controls row below */}
            {!isNarrow && (
              <div style={{ position: 'relative' }} ref={layoutPickerRef}>
                <button
                  onClick={() => {
                    if (!showLayoutPicker) {
                      const rect = layoutPickerRef.current.getBoundingClientRect();
                      setLayoutPickerPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
                    }
                    setShowLayoutPicker(v => !v);
                  }}
                  title={t('messageList.changeLayout', 'Change layout')}
                  style={{
                    background: showLayoutPicker ? 'var(--accent-dim)' : 'none',
                    border: `1px solid ${showLayoutPicker ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 6, padding: '4px 6px',
                    color: showLayoutPicker ? 'var(--accent)' : 'var(--text-tertiary)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={e => { if (!showLayoutPicker) { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--border)'; }}}
                  onMouseLeave={e => { if (!showLayoutPicker) { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="5" rx="1"/>
                    <rect x="3" y="11" width="8" height="10" rx="1"/>
                    <rect x="13" y="11" width="8" height="10" rx="1"/>
                  </svg>
                </button>

                {showLayoutPicker && layoutPickerPos && (
                  <div style={{
                    position: 'fixed', top: layoutPickerPos.top, right: layoutPickerPos.right,
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    boxShadow: 'var(--shadow-popover)',
                    minWidth: 200,
                    zIndex: 1000,
                    padding: '6px 0',
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', padding: '4px 12px 6px' }}>
                      {t('messageList.layout', 'Layout')}
                    </div>
                    {Object.entries(LAYOUTS).map(([key, def]) => {
                      const isActive = layout === key;
                      return (
                        <div
                          key={key}
                          onClick={() => { setLayout(key); setShowLayoutPicker(false); }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '7px 12px', cursor: 'pointer',
                            background: isActive ? 'var(--accent-dim)' : 'transparent',
                            transition: 'background 0.08s',
                          }}
                          onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                          onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ fontSize: 13, color: isActive ? 'var(--accent)' : 'var(--text-primary)', fontWeight: isActive ? 500 : 400, flex: 1 }}>
                            {def.label}
                          </span>
                          {isActive && (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* In wide layouts, keep filter + page size inline */}
            {!isNarrow && (
              <>
                {/* Filter unread */}
                <button
                  onClick={() => setUnreadOnly(!unreadOnly)}
                  title={unreadOnly ? t('messageList.showAll') : t('messageList.unreadOnly')}
                  style={{
                    background: unreadOnly ? 'var(--accent-dim)' : 'none',
                    border: `1px solid ${unreadOnly ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6, padding: '4px 8px',
                    color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
                    cursor: 'pointer', fontSize: 11, fontWeight: 500,
                  }}
                >
                  {t('messageList.unread')}
                </button>
                {/* Page size */}
                <select
                  value={pageSize}
                  onChange={e => setPageSize(parseInt(e.target.value))}
                  title={t('messageList.messagesPerPage')}
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

        {/* Narrow layouts: filter + page size + layout picker on their own row */}
        {isNarrow && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <button
              onClick={() => setUnreadOnly(!unreadOnly)}
              title={unreadOnly ? t('messageList.showAll') : t('messageList.unreadOnly')}
              style={{
                background: unreadOnly ? 'var(--accent-dim)' : 'none',
                border: `1px solid ${unreadOnly ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6, padding: '4px 8px',
                color: unreadOnly ? 'var(--accent)' : 'var(--text-tertiary)',
                cursor: 'pointer', fontSize: 11, fontWeight: 500,
              }}
            >
              {t('messageList.unread')}
            </button>
            <select
              value={pageSize}
              onChange={e => setPageSize(parseInt(e.target.value))}
              title={t('messageList.messagesPerPage')}
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
            <div style={{ position: 'relative', marginLeft: 'auto' }} ref={layoutPickerRef}>
              <button
                onClick={() => {
                  if (!showLayoutPicker) {
                    const rect = layoutPickerRef.current.getBoundingClientRect();
                    setLayoutPickerPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
                  }
                  setShowLayoutPicker(v => !v);
                }}
                title={t('messageList.changeLayout', 'Change layout')}
                style={{
                  background: showLayoutPicker ? 'var(--accent-dim)' : 'none',
                  border: `1px solid ${showLayoutPicker ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 6, padding: '4px 6px',
                  color: showLayoutPicker ? 'var(--accent)' : 'var(--text-tertiary)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center',
                  transition: 'color 0.15s, border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { if (!showLayoutPicker) { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--border)'; }}}
                onMouseLeave={e => { if (!showLayoutPicker) { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="5" rx="1"/>
                  <rect x="3" y="11" width="8" height="10" rx="1"/>
                  <rect x="13" y="11" width="8" height="10" rx="1"/>
                </svg>
              </button>
              {showLayoutPicker && layoutPickerPos && (
                <div style={{
                  position: 'fixed', top: layoutPickerPos.top, right: layoutPickerPos.right,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-popover)',
                  minWidth: 200,
                  zIndex: 1000,
                  padding: '6px 0',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', padding: '4px 12px 6px' }}>
                    {t('messageList.layout', 'Layout')}
                  </div>
                  {Object.entries(LAYOUTS).map(([key, def]) => {
                    const isActive = layout === key;
                    return (
                      <div
                        key={key}
                        onClick={() => { setLayout(key); setShowLayoutPicker(false); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '7px 12px', cursor: 'pointer',
                          background: isActive ? 'var(--accent-dim)' : 'transparent',
                          transition: 'background 0.08s',
                        }}
                        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ fontSize: 13, color: isActive ? 'var(--accent)' : 'var(--text-primary)', fontWeight: isActive ? 500 : 400, flex: 1 }}>
                          {def.label}
                        </span>
                        {isActive && (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
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
            placeholder={t('messageList.search')}
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
                {t('messageList.searchHelp.title')}
              </div>
              {[
                { op: 'from:amazon',      desc: t('messageList.searchHelp.from') },
                { op: 'subject:invoice',  desc: t('messageList.searchHelp.subject') },
                { op: 'to:john',          desc: t('messageList.searchHelp.to') },
                { op: 'has:attachment',   desc: t('messageList.searchHelp.hasAttachment') },
                { op: 'is:unread',        desc: t('messageList.searchHelp.isUnread') },
                { op: 'is:starred',       desc: t('messageList.searchHelp.isStarred') },
                { op: 'after:2024-01-01', desc: t('messageList.searchHelp.after') },
                { op: 'before:2024-12-31',desc: t('messageList.searchHelp.before') },
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
                {t('messageList.searchHelp.tip')} <code style={{ fontFamily: 'monospace' }}>from:amazon invoice</code>
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
              placeholder={t('messageList.search')}
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
          style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
        >
          {/* Pull-to-refresh indicator */}
          {isMobile && (
            <div style={{
              height: pullDistance,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
              paddingBottom: pullDistance > 8 ? 8 : 0,
              overflow: 'hidden',
              transition: pullDistance === 0 ? 'height 0.25s ease' : 'none',
              pointerEvents: 'none',
              gap: 4,
            }}>
              <div style={{
                opacity: Math.min(pullDistance / 32, 1),
                transform: syncing ? 'none' : `rotate(${pullDistance >= 64 ? 180 : 0}deg)`,
                transition: 'transform 0.2s ease',
                color: 'var(--accent)',
                display: 'flex',
              }}>
                {syncing ? (
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%',
                    border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                )}
              </div>
              {pullDistance > 20 && !syncing && (
                <div style={{
                  fontSize: 11, color: 'var(--accent)', fontWeight: 500,
                  opacity: Math.min((pullDistance - 20) / 20, 1),
                  transition: 'opacity 0.1s',
                }}>
                  {pullDistance >= 64 ? t('messageList.releaseToSync') : t('messageList.pullToSync')}
                </div>
              )}
            </div>
          )}
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
          <EmptyState
            folderSyncing={folderSyncing}
            searchQuery={searchQuery}
            unreadOnly={unreadOnly}
            selectedFolder={selectedFolder}
            accounts={accounts}
            onClearSearch={() => { setSearchQuery(''); }}
            onShowAll={() => setUnreadOnly(false)}
            onCompose={() => openCompose({})}
          />
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
              title={allSelected ? t('messageList.deselectAll') : t('messageList.selectAll')}
              style={{ cursor: 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, userSelect: 'none' }}>
              {t('messageList.selectedCount', { count: selectedCount })}
            </span>

            {/* Archive button */}
            <BulkBtn
              title={t('messageList.archiveSelected')}
              onClick={() => handleBulkArchive([...selectedIds], selectedMsgs)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="5" rx="1"/>
                <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
                <polyline points="9 13 12 16 15 13"/>
                <line x1="12" y1="11" x2="12" y2="16"/>
              </svg>
            </BulkBtn>

            {/* Delete button */}
            <BulkBtn
              title={t('messageList.deleteSelected')}
              onClick={() => handleBulkDelete([...selectedIds], selectedMsgs)}
              danger
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
              </svg>
            </BulkBtn>

            {/* Move button + folder picker */}
            <div style={{ position: 'relative' }} ref={folderPickerRef}>
              <BulkBtn
                title={canMove ? t('messageList.moveToFolder') : t('messageList.moveToFolderDisabled')}
                onClick={() => handleOpenFolderPicker(selectedMsgs)}
                disabled={!canMove}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
              </BulkBtn>

              {showFolderPicker && !isMobile && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: 'var(--shadow-popover)',
                  minWidth: 200, maxWidth: 280,
                  maxHeight: 320, overflowY: 'auto',
                  zIndex: 100,
                }}>
                  {pickerLoading ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      {t('common.loading')}
                    </div>
                  ) : pickerFolders.length === 0 ? (
                    <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      {t('contextMenu.folders.empty')}
                    </div>
                  ) : (
                    <>
                      <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {t('messageList.moveToFolder')}
                      </div>
                      {pickerFolders
                        .filter(f => f.path !== selectedFolder)
                        .map(f => (
                          <button
                            key={f.path}
                            onClick={() => handleBulkMove([...selectedIds], selectedMsgs, f.path)}
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
              {/* Mobile folder picker — bottom sheet */}
              {showFolderPicker && isMobile && (
                <>
                  <div
                    onClick={() => setShowFolderPicker(false)}
                    style={{
                      position: 'fixed', inset: 0, zIndex: 3000,
                      background: 'var(--overlay-scrim)',
                      backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
                    }}
                  />
                  <div style={{
                    position: 'fixed', left: 0, right: 0, bottom: 0,
                    zIndex: 3001,
                    background: 'var(--bg-secondary)',
                    borderRadius: '16px 16px 0 0',
                    boxShadow: '0 -4px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
                    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
                    animation: 'sheet-enter 0.2s cubic-bezier(0.34,1.56,0.64,1)',
                  }}>
                    {/* Drag handle */}
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
                      <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
                    </div>
                    {/* Title */}
                    <div style={{ padding: '4px 20px 12px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {t('messageList.moveToFolder')}
                    </div>
                    <div style={{ borderTop: '1px solid var(--border-subtle)', overflowY: 'auto', maxHeight: '60vh' }}>
                      {pickerLoading ? (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                          {t('common.loading')}
                        </div>
                      ) : pickerFolders.length === 0 ? (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                          {t('contextMenu.folders.empty')}
                        </div>
                      ) : pickerFolders
                        .filter(f => f.path !== selectedFolder)
                        .map(f => (
                          <button
                            key={f.path}
                            onClick={() => { handleBulkMove([...selectedIds], selectedMsgs, f.path); setShowFolderPicker(false); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 14,
                              width: '100%', minHeight: 48,
                              padding: '0 20px',
                              background: 'none', border: 'none',
                              borderBottom: '1px solid var(--border-subtle)',
                              color: 'var(--text-primary)', fontSize: 15,
                              cursor: 'pointer', textAlign: 'left',
                            }}
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
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Clear selection */}
            <button
              onClick={clearSelection}
              title={t('messageList.clearSelection')}
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

        {threadedView && !searchQuery.trim() ? (
          displayMessages.map(message => {
            const tid = message.thread_id || message.id;
            const swipeLeftAction = swipeActions?.left || 'archive';
            const swipeRightAction = swipeActions?.right || 'markRead';
            return (
              <ThreadRow
                key={tid}
                message={message}
                isExpanded={expandedThreadId === tid}
                threadMsgs={threadMessages[tid] || null}
                isLoadingThread={loadingThread === tid}
                selectedMessageId={selectedMessageId}
                lastViewedMessageId={lastViewedMessageId}
                showAccount={isUnified}
                isNarrow={isNarrow}
                onThreadClick={() => handleThreadClick(message)}
                onSelect={handleSelect}
                onMarkRead={handleThreadMarkRead}
                onStar={handleStar}
                onDelete={handleDelete}
                hoverQuickActions={hoverQuickActions}
                onContextMenu={(e, msg) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, message: msg });
                }}
                isMobile={isMobile}
                swipeLeftAction={swipeLeftAction}
                swipeRightAction={swipeRightAction}
                onSwipeLeft={selectionMode || swipeLeftAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeLeftAction, msg)}
                onSwipeRight={selectionMode || swipeRightAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeRightAction, msg)}
              />
            );
          })
        ) : (
          displayMessages.map(message => {
            const swipeLeftAction = swipeActions?.left || 'archive';
            const swipeRightAction = swipeActions?.right || 'markRead';
            return (
              <MessageRow
                key={message.id}
                message={message}
                selected={selectedMessageId === message.id}
                lastViewed={lastViewedMessageId === message.id && selectedMessageId !== message.id}
                isChecked={selectedIds.has(message.id)}
                selectionMode={selectionMode}
                showAccount={isUnified}
                isNarrow={isNarrow}
                onSelect={handleSelect}
                onToggleSelect={handleRowToggleSelect}
                onRangeSelect={handleRangeSelect}
                onAvatarClick={!isMobile ? handleAvatarClick : undefined}
                onMarkRead={handleMarkRead}
                onStar={handleStar}
                onDelete={handleDelete}
                hoverQuickActions={hoverQuickActions}
                onContextMenu={(e, msg) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, message: msg });
                }}
                isMobile={isMobile}
                swipeLeftAction={swipeLeftAction}
                swipeRightAction={swipeRightAction}
                onSwipeLeft={selectionMode || swipeLeftAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeLeftAction, msg)}
                onSwipeRight={selectionMode || swipeRightAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeRightAction, msg)}
                onLongPress={isMobile ? (id) => { setSelectionModeActive(true); toggleSelect(id); } : undefined}
              />
            );
          })
        )}

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
                <div>{t('common.loading')}</div>
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
                  {t('messageList.loadMore')}
                </button>
              </div>
            )}
            {!searchLoadingMore && !searchHasMore && displayMessages.length > 0 && (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                {t('messageList.noMoreMessages')}
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
                <div>{t('common.loading')}</div>
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
                  {t('messageList.loadMore')}
                </button>
              </div>
            )}
            {!loadingMessages && !hasMoreMessages && displayMessages.length > 0 && (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                {t('messageList.noMoreMessages')}
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
              >← {t('messageList.prevPage')}</button>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('messageList.pageOf', { current: currentPage, total: totalPages })}
              </span>
              <button
                onClick={() => loadPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                style={btnStyle(currentPage >= totalPages)}
                onMouseEnter={e => { if (currentPage < totalPages) { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)'; }}}
                onMouseLeave={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.color = currentPage >= totalPages ? 'var(--text-tertiary)' : 'var(--text-secondary)'; }}
              >{t('messageList.nextPage')} →</button>
            </div>
          );
        })()}
        </div>

        {/* Scroll-to-top button */}
        {showScrollTop && (
          <button
            onClick={() => { if (listRef.current) listRef.current.scrollTo({ top: 0, behavior: 'smooth' }); }}
            title={t('messageList.backToTop')}
            style={{
              position: 'absolute', bottom: 20, right: 16, zIndex: 20,
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: 'var(--shadow-soft)',
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

      {/* Undo bar — anchored to the bottom of the list panel on desktop */}
      {!isMobile && undoableNotifications.map((n, i) => (
        <UndoBar
          key={n.id}
          notification={n}
          onDismiss={() => removeNotification(n.id)}
          showTopBorder={i === 0}
        />
      ))}

      {isMobile && (
        <button
          onClick={() => openCompose({})}
          aria-label="Compose new message"
          style={{
            position: 'fixed',
            bottom: 'calc(var(--sab) + 20px)',
            right: 20,
            width: 56, height: 56,
            borderRadius: '50%',
            background: 'var(--accent)',
            border: 'none',
            boxShadow: 'var(--shadow-popover)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white',
            zIndex: 200,
            opacity: fabVisible ? 1 : 0,
            transform: fabVisible ? 'scale(1)' : 'scale(0.8)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
            pointerEvents: fabVisible ? 'auto' : 'none',
          }}
          onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.92)'; }}
          onMouseUp={e => { e.currentTarget.style.transform = fabVisible ? 'scale(1)' : 'scale(0.8)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = fabVisible ? 'scale(1)' : 'scale(0.8)'; }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      )}
    </div>
  );
}

function UndoBar({ notification, onDismiss, showTopBorder }) {
  const { t } = useTranslation();
  const [exiting, setExiting] = useState(false);

  const dismiss = () => {
    setExiting(true);
    setTimeout(onDismiss, 190);
  };

  const handleUndo = () => {
    notification.onUndo();
    dismiss();
  };

  useEffect(() => {
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={exiting ? 'action-bar-exit' : 'action-bar-enter'}
      style={{
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        borderTop: showTopBorder ? '1px solid var(--border-subtle)' : 'none',
        padding: '9px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--bg-primary)',
      }}
    >
      <div style={{
        position: 'absolute', bottom: 0, left: 0,
        height: 2, background: 'var(--accent)',
        animation: 'action-bar-progress 4.5s linear forwards',
      }} />
      <span style={{
        flex: 1, minWidth: 0,
        fontSize: 13, color: 'var(--text-secondary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {notification.title}
      </span>
      <button
        onClick={handleUndo}
        style={{
          background: 'none', border: 'none',
          color: 'var(--accent)', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', padding: '2px 4px', flexShrink: 0,
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = '0.75'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
      >
        {t('common.undo')}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          background: 'none', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer',
          padding: 2, display: 'flex', flexShrink: 0,
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

function EmptyState({ folderSyncing, searchQuery, unreadOnly, selectedFolder, accounts, onClearSearch, onShowAll, onCompose }) {
  const { t } = useTranslation();

  if (folderSyncing) {
    return (
      <div style={{ padding: '60px 40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <div style={{
          width: 24, height: 24, margin: '0 auto 12px',
          border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        <div style={{ fontSize: 14 }}>{t('common.loading')}</div>
      </div>
    );
  }

  if (searchQuery) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, margin: '0 auto 16px',
          background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>{t('messageList.noSearchResults')}</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          {t('messageList.noSearchResultsDesc', { query: searchQuery })}
        </div>
        <button onClick={onClearSearch} style={{
          padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
        }}>{t('messageList.clearSearch')}</button>
      </div>
    );
  }

  if (unreadOnly) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, margin: '0 auto 16px',
          background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>All caught up</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>No unread messages here</div>
        <button onClick={onShowAll} style={{
          padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
        }}>{t('messageList.showAll')}</button>
      </div>
    );
  }

  if (!accounts.length) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, margin: '0 auto 16px',
          background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
        </div>
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>No accounts yet</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Add an email account to get started</div>
      </div>
    );
  }

  const isInbox = !selectedFolder || selectedFolder === 'INBOX';
  return (
    <div style={{ padding: '60px 24px', textAlign: 'center' }}>
      <div style={{
        width: 48, height: 48, borderRadius: 14, margin: '0 auto 16px',
        background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-tertiary)',
      }}>
        {isInbox ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        )}
      </div>
      <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>
        {isInbox ? 'Inbox is empty' : 'Nothing here'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: isInbox ? 20 : 0 }}>
        {isInbox ? "You're all caught up" : 'This folder has no messages'}
      </div>
      {isInbox && (
        <button onClick={onCompose} style={{
          padding: '7px 18px', borderRadius: 8, border: 'none',
          background: 'var(--accent)', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>{t('sidebar.compose')}</button>
      )}
    </div>
  );
}

function ThreadRow({ message, isExpanded, threadMsgs, isLoadingThread, selectedMessageId, lastViewedMessageId, showAccount, isNarrow, onThreadClick, onSelect, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const messageCount = message.message_count || 1;
  const unreadCount  = parseInt(message.unread_count) || 0;
  const tid = message.thread_id || message.id;

  const { contentRef, swipeBgLeftRef, swipeBgRightRef, springBack } = useSwipeRow({
    isMobile, message, onSwipeLeft, onSwipeRight,
  });

  const isLastViewed = lastViewedMessageId === message.id
    || (lastViewedMessageId && threadMsgs?.some(m => m.id === lastViewedMessageId));
  const rowBg = isMobile
    ? 'var(--bg-primary)'
    : (isExpanded ? 'var(--bg-secondary)' : (hovered ? 'var(--bg-tertiary)' : (isLastViewed ? 'var(--accent-glow)' : 'transparent')));
  const leftActionView = getSwipeActionView(swipeRightAction, message, t, unreadCount);
  const rightActionView = getSwipeActionView(swipeLeftAction, message, t, unreadCount);

  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Swipe container wraps only the header row */}
      <div style={{ position: 'relative', overflow: 'hidden' }}>

      {isMobile && <SwipeBackground side="left" actionView={leftActionView} innerRef={swipeBgLeftRef} />}
      {isMobile && <SwipeBackground side="right" actionView={rightActionView} innerRef={swipeBgRightRef} />}

      {/* Thread header row */}
      <div
        ref={isMobile ? contentRef : undefined}
        onMouseEnter={() => !isMobile && setHovered(true)}
        onMouseLeave={() => !isMobile && setHovered(false)}
        onClick={onThreadClick}
        onContextMenu={!isMobile ? (e => onContextMenu(e, message)) : undefined}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '11px 14px', cursor: 'pointer',
          background: rowBg, transition: 'background 0.1s',
          position: 'relative',
          willChange: isMobile ? 'transform' : undefined,
        }}
      >
        {/* Unread dot */}
        {unreadCount > 0 && (
          <div style={{
            position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
            width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
          }} />
        )}

        {/* Avatar */}
        {!isNarrow && !isMobile && (
          <div style={{
            width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
            background: senderColor(message.from_email || message.from_name),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 600, color: 'white', marginTop: 1,
          }}>
            {(message.from_name || message.from_email || '?')[0].toUpperCase()}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, paddingLeft: unreadCount > 0 ? 6 : 0 }}>
          {/* Row 1: sender + badge + date */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              {showAccount && (
                <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: message.account_color || '#6366f1' }} />
              )}
              <span style={{
                fontSize: 13, fontWeight: unreadCount > 0 ? 600 : 400,
                color: unreadCount > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
              }}>
                {message.from_name || message.from_email || t('common.unknown', 'Unknown')}
              </span>
              {messageCount > 1 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                  borderRadius: 10, padding: '1px 6px', flexShrink: 0,
                }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    {isExpanded
                      ? <polyline points="18 15 12 9 6 15" />
                      : <polyline points="6 9 12 15 18 9" />}
                  </svg>
                  {messageCount}
                </span>
              )}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 8,
            }}>
              {message.has_attachments && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                </svg>
              )}
              {message.is_starred && (
                <button
                  onClick={e => { e.stopPropagation(); onStar(e, message); }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--amber)" stroke="var(--amber)" strokeWidth="2">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                </button>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatDate(message.date)}</span>
            </div>
          </div>
          {/* Row 2: subject */}
          <div style={{
            fontSize: 12, fontWeight: unreadCount > 0 ? 500 : 400,
            color: unreadCount > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2,
          }}>
            {message.subject || t('common.noSubject')}
          </div>
          {/* Row 3: snippet */}
          <div style={{
            fontSize: 12, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {message.snippet || ''}
          </div>
        </div>
        {hovered && hoverQuickActions && (
          <div style={{
            position: 'absolute', bottom: 6, right: 8,
            display: 'flex', alignItems: 'center', gap: 2,
            background: rowBg,
            borderRadius: 5,
            padding: '1px 2px',
          }}>

            <ActionBtn
              title={unreadCount > 0 ? t('contextMenu.markRead') : t('contextMenu.markUnread')}
              onClick={e => onMarkRead(e, message)}
            >
              {unreadCount > 0 ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path style={{ strokeLinecap: 'round' }} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9" /><polyline points="2 9 12 2 22 9" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path style={{ strokeLinecap: 'round' }} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{ strokeLinecap: 'round' }} points="16.36 9.95 12 13 2 6"/><circle style={{ strokeMiterlimit: 10, fill: 'currentColor' }} cx="19.96" cy="6" r="3"/>
                </svg>
              )}
            </ActionBtn>

            <ActionBtn title={message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star')} onClick={e => onStar(e, message)}>
              <svg width="13" height="13" viewBox="0 0 24 24"
                fill={message.is_starred ? 'var(--amber)' : 'none'}
                stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </ActionBtn>

            <ActionBtn title={t('message.delete')} onClick={e => onDelete(e, message)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
              </svg>
            </ActionBtn>
          </div>
        )}
      </div>
      </div>{/* end swipe container */}

      {/* Expanded sub-rows */}
      {isExpanded && (
        <div style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-subtle)' }}>
          {isLoadingThread ? (
            <div style={{ padding: '14px 16px', display: 'flex', justifyContent: 'center' }}>
              <div style={{
                width: 16, height: 16,
                border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }} />
            </div>
          ) : (threadMsgs || []).map((msg, idx) => (
            <div
              key={msg.id}
              onClick={e => { e.stopPropagation(); onSelect(msg); }}
              onContextMenu={!isMobile ? (e => { e.preventDefault(); onContextMenu(e, msg); }) : undefined}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '9px 14px 9px 44px',
                cursor: 'pointer', position: 'relative',
                background: selectedMessageId === msg.id || lastViewedMessageId === msg.id ? 'var(--accent-glow)' : 'transparent',
                borderTop: idx > 0 ? '1px solid var(--border-subtle)' : 'none',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (selectedMessageId !== msg.id) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = selectedMessageId === msg.id || lastViewedMessageId === msg.id ? 'var(--accent-glow)' : 'transparent'; }}
            >
              {!msg.is_read && (
                <div style={{
                  position: 'absolute', left: 28, top: '50%', transform: 'translateY(-50%)',
                  width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)',
                }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: 12, fontWeight: msg.is_read ? 400 : 600,
                    color: msg.is_read ? 'var(--text-secondary)' : 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {msg.from_name || msg.from_email || t('common.unknown', 'Unknown')}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, marginLeft: 8 }}>
                    {formatDate(msg.date)}
                  </span>
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
                }}>
                  {msg.snippet || ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRow({ message, selected, lastViewed, isChecked, selectionMode, showAccount, isNarrow, onSelect, onToggleSelect, onRangeSelect, onAvatarClick, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight, onLongPress }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [avatarHovered, setAvatarHovered] = useState(false);
  const { contentRef, swipeBgLeftRef, swipeBgRightRef } = useSwipeRow({
    isMobile, message, onSwipeLeft, onSwipeRight, onLongPress,
  });

  // On mobile the row content must be opaque — swipe action panels sit behind it
  // and would show through a transparent background.
  const bgDefault = isMobile ? 'var(--bg-primary)' : 'transparent';
  const selectedColor = message.account_color || 'var(--accent)';
  const bg = (selected && !selectionMode)
    ? 'var(--accent-glow)'
    : (isChecked ? 'var(--accent-dim)' : (hovered ? 'var(--bg-tertiary)' : (lastViewed && !isMobile ? 'var(--accent-glow)' : bgDefault)));

  // Avatar is interactive (wide layouts, desktop only) — it handles selection entry
  const hasInteractiveAvatar = !isNarrow && !isMobile && !!onAvatarClick;
  // Show avatar as checkbox when: in selection mode, or hovering over the avatar
  const avatarAsCheckbox = hasInteractiveAvatar && (selectionMode || avatarHovered);

  const leftActionView = getSwipeActionView(swipeRightAction, message, t);
  const rightActionView = getSwipeActionView(swipeLeftAction, message, t);

  const handleClick = (e) => {
    if (selectionMode) {
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect(message.id);
      } else {
        onToggleSelect(message.id);
      }
    } else {
      onSelect(message);
    }
  };

  const handleAvatarAreaClick = (e) => {
    e.stopPropagation();
    if (selectionMode) {
      if (e.shiftKey && onRangeSelect) {
        onRangeSelect(message.id);
      } else {
        onToggleSelect(message.id);
      }
    } else if (onAvatarClick) {
      onAvatarClick(message.id);
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
      {isMobile && <SwipeBackground side="left" actionView={leftActionView} innerRef={swipeBgLeftRef} />}
      {isMobile && <SwipeBackground side="right" actionView={rightActionView} innerRef={swipeBgRightRef} />}

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
          boxShadow: (selected && !selectionMode && !isMobile)
            ? `inset 0 0 0 1px ${selectedColor}22`
            : undefined,
        }}
      >
      {/* Selected row left accent rail */}
      {selected && !selectionMode && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
          background: message.account_color || 'var(--accent)',
          borderRadius: '0 2px 2px 0',
        }} />
      )}
      {/* Left indicator: for narrow/mobile layouts show checkbox or unread dot.
          Wide layouts use the avatar area instead (see below). */}
      {(!hasInteractiveAvatar) && (
        selectionMode ? (
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
        )
      )}
      {/* Unread dot for wide layouts — always shown (avatar is separate, doesn't conflict) */}
      {hasInteractiveAvatar && !selectionMode && !message.is_read && (
        <div style={{
          position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--accent)',
        }} />
      )}

      <div style={{ paddingLeft: (!hasInteractiveAvatar && selectionMode) ? 22 : (message.is_read ? 0 : 6), display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {/* Sender avatar — wide layouts only. Morphs into a checkbox on hover or in selection mode. */}
        {!isNarrow && !isMobile && (
          <div
            onClick={handleAvatarAreaClick}
            onMouseEnter={() => setAvatarHovered(true)}
            onMouseLeave={() => setAvatarHovered(false)}
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: avatarAsCheckbox
                ? (isChecked ? 'var(--accent)' : 'var(--bg-tertiary)')
                : senderColor(message.from_email || message.from_name),
              border: avatarAsCheckbox && !isChecked ? '2px solid var(--border)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 600, color: avatarAsCheckbox ? (isChecked ? 'white' : 'var(--text-tertiary)') : 'white',
              marginTop: 1,
              cursor: 'pointer',
              transition: 'background 0.12s, border 0.12s',
              userSelect: 'none',
              boxSizing: 'border-box',
            }}
          >
            {avatarAsCheckbox ? (
              isChecked ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )
            ) : (
              (message.from_name || message.from_email || '?')[0].toUpperCase()
            )}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
        {/* Row 1: From + date */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
            {showAccount && (
              <div style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: message.account_color || '#6366f1',
              }} />
            )}
            <span style={{
              fontSize: 13, fontWeight: message.is_read ? 400 : 600,
              color: message.is_read ? 'var(--text-secondary)' : 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}>
              {message.from_name || message.from_email || t('common.unknown')}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 8 }}>
            {message.has_attachments && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
              </svg>
            )}
            {message.is_starred && (
              <button
                onClick={e => { e.stopPropagation(); onStar(e, message); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--amber)" stroke="var(--amber)" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
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
          {message.subject || t('message.noSubject')}
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
      </div>

      {/* Hover actions — absolutely positioned so they never affect row height */}
      {hovered && hoverQuickActions && (
        <div style={{
          position: 'absolute', bottom: 6, right: 8,
          display: 'flex', alignItems: 'center', gap: 2,
          background: 'var(--bg-tertiary)',
          borderRadius: 5,
          padding: '1px 2px',
        }}>
          {/* Mark read/unread */}
          <ActionBtn title={message.is_read ? t('contextMenu.markUnread') : t('contextMenu.markRead')} onClick={e => onMarkRead(e, message)}>
            {message.is_read ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path style={{ strokeLinecap: 'round' }} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{ strokeLinecap: 'round' }} points="16.36 9.95 12 13 2 6"/><circle style={{ strokeMiterlimit: 10, fill: 'currentColor' }} cx="19.96" cy="6" r="3"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path style={{ strokeLinecap: 'round' }} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9" /><polyline points="2 9 12 2 22 9" />
              </svg>
            )}
          </ActionBtn>

          {/* Star */}
          <ActionBtn title={message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star')} onClick={e => onStar(e, message)}>
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
        color: hov ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        cursor: 'pointer',
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
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '5px 7px', borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${hov && !disabled ? (danger ? 'var(--red, #ef4444)' : 'var(--accent)') : 'var(--border)'}`,
        background: hov && !disabled ? (danger ? 'rgba(239,68,68,0.1)' : 'var(--accent-dim)') : 'var(--bg-tertiary)',
        color: disabled ? 'var(--text-tertiary)' : (hov && danger ? 'var(--red, #ef4444)' : (hov ? 'var(--accent)' : 'var(--text-secondary)')),
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
