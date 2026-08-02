import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, selectSelectedMessageMid } from '../store/index.js';
import { api } from '../utils/api.js';
import { LAYOUTS } from '../layouts.js';
import { senderColor } from '../themes.js';
import { useMobile } from '../hooks/useMobile.js';
import { isAccountInUnifiedInbox } from '../utils/unifiedInbox.js';
import { useSwipeRow } from '../hooks/useSwipeRow.js';
import ContextMenu from './ContextMenu.jsx';
import RowHoverActions from './RowHoverActions.jsx';
import GtdTabList from './GtdTabList.jsx';
import { useUiScale, descale } from '../hooks/useUiScale.js';
import {
  gtdActiveForContext, buildGtdDisplaySections, GTD_COLORS, GTD_CHIP_BG, sectionBadge, isSelectedRow,
  unclassifyThread,
} from '../utils/gtd.js';
import { formatDate } from '../utils/formatDate.js';
import SenderAvatarImage from './SenderAvatarImage.jsx';
import {
  openDraftFromMessage,
} from '../utils/composeFromMessage.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { createLatestRequest } from '../utils/latestRequest.js';
import { pendingMarkReadMap, completedMarkReadMap } from '../utils/pendingReads.js';
import { applyDeleteGuard } from '../utils/pendingDeletes.js';
import { stableConversationId } from '../commands/contracts.js';
import { contextMenuTargetMessages } from '../commands/contextMenuCommands.js';
import DelegatePill from './DelegatePill.jsx';
import { useCommandRuntimeContext } from '../commands/CommandRuntimeContext.jsx';
import { semanticSearchAvailable, semanticToggleState, searchInputRightPad, isCurrentSearchGeneration, LEXICAL_MODE, SEMANTIC_MODE } from '../utils/searchMode.js';
import { handleComposeRequest } from '../utils/composeRequest.js';

// Sparkle-toggle tone → resting/hover glyph colour + background chip. Kept next
// to the presentation (searchMode.js stays framework-free); the tone strings
// come from semanticToggleState(). The chip is what sets ON (faint purple) and
// the amber fallback apart from the greyed OFF state beyond glyph colour alone,
// and the hover variants give the icon a clickable affordance.
const SEMANTIC_TONE = {
  off:      { color: 'var(--text-secondary)', hoverColor: 'var(--text-primary)', chip: 'transparent',              hoverChip: 'var(--bg-hover)' },
  on:       { color: 'var(--accent)',         hoverColor: 'var(--accent)',       chip: 'var(--accent-glow)',       hoverChip: 'rgba(124, 106, 247, 0.28)' },
  fallback: { color: 'var(--amber)',          hoverColor: 'var(--amber)',        chip: 'rgba(251, 191, 36, 0.15)', hoverChip: 'rgba(251, 191, 36, 0.28)' },
};

