import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import { api } from '../utils/api.js';
import { LAYOUTS } from '../layouts.js';
import { senderColor } from '../themes.js';
import { useMobile } from '../hooks/useMobile.js';
import { useSwipeRow } from '../hooks/useSwipeRow.js';
import ContextMenu from './ContextMenu.jsx';
import RowHoverActions from './RowHoverActions.jsx';
import GtdTabList from './GtdTabList.jsx';
import {
  gtdActiveForContext, buildGtdDisplaySections, GTD_COLORS, GTD_CHIP_BG, sectionBadge, isSelectedRow,
  classifyThread, unclassifyThread,
} from '../utils/gtd.js';
import { formatDate } from '../utils/formatDate.js';
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

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

// Auto-advance the reading pane when the open message leaves the list: select the
// row that takes its place (next in display order, or previous if it was the last,
// or nothing if the list is now empty). Mirrors scheduleDelete's inline advance;
// call before removeMessage so the outgoing row is still present for the lookup.
// No-op unless the removed message is the currently selected one.
function advanceSelectionAfterRemoval(removedId) {
  const { messages, searchResults, searchQuery, selectedMessageId, setSelectedMessage } = useStore.getState();
  if (selectedMessageId !== removedId) return;
  const displayMsgs = searchQuery.trim() ? searchResults : messages;
  const idx = displayMsgs.findIndex(m => m.id === removedId);
  if (idx === -1) return;
  const next = displayMsgs[idx + 1] || displayMsgs[idx - 1] || null;
  setSelectedMessage(next?.id ?? null);
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
    appendMessages, messagesTotal, setMessagesTotal,
    setMessagesOffset, hasMoreMessages, setHasMoreMessages,
    loadingMessages, setLoadingMessages, selectedMessageId, lastViewedMessageId,
    setSelectedMessage, updateMessage, removeMessage,
    decrementUnread, incrementUnread, addNotification, notifications, removeNotification,
    searchQuery, setSearchQuery, setIsSearching,
    searchResults, setSearchResults, openCompose, accountsReady, accounts,
    messagesRefreshToken, layout, setLayout, pageSize, setPageSize, scrollMode,
    setMobileSidebarOpen, unreadCounts, showContacts, setShowContacts,
    threadedView, expandedThreadId, setExpandedThreadId,
    threadMessages, setThreadMessages, loadingThread, setLoadingThread,
    hoverQuickActions,
    swipeActions,
    folders, favoriteFolders, addFavoriteFolder, removeFavoriteFolder, setSelectedAccount,
    categorizationEnabled, categoryCounts, setCategoryCounts, adjustCategoryCount,
    markReadBehavior, markReadDelay,
    searchAllFolders,
    activeGtdTab, setActiveGtdTab, gtdSections,
  } = useStore();
  // RFC message_id of the open message, so a row highlights when it is a different DB copy
  // of the selected message (multi-folder model) — e.g. the inbox copy of a GTD sidebar click.
  const selectedMid = useStore(selectSelectedMessageMid);

  const isMobile = useMobile();
  const isUnified = selectedAccountId === null;
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  // Search is scoped to the current folder unless we're in the unified view or the
  // user toggled "search all folders". An in: operator in the query overrides this
  // server-side. undefined = search all folders.
  const searchFolder = (!isUnified && !searchAllFolders) ? selectedFolder : undefined;
  const searchPageSize = Math.max(1, Math.min(Number(pageSize) || 50, 200));
  const undoableNotifications = notifications.filter(n => n.onUndo);

  const currentLayout = LAYOUTS[layout] || LAYOUTS.comfortable;
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
  const [activeCategory, setActiveCategory] = useState('primary');
  const [currentPage, setCurrentPage] = useState(1);
  const currentPageRef = useRef(1);
  const [syncing, setSyncing] = useState(false);
  const [folderSyncing, setFolderSyncing] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [listScrolled, setListScrolled] = useState(false);
  const [fabVisible, setFabVisible] = useState(true);
  const lastScrollTopRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartXRef = useRef(null);
  const pullStartYRef = useRef(null);
  const pullDirectionRef = useRef(null);
  const pullDistRef = useRef(0);
  const handleSyncRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, message, defaultMoveView? }
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const searchFetchedOffsetRef = useRef(0);
  const listRef = useRef(null);
  const searchInputRef = useRef(null); // for focusSearch shortcut
  const pendingDeleteTimers = useRef(new Map()); // id/thread key -> pending delete metadata
  const recentMessageOpenUntilRef = useRef(0);
  const deferredRefreshTimerRef = useRef(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [pickerFolders, setPickerFolders] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const folderPickerRef = useRef(null);
  // Tracks the index of the last toggled row for shift-click range selection
  const lastSelectIdxRef = useRef(-1);

  // Layout picker
  const [showLayoutPicker, setShowLayoutPicker] = useState(false);
  const [layoutPickerPos, setLayoutPickerPos] = useState(null);
  const layoutPickerRef = useRef(null);

  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  useEffect(() => { setActiveCategory('primary'); setActiveGtdTab(null); }, [selectedAccountId, selectedFolder, setActiveGtdTab]);
  useEffect(() => {
    const markOpening = () => {
      recentMessageOpenUntilRef.current = Date.now() + 1500;
    };
    window.addEventListener('mailflow:message-opening', markOpening);
    return () => window.removeEventListener('mailflow:message-opening', markOpening);
  }, []);
  const searchTimer = useRef(null);

  // Category tab scroll arrows
  const catScrollRef = useRef(null);
  const [catScrollEdges, setCatScrollEdges] = useState({ left: false, right: false });
  const updateCatScrollEdges = useCallback(() => {
    const el = catScrollRef.current;
    if (!el) return;
    setCatScrollEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);
  useEffect(() => {
    updateCatScrollEdges();
  }, [activeCategory, selectedAccountId, selectedFolder, categorizationEnabled, updateCatScrollEdges]);

  // GTD surfaces (pills + tab list) apply when GTD is enabled for the context.
  const gtdActive = gtdActiveForContext(accounts, selectedAccountId);
  // While a GTD tab is selected the list body shows that section instead of the
  // folder listing. Same visibility envelope as the tab strip (INBOX, no search).
  const showGtdTab = gtdActive && !!activeGtdTab && selectedFolder === 'INBOX' && !searchQuery.trim();
  // Unread badge per GTD tab, from the shared sections store (Waiting merged).
  const gtdTabUnread = (() => {
    const map = {};
    for (const s of buildGtdDisplaySections(gtdSections)) map[s.key] = s.unread;
    return map;
  })();

  // Fetch unread counts per category for the tab bar badges.
  // Re-fetches whenever the account/folder changes or new mail arrives.
  const categorizationActive = categorizationEnabled || (!isUnified && selectedAccount?.categorization_enabled);
  useEffect(() => {
    if (!categorizationActive || selectedFolder !== 'INBOX') {
      setCategoryCounts({});
      return;
    }
    let cancelled = false;
    const params = selectedAccountId ? { accountId: selectedAccountId } : {};
    api.getCategoryCounts(params)
      .then(data => { if (!cancelled) setCategoryCounts(data.counts || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [categorizationActive, selectedAccountId, selectedFolder, messagesRefreshToken, setCategoryCounts]);

  const searchSeq = useRef(0);
  // Bumped to force the search effect to re-run (e.g. after rules move messages) so an
  // active search snapshot drops messages that no longer match. See #223.
  const [searchReloadToken, setSearchReloadToken] = useState(0);

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

  useEffect(() => {
    if (!showFolderPicker) setPickerSearch('');
  }, [showFolderPicker]);

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
        if (selectedFolder === 'INBOX' && (categorizationEnabled || selectedAccount?.categorization_enabled)) params.category = activeCategory;
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
  }, [selectedAccountId, selectedFolder, unreadOnly, activeCategory, pageSize, scrollMode, accountsReady, accounts.length, messagesRefreshToken, threadedView, categorizationEnabled, selectedAccount?.categorization_enabled, applyReadGuard, setHasMoreMessages, setLoadingMessages, setMessages, setMessagesOffset, setMessagesTotal]);

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
      if (selectedFolder === 'INBOX' && (categorizationEnabled || selectedAccount?.categorization_enabled)) params.category = activeCategory;
      const data = await api.getMessages(params);
      appendMessages(applyReadGuard(data.messages));
      setMessagesOffset(currentOffset + data.messages.length);
      setHasMoreMessages(currentOffset + data.messages.length < data.total);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  }, [selectedAccountId, selectedFolder, unreadOnly, activeCategory, pageSize, loadingMessages, hasMoreMessages, categorizationEnabled, selectedAccount?.categorization_enabled, applyReadGuard, appendMessages, setHasMoreMessages, setLoadingMessages, setMessagesOffset]);

  // Listen for background refresh events from WebSocket. If a message was just
  // opened, give its body request a brief head start before reloading the full list.
  useEffect(() => {
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
        if (selectedFolder === 'INBOX' && (categorizationEnabled || selectedAccount?.categorization_enabled)) params.category = activeCategory;
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
      } catch { /* intentional */ }
    };

    const handler = () => {
      if (!useStore.getState().loadingMessages && !searchQuery.trim()) {
        const delayMs = Math.max(0, recentMessageOpenUntilRef.current - Date.now());
        clearTimeout(deferredRefreshTimerRef.current);
        if (delayMs > 0) {
          deferredRefreshTimerRef.current = setTimeout(run, delayMs);
        } else {
          run();
        }
      }
    };
    window.addEventListener('mailflow:refresh', handler);
    return () => {
      window.removeEventListener('mailflow:refresh', handler);
      clearTimeout(deferredRefreshTimerRef.current);
    };
  }, [selectedAccountId, selectedFolder, unreadOnly, activeCategory, searchQuery, categorizationEnabled, selectedAccount?.categorization_enabled, applyReadGuard, setHasMoreMessages, setMessages, setMessagesOffset, setMessagesTotal]);

  // Search
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      setSearchHasMore(false);
      searchFetchedOffsetRef.current = 0;
      return;
    }
    setIsSearching(true);
    setSearchHasMore(false);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(searchQuery, selectedAccountId || undefined, { offset: 0, limit: searchPageSize, folder: searchFolder });
        if (searchSeq.current !== seq) return;
        searchFetchedOffsetRef.current = data.messages.length;
        setSearchResults(applyReadGuard(data.messages));
        setSearchHasMore(data.messages.length === searchPageSize);
      } catch (err) {
        if (searchSeq.current === seq) console.error('Search failed:', err);
      } finally {
        if (searchSeq.current === seq) setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, selectedAccountId, searchFolder, searchPageSize, searchReloadToken, applyReadGuard, setIsSearching, setSearchResults]);

  // Re-run an active search (and refresh the folder view) after inbox rules run, since
  // rules can move messages out of the searched folder and a search snapshot would
  // otherwise keep showing them. Scoped to the explicit rules-ran event rather than the
  // frequent mailflow:refresh (which is intentionally ignored while searching to keep
  // results stable during background syncs). Fixes #223.
  useEffect(() => {
    const handler = () => {
      // Bumps the search effect if a query is active (it no-ops on an empty query);
      // the refresh event reloads the folder list when not searching.
      setSearchReloadToken(t => t + 1);
      window.dispatchEvent(new Event('mailflow:refresh'));
    };
    window.addEventListener('mailflow:rules-ran', handler);
    return () => window.removeEventListener('mailflow:rules-ran', handler);
  }, []);

  const loadMoreSearch = useCallback(async () => {
    if (searchLoadingMore) return;
    const qSnapshot = searchQuery; // capture before async gap
    setSearchLoadingMore(true);
    try {
      const offset = searchFetchedOffsetRef.current;
      const data = await api.search(qSnapshot, selectedAccountId || undefined, { offset, limit: searchPageSize, folder: searchFolder });
      // Discard results if the query changed while we were fetching
      if (useStore.getState().searchQuery !== qSnapshot) return;
      searchFetchedOffsetRef.current = offset + data.messages.length;
      const current = useStore.getState().searchResults;
      useStore.setState({ searchResults: [...current, ...applyReadGuard(data.messages)] });
      setSearchHasMore(data.messages.length === searchPageSize);
    } catch (err) {
      console.error('Search load more failed:', err);
    } finally {
      setSearchLoadingMore(false);
    }
  }, [searchQuery, selectedAccountId, searchFolder, searchPageSize, searchLoadingMore, applyReadGuard]);

  const prefetchSearchAfterRemoval = useCallback(async (offset) => {
    const qSnapshot = useStore.getState().searchQuery;
    if (!qSnapshot.trim()) return;
    try {
      const data = await api.search(qSnapshot, selectedAccountId || undefined, { offset, limit: searchPageSize, folder: searchFolder });
      if (useStore.getState().searchQuery !== qSnapshot) return;
      searchFetchedOffsetRef.current = Math.max(searchFetchedOffsetRef.current, offset + data.messages.length);
      const additions = applyReadGuard(data.messages);
      if (!additions.length) {
        setSearchHasMore(data.messages.length === searchPageSize);
        return;
      }
      useStore.setState(state => {
        const existing = new Set(state.searchResults.map(m => m.id));
        const missing = additions.filter(m => m && !existing.has(m.id));
        return missing.length ? { searchResults: [...state.searchResults, ...missing] } : {};
      });
      setSearchHasMore(data.messages.length === searchPageSize);
    } catch (err) {
      console.error('Search prefetch after delete failed:', err);
    }
  }, [selectedAccountId, searchFolder, searchPageSize, applyReadGuard]);

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
      if (selectedFolder === 'INBOX' && (categorizationEnabled || selectedAccount?.categorization_enabled)) params.category = activeCategory;
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
  }, [selectedAccountId, selectedFolder, unreadOnly, activeCategory, pageSize, loadingMessages, threadedView, categorizationEnabled, selectedAccount?.categorization_enabled, applyReadGuard, setExpandedThreadId, setHasMoreMessages, setLoadingMessages, setMessages, setMessagesOffset, setMessagesTotal]);

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
      if (el.scrollTop !== 0) return;
      pullStartXRef.current = e.touches[0].clientX;
      pullStartYRef.current = e.touches[0].clientY;
      pullDirectionRef.current = null;
    };

    const onTouchMove = (e) => {
      if (pullStartYRef.current === null) return;
      const dx = e.touches[0].clientX - pullStartXRef.current;
      const delta = e.touches[0].clientY - pullStartYRef.current;
      if (!pullDirectionRef.current) {
        if (Math.abs(dx) < 6 && Math.abs(delta) < 6) return;
        pullDirectionRef.current = Math.abs(dx) > Math.abs(delta) ? 'h' : 'v';
      }
      if (pullDirectionRef.current === 'h') return;
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

    const resetPull = () => {
      pullStartXRef.current = null;
      pullStartYRef.current = null;
      pullDirectionRef.current = null;
      pullDistRef.current = 0;
      setPullDistance(0);
    };

    const onTouchEnd = () => {
      if (pullStartYRef.current === null) return;
      const dist = pullDistRef.current;
      resetPull();
      if (dist >= THRESHOLD) handleSyncRef.current?.();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', resetPull, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', resetPull);
    };
  }, [isMobile]);

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
    const isThreadRow = isThreadListRow(message);
    const unreadCount = Number.parseInt(message.unread_count, 10);
    // Use the row's own unread_count as the immediate estimate.
    // For thread rows this is the aggregate already present on the row;
    // for single messages it is always 1 (or 0 if already in the target state).
    const estimatedDelta = isThreadRow && Number.isFinite(unreadCount) ? unreadCount : 1;

    // Immediate optimistic update — do not wait for thread resolution.
    // For unexpanded thread rows this avoids a visible delay caused by the
    // api.getThread call inside resolveMessagesForThreadAction.
    if (isThreadRow) {
      updateMessage(message.id, { is_read: read, unread_count: read ? 0 : estimatedDelta });
      // setCachedThreadRead intentionally deferred until after resolution so
      // that actionMessages still reflects the pre-update sub-message states,
      // letting us compute the exact delta for any needed correction.
    } else {
      updateMessage(message.id, { is_read: read, unread_count: read ? 0 : 1 });
    }
    if (read) {
      if (estimatedDelta > 0) {
        decrementUnread(message.account_id, estimatedDelta);
        adjustCategoryCount(message.category, -estimatedDelta);
      }
    } else {
      if (estimatedDelta > 0) {
        incrementUnread(message.account_id, estimatedDelta);
        adjustCategoryCount(message.category, estimatedDelta);
      }
    }

    // Resolve the individual sub-messages needed for the bulk API call.
    // For unexpanded thread rows this fires api.getThread, but the UI has
    // already updated above so the user sees no delay.
    let actionMessages;
    try {
      actionMessages = await resolveMessagesForThreadAction(message);
    } catch (err) {
      console.error('Failed to load thread for read state change:', err.message);
      // Revert the optimistic update
      if (isThreadRow) {
        updateMessage(message.id, { is_read: !read, unread_count: !read ? 0 : estimatedDelta });
      } else {
        updateMessage(message.id, { is_read: !read, unread_count: !read ? 0 : 1 });
      }
      if (read && estimatedDelta > 0) { incrementUnread(message.account_id, estimatedDelta); adjustCategoryCount(message.category, estimatedDelta); }
      else if (!read && estimatedDelta > 0) { decrementUnread(message.account_id, estimatedDelta); adjustCategoryCount(message.category, -estimatedDelta); }
      return;
    }

    // Compute exact delta from sub-message states (before mutating the cache).
    const actualDelta = read
      ? actionMessages.filter(msg => !msg.is_read).length
      : actionMessages.filter(msg => msg.is_read).length;

    // Now update the thread cache and correct the parent row if our estimate was off.
    if (isThreadRow) {
      setCachedThreadRead(message, read);
      if (actualDelta !== estimatedDelta) {
        updateMessage(message.id, { is_read: read, unread_count: read ? 0 : actionMessages.length });
      }
    }

    // Correct the sidebar badge if the estimate differed from the actual count.
    if (actualDelta !== estimatedDelta) {
      const diff = actualDelta - estimatedDelta;
      if (read) {
        if (diff > 0) decrementUnread(message.account_id, diff);
        else incrementUnread(message.account_id, -diff);
      } else {
        if (diff > 0) incrementUnread(message.account_id, diff);
        else decrementUnread(message.account_id, -diff);
      }
      adjustCategoryCount(message.category, read ? -diff : diff);
    }

    if (read) {
      actionMessages.forEach(msg => setPending(msg.id, msg.account_id));
    } else {
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
        updateMessage(message.id, { is_read: !read, unread_count: read ? actualDelta : 0 });
        setCachedThreadRead(message, !read);
      } else {
        updateMessage(message.id, { is_read: !read, unread_count: read ? 1 : 0 });
      }
      if (read) {
        if (actualDelta > 0) { incrementUnread(message.account_id, actualDelta); adjustCategoryCount(message.category, actualDelta); }
        actionMessages.forEach(msg => pendingMarkReadMap.delete(msg.id));
      } else if (actualDelta > 0) {
        decrementUnread(message.account_id, actualDelta);
        adjustCategoryCount(message.category, -actualDelta);
      }
    }
  }, [
    resolveMessagesForThreadAction, isThreadListRow, updateMessage, setCachedThreadRead,
    decrementUnread, incrementUnread, adjustCategoryCount,
  ]);

  const handleMarkRead = (e, message) => {
    e.stopPropagation();
    setMessagesReadState(message, !message.is_read);
  };

  const setMessagesStarredState = useCallback(async (message, starred) => {
    let actionMessages;
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

  // GTD "done" from the inbox hover cluster (all-states mode): the backend marks the thread
  // read, strips every GTD label it carries, and archives the INBOX copy. Optimistic like
  // archive — advance the selection and drop the row immediately, no undo toast — and on
  // failure restore the row and surface the same notification the GTD sidebar's done uses.
  const handleGtdDone = useCallback(async (e, message) => {
    e.stopPropagation();
    advanceSelectionAfterRemoval(message.id);
    removeMessage(message.id);
    // gtdDone marks the WHOLE thread read server-side and unreadCounts is message-based, so
    // drop the row's full thread-unread (unread_count) like scheduleDelete does — a fixed -1
    // under-counts a multi-unread thread. Fall back to this row's own unread when absent.
    const unreadCount = Number.parseInt(message.unread_count, 10);
    const unreadDelta = Number.isFinite(unreadCount) ? unreadCount : (message.is_read ? 0 : 1);
    if (unreadDelta > 0) decrementUnread(message.account_id, unreadDelta);
    try {
      const res = await api.gtdDone(message.id);
      // Labels stripped but the archive step failed: the optimistic removal is still
      // correct, but the email is still in the inbox — say so rather than leave a gap.
      if (res?.archiveFailed) {
        addNotification({ title: t('gtd.doneArchiveFailed'), body: message.subject || t('common.noSubject') });
      }
    } catch (err) {
      console.error('GTD done failed:', err.message);
      useStore.getState().restoreMessages([message]);
      if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
      addNotification({ title: t('gtd.doneFailed'), body: message.subject || t('common.noSubject') });
    }
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

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

    // Advance selection to the next visible message before removing this one
    const { selectedMessageId, setSelectedMessage } = useStore.getState();
    if (selectedMessageId === visibleMessage.id) {
      const displayMsgs = scRef.current.displayMessages || [];
      const idx = displayMsgs.findIndex(m => m.id === visibleMessage.id);
      const next = displayMsgs[idx + 1] || displayMsgs[idx - 1] || null;
      setSelectedMessage(next?.id ?? null);
    }

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
            useStore.getState().restoreMessages([visibleMessage]);
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
        useStore.getState().restoreMessages([visibleMessage]);
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
        useStore.getState().restoreMessages([visibleMessage]);
        if (unreadDelta > 0) incrementUnread(message.account_id, unreadDelta);
      },
    });
  }, [
    isThreadListRow, expandedThreadId, resolveMessagesForThreadAction,
    removeMessage, setExpandedThreadId, decrementUnread, incrementUnread,
    addNotification, t,
  ]);

  // Antispam helpers (v0.1).
  //
  // Strategy for both mark-as-spam and mark-as-ham:
  //   1. Optimistically remove the message(s) from the visible list and decrement
  //      unread counts — same pattern as scheduleDelete above.
  //   2. Show a toast with Undo (4.5s window). Undo restores the message locally
  //      and cancels the API call via a per-message timer.
  //   3. After the timer fires, call api.markSpam / api.markHam per id in parallel
  //      (Promise.allSettled). On any failure, restore the messages that failed
  //      and show an error toast.
  //
  // Bulk is handled by collecting `messages` from selectedIds if multiple are
  // selected; the caller (handleContextAction) decides which set to pass.

  const performSpamLabel = useCallback(async (messages, label) => {
    if (!messages.length) return;
    const ids = messages.map(m => m.id);
    const isBulk = ids.length > 1;

    // Optimistic local update: remove from view + drop unread badge.
    const unreadCount = messages.reduce((sum, m) => sum + (m.is_read ? 0 : 1), 0);
    const accountId = messages[0].account_id;
    messages.forEach(m => removeMessage(m.id));
    if (unreadCount > 0) decrementUnread(accountId, unreadCount);

    // Folder-aware unread badge updates for the sidebar.
    //
    // For spam (move INTO the junk folder) we decrement whichever folder the
    // messages came from (typically INBOX, but possibly some other folder the
    // user is in). For ham (move OUT of junk into inbox) we decrement the
    // source folder (junk) and increment the destination folder (inbox).
    //
    // We aggregate by folder path because a bulk action may touch messages
    // from different folders in theory (the UI currently only selects from
    // one folder at a time, but the data model allows otherwise).
    const { adjustFolderUnread } = useStore.getState();
    const account = accounts.find(a => a.id === accountId);
    const spamDest = account?.folder_mappings?.spam;
    const inboxDest = account?.folder_mappings?.inbox || 'INBOX';
    const unreadBySource = new Map();
    const unreadByHamSource = new Map(); // for ham: track source folder
    messages.forEach(m => {
      if (m.is_read) return;
      const src = m.folder;
      if (!src) return;
      if (label === 'spam') {
        unreadBySource.set(src, (unreadBySource.get(src) || 0) + 1);
      } else if (label === 'ham') {
        unreadByHamSource.set(src, (unreadByHamSource.get(src) || 0) + 1);
      }
    });
    if (label === 'spam') {
      // origin folder loses its unread messages; junk gains them
      for (const [src, n] of unreadBySource) adjustFolderUnread(accountId, src, -n);
      if (spamDest && unreadCount > 0) adjustFolderUnread(accountId, spamDest, +unreadCount);
    } else if (label === 'ham') {
      // junk loses them; inbox gains them
      for (const [src, n] of unreadByHamSource) adjustFolderUnread(accountId, src, -n);
      if (inboxDest && unreadCount > 0) adjustFolderUnread(accountId, inboxDest, +unreadCount);
    }

    // Per-id timer map so Undo can cancel any pending API call.
    const timers = new Map();
    let settled = false;
    const undo = () => {
      settled = true;
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
      // Restore the messages in their original position (re-sort by date).
      useStore.getState().restoreMessages(messages);
      if (unreadCount > 0) incrementUnread(accountId, unreadCount);
      // Reverse the folder badge adjustments so undo behaves like the move
      // never happened.
      if (label === 'spam') {
        for (const [src, n] of unreadBySource) adjustFolderUnread(accountId, src, +n);
        if (spamDest && unreadCount > 0) adjustFolderUnread(accountId, spamDest, -unreadCount);
      } else if (label === 'ham') {
        for (const [src, n] of unreadByHamSource) adjustFolderUnread(accountId, src, +n);
        if (inboxDest && unreadCount > 0) adjustFolderUnread(accountId, inboxDest, -unreadCount);
      }
    };

    const performCall = (id) => {
      const fn = label === 'spam' ? api.markSpam : api.markHam;
      return fn(id).catch(err => ({ __failed: true, id, message: err.message }));
    };

    timers.set('__call__', setTimeout(async () => {
      if (settled) return;
      timers.delete('__call__');
      const results = await Promise.allSettled(ids.map(performCall));
      const failed = [];
      results.forEach((r, i) => {
        if (r.status === 'rejected' || r.value?.__failed) failed.push(ids[i]);
      });
      if (failed.length) {
        const failedMsgs = messages.filter(m => failed.includes(m.id));
        useStore.getState().restoreMessages(failedMsgs);
        const failedUnread = failedMsgs.reduce((sum, m) => sum + (m.is_read ? 0 : 1), 0);
        if (failedUnread > 0) incrementUnread(accountId, failedUnread);
        const titleKey = label === 'spam' ? 'spam.failTitle' : 'spam.failHamTitle';
        const bodyKey = label === 'spam' ? 'spam.failBody' : 'spam.failHamBody';
        addNotification({
          type: 'error',
          title: t(titleKey),
          body: isBulk ? t('spam.failBodyBulk', { count: failed.length }) : t(bodyKey),
        });
      }
      // Safety net: after the IMAP move actually completes (or partially
      // fails), reconcile sidebar counts and folder badges with the server.
      // Even if our optimistic math was right, edge cases like the user
      // moving messages between two folders that share a parent, or a
      // concurrent IMAP IDLE update, can desync the local counters.
      api.getUnreadCounts().then(c => useStore.getState().setUnreadCounts(c)).catch(() => {});
      api.getFolders(accountId).then(f => useStore.getState().setFolders(accountId, f)).catch(() => {});
    }, 4500));

    addNotification({
      title: label === 'spam'
        ? (isBulk ? t('spam.movedToSpamBulk', { count: ids.length }) : t('spam.movedToSpam'))
        : (isBulk ? t('spam.movedToInboxBulk', { count: ids.length }) : t('spam.movedToInbox')),
      body: messages[0].subject || t('common.noSubject'),
      onUndo: undo,
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t, accounts]);

  // On page unload (refresh/close), fire pending deletes with keepalive:true so the
  // browser completes the request even after the page tears down. Clears the map so
  // the unmount cleanup below does not double-fire on normal navigation.
  useEffect(() => {
    const handleBeforeUnload = () => {
      pendingDeleteTimers.current.forEach(({ timer, message, ids }) => {
        clearTimeout(timer);
        const deleteIds = ids?.length ? ids : [message.id];
        try {
          if (deleteIds.length > 1) {
            fetch('/api/mail/messages/bulk-delete', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MailFlow' },
              body: JSON.stringify({ ids: deleteIds }),
              keepalive: true,
            });
          } else {
            fetch(`/api/mail/messages/${deleteIds[0]}`, {
              method: 'DELETE',
              credentials: 'include',
              headers: { 'X-Requested-With': 'MailFlow' },
              keepalive: true,
            });
          }
        } catch { /* keepalive not supported — best effort */ }
      });
      pendingDeleteTimers.current.clear();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // On normal unmount (navigating away), immediately fire any pending deletes.
  // Navigating away during the 4.5s undo window should still delete the message —
  // cancelling the timer would silently leave it on the server.
  // (Page refresh is handled by the beforeunload listener above which clears the map first.)
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
    advanceSelectionAfterRemoval(message.id);
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
        useStore.getState().restoreMessages([message]);
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
      : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
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
        const fromEmail = (message.from_email || '').toLowerCase();
        const match = aliases.find(al => {
          const aliasEmail = al.email.toLowerCase();
          return allEmails.includes(aliasEmail) || fromEmail === aliasEmail;
        });
        return match ? match.id : null;
      } catch { return null; }
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
      } catch { return []; }
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

  // Folder search results — shown at the top when searching with a plain query
  // (no special operator prefixes like from:, to:, subject:, has:, is:)
  const folderSearchResults = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    if (/(?:^|\s)-?(?:from|to|subject|has|is|cc|bcc|in|after|before):/.test(q)) return [];
    const results = [];
    for (const [accountId, folderList] of Object.entries(folders)) {
      if (!Array.isArray(folderList)) continue;
      const account = accounts.find(a => a.id === accountId);
      for (const folder of folderList) {
        const name = (folder.name || folder.path || '').toLowerCase();
        const path = (folder.path || '').toLowerCase();
        if (name.includes(q) || path.includes(q)) {
          results.push({ ...folder, accountId, accountName: account?.name || account?.email_address || '' });
        }
      }
    }
    return results;
  })();
  // Keep scRef in sync so scheduleDelete can read displayMessages without a stale closure
  scRef.current.displayMessages = displayMessages;

  // Arrow-key navigation: intercepts ArrowDown/ArrowUp when the list container has focus.
  const handleListKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); shortcutBus.emit('nextMessage'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); shortcutBus.emit('prevMessage'); }
  }, []);

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
    const key = `bulk:${ids[0]}`;
    const searchOffsetBeforeRemoval = searchFetchedOffsetRef.current;
    const shouldPrefetchSearch = Boolean(useStore.getState().searchQuery.trim() && searchHasMore);
    ids.forEach(id => setPendingDelete(id));
    ids.forEach(id => removeMessage(id));
    if (shouldPrefetchSearch) {
      prefetchSearchAfterRemoval(searchOffsetBeforeRemoval);
    }
    msgs.forEach(msg => {
      const delta = parseInt(msg.unread_count) || (msg.is_read ? 0 : 1);
      if (delta > 0) decrementUnread(msg.account_id, delta);
    });
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    let undone = false;
    const timer = setTimeout(async () => {
      pendingDeleteTimers.current.delete(key);
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
        useStore.getState().restoreMessages(failedMsgs);
        failedMsgs.forEach(msg => {
          const delta = parseInt(msg.unread_count) || (msg.is_read ? 0 : 1);
          if (delta > 0) incrementUnread(msg.account_id, delta);
        });
        addNotification({ type: 'error', title: t('messageList.bulkDeleted.failTitle'), body: t('messageList.bulkDeleted.failBody', { count: failedIds.length }) });
      }
      if (useStore.getState().searchQuery.trim()) {
        setSearchReloadToken(token => token + 1);
      }
    }, 4500);
    pendingDeleteTimers.current.set(key, { timer, message: msgs[0], ids });
    addNotification({
      title: t('messageList.bulkDeleted.title', { count: ids.length }),
      body: t('messageList.bulkDeleted.body'),
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        pendingDeleteTimers.current.delete(key);
        ids.forEach(id => clearPendingDelete(id));
        useStore.getState().restoreMessages(msgs);
        msgs.forEach(msg => {
          const delta = parseInt(msg.unread_count) || (msg.is_read ? 0 : 1);
          if (delta > 0) incrementUnread(msg.account_id, delta);
        });
      },
    });
  }, [searchHasMore, removeMessage, prefetchSearchAfterRemoval, decrementUnread, incrementUnread, addNotification, t]);

  const handleBulkMove = useCallback((ids, msgs, folder) => {
    ids.forEach(id => removeMessage(id));
    msgs.forEach(msg => { if (!msg.is_read) decrementUnread(msg.account_id); });
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
          useStore.getState().restoreMessages(failedMsgs);
          addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: failedMsgs.length }) });
        } else if (msgs[0]?.account_id) {
          useStore.getState().recordRecentFolder({ accountId: msgs[0].account_id, path: folder });
        }
      } catch (err) {
        console.error('Bulk move failed:', err);
        useStore.getState().restoreMessages(msgs);
        addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: ids.length }) });
      }
    }, 4500);
    addNotification({
      title: t('messageList.bulkMoved.title', { count: ids.length }),
      body: folder,
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        useStore.getState().restoreMessages(msgs);
        msgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
      },
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  const handleRowMove = useCallback((e, msg) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4, message: msg, defaultMoveView: true });
  }, []);

  const handleRowDragStart = useCallback((e, message) => {
    const { selectedIds } = scRef.current;
    const isMulti = selectedIds.size > 1 && selectedIds.has(message.id);
    const payload = isMulti
      ? { messageIds: [...selectedIds], accountId: message.account_id }
      : { messageId: message.id, accountId: message.account_id };
    e.dataTransfer.setData('application/x-mailflow-message', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  }, []);

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
          useStore.getState().restoreMessages(failedMsgs);
          failedMsgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
          if (result.noArchiveFolder?.length) {
            addNotification({ title: t('messageList.bulkArchived.noFolderTitle'), body: t('messageList.bulkArchived.noFolderBody') });
          } else {
            addNotification({ title: t('messageList.bulkArchived.failTitle'), body: t('messageList.bulkArchived.failBody', { count: failedMsgs.length }) });
          }
        }
      } catch (err) {
        console.error('Bulk archive failed:', err);
        useStore.getState().restoreMessages(msgs);
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
        useStore.getState().restoreMessages(msgs);
        msgs.forEach(msg => { if (!msg.is_read) incrementUnread(msg.account_id); });
      },
    });
  }, [removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  const handleBulkMarkRead = useCallback(async (ids, msgs) => {
    const markAsRead = msgs.some(m => !m.is_read);
    // Compute per-account and per-category unread deltas before mutating state
    const deltaByAccount = {};
    const deltaByCategory = {};
    msgs.forEach(msg => {
      if (!deltaByAccount[msg.account_id]) deltaByAccount[msg.account_id] = 0;
      const catKey = msg.category || 'primary';
      if (!deltaByCategory[catKey]) deltaByCategory[catKey] = 0;
      if (markAsRead && !msg.is_read) { deltaByAccount[msg.account_id]++; deltaByCategory[catKey]++; }
      if (!markAsRead && msg.is_read) { deltaByAccount[msg.account_id]++; deltaByCategory[catKey]++; }
    });
    // Optimistic update
    msgs.forEach(msg => updateMessage(msg.id, { is_read: markAsRead, unread_count: markAsRead ? 0 : 1 }));
    Object.entries(deltaByAccount).forEach(([accountId, delta]) => {
      if (delta > 0) markAsRead ? decrementUnread(accountId, delta) : incrementUnread(accountId, delta);
    });
    Object.entries(deltaByCategory).forEach(([cat, delta]) => {
      if (delta > 0) adjustCategoryCount(cat, markAsRead ? -delta : delta);
    });
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    try {
      await api.bulkRead(ids, markAsRead);
    } catch (err) {
      console.error('Bulk mark read failed:', err);
      msgs.forEach(msg => updateMessage(msg.id, { is_read: msg.is_read, unread_count: msg.unread_count }));
      Object.entries(deltaByAccount).forEach(([accountId, delta]) => {
        if (delta > 0) markAsRead ? incrementUnread(accountId, delta) : decrementUnread(accountId, delta);
      });
      Object.entries(deltaByCategory).forEach(([cat, delta]) => {
        if (delta > 0) adjustCategoryCount(cat, markAsRead ? delta : -delta);
      });
    }
  }, [updateMessage, decrementUnread, incrementUnread, adjustCategoryCount]);

  const autoMarkReadTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(autoMarkReadTimerRef.current), []);

  // Keep refs to bulk handlers so the shortcut effect (registered once) is never stale
  const bulkDeleteRef    = useRef(handleBulkDelete);
  const bulkArchiveRef   = useRef(handleBulkArchive);
  const scheduleDeleteRef = useRef(scheduleDelete);
  const handleContextActionRef = useRef(null); // assigned below, once handleContextAction is defined
  useEffect(() => { bulkDeleteRef.current    = handleBulkDelete;  }, [handleBulkDelete]);
  useEffect(() => { bulkArchiveRef.current   = handleBulkArchive; }, [handleBulkArchive]);
  useEffect(() => { scheduleDeleteRef.current = scheduleDelete;   }, [scheduleDelete]);

  // Subscribe to keyboard shortcut actions that belong to the message list.
  // Registered once ([] deps); all live state is read through scRef/bulkDeleteRef/bulkArchiveRef.
  useEffect(() => {
    const getState = () => useStore.getState();

    const markRead = (msg) => {
      if (msg.is_read) return;
      const { updateMessage, decrementUnread, incrementUnread, adjustCategoryCount, markReadBehavior, markReadDelay } = getState();
      if (markReadBehavior === 'manual') return;
      clearTimeout(autoMarkReadTimerRef.current);
      autoMarkReadTimerRef.current = null;
      const doMarkRead = () => {
        updateMessage(msg.id, { is_read: true });
        decrementUnread(msg.account_id);
        adjustCategoryCount(msg.category, -1);
        setPending(msg.id, msg.account_id);
        api.bulkRead([msg.id], true)
          .then(() => {
            pendingMarkReadMap.delete(msg.id);
            completedMarkReadMap.set(msg.id, msg.account_id);
            setTimeout(() => completedMarkReadMap.delete(msg.id), 10000);
          })
          .catch(e => {
            console.error('markRead failed:', e.message);
            updateMessage(msg.id, { is_read: false });
            incrementUnread(msg.account_id);
            adjustCategoryCount(msg.category, 1);
            pendingMarkReadMap.delete(msg.id);
          });
      };
      if (markReadBehavior === 'delay') {
        autoMarkReadTimerRef.current = setTimeout(doMarkRead, (markReadDelay || 1) * 1000);
      } else {
        doMarkRead();
      }
    };

    const onNext = () => {
      const { messages, searchResults, searchQuery, selectedMessageId, setSelectedMessage } = getState();
      const pool = searchQuery.trim() ? searchResults : messages;
      if (!pool.length) return;
      const idx = pool.findIndex(m => m.id === selectedMessageId);
      const next = pool[idx + 1] ?? pool[0];
      setSelectedMessage(next.id);
      markRead(next);
    };

    const onPrev = () => {
      const { messages, searchResults, searchQuery, selectedMessageId, setSelectedMessage } = getState();
      const pool = searchQuery.trim() ? searchResults : messages;
      if (!pool.length) return;
      const idx = pool.findIndex(m => m.id === selectedMessageId);
      const prev = idx <= 0 ? pool[pool.length - 1] : pool[idx - 1];
      setSelectedMessage(prev.id);
      markRead(prev);
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
      const { messages, searchResults, searchQuery, selectedMessageId, removeMessage, decrementUnread, addNotification } = getState();
      const pool = searchQuery.trim() ? searchResults : messages;
      const ids = [...scRef.current.selectedIds];
      if (ids.length > 0) {
        const msgs = pool.filter(m => ids.includes(m.id));
        bulkArchiveRef.current(ids, msgs);
      } else if (selectedMessageId) {
        const msg = pool.find(m => m.id === selectedMessageId);
        if (!msg) return;
        advanceSelectionAfterRemoval(selectedMessageId);
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
      const { messages, searchResults, searchQuery, selectedMessageId } = getState();
      const pool = searchQuery.trim() ? searchResults : messages;
      const ids = [...scRef.current.selectedIds];
      if (ids.length > 0) {
        const msgs = pool.filter(m => ids.includes(m.id));
        bulkDeleteRef.current(ids, msgs);
      } else if (selectedMessageId) {
        const msg = pool.find(m => m.id === selectedMessageId);
        if (!msg) return;
        scheduleDeleteRef.current(msg);
      }
    };

    const onToggleRead = () => {
      const { messages, selectedMessageId, updateMessage, decrementUnread, incrementUnread, adjustCategoryCount } = getState();
      if (!selectedMessageId) return;
      const msg = messages.find(m => m.id === selectedMessageId);
      if (!msg) return;
      const newRead = !msg.is_read;
      updateMessage(selectedMessageId, { is_read: newRead });
      if (newRead) {
        decrementUnread(msg.account_id);
        adjustCategoryCount(msg.category, -1);
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
        adjustCategoryCount(msg.category, 1);
        pendingMarkReadMap.delete(selectedMessageId);
        completedMarkReadMap.delete(selectedMessageId);
        api.bulkRead([selectedMessageId], false).catch(console.error);
      }
    };

    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    // GTD classify keys (t/w/d): COPY the selected message into a state's label
    // folder, reusing the same classify dispatch as the context menu (no parallel
    // action path). Silent no-op unless the message's account has GTD enabled, so
    // the keys stay inert for non-GTD accounts.
    const gtdClassifySelected = (state) => () => {
      const { messages, searchResults, searchQuery, selectedMessageId, accounts } = getState();
      if (!selectedMessageId) return;
      const pool = searchQuery.trim() ? searchResults : messages;
      const msg = pool.find(m => m.id === selectedMessageId);
      if (!msg) return;
      if (!accounts.find(a => a.id === msg.account_id)?.gtd_enabled) return;
      handleContextActionRef.current?.('gtdClassify', msg, state);
    };
    const onGtdTodo      = gtdClassifySelected('todo');
    const onGtdWatch     = gtdClassifySelected('watch');
    const onGtdDelegated = gtdClassifySelected('delegated');

    shortcutBus.on('nextMessage',   onNext);
    shortcutBus.on('prevMessage',   onPrev);
    shortcutBus.on('openMessage',   onOpen);
    shortcutBus.on('selectMessage', onSelect);
    shortcutBus.on('archive',       onArchive);
    shortcutBus.on('delete',        onDelete);
    shortcutBus.on('toggleRead',    onToggleRead);
    shortcutBus.on('focusSearch',   onFocusSearch);
    shortcutBus.on('gtdTodo',       onGtdTodo);
    shortcutBus.on('gtdWatch',      onGtdWatch);
    shortcutBus.on('gtdDelegated',  onGtdDelegated);

    return () => {
      shortcutBus.off('nextMessage',   onNext);
      shortcutBus.off('prevMessage',   onPrev);
      shortcutBus.off('openMessage',   onOpen);
      shortcutBus.off('selectMessage', onSelect);
      shortcutBus.off('archive',       onArchive);
      shortcutBus.off('delete',        onDelete);
      shortcutBus.off('toggleRead',    onToggleRead);
      shortcutBus.off('focusSearch',   onFocusSearch);
      shortcutBus.off('gtdTodo',       onGtdTodo);
      shortcutBus.off('gtdWatch',      onGtdWatch);
      shortcutBus.off('gtdDelegated',  onGtdDelegated);
    };
  }, []);

  // Scroll the selected message row into view whenever selection changes.
  // block:'nearest' is a no-op when the row is already visible, so mouse clicks don't cause jumps.
  useEffect(() => {
    if (!selectedMessageId || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-msgid="${selectedMessageId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedMessageId]);

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
          : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
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
            const fromEmail = (message.from_email || '').toLowerCase();
            const match = aliases.find(al => {
              const aliasEmail = al.email.toLowerCase();
              return allEmails.includes(aliasEmail) || fromEmail === aliasEmail;
            });
            return match ? match.id : null;
          } catch { return null; }
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
          } catch { return []; }
        })();

        const referencesChain = [message.in_reply_to, message.message_id]
          .filter(Boolean).join(' ').trim() || null;
        const rawSubject = (message.subject || '').trim();

        const replyBody = await api.getMessageBody(message.id).catch(() => null);
        const replyDate = message.date ? new Date(message.date).toLocaleString() : '';
        const replySafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
        const replyFromStr = replySafeName
          ? `${replySafeName} <${message.from_email}>`
          : message.from_email || '';
        const quotedText = replyBody?.text
          ? `\n\n---\nOn ${replyDate}, ${replyFromStr} wrote:\n${replyBody.text.split('\n').map(l => '> ' + l).join('\n')}`
          : '';
        const quotedBodyHtml = replyBody?.html
          ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${replyDate}, ${replyFromStr} wrote:</p>${replyBody.html}</div>`
          : null;

        openCompose({
          to: sender,
          cc: replyAll ? allRecipients : [],
          subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
          body: '',
          quotedBody: quotedText,
          quotedBodyHtml,
          inReplyTo: message.message_id,
          references: referencesChain,
          accountId: message.account_id,
          aliasId: replyAliasId,
          isReply: true,
          isReplyAll: replyAll,
          originalFrom: sender,
          allRecipients,
        });
        break;
      }
      case 'forward': {
        const fwdBody = await api.getMessageBody(message.id).catch(() => null);
        const fwdDate = message.date ? new Date(message.date).toLocaleString() : '';
        const fwdSafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
        const fwdFromStr = fwdSafeName
          ? `${fwdSafeName} <${message.from_email}>`
          : message.from_email || '';
        const safeSubject = (message.subject || '').replace(/[\r\n]+/g, ' ');
        const toStr = parseAddressField(message.to_addresses);
        const ccStr = parseAddressField(message.cc_addresses);

        const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fwdFromStr}\nDate: ${fwdDate}\nSubject: ${safeSubject}${toStr ? `\nTo: ${toStr}` : ''}${ccStr ? `\nCc: ${ccStr}` : ''}\n\n${fwdBody?.text || ''}`;
        const fwdHtml = fwdBody?.html
          ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${fwdFromStr}<br>Date: ${fwdDate}<br>Subject: ${safeSubject}${toStr ? `<br>To: ${toStr}` : ''}${ccStr ? `<br>Cc: ${ccStr}` : ''}</p>${fwdBody.html}</div>`
          : null;

        openCompose({
          subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
          body: '',
          quotedBody: fwdText,
          quotedBodyHtml: fwdHtml,
          accountId: message.account_id,
          isForward: true,
          forwardedAttachments: (fwdBody?.attachments || []).map(att => ({
            messageId: message.id,
            part: att.part,
            filename: att.filename || 'attachment',
            type: att.type || 'application/octet-stream',
            size: att.size || 0,
          })),
        });
        break;
      }
      case 'bulkSelect':
        setSelectedIds(new Set([message.id]));
        break;
      case 'archive': {
        const archived = message;
        advanceSelectionAfterRemoval(archived.id);
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
            useStore.getState().restoreMessages([archived]);
            if (!archived.is_read) incrementUnread(archived.account_id);
          },
        });
        break;
      }
      case 'moveTo': {
        const folder = data;
        if (!folder) break;
        // If multiple messages are checked and the right-clicked message is among them,
        // delegate to handleBulkMove so all selected messages are moved together.
        if (selectedIds.size > 1 && selectedIds.has(message.id)) {
          const bulkMsgs = displayMessages.filter(m => selectedIds.has(m.id));
          handleBulkMove([...selectedIds], bulkMsgs, folder);
          // handleBulkMove already clears the selection internally.
          break;
        }
        const moved = message;
        let moveMessages;
        try {
          moveMessages = await resolveMessagesForThreadAction(message);
        } catch (err) {
          console.error('Failed to load thread for move:', err.message);
          addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
          break;
        }
        const moveIds = [...new Set(moveMessages.map(msg => msg.id).filter(Boolean))];
        removeMessage(moved.id);
        if (!moved.is_read) decrementUnread(moved.account_id);
        // Remove the moved message from the selection so the action bar doesn't
        // stay around claiming "X selected" for messages that are no longer here.
        if (selectedIds.has(moved.id)) {
          const next = new Set(selectedIds);
          next.delete(moved.id);
          setSelectedIds(next);
          if (next.size === 0) setSelectionModeActive(false);
        }
        let moveUndone = false;
        const moveTimer = setTimeout(async () => {
          if (moveUndone) return;
          try {
            await api.bulkMove(moveIds, folder);
            useStore.getState().recordRecentFolder({ accountId: moved.account_id, path: folder });
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
            useStore.getState().restoreMessages([moved]);
            if (!moved.is_read) incrementUnread(moved.account_id);
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
        if (selectedIds.has(snoozedMsg.id)) {
          const next = new Set(selectedIds);
          next.delete(snoozedMsg.id);
          setSelectedIds(next);
          if (next.size === 0) setSelectionModeActive(false);
        }
        addNotification({ title: t('message.snoozed.title'), body: snoozedMsg.subject || t('common.noSubject') });
        api.snoozeMessage(snoozedMsg.id, untilIso).catch(err => {
          console.error('Snooze failed:', err.message);
          useStore.getState().restoreMessages([snoozedMsg]);
          if (!snoozedMsg.is_read) incrementUnread(snoozedMsg.account_id);
          addNotification({ title: t('message.snoozed.failTitle'), body: t('message.snoozed.failBody') });
        });
        break;
      }
      case 'gtdClassify': {
        // Classify = COPY into the state's label folder. The message stays put
        // (no optimistic removal / undo — it does not leave INBOX), so we just
        // fire the copy and poke the GTD sections store instead of waiting on the WS event.
        await classifyThread(message.id, data, {
          gtdClassify: api.gtdClassify,
          addNotification,
          scheduleGtdSectionsFetch: useStore.getState().scheduleGtdSectionsFetch,
          t,
        });
        break;
      }
      case 'gtdRemove': {
        await unclassifyThread(message.id, data, {
          gtdUnclassify: api.gtdUnclassify,
          addNotification,
          scheduleGtdSectionsFetch: useStore.getState().scheduleGtdSectionsFetch,
          t,
        });
        break;
      }
      case 'createRuleFromMessage': {
        const store = useStore.getState();
        store.setRulesPreFill({ fromEmail: message.from_email, fromName: message.from_name });
        store.setAdminTab('rules');
        store.setShowAdmin(true);
        break;
      }
      case 'addToBlockList': {
        const email = message.from_email;
        if (!email) break;
        api.addToBlockList(email).then(() => {
          addNotification({ title: t('blockList.blocked'), body: email });
        }).catch(() => {
          addNotification({ title: t('blockList.errorAdd'), body: email });
        });
        break;
      }
      case 'delete':
        if (selectedIds.size > 1 && selectedIds.has(message.id)) {
          const bulkMsgs = displayMessages.filter(m => selectedIds.has(m.id));
          handleBulkDelete([...selectedIds], bulkMsgs);
        } else {
          scheduleDelete(message);
        }
        break;
      case 'markSpam': {
        // Bulk when more than one message is selected and the right-clicked
        // message is among them; otherwise just the single message.
        const targets = (selectedIds.size > 1 && selectedIds.has(message.id))
          ? displayMessages.filter(m => selectedIds.has(m.id))
          : [message];
        performSpamLabel(targets, 'spam');
        // The action bar should not claim "X selected" for messages that have
        // just been queued for move-to-Junk. Clear the selection (handleBulk*
        // already does this; performSpamLabel doesn't, because it's shared
        // with the single-message toolbar path which never had a selection).
        if (selectedIds.has(message.id)) clearSelection();
        break;
      }
      case 'markHam': {
        const targets = (selectedIds.size > 1 && selectedIds.has(message.id))
          ? displayMessages.filter(m => selectedIds.has(m.id))
          : [message];
        performSpamLabel(targets, 'ham');
        if (selectedIds.has(message.id)) clearSelection();
        break;
      }
      case 'setCategory': {
        const newCategory = data || 'primary';
        const dbCategory = newCategory === 'primary' ? null : newCategory;
        try {
          await api.setMessageCategory(message.id, newCategory);
          const inFilteredView = categorizationActive && activeCategory && activeCategory !== (newCategory || 'primary');
          if (inFilteredView) {
            removeMessage(message.id);
          } else {
            updateMessage(message.id, { category: dbCategory });
          }
          // Refresh category counts badge
          const countParams = selectedAccountId ? { accountId: selectedAccountId } : {};
          api.getCategoryCounts(countParams).then(d => setCategoryCounts(d.counts || {})).catch(() => {});
        } catch (err) {
          console.error('setCategory failed:', err?.message);
        }
        break;
      }
      default:
        break;
    }
  };
  // Expose the latest handleContextAction to the once-registered shortcut effect via
  // a post-commit effect (the sibling handler refs' pattern), rather than mutating the
  // ref during render. No dep array: handleContextAction isn't memoized, so it syncs
  // on every commit.
  useEffect(() => { handleContextActionRef.current = handleContextAction; });

  const handleThreadMarkRead = (e, message) => {
    e.stopPropagation();
    const uc = parseInt(message.unread_count);
    const hasUnreadInThread = Number.isFinite(uc) && uc > 0;
    handleContextAction(hasUnreadInThread ? 'markRead' : 'markUnread', message);
  };

  const isDraftsFolder = (() => {
    if (!selectedAccountId) return false;
    const account = accounts.find(a => a.id === selectedAccountId);
    if (!account) return false;
    if (account.folder_mappings?.drafts && account.folder_mappings.drafts === selectedFolder) return true;
    const folderList = folders[selectedAccountId] || [];
    const folderInfo = folderList.find(f => f.path === selectedFolder);
    return folderInfo?.special_use === '\\Drafts';
  })();

  const formatAddressArray = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(a => {
      if (typeof a === 'string') return a;
      const addr = a.address || a.email || '';
      return (a.name && addr) ? `${a.name} <${addr}>` : (addr || a.name || '');
    }).filter(Boolean);
  };

  const handleSelect = async (message) => {
    if (isDraftsFolder) {
      try {
        const bodyData = await api.getMessageBody(message.id);
        openCompose({
          accountId: message.account_id,
          draftUid: message.uid,
          draftFolder: message.folder,
          to: formatAddressArray(message.to_addresses),
          cc: formatAddressArray(message.cc_addresses),
          subject: message.subject || '',
          body: bodyData.html || bodyData.text || '',
          bodyIsHtml: !!bodyData.html,
        });
      } catch (err) {
        console.error('Failed to open draft:', err.message);
        setSelectedMessage(message.id);
      }
      return;
    }
    recentMessageOpenUntilRef.current = Date.now() + 1500;
    api.getMessageBody(message.id).catch(() => {});
    setSelectedMessage(message.id);
    listRef.current?.focus({ preventScroll: true });
    clearTimeout(autoMarkReadTimerRef.current);
    autoMarkReadTimerRef.current = null;
    if (!message.is_read && markReadBehavior !== 'manual') {
      const prevUnread = message.unread_count;
      const doMarkRead = () => {
        updateMessage(message.id, { is_read: true, unread_count: 0 });
        decrementUnread(message.account_id);
        adjustCategoryCount(message.category, -1);
        setPending(message.id, message.account_id);
        api.bulkRead([message.id], true)
          .catch(() => api.bulkRead([message.id], true))
          .then(() => {
            pendingMarkReadMap.delete(message.id);
            completedMarkReadMap.set(message.id, message.account_id);
            setTimeout(() => completedMarkReadMap.delete(message.id), 10000);
          })
          .catch(e => {
            console.error('markRead failed:', e.message);
            updateMessage(message.id, { is_read: false, unread_count: prevUnread });
            incrementUnread(message.account_id);
            adjustCategoryCount(message.category, 1);
            pendingMarkReadMap.delete(message.id);
          });
      };
      if (markReadBehavior === 'delay') {
        autoMarkReadTimerRef.current = setTimeout(doMarkRead, markReadDelay * 1000);
      } else {
        doMarkRead();
      }
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

  const accountColor = selectedAccount?.color || 'currentColor';
  const showInboxIcon = !isUnified && selectedFolder === 'INBOX' && !searchQuery.trim();

  const label = searchQuery.trim()
    ? `Search: "${searchQuery}"`
    : isUnified ? t('sidebar.allInboxes') : selectedFolder;

  // Non-INBOX folders omitted: byAccount is account-total, not folder-specific, so it would mislead.
  const headerUnread = isUnified
    ? unreadCounts.total
    : (selectedFolder === 'INBOX' ? (unreadCounts.byAccount[selectedAccountId] ?? 0) : 0);

  // Derived bulk-selection values (computed fresh each render, no stale closure risk)
  const selectionMode = selectedIds.size > 0 || selectionModeActive;
  const selectedMsgs = displayMessages.filter(m => selectedIds.has(m.id));
  const selectedCount = selectedIds.size;
  const allSelected = displayMessages.length > 0 && selectedIds.size === displayMessages.length;
  const selectedAccountIds = [...new Set(selectedMsgs.map(m => m.account_id))];
  const canMove = selectedAccountIds.length === 1;
  const bulkMarkAsRead = selectedMsgs.some(m => !m.is_read);

  return (
    <div style={{
      width: isMobile ? '100%' : (isColumn ? '100%' : 'var(--list-width)'),
      minWidth: isMobile ? undefined : (isColumn ? undefined : 180),
      flex: isMobile ? 1 : (isColumn ? '0 0 42%' : undefined),
      minHeight: isColumn && !isMobile ? 0 : undefined,
      borderRight: (isMobile || isColumn) ? 'none' : '1px solid var(--border-subtle)',
      borderBottom: (!isMobile && isColumn) ? '1px solid var(--border-subtle)' : 'none',
      display: 'flex', flexDirection: 'column',
      height: (isMobile || isColumn) ? undefined : '100%',
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

          {/* Folder / account title + unread count */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
            <h2 style={{
              margin: 0, fontSize: 16, fontWeight: 600,
              color: 'var(--text-primary)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              minWidth: 0, display: 'flex', alignItems: 'center',
            }}>
              {isUnified && !searchQuery.trim() ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                  <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
                </svg>
              ) : showInboxIcon ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accountColor} strokeWidth="2">
                  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                  <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
                </svg>
              ) : label}
            </h2>
            {headerUnread > 0 && !searchQuery.trim() && (
              <span style={{
                flexShrink: 0,
                fontSize: 11, fontWeight: 600, color: 'var(--accent-text)',
                background: 'var(--accent)', padding: '1px 7px',
                borderRadius: 10, minWidth: 20, textAlign: 'center',
              }}>
                {headerUnread > 999 ? '999+' : headerUnread}
              </span>
            )}
          </div>

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

          {/* Contacts */}
          <button
            onClick={() => setShowContacts(!showContacts)}
            aria-label={t('contacts.title')}
            style={{
              background: showContacts ? 'var(--bg-hover)' : 'none', border: 'none',
              color: showContacts ? 'var(--accent)' : 'var(--text-tertiary)',
              cursor: 'pointer', padding: 0, borderRadius: 7, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              minWidth: 44, minHeight: 44,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87"/>
              <path d="M16 3.13a4 4 0 010 7.75"/>
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
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: isNarrow ? 6 : 10 }}>
          <h2 style={{
            margin: 0, fontSize: 15, fontWeight: 600,
            color: 'var(--text-primary)',
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center',
          }}>
            {isUnified && !searchQuery ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
              </svg>
            ) : showInboxIcon ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={accountColor} strokeWidth="2">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
                <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
              </svg>
            ) : label}
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
            {/* Select / cancel selection */}
            <button
              onClick={() => selectionMode ? clearSelection() : setSelectionModeActive(true)}
              title={selectionMode ? t('common.cancel') : t('messageList.selectMessages')}
              style={{
                background: selectionMode ? 'var(--accent-dim)' : 'none',
                border: `1px solid ${selectionMode ? 'var(--accent)' : 'transparent'}`,
                borderRadius: 6, padding: '4px 6px',
                color: selectionMode ? 'var(--accent)' : 'var(--text-tertiary)',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                transition: 'color 0.15s, border-color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { if (!selectionMode) { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--border)'; }}}
              onMouseLeave={e => { if (!selectionMode) { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <polyline points="9 11 12 14 22 4"/>
              </svg>
            </button>
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
                { op: 'in:all',           desc: t('messageList.searchHelp.inAll') },
                { op: '-from:amazon',     desc: t('messageList.searchHelp.negate') },
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

      {/* Category + GTD tabs — shown in INBOX when categorization and/or GTD is active */}
      {(categorizationActive || gtdActive) && selectedFolder === 'INBOX' && !searchQuery.trim() && (
        <div style={{ position: 'relative', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)' }}>
          {!isMobile && catScrollEdges.left && (
            <button
              onClick={() => { catScrollRef.current?.scrollBy({ left: -120, behavior: 'smooth' }); }}
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 32, zIndex: 1,
                background: 'linear-gradient(to right, var(--bg-secondary) 55%, transparent)',
                border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center',
                paddingLeft: 6, color: 'var(--text-tertiary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          )}
          <div
            ref={catScrollRef}
            onScroll={updateCatScrollEdges}
            style={{
              display: 'flex', gap: 6, padding: '7px 10px',
              overflowX: 'auto', scrollbarWidth: 'none',
              background: 'var(--bg-secondary)',
            }}
          >
            {categorizationActive && ['primary', 'newsletter', 'promotion', 'automated', 'social'].map(cat => {
              const unread = categoryCounts[cat] || 0;
              const isActive = activeCategory === cat && !activeGtdTab;
              return (
                <button
                  key={cat}
                  onClick={() => { setActiveGtdTab(null); setActiveCategory(cat); }}
                  style={{
                    padding: '3px 11px', flexShrink: 0,
                    borderRadius: 100,
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                    background: 'none',
                    color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer', fontSize: 11, fontWeight: isActive ? 500 : 400,
                    whiteSpace: 'nowrap',
                    transition: 'color 0.15s, border-color 0.15s',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {t(`messageList.categories.${cat}`)}
                  {unread > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, lineHeight: 1,
                      padding: '1px 5px', borderRadius: 100,
                      background: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
                      color: 'var(--bg-primary)',
                      minWidth: 16, textAlign: 'center',
                    }}>
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              );
            })}
            {/* GTD pills — Inbox | Todo | Waiting | Reference | Someday. Inbox is the
                whole-inbox default (activeGtdTab === null, no GTD tab selected); the
                rest switch the list to that state's section (from the shared sections
                store, not ?category=). Waiting merges watch+delegated. This order
                matches GTD_DISPLAY_SECTION_ORDER (todo → waiting → reference → someday) after
                the leading Inbox pill; the two arrays stay independent (do not fold
                into one constant). */}
            {gtdActive && (
              <button
                key="gtd-inbox"
                onClick={() => setActiveGtdTab(null)}
                style={{
                  padding: '3px 11px', flexShrink: 0, borderRadius: 100,
                  border: `1px solid ${activeGtdTab === null ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'none',
                  color: activeGtdTab === null ? 'var(--accent)' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: 11, fontWeight: activeGtdTab === null ? 600 : 400,
                  whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {t('gtd.inbox')}
                {headerUnread > 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 600, lineHeight: 1,
                    padding: '1px 5px', borderRadius: 100,
                    background: activeGtdTab === null ? 'var(--accent)' : 'var(--text-tertiary)',
                    color: 'var(--bg-primary)',
                    minWidth: 16, textAlign: 'center',
                  }}>
                    {headerUnread > 99 ? '99+' : headerUnread}
                  </span>
                )}
              </button>
            )}
            {gtdActive && [
              { key: 'todo', label: t('gtd.state.todo') },
              { key: 'waiting', label: t('gtd.waiting') },
              { key: 'reference', label: t('gtd.state.reference') },
              { key: 'someday', label: t('gtd.state.someday') },
            ].map(({ key, label }) => {
              const isActive = activeGtdTab === key;
              const color = GTD_COLORS[key === 'waiting' ? 'watch' : key];
              const chipBg = GTD_CHIP_BG[key === 'waiting' ? 'watch' : key];
              const badge = sectionBadge(gtdTabUnread[key]);
              return (
                <button
                  key={`gtd-${key}`}
                  onClick={() => setActiveGtdTab(isActive ? null : key)}
                  style={{
                    padding: '3px 11px', flexShrink: 0, borderRadius: 100,
                    border: `1px solid ${isActive ? color : 'var(--border)'}`,
                    background: isActive ? chipBg : 'none',
                    color: isActive ? color : 'var(--text-secondary)',
                    cursor: 'pointer', fontSize: 11, fontWeight: isActive ? 600 : 400,
                    whiteSpace: 'nowrap', transition: 'color 0.15s, border-color 0.15s',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {label}
                  {badge && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, lineHeight: 1,
                      padding: '1px 5px', borderRadius: 100,
                      background: isActive ? color : 'var(--text-tertiary)',
                      color: 'var(--bg-primary)', minWidth: 16, textAlign: 'center',
                    }}>
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {!isMobile && catScrollEdges.right && (
            <button
              onClick={() => { catScrollRef.current?.scrollBy({ left: 120, behavior: 'smooth' }); }}
              style={{
                position: 'absolute', right: 0, top: 0, bottom: 0, width: 32, zIndex: 1,
                background: 'linear-gradient(to left, var(--bg-secondary) 55%, transparent)',
                border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'flex-end', paddingRight: 6, color: 'var(--text-tertiary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          )}
        </div>
      )}

      {/* Message list */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          ref={listRef}
          onScroll={handleScroll}
          onKeyDown={handleListKeyDown}
          tabIndex={0}
          style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', outline: 'none', overscrollBehavior: 'contain' }}
        >
          {showGtdTab ? <GtdTabList /> : (<>
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
        {/* ── Folder search results ─────────────────────────── */}
        {folderSearchResults.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{
              padding: '8px 14px 4px',
              fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
              color: 'var(--text-tertiary)', textTransform: 'uppercase',
            }}>
              {t('messageList.foldersHeading')}
            </div>
            {folderSearchResults.map(folder => {
              const isFav = favoriteFolders.some(f => f.accountId === folder.accountId && f.path === folder.path);
              return (
                <div
                  key={`${folder.accountId}/${folder.path}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 14px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                  onClick={() => {
                    setSelectedAccount(folder.accountId, folder.path);
                    setSearchQuery('');
                    setMobileSidebarOpen(false);
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.75" style={{ flexShrink: 0 }}>
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {folder.name || folder.path}
                    </div>
                    {folder.accountName && (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {folder.accountName}
                      </div>
                    )}
                  </div>
                  <button
                    title={isFav ? t('sidebar.folderMenu.unfavorite') : t('sidebar.folderMenu.favorite')}
                    onClick={e => {
                      e.stopPropagation();
                      if (isFav) {
                        removeFavoriteFolder(folder.accountId, folder.path);
                      } else {
                        addFavoriteFolder({ accountId: folder.accountId, path: folder.path, name: folder.name || folder.path });
                      }
                    }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                      padding: '2px 4px', color: isFav ? 'var(--amber)' : 'var(--text-tertiary)',
                      display: 'flex', alignItems: 'center',
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill={isFav ? 'var(--amber)' : 'none'} stroke="currentColor" strokeWidth="1.75">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  </button>
                </div>
              );
            })}
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
            onCompose={() => openCompose({ accountId: selectedAccountId || undefined })}
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

            {/* Mark read / unread button */}
            <BulkBtn
              title={bulkMarkAsRead ? t('messageList.markReadSelected') : t('messageList.markUnreadSelected')}
              onClick={() => handleBulkMarkRead([...selectedIds], selectedMsgs)}
            >
              {bulkMarkAsRead ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/>
                  <polyline points="22 9 12 16 2 9"/>
                  <polyline points="2 9 12 2 22 9"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/>
                  <polyline strokeLinecap="round" points="16.36 9.95 12 13 2 6"/>
                  <circle cx="19.96" cy="6" r="3" fill="var(--accent)" stroke="var(--accent)"/>
                </svg>
              )}
            </BulkBtn>

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

              {showFolderPicker && !isMobile && (<>
                <div onClick={() => setShowFolderPicker(false)} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 99 }} />
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  boxShadow: 'var(--shadow-popover)',
                  minWidth: 200, maxWidth: 320,
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
                      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                        <input
                          autoFocus
                          value={pickerSearch}
                          onChange={e => setPickerSearch(e.target.value)}
                          placeholder={t('contextMenu.folders.search')}
                          style={{
                            width: '100%', boxSizing: 'border-box',
                            padding: '5px 8px', fontSize: 12,
                            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                            borderRadius: 5, color: 'var(--text-primary)',
                            outline: 'none',
                          }}
                        />
                      </div>
                      <div style={{ maxHeight: 285, overflowY: 'auto' }}>
                      {(() => {
                        const q = pickerSearch.trim().toLowerCase();
                        const displayed = pickerFolders
                          .filter(f => f.path !== selectedFolder && (!q || f.name.toLowerCase().includes(q)));
                        return displayed.length === 0 ? (
                          <div style={{ padding: '12px 12px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                            {t('contextMenu.folders.empty')}
                          </div>
                        ) : (
                          <>
                            {!q && (
                              <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                {t('messageList.moveToFolder')}
                              </div>
                            )}
                            {displayed.map(f => (
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
                            ))}
                          </>
                        );
                      })()}
                      </div>
                    </>
                  )}
                </div>
              </>)}
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
                    <div style={{ padding: '0 20px 12px' }}>
                      <input
                        value={pickerSearch}
                        onChange={e => setPickerSearch(e.target.value)}
                        placeholder={t('contextMenu.folders.search')}
                        style={{
                          width: '100%', boxSizing: 'border-box',
                          padding: '8px 12px', fontSize: 14,
                          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                          borderRadius: 8, color: 'var(--text-primary)',
                          outline: 'none',
                        }}
                      />
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
                      ) : (() => {
                        const q = pickerSearch.trim().toLowerCase();
                        const displayed = pickerFolders
                          .filter(f => f.path !== selectedFolder && (!q || f.name.toLowerCase().includes(q)));
                        return displayed.length === 0 ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                            {t('contextMenu.folders.empty')}
                          </div>
                        ) : displayed.map(f => (
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
                        ));
                      })()}
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
                selectedMid={selectedMid}
                lastViewedMessageId={lastViewedMessageId}
                showAccount={false} /* No per-account dot on unified rows: it added noise beside the unread indicator; the account is visible in the message pane header. */
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
                onMove={handleRowMove}
                onGtdDone={gtdActiveForContext(accounts, message.account_id) ? handleGtdDone : undefined}
                isMobile={isMobile}
                swipeLeftAction={swipeLeftAction}
                swipeRightAction={swipeRightAction}
                onSwipeLeft={selectionMode || swipeLeftAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeLeftAction, msg)}
                onSwipeRight={selectionMode || swipeRightAction === 'disabled' ? undefined : (msg) => runSwipeAction(swipeRightAction, msg)}
                isChecked={selectedIds.has(message.id)}
                selectionMode={selectionMode}
                onToggleSelect={handleRowToggleSelect}
                onRangeSelect={handleRangeSelect}
                onLongPress={isMobile ? (id) => { setSelectionModeActive(true); toggleSelect(id); } : undefined}
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
                selected={isSelectedRow(message, selectedMessageId, selectedMid)}
                lastViewed={lastViewedMessageId === message.id && selectedMessageId !== message.id}
                isChecked={selectedIds.has(message.id)}
                selectionMode={selectionMode}
                showAccount={false} /* No per-account dot on unified rows: it added noise beside the unread indicator; the account is visible in the message pane header. */
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
                onMove={handleRowMove}
                onGtdDone={gtdActiveForContext(accounts, message.account_id) ? handleGtdDone : undefined}
                onDragStart={handleRowDragStart}
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
            defaultMoveView={contextMenu.defaultMoveView}
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
        </>)}
        </div>

        {/* Scroll-to-top button — desktop only (mobile handled in FAB container below) */}
        {!isMobile && showScrollTop && (
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

      {/* Mobile FAB cluster — compose always present, scroll-to-top stacks above it */}
      {isMobile && (
        <div style={{
          position: 'fixed',
          bottom: 'calc(var(--sab) + 20px)',
          right: 20,
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          pointerEvents: 'none',
        }}>
          {showScrollTop && (
            <button
              onClick={() => { if (listRef.current) listRef.current.scrollTo({ top: 0, behavior: 'smooth' }); }}
              title={t('messageList.backToTop')}
              style={{
                pointerEvents: 'auto',
                width: 44, height: 44, borderRadius: '50%',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: 'var(--shadow-soft)',
                animation: 'fade-in 0.15s ease',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
          )}
          <button
            onClick={() => openCompose({ accountId: selectedAccountId || undefined })}
            aria-label={t('messageList.composeAriaLabel')}
            style={{
              pointerEvents: fabVisible ? 'auto' : 'none',
              width: 44, height: 44, borderRadius: '50%',
              background: 'var(--accent)', border: 'none',
              boxShadow: 'var(--shadow-popover)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--accent-text)',
              opacity: fabVisible ? 1 : 0,
              transform: fabVisible ? 'scale(1)' : 'scale(0.8)',
              transition: 'opacity 0.2s ease, transform 0.2s ease',
            }}
            onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.92)'; }}
            onMouseUp={e => { e.currentTarget.style.transform = fabVisible ? 'scale(1)' : 'scale(0.8)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = fabVisible ? 'scale(1)' : 'scale(0.8)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        </div>
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
        aria-label={t('common.dismiss')}
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
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>{t('messageList.emptyInbox')}</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>{t('messageList.emptyInboxDesc')}</div>
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
        <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 6 }}>{t('messageList.noAccounts')}</div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('messageList.noAccountsDesc')}</div>
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
          background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>{t('sidebar.compose')}</button>
      )}
    </div>
  );
}

function ThreadRow({ message, isExpanded, threadMsgs, isLoadingThread, selectedMessageId, selectedMid, lastViewedMessageId, showAccount, isNarrow, onThreadClick, onSelect, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, onMove, onGtdDone, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight, isChecked, selectionMode, onToggleSelect, onRangeSelect, onLongPress }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const messageCount = message.message_count || 1;
  const unreadCount  = parseInt(message.unread_count) || 0;

  const { contentRef, swipeBgLeftRef, swipeBgRightRef, tappedRef } = useSwipeRow({
    isMobile, message, onSwipeLeft, onSwipeRight, onLongPress,
    onTap: isMobile && !selectionMode ? onThreadClick : undefined,
  });

  const hasAvatar = !isNarrow && !isMobile;
  const avatarAsCheckbox = hasAvatar && selectionMode;
  // Identity-matched selection (parity with the flat MessageRow's isSelectedRow): a GTD sidebar
  // deep-link opens a different DB copy of the same mail, so match the head or any cached
  // sub-message on message_id, not just the raw id, or the inbox thread row won't light up.
  const selectedHere = isSelectedRow(message, selectedMessageId, selectedMid)
    || !!threadMsgs?.some(m => isSelectedRow(m, selectedMessageId, selectedMid));
  const isLastViewed = selectedHere
    || lastViewedMessageId === message.id
    || (lastViewedMessageId && threadMsgs?.some(m => m.id === lastViewedMessageId));
  const bgDefault = isMobile ? 'var(--bg-primary)' : 'transparent';
  const rowBg = isChecked
    ? 'var(--accent-dim)'
    : (isExpanded ? 'var(--bg-secondary)' : (hovered ? 'var(--bg-tertiary)' : (isLastViewed ? 'var(--accent-glow)' : bgDefault)));
  const leftActionView = getSwipeActionView(swipeRightAction, message, t, unreadCount);
  const rightActionView = getSwipeActionView(swipeLeftAction, message, t, unreadCount);

  return (
    <div data-msgid={message.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Swipe container wraps only the header row */}
      <div style={{ position: 'relative', overflow: 'hidden' }}>

      {isMobile && <SwipeBackground side="left" actionView={leftActionView} innerRef={swipeBgLeftRef} />}
      {isMobile && <SwipeBackground side="right" actionView={rightActionView} innerRef={swipeBgRightRef} />}

      {/* Thread header row */}
      <div
        ref={isMobile ? contentRef : undefined}
        onMouseEnter={() => !isMobile && setHovered(true)}
        onMouseLeave={() => !isMobile && setHovered(false)}
        onClick={selectionMode ? (e) => {
          if (e.shiftKey && onRangeSelect) { onRangeSelect(message.id); }
          else { onToggleSelect(message.id); }
        } : () => { if (tappedRef.current) { tappedRef.current = false; return; } onThreadClick(); }}
        onContextMenu={!isMobile ? (e => onContextMenu(e, message)) : undefined}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '11px 14px', cursor: 'pointer',
          background: rowBg, transition: 'background 0.1s',
          position: 'relative',
          willChange: isMobile ? 'transform' : undefined,
        }}
      >
        {/* Left indicator: checkbox in selection mode (narrow/mobile), unread dot otherwise */}
        {!hasAvatar ? (
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
            unreadCount > 0 && (
              <div className="unread-dot" style={{
                position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
                width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
              }} />
            )
          )
        ) : (
          !selectionMode && unreadCount > 0 && (
            <div className="unread-dot" style={{
              position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
              width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)',
            }} />
          )
        )}

        {/* Avatar — morphs into a checkbox when in selection mode */}
        {!isNarrow && !isMobile && (
          <div
            onClick={selectionMode ? e => { e.stopPropagation(); onToggleSelect(message.id); } : undefined}
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              position: 'relative', overflow: 'hidden',
              background: avatarAsCheckbox
                ? (isChecked ? 'var(--accent)' : 'var(--bg-tertiary)')
                : senderColor(message.from_email || message.from_name),
              border: avatarAsCheckbox && !isChecked ? '2px solid var(--border)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 600,
              color: avatarAsCheckbox ? (isChecked ? 'white' : 'var(--text-tertiary)') : 'white',
              marginTop: 1,
              cursor: selectionMode ? 'pointer' : 'default',
              transition: 'background 0.12s, border 0.12s',
              userSelect: 'none',
              boxSizing: 'border-box',
            }}
          >
            {avatarAsCheckbox ? (
              isChecked ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="3" style={{ stroke: 'var(--accent-text)' }}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )
            ) : (
              <>
                {(message.from_name || message.from_email || '?')[0].toUpperCase()}
                {message.has_contact_photo && message.from_email && (
                  <img
                    src={`/api/contacts/photo?email=${encodeURIComponent(message.from_email)}`}
                    alt=""
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
              </>
            )}
          </div>
        )}

        <div style={{ paddingLeft: (!hasAvatar && selectionMode) ? 22 : 0, flex: 1, minWidth: 0 }}>
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
          <RowHoverActions
            message={message}
            isRead={unreadCount === 0}
            background={rowBg}
            deleteTitleKey="message.delete"
            onMarkRead={onMarkRead}
            onStar={onStar}
            onDelete={onDelete}
            onMove={onMove}
            onGtdDone={onGtdDone}
          />
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
              onClick={e => { e.stopPropagation(); if (!selectionMode) onSelect(msg); }}
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

function MessageRow({ message, selected, lastViewed, isChecked, selectionMode, showAccount, isNarrow, onSelect, onToggleSelect, onRangeSelect, onAvatarClick, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, onMove, onGtdDone, onDragStart, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight, onLongPress }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [avatarHovered, setAvatarHovered] = useState(false);
  const { contentRef, swipeBgLeftRef, swipeBgRightRef, tappedRef } = useSwipeRow({
    isMobile, message, onSwipeLeft, onSwipeRight, onLongPress,
    onTap: isMobile && !selectionMode ? () => onSelect(message) : undefined,
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
      // onTap already fired this from touchend — skip the redundant synthesized click.
      if (tappedRef.current) { tappedRef.current = false; return; }
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
      data-msgid={message.id}
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
        draggable={!isMobile}
        onDragStart={!isMobile ? (e) => onDragStart(e, message) : undefined}
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
            <div className="unread-dot" style={{
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

      <div style={{ paddingLeft: (!hasInteractiveAvatar && selectionMode) ? 22 : 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {/* Sender avatar — wide layouts only. Morphs into a checkbox on hover or in selection mode. */}
        {!isNarrow && !isMobile && (
          <div
            onClick={handleAvatarAreaClick}
            onMouseEnter={() => setAvatarHovered(true)}
            onMouseLeave={() => setAvatarHovered(false)}
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              position: 'relative', overflow: 'hidden',
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="3" style={{ stroke: 'var(--accent-text)' }}>
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )
            ) : (
              <>
                {(message.from_name || message.from_email || '?')[0].toUpperCase()}
                {message.has_contact_photo && message.from_email && (
                  <img
                    src={`/api/contacts/photo?email=${encodeURIComponent(message.from_email)}`}
                    alt=""
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
              </>
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
        <RowHoverActions
          message={message}
          isRead={message.is_read}
          background="var(--bg-tertiary)"
          deleteTitleKey="common.delete"
          onMarkRead={onMarkRead}
          onStar={onStar}
          onDelete={onDelete}
          onMove={onMove}
          onGtdDone={onGtdDone}
        />
      )}
      </div>
    </div>
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
