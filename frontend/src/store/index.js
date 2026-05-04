import { create } from 'zustand';
import { api } from '../utils/api.js';
import { applyTheme } from '../themes.js';
import { applyFontSet } from '../fonts.js';
import { applyLayout } from '../layouts.js';
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

export const useStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => set({ user }),
  updateUser: (updates) => set(state => ({ user: state.user ? { ...state.user, ...updates } : state.user })),

  // Accounts
  accounts: [],
  accountsReady: false, // true once the initial getAccounts() call has resolved
  setAccounts: (accounts) => set({ accounts, accountsReady: true }),
  updateAccount: (id, updates) => set(state => ({
    accounts: state.accounts.map(a => a.id === id ? { ...a, ...updates } : a)
  })),

  // Navigation
  selectedAccountId: null, // null = unified inbox
  selectedFolder: 'INBOX',
  messagesRefreshToken: 0, // incremented on every nav click so the effect always re-fires
  setSelectedAccount: (accountId, folder = 'INBOX') => set(state => ({
    selectedAccountId: accountId,
    selectedFolder: folder,
    selectedMessageId: null,
    messages: [],
    messagesOffset: 0,
    hasMoreMessages: true,
    messagesRefreshToken: state.messagesRefreshToken + 1,
    expandedThreadId: null,
    threadMessages: {},
  })),

  // Messages
  messages: [],
  setMessages: (messages) => set({ messages }),
  appendMessages: (newMessages) => set(state => ({
    messages: [...state.messages, ...newMessages]
  })),
  updateMessage: (id, updates) => set(state => ({
    messages: state.messages.map(m => m.id === id ? { ...m, ...updates } : m)
  })),
  removeMessage: (id) => set(state => ({
    messages: state.messages.filter(m => m.id !== id),
    selectedMessageId: state.selectedMessageId === id ? null : state.selectedMessageId,
  })),
  messagesOffset: 0,
  setMessagesOffset: (offset) => set({ messagesOffset: offset }),
  messagesTotal: 0,
  setMessagesTotal: (total) => set({ messagesTotal: total }),
  hasMoreMessages: true,
  setHasMoreMessages: (v) => set({ hasMoreMessages: v }),

  // Selected message
  selectedMessageId: null,
  setSelectedMessage: (id) => set({ selectedMessageId: id }),

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

  // UI state
  sidebarCollapsed: localStorage.getItem('mailflow_sidebar_collapsed') === 'true',
  toggleSidebar: () => set(state => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('mailflow_sidebar_collapsed', String(next));
    return { sidebarCollapsed: next };
  }),
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
    notifications: [{ ...n, id: crypto.randomUUID() }, ...state.notifications].slice(0, 5)
  })),
  removeNotification: (id) => set(state => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  // Admin panel
  showAdmin: false,
  adminTab: 'accounts', // 'accounts' | 'appearance' | 'integrations' | 'users'
  setShowAdmin: (v) => set({ showAdmin: v }),
  setAdminTab: (t) => set({ adminTab: t }),

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
  theme: localStorage.getItem('mailflow_theme') || 'dark',
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

  // Layout
  layout: localStorage.getItem('mailflow_layout') || 'classic',
  setLayout: (layout) => {
    localStorage.setItem('mailflow_layout', layout);
    set({ layout });
    applyLayout(layout);
    schedulePrefSave({ layout });
  },

  // Image privacy
  blockRemoteImages: true,
  imageWhitelist: { addresses: [], domains: [] },
  setBlockRemoteImages: (val) => {
    set({ blockRemoteImages: val });
    return api.savePreferences({ blockRemoteImages: val }).catch(() => {});
  },
  setImageWhitelist: (whitelist) => {
    set({ imageWhitelist: whitelist });
    return api.savePreferences({ imageWhitelist: whitelist });
  },

  // Keyboard shortcuts — stores only user overrides (action → key).
  // Merged with defaults at use-time via getEffectiveShortcuts().
  shortcuts: {},
  setShortcuts: (overrides) => {
    set({ shortcuts: overrides });
    return api.savePreferences({ shortcuts: overrides }).catch(() => {});
  },

  // Hidden folders — { [accountId]: [path, ...] }
  hiddenFolders: {},
  setHiddenFolders: (hf) => {
    set({ hiddenFolders: hf });
    return api.savePreferences({ hiddenFolders: hf }).catch(() => {});
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
      if (prefs.layout) {
        localStorage.setItem('mailflow_layout', prefs.layout);
        set({ layout: prefs.layout });
        applyLayout(prefs.layout);
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
      if (prefs.hiddenFolders) set({ hiddenFolders: prefs.hiddenFolders });
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
    } catch (_) {}
  },
}));