// Folder icon for move picker
function FolderIcon({ specialUse, size = 13 }) {
  const s = (specialUse || '').toLowerCase();
  if (s.includes('sent'))   return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
  if (s.includes('trash'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
  if (s.includes('draft'))  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>;
  if (s.includes('spam') || s.includes('junk')) return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
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

const SWIPE_COMMANDS = Object.freeze({
  archive: 'mail.archive',
  delete: 'mail.trash',
  star: 'mail.toggleStar',
  markRead: 'mail.toggleRead',
  reply: 'mail.reply',
  replyAll: 'mail.replyAll',
});

const THREAD_EXPANDING_COMMANDS = new Set([
  'mail.archive', 'mail.snooze', 'mail.move', 'mail.read', 'mail.unread', 'mail.toggleRead',
  'mail.star', 'mail.unstar', 'mail.toggleStar', 'mail.trash', 'mail.spam', 'mail.notSpam',
  'gtd.delegate',
]);

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
  const { controller: commandController } = useCommandRuntimeContext();
  const uiScale = useUiScale();
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
    hoverQuickActions, showMobileAvatars,
    swipeActions,
    folders, favoriteFolders, addFavoriteFolder, removeFavoriteFolder, setSelectedAccount,
    categorizationEnabled, categoryCounts, setCategoryCounts,
    markReadBehavior, markReadDelay,
    searchAllFolders,
    searchMode, setSearchMode,
    activeGtdTab, setActiveGtdTab, gtdSections,
  } = useStore();
  // RFC message_id of the open message, so a row highlights when it is a different DB copy
  // of the selected message (multi-folder model) — e.g. the inbox copy of a GTD sidebar click.
  const selectedMid = useStore(selectSelectedMessageMid);
  const selectedIds = useStore(state => state.selectedMessageIds);
  const setSelectedIds = useStore(state => state.setSelectedMessageIds);
  const requestCompose = useCallback(request => handleComposeRequest(request, {
    addNotification,
    t,
  }), [addNotification, t]);

  const isMobile = useMobile();
  const isUnified = selectedAccountId === null;
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const unifiedInboxAccountKey = accounts
    .filter(isAccountInUnifiedInbox)
    .map(account => account.id)
    .join(',');
  // Search is scoped to the current folder unless we're in the unified view or the
  // user toggled "search all folders". An in: operator in the query overrides this
  // server-side. undefined = search all folders.
  const searchFolder = (!isUnified && !searchAllFolders) ? selectedFolder : undefined;
  const searchPageSize = Math.max(1, Math.min(Number(pageSize) || 50, 200));
  const undoableNotifications = notifications.filter(n => n.onUndo && !n.countdownUntil);

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
  const [semanticAvailable, setSemanticAvailable] = useState(false);
  const [searchFellBack, setSearchFellBack] = useState(false);
  // The active mode is searchMode only when the vector-availability probe says
  // semantic search is usable; otherwise force lexical regardless of the
  // persisted preference (e.g. this Postgres has no pgvector schema).
  const effectiveMode = semanticAvailable ? searchMode : LEXICAL_MODE;

  // Right-side control cluster that lives INSIDE the search input, shared by the
  // desktop and mobile search boxes. Holds the semantic-search toggle (sparkle
  // icon, gated on vector availability) and the clear-query button, in that
  // order. The toggle is greyed when off, purple when on, and amber when the
  // backend silently fell back to lexical — the fallback hint rides the icon's
  // colour + tooltip so no extra row appears below the input.
  const renderSearchControls = () => {
    const on = searchMode !== LEXICAL_MODE;
    const toggle = semanticToggleState({ on, fellBack: searchFellBack, hasQuery: Boolean(searchQuery.trim()) });
    const toggleLabel = t(toggle.titleKey);
    const tone = SEMANTIC_TONE[toggle.tone];
    // Shared icon-button shape so the sparkle and clear × read as one cluster
    // and their hover chips are the same size.
    const iconBtn = {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 4, borderRadius: 6, border: 'none', cursor: 'pointer',
      WebkitTapHighlightColor: 'transparent',
      transition: 'background 0.15s, color 0.15s',
    };
    return (
      <div style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', alignItems: 'center', gap: 2,
      }}>
        {semanticAvailable && (
          <button
            type="button"
            aria-pressed={on}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => { setSearchFellBack(false); setSearchMode(on ? LEXICAL_MODE : SEMANTIC_MODE); }}
            onMouseEnter={e => { e.currentTarget.style.background = tone.hoverChip; e.currentTarget.style.color = tone.hoverColor; }}
            onMouseLeave={e => { e.currentTarget.style.background = tone.chip; e.currentTarget.style.color = tone.color; }}
            style={{ ...iconBtn, background: tone.chip, color: tone.color }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              {/* Two-star "sparkles" AI glyph: a large 4-point star with a smaller
                  offset one, so it reads as ✨ rather than a "+" at small sizes. */}
              <path d="M10 6 L12 10.5 L16.5 12.5 L12 14.5 L10 19 L8 14.5 L3.5 12.5 L8 10.5 Z" />
              <path d="M18 3.3 L19 5.5 L21.2 6.5 L19 7.5 L18 9.7 L17 7.5 L14.8 6.5 L17 5.5 Z" />
            </svg>
          </button>
        )}
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            aria-label={t('messageList.clearSearch')}
            title={t('messageList.clearSearch')}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            style={{ ...iconBtn, background: 'transparent', color: 'var(--text-tertiary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>
    );
  };
  const listRef = useRef(null);
  const searchInputRef = useRef(null); // for focusSearch shortcut
  const recentMessageOpenUntilRef = useRef(0);
  const deferredRefreshTimerRef = useRef(null);

  // Bulk selection state
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
  useEffect(() => { setActiveCategory('primary'); }, [selectedAccountId, selectedFolder]);
  useEffect(() => {
    const markOpening = () => {
      recentMessageOpenUntilRef.current = Date.now() + 1500;
    };
    window.addEventListener('mailflow:message-opening', markOpening);
    return () => window.removeEventListener('mailflow:message-opening', markOpening);
  }, []);

  // Probe vector availability once on mount — gates whether the semantic
  // toggle renders at all (Task 10).
  useEffect(() => {
    let alive = true;
    api.ai.status()
      .then(s => { if (alive) setSemanticAvailable(semanticSearchAvailable(s)); })
      .catch(() => { if (alive) setSemanticAvailable(false); });
    return () => { alive = false; };
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
  }, [categorizationActive, selectedAccountId, selectedFolder, messagesRefreshToken, unifiedInboxAccountKey, setCategoryCounts]);

  const searchSeq = useRef(0);
  const refreshRequestRef = useRef(null);
  if (refreshRequestRef.current === null) refreshRequestRef.current = createLatestRequest();
  // Bumped to force the search effect to re-run (e.g. after rules move messages) so an
  // active search snapshot drops messages that no longer match. See #223.
  const [searchReloadToken, setSearchReloadToken] = useState(0);

  // Ref that always holds the latest values needed by shortcut handlers.
  // Updated synchronously on every render so handlers are never stale.
  const scRef = useRef({});
  scRef.current = { selectedIds, setSelectedIds };

  // Clear selection whenever the message list resets (nav, folder change, etc.)
  useEffect(() => {
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    lastSelectIdxRef.current = -1;
  }, [messagesRefreshToken, setSelectedIds]);

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
  }, [setSelectedIds]);

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
        await refreshRequestRef.current.run(
          () => api.getMessages(params),
          (data) => {
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
          },
        );
      } catch (err) {
        console.error('Failed to load messages:', err);
        setFolderSyncing(false);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [selectedAccountId, selectedFolder, unreadOnly, activeCategory, pageSize, scrollMode, accountsReady, unifiedInboxAccountKey, messagesRefreshToken, threadedView, categorizationEnabled, selectedAccount?.categorization_enabled, applyReadGuard, setHasMoreMessages, setLoadingMessages, setMessages, setMessagesOffset, setMessagesTotal]);

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
        await refreshRequestRef.current.run(
          () => api.getMessages(params),
          (data) => {
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
          },
        );
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
    // Bump the request generation on EVERY context change (query, mode, folder,
    // account, page size — the dep set below — and clearing the query). Async
    // appends (load-more, post-delete prefetch) capture this before their await
    // and discard themselves if it moves on, so a stale page can't append onto a
    // fresh, different-context list.
    const seq = ++searchSeq.current;
    if (!searchQuery.trim()) {
      setIsSearching(false);
      setSearchResults([]);
      setSearchHasMore(false);
      setSearchFellBack(false);
      searchFetchedOffsetRef.current = 0;
      return;
    }
    setIsSearching(true);
    setSearchHasMore(false);
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await api.search(searchQuery, selectedAccountId || undefined, { offset: 0, limit: searchPageSize, folder: searchFolder, mode: effectiveMode });
        if (searchSeq.current !== seq) return;
        searchFetchedOffsetRef.current = data.messages.length;
        setSearchResults(applyReadGuard(data.messages));
        setSearchHasMore(data.messages.length === searchPageSize);
        setSearchFellBack(Boolean(data.fellBack));
      } catch (err) {
        if (searchSeq.current === seq) console.error('Search failed:', err);
      } finally {
        if (searchSeq.current === seq) setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, selectedAccountId, searchFolder, searchPageSize, searchReloadToken, unifiedInboxAccountKey, effectiveMode, applyReadGuard, setIsSearching, setSearchResults]);

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
    const seq = searchSeq.current; // request generation at dispatch time
    setSearchLoadingMore(true);
    try {
      const offset = searchFetchedOffsetRef.current;
      const data = await api.search(qSnapshot, selectedAccountId || undefined, { offset, limit: searchPageSize, folder: searchFolder, mode: effectiveMode });
      // Discard if ANY search context (query, mode, folder, account) changed
      // while we were fetching — otherwise a stale page appends onto a fresh list.
      if (!isCurrentSearchGeneration(seq, searchSeq.current)) return;
      searchFetchedOffsetRef.current = offset + data.messages.length;
      const current = useStore.getState().searchResults;
      useStore.setState({ searchResults: [...current, ...applyReadGuard(data.messages)] });
      setSearchHasMore(data.messages.length === searchPageSize);
    } catch (err) {
      console.error('Search load more failed:', err);
    } finally {
      setSearchLoadingMore(false);
    }
  }, [searchQuery, selectedAccountId, searchFolder, searchPageSize, searchLoadingMore, effectiveMode, applyReadGuard]);

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
      await refreshRequestRef.current.run(
        () => api.getMessages(params),
        (data) => {
          setMessagesTotal(data.total);
          setMessages(applyReadGuard(data.messages));
          setMessagesOffset((pageNum - 1) * pageSize + data.messages.length);
          setHasMoreMessages(false);
          setExpandedThreadId(null);
          if (listRef.current) listRef.current.scrollTop = 0;
        },
      );
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
    const data = await api.getThread(tid, effectiveFolder, isUnified);
    const resolved = data.messages?.length ? data.messages : [message];
    if (resolved.length > 1) setThreadMessages(tid, resolved);
    return resolved;
  }, [isThreadListRow, threadMessages, selectedAccountId, selectedFolder, isUnified, setThreadMessages]);

  const executeForMessages = useCallback(async (commandId, source, targetMessages, input) => {
    let actionableMessages = targetMessages;
    if (THREAD_EXPANDING_COMMANDS.has(commandId)) {
      try {
        actionableMessages = (await Promise.all(
          targetMessages.map(message => resolveMessagesForThreadAction(message)),
        )).flat();
      } catch (error) {
        addNotification({
          type: 'error',
          title: t('commandPalette.outcome.failedTitle'),
          body: error instanceof Error ? error.message : String(error),
        });
        return { status: 'failed', error };
      }
    }
    const frozenTargetIds = [...new Set(actionableMessages.map(stableConversationId).filter(Boolean))];
    return commandController.execute(commandId, {
      source,
      input,
      frozenTargetIds,
    });
  }, [addNotification, commandController, resolveMessagesForThreadAction, t]);

  const handleMarkRead = (e, message) => {
    e.stopPropagation();
    executeForMessages('mail.toggleRead', 'hover', [message]);
  };

  const handleStar = (e, message) => {
    e.stopPropagation();
    executeForMessages('mail.toggleStar', 'hover', [message]);
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

  const handleDelete = (e, message) => {
    e.stopPropagation();
    executeForMessages('mail.trash', 'hover', [message]);
  };

  const runSwipeAction = useCallback((action, message) => {
    const commandId = SWIPE_COMMANDS[action];
    if (commandId) executeForMessages(commandId, 'swipe', [message]);
  }, [executeForMessages]);

  // ── Bulk selection helpers ───────────────────────────────────
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [setSelectedIds]);

  const selectAll = useCallback((msgs) => {
    setSelectedIds(new Set(msgs.map(m => m.id)));
  }, [setSelectedIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    lastSelectIdxRef.current = -1;
  }, [setSelectedIds]);

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
  // Arrow-key navigation: intercepts ArrowDown/ArrowUp when the list container has focus.
  const handleListKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      commandController.execute('navigation.nextConversation', { source: 'list-keydown' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      commandController.execute('navigation.previousConversation', { source: 'list-keydown' });
    }
  }, [commandController]);

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
  }, [displayMessages, setSelectedIds]);

  // Called for normal (non-shift) row checkbox toggles — tracks anchor for range select
  const handleRowToggleSelect = useCallback((id) => {
    const idx = displayMessages.findIndex(m => m.id === id);
    lastSelectIdxRef.current = idx;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [displayMessages, setSelectedIds]);

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
  }, [displayMessages, setSelectedIds]);

  const handleBulkDelete = useCallback((_ids, msgs) => {
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    return executeForMessages('mail.trash', 'bulk-toolbar', msgs);
  }, [executeForMessages]);

  const handleBulkMove = useCallback((_ids, msgs, folder) => {
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    return executeForMessages('mail.move', 'bulk-toolbar', msgs, { folder });
  }, [executeForMessages]);

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

  const handleBulkArchive = useCallback((_ids, msgs) => {
    setSelectionModeActive(false);
    setShowFolderPicker(false);
    return executeForMessages('mail.archive', 'bulk-toolbar', msgs);
  }, [executeForMessages]);

  const handleBulkMarkRead = useCallback((_ids, msgs) => {
    setSelectionModeActive(false);
    return executeForMessages('mail.toggleRead', 'bulk-toolbar', msgs);
  }, [executeForMessages]);

  const autoMarkReadTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(autoMarkReadTimerRef.current), []);

  // Subscribe to keyboard shortcut actions that belong to the message list.
  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    shortcutBus.on('focusSearch',   onFocusSearch);

    return () => {
      shortcutBus.off('focusSearch',   onFocusSearch);
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

  const handleContextUtility = async (action, message, data) => {
    switch (action) {
      case 'open':
        handleSelect(message);
        break;
      case 'bulkSelect':
        setSelectedIds(new Set([message.id]));
        break;
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
  const handleThreadMarkRead = (e, message) => {
    e.stopPropagation();
    const uc = parseInt(message.unread_count);
    const hasUnreadInThread = Number.isFinite(uc) && uc > 0;
    executeForMessages(hasUnreadInThread ? 'mail.read' : 'mail.unread', 'hover', [message]);
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

  const handleSelect = async (message) => {
    if (isDraftsFolder) {
      try {
        const opened = await requestCompose(() => openDraftFromMessage(message, {
          openCompose,
          getMessageBody: api.getMessageBody,
        }));
        if (opened === null) setSelectedMessage(message.id);
      } catch (err) {
        console.error('Failed to load draft:', err.message);
        addNotification({ type: 'error', title: t('common.error', { message: err.message }) });
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
      const doMarkRead = () => executeForMessages('mail.read', 'auto-read', [message]);
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
        const data = await api.getThread(tid, effectiveFolder, isUnified);
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
    // No quotes around the query: when the header truncates with a CSS ellipsis
    // the closing quote would be lost, stranding an unbalanced opening one.
    ? `Search: ${searchQuery}`
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
              ) : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>}
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
            ) : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>}
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
                    position: 'fixed', top: descale(layoutPickerPos.top, uiScale), right: descale(layoutPickerPos.right, uiScale),
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
                  position: 'fixed', top: descale(layoutPickerPos.top, uiScale), right: descale(layoutPickerPos.right, uiScale),
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
              width: '100%', padding: `8px ${searchInputRightPad(semanticAvailable)}px 8px 32px`,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
              outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--accent)'; setSearchFocused(true); }}
            onBlur={e => { e.target.style.borderColor = 'var(--border)'; setSearchFocused(false); }}
          />
          {renderSearchControls()}

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
                width: '100%', padding: `8px ${searchInputRightPad(semanticAvailable)}px 8px 32px`,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
                outline: 'none', boxSizing: 'border-box',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
            {renderSearchControls()}
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
            onCompose={() => { void requestCompose(() => openCompose({ accountId: selectedAccountId || undefined })); }}
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
                showMobileAvatars={showMobileAvatars}
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
                showMobileAvatars={showMobileAvatars}
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
            targetIds={(selectedIds.size > 1 && selectedIds.has(contextMenu.message.id)
              ? displayMessages.filter(candidate => selectedIds.has(candidate.id))
              : [contextMenu.message]
            ).map(stableConversationId).filter(Boolean)}
            defaultMoveView={contextMenu.defaultMoveView}
            onCommand={(commandId, input) => {
              const selectedMessages = displayMessages.filter(candidate => selectedIds.has(candidate.id));
              const targetMessages = contextMenuTargetMessages(
                commandId,
                contextMenu.message,
                selectedMessages,
              );
              return executeForMessages(commandId, 'context-menu', targetMessages, input);
            }}
            onClose={() => setContextMenu(null)}
            onAction={(action, data) => handleContextUtility(action, contextMenu.message, data)}
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
            onClick={() => { void requestCompose(() => openCompose({ accountId: selectedAccountId || undefined })); }}
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

function ThreadRow({ message, isExpanded, threadMsgs, isLoadingThread, selectedMessageId, selectedMid, lastViewedMessageId, showAccount, isNarrow, onThreadClick, showMobileAvatars, onSelect, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, onMove, onGtdDone, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight, isChecked, selectionMode, onToggleSelect, onRangeSelect, onLongPress }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const messageCount = message.message_count || 1;
  const unreadCount  = parseInt(message.unread_count) || 0;

  const { contentRef, swipeBgLeftRef, swipeBgRightRef, tappedRef } = useSwipeRow({
    isMobile, message, onSwipeLeft, onSwipeRight, onLongPress,
    onTap: isMobile && !selectionMode ? onThreadClick : undefined,
  });

  const hasAvatar = !isNarrow && !isMobile;
  // Avatars render on desktop always, and on mobile when the user opts in (#213). Selection/
  // checkbox behaviour stays tied to hasAvatar (desktop only) — showAvatar only controls display,
  // so the mobile row keeps its own unread-dot/checkbox layout and the avatar is non-interactive.
  const showAvatar = hasAvatar || (isMobile && showMobileAvatars && !selectionMode);
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

        {/* Avatar — morphs into a checkbox when in selection mode (desktop); display-only on mobile */}
        {showAvatar && (
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
                <SenderAvatarImage
                  email={message.from_email}
                  hasContactPhoto={message.has_contact_photo}
                />
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
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
          }}>
            <DelegatePill delegation={message.delegation} compact />
            <span style={{
              minWidth: 0, flex: 1, fontSize: 12, color: 'var(--text-tertiary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {message.snippet || ''}
            </span>
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

function MessageRow({ message, selected, lastViewed, isChecked, selectionMode, showAccount, isNarrow, onSelect, onToggleSelect, onRangeSelect, onAvatarClick, showMobileAvatars, onMarkRead, onStar, onDelete, hoverQuickActions, onContextMenu, onMove, onGtdDone, onDragStart, isMobile, swipeLeftAction, swipeRightAction, onSwipeLeft, onSwipeRight, onLongPress }) {
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
  // Display the avatar on desktop, and on mobile when opted in (#213). Interactivity
  // (click-to-select, hover-to-checkbox) stays tied to hasInteractiveAvatar — desktop only —
  // so on mobile the avatar is a plain, non-interactive sender avatar and the row keeps its
  // own unread-dot / checkbox layout.
  const showAvatar = (!isNarrow && !isMobile) || (isMobile && showMobileAvatars && !selectionMode);
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
        {/* Sender avatar — desktop always, or opted-in on mobile (#213). Interactive (click-to-select,
            hover-to-checkbox) on desktop only; a plain display avatar on mobile. */}
        {showAvatar && (
          <div
            onClick={hasInteractiveAvatar ? handleAvatarAreaClick : undefined}
            onMouseEnter={hasInteractiveAvatar ? () => setAvatarHovered(true) : undefined}
            onMouseLeave={hasInteractiveAvatar ? () => setAvatarHovered(false) : undefined}
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
              cursor: hasInteractiveAvatar ? 'pointer' : 'default',
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
                <SenderAvatarImage
                  email={message.from_email}
                  hasContactPhoto={message.has_contact_photo}
                />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <DelegatePill delegation={message.delegation} compact />
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
