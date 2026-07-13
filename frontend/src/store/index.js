import { create } from 'zustand';
import { api } from '../utils/api.js';
import { applyTheme, applyCustomCss, getInitialTheme } from '../themes.js';
import { applyFontSet, applyFontSize } from '../fonts.js';
import { applyLayout, normalizeLayout } from '../layouts.js';
import { DEFAULT_AI_ACTIONS } from '../aiActions.js';
import { removeGtdThreadFromSections, setGtdThreadReadInSections } from '../utils/gtd.js';
import { clampRightSidebarWidth } from '../utils/rightSidebar.js';
import i18n from '../i18n.js';

// Accumulate rapid preference changes and flush at most once per second.
let _prefFlushTimer = null;
let _pendingPrefs = {};
function schedulePrefSave(prefs) {
  Object.assign(_pendingPrefs, prefs);
  clearTimeout(_prefFlushTimer);
  _prefFlushTimer = setTimeout(() => {
    const toSave = _pendingPrefs;
    _pendingPrefs = {};
    api.savePreferences(toSave).catch(() => {});
  }, 1000);
}

// GTD sections fetch coordination. A monotonic seq guards against stale
// responses landing after a newer context switch; the timer debounces the
// WS-driven refetch (gtd_sections_updated can fire several times per tick).
let _gtdSectionsSeq = 0;
let _gtdFetchTimer = null;

