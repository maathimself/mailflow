import { create } from 'zustand';
import { api } from '../utils/api.js';
import { applyTheme } from '../themes.js';
import { applyFontSet } from '../fonts.js';
import { applyLayout } from '../layouts.js';

export const useStore = create((set, get) => ({
  // Auth
  user: null,
  setUser: (user) => set({ user }),

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
  prependMessages: (newMessages) => set(state => ({
    messages: [...newMessages, ...state.messages]
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
  decrementUnread: (accountId) => set(state => {
    const byAccount = { ...state.unreadCounts.byAccount };
    if (byAccount[accountId] > 0) byAccount[accountId]--;
    const total = Math.max(0, state.unreadCounts.total - 1);
    return { unreadCounts: { total, byAccount } };
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
    api.savePreferences({ pageSize: String(size) }).catch(() => {});
  },
  scrollMode: localStorage.getItem('mailflow_scroll_mode') || 'infinite',
  setScrollMode: (mode) => {
    localStorage.setItem('mailflow_scroll_mode', mode);
    set({ scrollMode: mode });
    api.savePreferences({ scrollMode: mode }).catch(() => {});
  },
  syncInterval: parseInt(localStorage.getItem('mailflow_sync_interval')) || 60,
  setSyncInterval: (seconds) => {
    localStorage.setItem('mailflow_sync_interval', String(seconds));
    set({ syncInterval: seconds });
    api.savePreferences({ syncInterval: String(seconds) }).catch(() => {});
  },
  notificationSound: localStorage.getItem('mailflow_notification_sound') || 'tritone',
  setNotificationSound: (sound) => {
    localStorage.setItem('mailflow_notification_sound', sound);
    set({ notificationSound: sound });
    api.savePreferences({ notificationSound: sound }).catch(() => {});
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
    notifications: [{ ...n, id: Date.now() + Math.random() }, ...state.notifications].slice(0, 5)
  })),
  removeNotification: (id) => set(state => ({
    notifications: state.notifications.filter(n => n.id !== id)
  })),

  // Account settings modal
  showAccountSettings: false,
  setShowAccountSettings: (v) => set({ showAccountSettings: v }),
  editingAccount: null,
  setEditingAccount: (a) => set({ editingAccount: a }),

  // Admin panel
  showAdmin: false,
  adminTab: 'accounts', // 'accounts' | 'themes' | 'fonts' | 'layouts' | 'integrations' | 'users'
  setShowAdmin: (v) => set({ showAdmin: v }),
  setAdminTab: (t) => set({ adminTab: t }),

  // Theme
  theme: localStorage.getItem('mailflow_theme') || 'dark',
  setTheme: (theme) => {
    localStorage.setItem('mailflow_theme', theme);
    set({ theme });
    applyTheme(theme); // keep CSS vars + favicon in sync
    api.savePreferences({ theme }).catch(() => {}); // fire-and-forget
  },

  // Font
  fontSet: localStorage.getItem('mailflow_font') || 'default',
  setFontSet: (fontSet) => {
    localStorage.setItem('mailflow_font', fontSet);
    set({ fontSet });
    api.savePreferences({ font: fontSet }).catch(() => {}); // fire-and-forget
  },

  // Layout
  layout: localStorage.getItem('mailflow_layout') || 'classic',
  setLayout: (layout) => {
    localStorage.setItem('mailflow_layout', layout);
    set({ layout });
    applyLayout(layout);
    api.savePreferences({ layout }).catch(() => {}); // fire-and-forget
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
        const n = parseInt(prefs.pageSize);
        localStorage.setItem('mailflow_page_size', String(n));
        set({ pageSize: n });
      }
      if (prefs.scrollMode) {
        localStorage.setItem('mailflow_scroll_mode', prefs.scrollMode);
        set({ scrollMode: prefs.scrollMode });
      }
      if (prefs.syncInterval) {
        const n = parseInt(prefs.syncInterval);
        localStorage.setItem('mailflow_sync_interval', String(n));
        set({ syncInterval: n });
      }
    } catch (_) {}
  },
}));