function readGtdCollapsedSections() {
  try {
    const raw = JSON.parse(localStorage.getItem('mailflow_gtd_collapsed_sections') || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* fall through to default */ }
  // Someday is collapsed by default — lowest-priority section, out of the way
  // until the user wants it.
  return { someday: true };
}

export const useStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => set({ user }),
  updateUser: (updates) => set(state => ({ user: state.user ? { ...state.user, ...updates } : state.user })),

  // Todoist integration status (persisted across page loads via localStorage)
  todoistConnected: localStorage.getItem('mailflow_todoist_connected') === '1',
  setTodoistConnected: (connected) => {
    if (connected) localStorage.setItem('mailflow_todoist_connected', '1');
    else localStorage.removeItem('mailflow_todoist_connected');
    set({ todoistConnected: connected });
  },

  // Lock screen
  isLocked: localStorage.getItem('mailflow_locked') === '1',
  setLocked: (locked) => {
    if (locked) {
      const { selectedMessageId } = get();
      if (selectedMessageId) localStorage.setItem('mailflow_locked_message', selectedMessageId);
      localStorage.setItem('mailflow_locked', '1');
      set({
        isLocked: true,
        messages: [], searchResults: [], searchQuery: '',
        accounts: [], accountsReady: false,
        folders: {}, selectedMessageId: null,
        unreadCounts: { total: 0, byAccount: {} },
        notifications: [], threadMessages: {}, expandedThreadId: null,
        backfillProgress: {},
      });
    } else {
      const restoredMessageId = localStorage.getItem('mailflow_locked_message') || null;
      localStorage.removeItem('mailflow_locked_message');
      localStorage.removeItem('mailflow_locked');
      set({ isLocked: false, selectedMessageId: restoredMessageId });
    }
  },

  // Accounts
  accounts: [],
  accountsReady: false, // true once the initial getAccounts() call has resolved
  setAccounts: (accounts) => set({ accounts, accountsReady: true }),
  updateAccount: (id, updates) => set(state => ({
    accounts: state.accounts.map(a => a.id === id ? { ...a, ...updates } : a)
  })),

  // Navigation
  selectedAccountId: localStorage.getItem('mailflow_selected_account') || null, // '' stored as null
  selectedFolder: localStorage.getItem('mailflow_selected_folder') || 'INBOX',
  messagesRefreshToken: 0, // incremented on every nav click so the effect always re-fires
  setSelectedAccount: (accountId, folder = 'INBOX') => {
    localStorage.setItem('mailflow_selected_account', accountId ?? '');
    localStorage.setItem('mailflow_selected_folder', folder);
    return set(state => {
      // #221: auto-close a folder-scoped search when navigating to a different
      // folder/account. A scoped search (a specific account with "Search all folders"
      // off) targets the current folder, so its results are stale once you leave it;
      // an all-folders search spans everything and is left intact. Clearing only
      // searchQuery lets the search effect tear down the rest of the search state,
      // exactly like the in-box clear (X) button does.
      const navChanged = state.selectedAccountId !== accountId || state.selectedFolder !== folder;
      const wasScopedSearch = !!state.selectedAccountId && !state.searchAllFolders && !!state.searchQuery.trim();
      return {
        selectedAccountId: accountId,
        selectedFolder: folder,
        selectedMessageId: null,
        messages: [],
        messagesOffset: 0,
        hasMoreMessages: true,
        messagesRefreshToken: state.messagesRefreshToken + 1,
        expandedThreadId: null,
        threadMessages: {},
        showContacts: false,
        ...(navChanged && wasScopedSearch ? { searchQuery: '' } : {}),
      };
    });
  },


  // Messages
  messages: [],
  setMessages: (messages) => set({ messages }),
  appendMessages: (newMessages) => set(state => {
    // Deduplicate by id: if the same message already exists in state, keep the
    // existing copy (which may carry optimistic local-only fields the network
    // refresh just lost, like unread_count). Without this, bulk operations
    // (Mark as Spam, moveTo, scheduleDelete...) followed by Undo + a network
    // refresh can briefly produce visible "clones" of the same message.
    const existing = new Set(state.messages.map(m => m.id));
    const additions = newMessages.filter(m => m && !existing.has(m.id));
    if (additions.length === 0) return {};
    return { messages: [...state.messages, ...additions] };
  }),
  updateMessage: (id, updates) => set(state => {
    const apply = (m) => m.id === id ? { ...m, ...updates } : m;
    const threadMessages = Object.fromEntries(
      Object.entries(state.threadMessages).map(([tid, msgs]) => [tid, msgs.map(apply)])
    );
    // Resync the parent thread row's aggregate read state only when a sub-message was
    // updated. Sub-messages live exclusively in threadMessages, not in the main list.
    // Resyncing on direct thread-row updates would read stale sub-messages and revert
    // keyboard mark-read and setMessagesReadState changes.
    const inMainList = state.messages.some(m => m.id === id);
    const messages = state.messages.map(m => {
      const updated = apply(m);
      if (inMainList) return updated;
      const tid = m.thread_id || m.id;
      const subs = threadMessages[tid];
      if (!subs) return updated;
      const unread_count = subs.filter(s => !s.is_read).length;
      return { ...updated, unread_count, is_read: unread_count === 0 };
    });
    return { messages, searchResults: state.searchResults.map(apply), threadMessages };
  }),
  removeMessage: (id) => set(state => ({
    messages: state.messages.filter(m => m.id !== id),
    searchResults: state.searchResults.filter(m => m.id !== id),
    selectedMessageId: state.selectedMessageId === id ? null : state.selectedMessageId,
  })),
  restoreMessages: (msgs) => set(state => {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    const sort = arr => [...arr].sort((a, b) => new Date(b.date) - new Date(a.date));
    // Deduplicate against both the main list and searchResults: if the message
    // is already present (e.g. user clicked Undo after the messages had already
    // been restored by a network refresh), skip it. The local copy carries the
    // freshest optimistic state, so we prefer it over the server view.
    const inMessages = new Set(state.messages.map(m => m.id));
    const missing = list.filter(m => m && !inMessages.has(m.id));
    if (missing.length === 0 && !state.searchQuery.trim()) return {};
    const inSearch = new Set(state.searchResults.map(m => m.id));
    const missingFromSearch = list.filter(m => m && !inSearch.has(m.id));
    return {
      messages: missing.length ? sort([...state.messages, ...missing]) : state.messages,
      searchResults: state.searchQuery.trim() && missingFromSearch.length
        ? sort([...state.searchResults, ...missingFromSearch])
        : state.searchResults,
    };
  }),
  messagesOffset: 0,
  setMessagesOffset: (offset) => set({ messagesOffset: offset }),
  messagesTotal: 0,
  setMessagesTotal: (total) => set({ messagesTotal: total }),
  hasMoreMessages: true,
  setHasMoreMessages: (v) => set({ hasMoreMessages: v }),

  // Selected message
  selectedMessageId: null,
  lastViewedMessageId: null,
  setSelectedMessage: (id) => set(id ? { selectedMessageId: id, lastViewedMessageId: id } : { selectedMessageId: null }),

  // Unread counts
  unreadCounts: { total: 0, byAccount: {} },
  setUnreadCounts: (counts) => set({ unreadCounts: counts }),
  decrementUnread: (accountId, count = 1) => set(state => {
    const byAccount = { ...state.unreadCounts.byAccount };
    byAccount[accountId] = Math.max(0, (byAccount[accountId] || 0) - count);
    const total = Math.max(0, state.unreadCounts.total - count);
    return { unreadCounts: { total, byAccount } };
  }),
  incrementUnread: (accountId, count = 1) => set(state => {
    const byAccount = { ...state.unreadCounts.byAccount };
    byAccount[accountId] = (byAccount[accountId] || 0) + count;
    return { unreadCounts: { total: state.unreadCounts.total + count, byAccount } };
  }),

  // Folders
  folders: {}, // accountId -> folders[]
  setFolders: (accountId, folders) => set(state => ({
    folders: { ...state.folders, [accountId]: folders }
  })),
  // Increment/decrement the unread_count of a single folder in one account's
  // list. Used for optimistic UI updates when marking messages as read/spam/ham
  // so the sidebar badge updates without waiting for a full folder sync.
  // We clamp at 0 to avoid negative counters when the optimistic guess was off.
  adjustFolderUnread: (accountId, folderPath, delta) => set(state => {
    const accountFolders = state.folders[accountId];
    if (!accountFolders) return {};
    let changed = false;
    const next = accountFolders.map(f => {
      if (f.path === folderPath && Number.isFinite(f.unread_count)) {
        const updated = Math.max(0, f.unread_count + delta);
        if (updated !== f.unread_count) { changed = true; return { ...f, unread_count: updated }; }
      }
      return f;
    });
    if (!changed) return {};
    return { folders: { ...state.folders, [accountId]: next } };
  }),

  // UI state
  sidebarCollapsed: localStorage.getItem('mailflow_sidebar_collapsed') === 'true',
  toggleSidebar: () => set(state => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('mailflow_sidebar_collapsed', String(next));
    return { sidebarCollapsed: next };
  }),
  sidebarWidth: (() => {
    const n = parseInt(localStorage.getItem('mailflow_sidebar_width'));
    return (n >= 160 && n <= 400) ? n : 240;
  })(),
  setSidebarWidth: (w) => {
    localStorage.setItem('mailflow_sidebar_width', String(w));
    set({ sidebarWidth: w });
    schedulePrefSave({ sidebarWidth: String(w) });
  },
  isSidebarResizing: false,
  setIsSidebarResizing: (v) => set({ isSidebarResizing: v }),
  pageSize: parseInt(localStorage.getItem('mailflow_page_size')) || 50,
  setPageSize: (size) => {
    localStorage.setItem('mailflow_page_size', String(size));
    set({ pageSize: size });
    schedulePrefSave({ pageSize: String(size) });
  },
  scrollMode: localStorage.getItem('mailflow_scroll_mode') || 'infinite',
  setScrollMode: (mode) => {
    localStorage.setItem('mailflow_scroll_mode', mode);
    set({ scrollMode: mode });
    schedulePrefSave({ scrollMode: mode });
  },
  // When true, search spans all folders instead of the current one (per device).
  searchAllFolders: localStorage.getItem('mailflow_search_all_folders') === '1',
  setSearchAllFolders: (v) => {
    if (v) localStorage.setItem('mailflow_search_all_folders', '1');
    else localStorage.removeItem('mailflow_search_all_folders');
    set({ searchAllFolders: v });
  },
  swipeActions: (() => {
    try {
      return JSON.parse(localStorage.getItem('mailflow_swipe_actions') || 'null') || { left: 'archive', right: 'markRead' };
    } catch {
      return { left: 'archive', right: 'markRead' };
    }
  })(),
  setSwipeAction: (direction, action) => set(state => {
    const next = { ...state.swipeActions, [direction]: action };
    localStorage.setItem('mailflow_swipe_actions', JSON.stringify(next));
    schedulePrefSave({ swipeActions: next });
    return { swipeActions: next };
  }),
  syncInterval: parseInt(localStorage.getItem('mailflow_sync_interval')) || 60,
  setSyncInterval: (seconds) => {
    localStorage.setItem('mailflow_sync_interval', String(seconds));
    set({ syncInterval: seconds });
    schedulePrefSave({ syncInterval: String(seconds) });
  },
  notificationSound: localStorage.getItem('mailflow_notification_sound') || 'tritone',
  setNotificationSound: (sound) => {
    localStorage.setItem('mailflow_notification_sound', sound);
    set({ notificationSound: sound });
    schedulePrefSave({ notificationSound: sound });
  },
  customSoundDataUrl: localStorage.getItem('mailflow_custom_sound') || null,
  setCustomSoundDataUrl: (dataUrl) => {
    if (dataUrl) {
      localStorage.setItem('mailflow_custom_sound', dataUrl);
    } else {
      localStorage.removeItem('mailflow_custom_sound');
    }
    set({ customSoundDataUrl: dataUrl });
  },
  composing: false,
  composeData: null,
  openCompose: (data = null) => set({ composing: true, composeData: data }),
  closeCompose: () => set({ composing: false, composeData: null }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  isSearching: false,
  setIsSearching: (v) => set({ isSearching: v }),
  searchResults: [],
  setSearchResults: (r) => set({ searchResults: r }),

  // Loading
  loadingMessages: false,
  setLoadingMessages: (v) => set({ loadingMessages: v }),

  // Notifications
  notifications: [],
  addNotification: (n) => set(state => ({
    notifications: [{ ...n, id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }, ...state.notifications].slice(0, 5)
  })),
  removeNotification: (id) => set(state => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  // Admin panel
  showAdmin: false,
  adminTab: 'accounts', // 'accounts' | 'appearance' | 'integrations' | 'users'
  setShowAdmin: (v) => set({ showAdmin: v }),
  setAdminTab: (t) => set({ adminTab: t }),

  // Contacts view
  showContacts: false,
  setShowContacts: (v) => set({ showContacts: v }),
  rulesPreFill: null, // { fromEmail, fromName, subject } — transient, set by context menu
  setRulesPreFill: (v) => set({ rulesPreFill: v }),

  backfillProgress: {}, // { [accountId]: { synced: N, total: N } | null } — transient
  setBackfillProgress: (accountId, progress) => set(state => ({
    backfillProgress: { ...state.backfillProgress, [accountId]: progress },
  })),

  // Mobile navigation
  mobileSidebarOpen: false,
  setMobileSidebarOpen: (v) => set({ mobileSidebarOpen: v }),

  // Language
  language: localStorage.getItem('mailflow_language') || 'en',
  setLanguage: (lng) => {
    localStorage.setItem('mailflow_language', lng);
    set({ language: lng });
    i18n.changeLanguage(lng);
    schedulePrefSave({ language: lng });
  },

  // Threaded view
  threadedView: localStorage.getItem('mailflow_threaded_view') === 'true',
  setThreadedView: (val) => {
    localStorage.setItem('mailflow_threaded_view', String(val));
    set({ threadedView: val, expandedThreadId: null, threadMessages: {} });
    schedulePrefSave({ threadedView: val });
  },

  // Compose format
  plaintextEmail: localStorage.getItem('mailflow_plaintext_email') === 'true',
  setPlaintextEmail: (val) => {
    localStorage.setItem('mailflow_plaintext_email', String(val));
    set({ plaintextEmail: val });
    schedulePrefSave({ plaintextEmail: val });
  },

  // Message list quick actions
  hoverQuickActions: localStorage.getItem('mailflow_hover_quick_actions') !== 'false',
  setHoverQuickActions: (val) => {
    localStorage.setItem('mailflow_hover_quick_actions', String(val));
    set({ hoverQuickActions: val });
    schedulePrefSave({ hoverQuickActions: val });
  },

  replyDefault: localStorage.getItem('mailflow_reply_default') || 'reply',
  setReplyDefault: (val) => {
    localStorage.setItem('mailflow_reply_default', val);
    set({ replyDefault: val });
    schedulePrefSave({ replyDefault: val });
  },

  markReadBehavior: localStorage.getItem('mailflow_mark_read_behavior') || 'immediate',
  setMarkReadBehavior: (val) => {
    localStorage.setItem('mailflow_mark_read_behavior', val);
    set({ markReadBehavior: val });
    schedulePrefSave({ markReadBehavior: val });
  },
  markReadDelay: parseInt(localStorage.getItem('mailflow_mark_read_delay') || '1') || 1,
  setMarkReadDelay: (val) => {
    const n = Math.max(1, Math.min(10, parseInt(val) || 1));
    localStorage.setItem('mailflow_mark_read_delay', String(n));
    set({ markReadDelay: n });
    schedulePrefSave({ markReadDelay: n });
  },

  // Thread expansion cache (not persisted — reset on navigation)
  expandedThreadId: null,
  setExpandedThreadId: (id) => set({ expandedThreadId: id }),
  threadMessages: {},
  setThreadMessages: (threadId, msgs) => set(state => ({
    threadMessages: { ...state.threadMessages, [threadId]: msgs },
  })),
  loadingThread: null,
  setLoadingThread: (id) => set({ loadingThread: id }),

  // Theme
  theme: localStorage.getItem('mailflow_theme') || getInitialTheme(),
  setTheme: (theme) => {
    localStorage.setItem('mailflow_theme', theme);
    set({ theme });
    applyTheme(theme); // keep CSS vars + favicon in sync
    schedulePrefSave({ theme });
  },

  // Font
  fontSet: localStorage.getItem('mailflow_font') || 'default',
  setFontSet: (fontSet) => {
    localStorage.setItem('mailflow_font', fontSet);
    set({ fontSet });
    applyFontSet(fontSet);
    schedulePrefSave({ font: fontSet });
  },

  fontSize: parseInt(localStorage.getItem('mailflow_font_size')) || 100,
  setFontSize: (pct) => {
    localStorage.setItem('mailflow_font_size', String(pct));
    set({ fontSize: pct });
    applyFontSize(pct);
    schedulePrefSave({ fontSize: String(pct) });
  },

  showAppBadge: localStorage.getItem('mailflow_app_badge') !== 'false',
  setShowAppBadge: (val) => {
    localStorage.setItem('mailflow_app_badge', String(val));
    set({ showAppBadge: val });
    schedulePrefSave({ showAppBadge: val });
  },

  showFaviconBadge: localStorage.getItem('mailflow_favicon_badge') !== 'false',
  setShowFaviconBadge: (val) => {
    localStorage.setItem('mailflow_favicon_badge', String(val));
    set({ showFaviconBadge: val });
    schedulePrefSave({ showFaviconBadge: val });
  },

  categorizationEnabled: false,
  setCategorizationEnabled: (val) => {
    set({ categorizationEnabled: val });
    schedulePrefSave({ categorizationEnabled: val });
  },

  // Unread counts per category for the tab bar badges { primary: N, newsletter: N, ... }
  categoryCounts: {},
  setCategoryCounts: (counts) => set({ categoryCounts: counts }),
  adjustCategoryCount: (category, delta) => set(state => {
    const key = category || 'primary';
    const current = state.categoryCounts[key] || 0;
    return { categoryCounts: { ...state.categoryCounts, [key]: Math.max(0, current + delta) } };
  }),

  // ── Right-sidebar layout ────────────────────────────────────────────────────
  // Independent column width (own var + handle, not --list-width).
  rightSidebarWidth: clampRightSidebarWidth(localStorage.getItem('mailflow_right_sidebar_width')),
  setRightSidebarWidth: (w) => {
    const clamped = clampRightSidebarWidth(w);
    localStorage.setItem('mailflow_right_sidebar_width', String(clamped));
    set({ rightSidebarWidth: clamped });
    schedulePrefSave({ rightSidebarWidth: clamped });
  },
  isRightSidebarResizing: false,
  setIsRightSidebarResizing: (v) => set({ isRightSidebarResizing: v }),

  rightSidebarHidden: localStorage.getItem('mailflow_right_sidebar_hidden') === 'true',
  toggleRightSidebarHidden: () => set(state => {
    const next = !state.rightSidebarHidden;
    localStorage.setItem('mailflow_right_sidebar_hidden', String(next));
    schedulePrefSave({ rightSidebarHidden: next });
    return { rightSidebarHidden: next };
  }),

  // ── GTD content + tabs ──────────────────────────────────────────────────────
  // Per-section collapse state (section key -> bool). Someday collapsed by default.
  gtdCollapsedSections: readGtdCollapsedSections(),
  toggleGtdSection: (section) => set(state => {
    const next = { ...state.gtdCollapsedSections, [section]: !state.gtdCollapsedSections[section] };
    localStorage.setItem('mailflow_gtd_collapsed_sections', JSON.stringify(next));
    schedulePrefSave({ gtdCollapsedSections: next });
    return { gtdCollapsedSections: next };
  }),

  // Active GTD browse tab in the message-list pill strip (null = normal list).
  activeGtdTab: null,
  setActiveGtdTab: (tab) => set({ activeGtdTab: tab }),

  // Sections data feeding both the rail and the tab list. null before first load.
  gtdSections: null,
  fetchGtdSections: async () => {
    const seq = ++_gtdSectionsSeq;
    const accountId = get().selectedAccountId || undefined;
    try {
      const data = await api.getGtdSections({ accountId, limit: 50 });
      if (seq !== _gtdSectionsSeq) return; // superseded by a newer fetch
      set({ gtdSections: data.sections || {} });
    } catch {
      // Best-effort; scheduleGtdSectionsFetch/the next context change will retry.
    }
  },
  // Debounced refetch — used by the WS gtd_sections_updated handler and after a
  // classify so the rail converges without waiting on (or racing) the socket.
  scheduleGtdSectionsFetch: () => {
    clearTimeout(_gtdFetchTimer);
    _gtdFetchTimer = setTimeout(() => { get().fetchGtdSections(); }, 400);
  },
  // Optimistically drop a thread's head from the given GTD state sections after a
  // "done" action so the rail row disappears instantly; the gtd_sections_updated
  // refetch reconciles the authoritative counts. identity is message_id||id; states
  // are the backend section keys whose labels were removed (todo/watch/delegated/…).
  // Delegates to a pure helper (unit-tested in gtd.test.js) that also keeps the deduped
  // Waiting rollup in step so the Waiting badge is correct instantly.
  removeGtdThread: (identity, states) => set(state => {
    const next = removeGtdThreadFromSections(state.gtdSections, identity, states);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's read flag so a rail row's bold/normal styling
  // updates instantly on a mark-read/unread from the rail; the WS/gtd refetch reconciles.
  // identity is message_id||id and matches across every state a thread is labelled with
  // (a merged Waiting row lives in both watch and delegated), keeping them in sync — and
  // the deduped Waiting rollup's unread with them (pure helper, unit-tested in gtd.test.js).
  markGtdThreadRead: (identity, isRead) => set(state => {
    const next = setGtdThreadReadInSections(state.gtdSections, identity, isRead);
    return next === state.gtdSections ? {} : { gtdSections: next };
  }),
  // Optimistically flip a section thread's star so a rail row's star fills/empties instantly
  // on a toggle; the WS/gtd refetch reconciles. identity is message_id||id and matches across
  // every state a thread is labelled with (a merged Waiting row lives in both watch and
  // delegated), keeping them in sync. Star does not affect the unread rollup.
  markGtdThreadStarred: (identity, isStarred) => set(state => {
    const cur = state.gtdSections;
    if (!cur || identity == null) return {};
    const next = { ...cur };
    let changed = false;
    for (const [key, sec] of Object.entries(cur)) {
      if (!sec || !Array.isArray(sec.threads)) continue;
      let touched = false;
      const threads = sec.threads.map(th => {
        if ((th.message_id || th.id) !== identity || !!th.is_starred === isStarred) return th;
        touched = true;
        return { ...th, is_starred: isStarred };
      });
      if (!touched) continue;
      changed = true;
      next[key] = { ...sec, threads };
    }
    return changed ? { gtdSections: next } : {};
  }),

  // Which cached imported pet renders at inbox-zero (null = the built-in SVG dog).
  // A flat user preference; the asset bytes live server-side, keyed by this slug.
  gtdPetSlug: null,
  setGtdPetSlug: (slug) => {
    const value = slug || null;
    set({ gtdPetSlug: value });
    // '' is the explicit "clear" sentinel the prefs allow-list understands.
    api.savePreferences({ gtdPetSlug: value || '' }).catch(() => {});
  },

  // Layout
  layout: (() => {
    const raw = localStorage.getItem('mailflow_layout');
    const clean = normalizeLayout(raw);
    // Self-heal a stale/removed preset so it can never reach a consumer (#207).
    if (raw && raw !== clean) localStorage.setItem('mailflow_layout', clean);
    return clean;
  })(),
  setLayout: (layout) => {
    const clean = normalizeLayout(layout);
    localStorage.setItem('mailflow_layout', clean);
    localStorage.removeItem('mailflow_list_width');
    set({ layout: clean });
    applyLayout(clean);
    schedulePrefSave({ layout: clean });
  },

  // Image privacy
  blockRemoteImages: true,
  imageWhitelist: { addresses: [], domains: [] },
  setBlockRemoteImages: (val) => {
    set({ blockRemoteImages: val });
    return api.savePreferences({ blockRemoteImages: val });
  },
  setImageWhitelist: (whitelist) => {
    const prev = get().imageWhitelist;
    set({ imageWhitelist: whitelist });
    return api.savePreferences({ imageWhitelist: whitelist }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },
  addToImageWhitelist: ({ type, value }) => {
    const prev = get().imageWhitelist;
    const key = type === 'address' ? 'addresses' : 'domains';
    const normalized = value.toLowerCase();
    set({
      imageWhitelist: {
        ...prev,
        [key]: [...new Set([...(prev[key] || []), normalized])],
      },
    });
    return api.addToImageWhitelist({ type, value: normalized }).catch(err => {
      set({ imageWhitelist: prev });
      throw err;
    });
  },

  // Keyboard shortcuts — stores only user overrides (action → key).
  // Merged with defaults at use-time via getEffectiveShortcuts().
  shortcuts: {},
  setShortcuts: (overrides) => {
    set({ shortcuts: overrides });
    return api.savePreferences({ shortcuts: overrides }).catch(() => {});
  },

  // User-defined AI actions (#202), synced across devices. Each: { id, label, prompt }.
  // null = not yet loaded; loadPreferences seeds defaults on first run.
  aiActions: null,
  setAiActions: (actions) => {
    set({ aiActions: actions });
    return api.savePreferences({ aiActions: actions }).catch(() => {});
  },

  // Hidden folders — { [accountId]: [path, ...] }
  hiddenFolders: {},
  setHiddenFolders: (hf) => {
    set({ hiddenFolders: hf });
    return api.savePreferences({ hiddenFolders: hf }).catch(() => {});
  },

  // Sidebar tree state — persisted so the tree looks the same after reload/re-login
  expandedAccounts: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_expanded_accounts') || '{}'); }
    catch { return {}; }
  })(),
  setExpandedAccounts: (updater) => {
    const next = typeof updater === 'function' ? updater(get().expandedAccounts) : updater;
    localStorage.setItem('mailflow_expanded_accounts', JSON.stringify(next));
    set({ expandedAccounts: next });
    schedulePrefSave({ expandedAccounts: next });
  },

  // collapsedFolders stored as array of "accountId:path" keys (Set can't be JSON-serialised)
  collapsedFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_collapsed_folders') || '[]'); }
    catch { return []; }
  })(),
  toggleCollapsedFolder: (accountId, path) => {
    const key = `${accountId}:${path}`;
    const prev = get().collapsedFolders;
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    localStorage.setItem('mailflow_collapsed_folders', JSON.stringify(next));
    set({ collapsedFolders: next });
    schedulePrefSave({ collapsedFolders: next });
  },

  // Favorite folders — [{ accountId, path }, ...] ordered by insertion
  favoriteFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_favorite_folders') || '[]'); }
    catch { return []; }
  })(),
  addFavoriteFolder: ({ accountId, path }) => {
    const prev = get().favoriteFolders;
    if (prev.some(f => f.accountId === accountId && f.path === path)) return;
    const next = [...prev, { accountId, path }];
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  removeFavoriteFolder: ({ accountId, path }) => {
    const next = get().favoriteFolders.filter(f => !(f.accountId === accountId && f.path === path));
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  renameFavoriteFolder: ({ accountId, path, label }) => {
    const next = get().favoriteFolders.map(f => {
      if (f.accountId !== accountId || f.path !== path) return f;
      // eslint-disable-next-line no-unused-vars
      const { label: _old, ...base } = f;
      return label ? { ...base, label } : base;
    });
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },
  reorderFavoriteFolders: (next) => {
    localStorage.setItem('mailflow_favorite_folders', JSON.stringify(next));
    set({ favoriteFolders: next });
    schedulePrefSave({ favoriteFolders: next });
  },

  // Recent move-to folders — [{ accountId, path }, ...] most-recent first, capped at 5
  recentFolders: (() => {
    try { return JSON.parse(localStorage.getItem('mailflow_recent_folders') || '[]'); }
    catch { return []; }
  })(),
  recordRecentFolder: ({ accountId, path }) => {
    const prev = get().recentFolders;
    const deduped = prev.filter(f => !(f.accountId === accountId && f.path === path));
    const next = [{ accountId, path }, ...deduped].slice(0, 5);
    localStorage.setItem('mailflow_recent_folders', JSON.stringify(next));
    set({ recentFolders: next });
    schedulePrefSave({ recentFolders: next });
  },

  // Fetch server preferences and apply them — call after any successful login.
  // Sets localStorage so subsequent page loads apply the right values instantly.
  loadPreferences: async () => {
    try {
      const prefs = await api.getPreferences();
      if (prefs.theme) {
        localStorage.setItem('mailflow_theme', prefs.theme);
        set({ theme: prefs.theme });
        applyTheme(prefs.theme);
      }
      if (prefs.font) {
        localStorage.setItem('mailflow_font', prefs.font);
        set({ fontSet: prefs.font });
        applyFontSet(prefs.font);
      }
      if (prefs.fontSize) {
        const n = parseInt(prefs.fontSize) || 100;
        localStorage.setItem('mailflow_font_size', String(n));
        set({ fontSize: n });
        applyFontSize(n);
      }
      if (prefs.layout) {
        const clean = normalizeLayout(prefs.layout);
        const prevLayout = get().layout;
        localStorage.setItem('mailflow_layout', clean);
        set({ layout: clean });
        if (clean !== prevLayout) localStorage.removeItem('mailflow_list_width');
        const savedListWidth = clean !== prevLayout
          ? undefined
          : (Number(localStorage.getItem('mailflow_list_width')) || undefined);
        applyLayout(clean, savedListWidth);
      }
      if (prefs.notificationSound) {
        localStorage.setItem('mailflow_notification_sound', prefs.notificationSound);
        set({ notificationSound: prefs.notificationSound });
      }
      if (prefs.pageSize) {
        const n = parseInt(prefs.pageSize) || 50;
        localStorage.setItem('mailflow_page_size', String(n));
        set({ pageSize: n });
      }
      if (prefs.scrollMode) {
        localStorage.setItem('mailflow_scroll_mode', prefs.scrollMode);
        set({ scrollMode: prefs.scrollMode });
      }
      if (prefs.swipeActions) {
        const swipeActions = {
          left: prefs.swipeActions.left || 'archive',
          right: prefs.swipeActions.right || 'markRead',
        };
        localStorage.setItem('mailflow_swipe_actions', JSON.stringify(swipeActions));
        set({ swipeActions });
      }
      if (prefs.syncInterval) {
        const n = parseInt(prefs.syncInterval) || 60;
        localStorage.setItem('mailflow_sync_interval', String(n));
        set({ syncInterval: n });
      }
      // blockRemoteImages: explicit false disables blocking; anything else keeps the default (true)
      if (prefs.blockRemoteImages === false) set({ blockRemoteImages: false });
      else if (prefs.blockRemoteImages === true) set({ blockRemoteImages: true });
      if (prefs.imageWhitelist) set({ imageWhitelist: prefs.imageWhitelist });
      if (prefs.shortcuts) set({ shortcuts: prefs.shortcuts });
      if (Array.isArray(prefs.aiActions)) {
        set({ aiActions: prefs.aiActions });
      } else {
        // First run — seed editable example actions and persist them once so the
        // seed doesn't reappear after the user deletes them.
        set({ aiActions: DEFAULT_AI_ACTIONS });
        api.savePreferences({ aiActions: DEFAULT_AI_ACTIONS }).catch(() => {});
      }
      if (prefs.hiddenFolders) set({ hiddenFolders: prefs.hiddenFolders });
      if (prefs.expandedAccounts && typeof prefs.expandedAccounts === 'object' && !Array.isArray(prefs.expandedAccounts)) {
        localStorage.setItem('mailflow_expanded_accounts', JSON.stringify(prefs.expandedAccounts));
        set({ expandedAccounts: prefs.expandedAccounts });
      }
      if (Array.isArray(prefs.collapsedFolders)) {
        localStorage.setItem('mailflow_collapsed_folders', JSON.stringify(prefs.collapsedFolders));
        set({ collapsedFolders: prefs.collapsedFolders });
      }
      if (Array.isArray(prefs.favoriteFolders)) {
        localStorage.setItem('mailflow_favorite_folders', JSON.stringify(prefs.favoriteFolders));
        set({ favoriteFolders: prefs.favoriteFolders });
      }
      if (Array.isArray(prefs.recentFolders)) {
        localStorage.setItem('mailflow_recent_folders', JSON.stringify(prefs.recentFolders));
        set({ recentFolders: prefs.recentFolders });
      }
      if (prefs.language) {
        localStorage.setItem('mailflow_language', prefs.language);
        set({ language: prefs.language });
        i18n.changeLanguage(prefs.language);
      }
      if (typeof prefs.threadedView === 'boolean') {
        localStorage.setItem('mailflow_threaded_view', String(prefs.threadedView));
        set({ threadedView: prefs.threadedView });
      }
      if (typeof prefs.plaintextEmail === 'boolean') {
        localStorage.setItem('mailflow_plaintext_email', String(prefs.plaintextEmail));
        set({ plaintextEmail: prefs.plaintextEmail });
      }
      if (typeof prefs.hoverQuickActions === 'boolean') {
        localStorage.setItem('mailflow_hover_quick_actions', String(prefs.hoverQuickActions));
        set({ hoverQuickActions: prefs.hoverQuickActions });
      }
      if (prefs.replyDefault === 'reply' || prefs.replyDefault === 'replyAll') {
        localStorage.setItem('mailflow_reply_default', prefs.replyDefault);
        set({ replyDefault: prefs.replyDefault });
      }
      if (prefs.markReadBehavior === 'immediate' || prefs.markReadBehavior === 'delay' || prefs.markReadBehavior === 'manual') {
        localStorage.setItem('mailflow_mark_read_behavior', prefs.markReadBehavior);
        set({ markReadBehavior: prefs.markReadBehavior });
      }
      if (prefs.markReadDelay) {
        const n = Math.max(1, Math.min(10, parseInt(prefs.markReadDelay) || 1));
        localStorage.setItem('mailflow_mark_read_delay', String(n));
        set({ markReadDelay: n });
      }
      if (prefs.sidebarWidth) {
        const n = parseInt(prefs.sidebarWidth);
        if (n >= 160 && n <= 400) {
          localStorage.setItem('mailflow_sidebar_width', String(n));
          set({ sidebarWidth: n });
        }
      }
      if (typeof prefs.showAppBadge === 'boolean') {
        localStorage.setItem('mailflow_app_badge', String(prefs.showAppBadge));
        set({ showAppBadge: prefs.showAppBadge });
      }
      if (typeof prefs.showFaviconBadge === 'boolean') {
        localStorage.setItem('mailflow_favicon_badge', String(prefs.showFaviconBadge));
        set({ showFaviconBadge: prefs.showFaviconBadge });
      }
      if (typeof prefs.categorizationEnabled === 'boolean') {
        set({ categorizationEnabled: prefs.categorizationEnabled });
      }
      if (prefs.rightSidebarWidth != null) {
        const n = clampRightSidebarWidth(prefs.rightSidebarWidth);
        localStorage.setItem('mailflow_right_sidebar_width', String(n));
        set({ rightSidebarWidth: n });
      }
      if (prefs.gtdCollapsedSections && typeof prefs.gtdCollapsedSections === 'object' && !Array.isArray(prefs.gtdCollapsedSections)) {
        localStorage.setItem('mailflow_gtd_collapsed_sections', JSON.stringify(prefs.gtdCollapsedSections));
        set({ gtdCollapsedSections: prefs.gtdCollapsedSections });
      }
      if (typeof prefs.gtdPetSlug === 'string') {
        set({ gtdPetSlug: prefs.gtdPetSlug || null });
      }
      if (typeof prefs.rightSidebarHidden === 'boolean') {
        localStorage.setItem('mailflow_right_sidebar_hidden', String(prefs.rightSidebarHidden));
        set({ rightSidebarHidden: prefs.rightSidebarHidden });
      }
      if (prefs.customCss) {
        applyCustomCss(prefs.customCss);
      }
    } catch { /* intentional */ }
  },
}));

// The RFC message_id of the currently selected message, resolved from the same pools the
// reading pane uses: the active folder/search list, then any stashed thread — including the
// __dl_ deep-link stash written by GTD sidebar selection. Returns null when nothing is selected
// or the selected row has no message_id. Lets the GTD sidebar and message list highlight every
// copy of the open message by identity (not just the exact DB row that was clicked). A plain selector, not
// a state field, so it stays in sync with the list automatically; returns a primitive so a
// useStore(selectSelectedMessageMid) subscription only re-renders when the value changes.
export function selectSelectedMessageMid(s) {
  const id = s.selectedMessageId;
  if (id == null) return null;
  const pool = s.searchQuery?.trim() ? s.searchResults : s.messages;
  const msg = pool.find(m => m.id === id)
    ?? Object.values(s.threadMessages).flat().find(m => m.id === id);
  return msg?.message_id ?? null;
}
