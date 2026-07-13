import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { useMobile } from '../hooks/useMobile.js';
import { LAYOUTS } from '../layouts.js';
import { updateFaviconBadge } from '../themes.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { setPending, pendingMarkReadMap, completedMarkReadMap } from '../utils/pendingReads.js';
import { buildKeyMap, buildModKeyMap, getEffectiveShortcuts, getGroupedActions, parseModKey, modLabel, SPECIAL_KEYS, SPECIAL_KEY_LABELS } from '../utils/defaultShortcuts.js';
import Sidebar from './Sidebar.jsx';
import MessageList from './MessageList.jsx';
import MessagePane from './MessagePane.jsx';
import GtdSidebarContent from './GtdSidebarContent.jsx';
import NotificationToasts from './NotificationToasts.jsx';
import CommandPalette from './CommandPalette.jsx';
import { gtdActiveForContext } from '../utils/gtd.js';

const ContactsPage = lazy(() => import('./ContactsPage.jsx'));

const ComposeModal = lazy(() => import('./ComposeModal.jsx'));
const AdminPanel   = lazy(() => import('./AdminPanel.jsx'));

// Read + atomically clear the deep-link the service worker persisted on a
// notification tap (shared IndexedDB store 'mailflow-nav'). Fully guarded so any
// storage error resolves to null instead of throwing.
function takePendingDeepLink() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const open = indexedDB.open('mailflow-nav', 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore('kv'); } catch { /* store already exists */ } };
      open.onerror = () => done(null);
      open.onblocked = () => done(null);
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          const store = tx.objectStore('kv');
          const getReq = store.get('pending_deeplink');
          getReq.onsuccess = () => { if (getReq.result != null) store.delete('pending_deeplink'); };
          tx.oncomplete = () => { const v = getReq.result ?? null; db.close(); done(v); };
          tx.onerror = () => { db.close(); done(null); };
          tx.onabort = () => { db.close(); done(null); };
        } catch { done(null); }
      };
    } catch { done(null); }
  });
}

const lazyFallback = (
  <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
    <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
  </div>
);

export default function MailApp() {
  const { t } = useTranslation();
  const {
    setAccounts, setUnreadCounts, showAdmin,
    setShowAdmin, setAdminTab, composing, sidebarCollapsed, layout,
    unreadCounts, selectedAccountId, openCompose, setSelectedAccount,
    shortcuts, selectedMessageId, setSelectedMessage,
    mobileSidebarOpen, setMobileSidebarOpen, addNotification,
    fontSize, showAppBadge, showFaviconBadge,
    sidebarWidth, setSidebarWidth, setIsSidebarResizing,
    showContacts, setTodoistConnected,
    accounts, rightSidebarWidth, setRightSidebarWidth, isRightSidebarResizing, setIsRightSidebarResizing,
    fetchGtdSections, rightSidebarHidden, toggleRightSidebarHidden,
  } = useStore();

  // Single owner of the GTD sections fetch: reload whenever the context (unified
  // vs a single account) changes and GTD is active there. Both the rail and the
  // tab list read the resulting store slice; live updates arrive via WS.
  const gtdActive = gtdActiveForContext(accounts, selectedAccountId);
  // Also key on the set of GTD-enabled accounts so enabling a second account refetches
  // the unified sections — gtdActive alone stays true and wouldn't retrigger when it
  // flips from one enabled account to two.
  const gtdEnabledKey = accounts.filter(a => a.gtd_enabled).map(a => a.id).sort().join(',');
  useEffect(() => {
    if (gtdActive) fetchGtdSections();
  }, [gtdActive, selectedAccountId, gtdEnabledKey, fetchGtdSections]);

  const scale = fontSize / 100;
  const [vpSize, setVpSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const update = () => setVpSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        window.dispatchEvent(new CustomEvent('mailflow:refresh'));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isMobile = useMobile();
  const sidebarDragRef = useRef(null);
  const sidebarResizeRef = useRef(null);
  const listResizeRef = useRef(null);
  const rightSidebarResizeRef = useRef(null);

  // Keep the right sidebar's width CSS var in sync with the persisted preference.
  useEffect(() => {
    document.documentElement.style.setProperty('--right-sidebar-width', rightSidebarWidth + 'px');
  }, [rightSidebarWidth]);

  const handleSidebarResizeMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setIsSidebarResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (mv) => {
      const dx = mv.clientX - startX;
      const clamped = Math.min(400, Math.max(160, startWidth + dx));
      setSidebarWidth(clamped);
    };

    const onMouseUp = () => {
      setIsSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      sidebarResizeRef.current = null;
    };

    sidebarResizeRef.current = { onMouseMove, onMouseUp };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  useEffect(() => {
    return () => {
      if (sidebarResizeRef.current) {
        document.removeEventListener('mousemove', sidebarResizeRef.current.onMouseMove);
        document.removeEventListener('mouseup', sidebarResizeRef.current.onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      if (listResizeRef.current) {
        document.removeEventListener('mousemove', listResizeRef.current.onMouseMove);
        document.removeEventListener('mouseup', listResizeRef.current.onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      if (rightSidebarResizeRef.current) {
        document.removeEventListener('mousemove', rightSidebarResizeRef.current.onMouseMove);
        document.removeEventListener('mouseup', rightSidebarResizeRef.current.onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const currentLayout = LAYOUTS[layout] || LAYOUTS.comfortable;

  // Shortcut hint (e.g. "⌘/") for the collapse/expand tooltips, derived from the
  // live shortcut map via the existing helpers — no new plumbing. '' when unbound.
  const rightSidebarToggleParsed = parseModKey(getEffectiveShortcuts(shortcuts).toggleRightSidebar);
  const rightSidebarToggleHint = rightSidebarToggleParsed ? `${modLabel(rightSidebarToggleParsed.mod)}${rightSidebarToggleParsed.bare}` : '';
  // The right sidebar renders when a feature supplies content. GTD is the
  // current (only) provider; the layout/shortcut infrastructure below is
  // feature-agnostic and keys off the seam, not the feature.
  const rightSidebarContent = gtdActive
    ? <GtdSidebarContent onCollapse={toggleRightSidebarHidden} toggleHint={rightSidebarToggleHint} />
    : null;
  const rightSidebarApplicable = !isMobile && currentLayout.direction === 'row' && rightSidebarContent != null;

  const handleListResizeMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--list-width')) || currentLayout.listWidth || 360;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (mv) => {
      const dx = mv.clientX - startX;
      const clamped = Math.max(180, Math.min(700, startWidth + dx));
      document.documentElement.style.setProperty('--list-width', clamped + 'px');
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      listResizeRef.current = null;
      const finalWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--list-width'));
      if (finalWidth) localStorage.setItem('mailflow_list_width', String(finalWidth));
    };

    listResizeRef.current = { onMouseMove, onMouseUp };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Right-sidebar resize — its own width var + handle, independent of --list-width.
  // The handle sits to its left, so dragging left widens the sidebar.
  const handleRightSidebarResizeMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-sidebar-width')) || rightSidebarWidth || 296;
    setIsRightSidebarResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (mv) => {
      const dx = mv.clientX - startX;
      const clamped = Math.max(200, Math.min(600, startWidth - dx));
      document.documentElement.style.setProperty('--right-sidebar-width', clamped + 'px');
    };

    const onMouseUp = () => {
      setIsRightSidebarResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      rightSidebarResizeRef.current = null;
      const finalWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-sidebar-width'));
      if (finalWidth) setRightSidebarWidth(finalWidth);
    };

    rightSidebarResizeRef.current = { onMouseMove, onMouseUp };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Push a history entry when an email is opened on mobile so that the browser's
  // native back gesture (iOS swipe, Android back button) pops an in-app state
  // instead of leaving MailFlow entirely.
  const prevMessageIdRef = useRef(selectedMessageId);
  const selectedMessageIdRef = useRef(selectedMessageId);
  useEffect(() => { selectedMessageIdRef.current = selectedMessageId; }, [selectedMessageId]);

  useEffect(() => {
    if (!isMobile) return;
    const prev = prevMessageIdRef.current;
    prevMessageIdRef.current = selectedMessageId;
    if (selectedMessageId && !prev) {
      history.pushState({ mailflow: 'message' }, '', '/');
    }
  }, [isMobile, selectedMessageId]);

  useEffect(() => {
    if (!isMobile) return;
    // In standalone PWA mode (iOS home-screen install), push a guard entry on
    // startup so there is always at least one history entry above the baseline.
    // The handler re-pushes it after every popstate so back swipes always land
    // inside the app rather than exiting the PWA and showing a blank Safari page.
    if (window.navigator.standalone && history.state?.mailflow !== 'guard') {
      history.pushState({ mailflow: 'guard' }, '', '/');
    }
    const handler = (event) => {
      if (selectedMessageIdRef.current) setSelectedMessage(null);
      // Backing out of a message lands on the existing guard entry. Re-pushing
      // during that popstate can make iOS PWA history gestures temporarily stop
      // delivering taps, so only re-arm when the user has backed past the guard.
      if (window.navigator.standalone && event.state?.mailflow !== 'guard') {
        history.pushState({ mailflow: 'guard' }, '', '/');
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isMobile, setSelectedMessage]);

  useWebSocket();

  // Open a specific message by id (fetch → cache → select). Shared by the on-load
  // deep-link path and the service-worker notification-tap path so both behave
  // identically.
  const openDeepLinkMessage = useCallback((id) => {
    return api.getMessage(id)
      .then(msg => {
        // threadMessages is not cleared by setMessages(), so storing the message
        // here keeps it available to MessagePane even after the message list loads
        // a different folder's page (which would evict it from the main array).
        useStore.getState().setThreadMessages(`__dl_${msg.id}`, [msg]);
        setSelectedMessage(msg.id);
        // The deep-link opens the message directly, bypassing the list/pane
        // selectAndMarkRead — so mark it read here too. Mirrors that logic exactly,
        // including the pending-read guard that stops a concurrent sync from
        // reverting the optimistic flag. Respects the user's manual-mark preference.
        const st = useStore.getState();
        if (msg.is_read || st.markReadBehavior === 'manual') return;
        st.updateMessage(msg.id, { is_read: true });
        st.decrementUnread(msg.account_id);
        st.adjustCategoryCount(msg.category, -1);
        setPending(msg.id, msg.account_id);
        api.bulkRead([msg.id], true)
          .then(() => {
            pendingMarkReadMap.delete(msg.id);
            completedMarkReadMap.set(msg.id, msg.account_id);
            setTimeout(() => completedMarkReadMap.delete(msg.id), 10000);
          })
          .catch(e => {
            console.error('Deep-link markRead failed:', e.message);
            st.updateMessage(msg.id, { is_read: false });
            st.incrementUnread(msg.account_id);
            st.adjustCategoryCount(msg.category, 1);
            pendingMarkReadMap.delete(msg.id);
          });
      })
      .catch(err => console.warn('Deep link message not found:', err.message));
  }, [setSelectedMessage]);

  // Consume the deep-link the SW persisted on a notification tap: read+clear it,
  // then open the message. IndexedDB is the reliable channel on iOS (postMessage can
  // be missed on a focus-with-reload, openWindow's URL is ignored on cold launch).
  const consumePendingDeepLink = useCallback(() => {
    takePendingDeepLink().then((url) => {
      if (!url) return;
      try {
        const id = new URL(url, window.location.origin).searchParams.get('m');
        if (id) openDeepLinkMessage(id);
      } catch { /* ignore a malformed persisted deep-link */ }
    });
  }, [openDeepLinkMessage]);

  // On load: open a deep-linked message from ?m= (Chromium honors openWindow) or a
  // stored id, plus any target the SW persisted for a notification tap.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepLinkId = params.get('m') || sessionStorage.getItem('mailflow_deep_link_id');
    if (deepLinkId) {
      sessionStorage.removeItem('mailflow_deep_link_id');
      history.replaceState(null, '', window.location.pathname);
      openDeepLinkMessage(deepLinkId);
    }
    consumePendingDeepLink();
  }, [openDeepLinkMessage, consumePendingDeepLink]);

  // A notification tap that returns to a backgrounded app (the achievable iOS case)
  // fires visibilitychange; the SW also nudges via postMessage. Both just consume the
  // persisted target — read+clear is atomic, so whichever runs first wins.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') consumePendingDeepLink(); };
    document.addEventListener('visibilitychange', onVisible);
    let onSwMessage;
    if ('serviceWorker' in navigator) {
      onSwMessage = (event) => {
        if (event.data && event.data.type === 'mailflow_deeplink') consumePendingDeepLink();
      };
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (onSwMessage) navigator.serviceWorker.removeEventListener('message', onSwMessage);
    };
  }, [consumePendingDeepLink]);

  // PWA mailto: handler (manifest protocol_handlers → /?mailto=<encoded mailto: URL>).
  // Parse the mailto and open a pre-filled compose window. Runs once on mount; a no-op
  // for a normal launch since the param is absent.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('mailto');
    if (!raw) return;
    // Strip only the mailto param first so a refresh doesn't reopen compose.
    const loc = new URL(window.location.href);
    loc.searchParams.delete('mailto');
    history.replaceState(null, '', loc.pathname + loc.search);
    try {
      const mt = new URL(raw);
      if (mt.protocol !== 'mailto:') return;
      const safeDecode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
      // pathname addresses are raw-encoded; searchParams values are already decoded.
      const splitAddrs = (s, decode) => !s ? [] : s.split(',').map(a => decode ? safeDecode(a.trim()) : a.trim()).filter(Boolean);
      const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // A mailto body is plain text (RFC 6068); escape it so it renders literally in
      // the HTML editor and can't inject markup.
      const bodyText = mt.searchParams.get('body') || '';
      openCompose({
        accountId: useStore.getState().selectedAccountId || undefined,
        to: [...splitAddrs(mt.pathname, true), ...splitAddrs(mt.searchParams.get('to'), false)],
        cc: splitAddrs(mt.searchParams.get('cc'), false),
        bcc: splitAddrs(mt.searchParams.get('bcc'), false),
        subject: mt.searchParams.get('subject') || '',
        body: bodyText ? esc(bodyText).replace(/\r?\n/g, '<br>') : '',
      });
    } catch (err) {
      console.warn('Invalid mailto link:', err.message);
    }
  }, [openCompose]);

  useEffect(() => {
    // Load accounts
    api.getAccounts()
      .then(accounts => {
        setAccounts(accounts); // also sets accountsReady:true in the store
      })
      .catch(err => {
        console.error(err);
        // Even on error, mark accounts as ready so MessageList doesn't hang
        useStore.setState({ accountsReady: true });
      });

    // Sync Todoist connection state — localStorage alone isn't enough across devices/sessions
    api.todoist.status().then(({ connected }) => setTodoistConnected(connected)).catch(() => {});

    // Preload ComposeModal chunk so first open is instant
    import('./ComposeModal.jsx');

    // Load unread counts
    const refreshCounts = () => {
      api.getUnreadCounts()
        .then(setUnreadCounts)
        .catch(console.error);
    };
    refreshCounts();
    // 5-minute fallback poll — WebSocket sync_complete events handle the common case;
    // this covers stale counts when the WebSocket is temporarily disconnected.
    const interval = setInterval(refreshCounts, 300000);
    return () => clearInterval(interval);
  }, [setAccounts, setUnreadCounts, setTodoistConnected]);

  // Update browser tab title, favicon badge, and PWA home screen badge with unread count
  useEffect(() => {
    const total = unreadCounts.total;
    const tabCount = selectedAccountId
      ? (unreadCounts.byAccount[selectedAccountId] ?? 0)
      : total;
    document.title = 'MailFlow';
    updateFaviconBadge(showFaviconBadge ? tabCount : 0);
    // App-icon badge always reflects total unread across all accounts so that
    // selecting a zero-unread account never clears the home screen badge.
    if ('setAppBadge' in navigator) {
      if (showAppBadge && total > 0) navigator.setAppBadge(total).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    }
  }, [unreadCounts, selectedAccountId, showAppBadge, showFaviconBadge]);

  // ── Global keyboard shortcut listener ──────────────────────────────────────
  // Uses refs for composing/showAdmin so the listener doesn't need to
  // re-register every time those values change — only re-registers when the
  // user's custom shortcut map changes.
  const composingRef  = useRef(composing);
  const showAdminRef  = useRef(showAdmin);
  useEffect(() => { composingRef.current  = composing;  }, [composing]);
  useEffect(() => { showAdminRef.current  = showAdmin;  }, [showAdmin]);

  useEffect(() => {
    if (isMobile) return;
    const keyMap    = buildKeyMap(shortcuts);
    const modKeyMap = buildModKeyMap(shortcuts);
    // Keys that are prefixes of two-key sequences (e.g. 'g' for 'gi').
    // Special keys like 'Delete' have length > 1 but are single keypresses — exclude them.
    const prefixKeys = new Set(
      Object.keys(keyMap).filter(k => k.length > 1 && !SPECIAL_KEYS.has(k)).map(k => k[0])
    );

    let pendingKey   = null;
    let pendingTimer = null;

    const clearPending = () => {
      pendingKey = null;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    };

    const handler = (e) => {
      // Never intercept when the compose modal or admin panel is open, or an input is focused
      if (composingRef.current || showAdminRef.current) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
      // Modifier combos: emit registered actions, pass everything else through
      if (e.ctrlKey || e.metaKey) {
        const action = modKeyMap[e.key.toLowerCase()];
        if (action) { e.preventDefault(); shortcutBus.emit(action); }
        return;
      }
      if (e.altKey) return;

      const key = e.key;

      // Pure modifier keys — never intercept
      if (['CapsLock', 'Control', 'Meta', 'Alt', 'Shift'].includes(key)) return;

      // Escape cancels any pending prefix sequence
      if (key === 'Escape') { clearPending(); return; }

      // Resolve two-key sequences
      let resolved = key;
      if (pendingKey !== null) {
        resolved = pendingKey + key;
        clearPending();
      }

      // Check the keymap first — bound actions take priority, including special
      // keys like Delete that would otherwise be skipped below.
      const action = keyMap[resolved];
      if (action) {
        e.preventDefault();
        shortcutBus.emit(action);
        return;
      }

      // Skip non-character keys that aren't bound (arrow keys, F-keys, etc.)
      if (['Tab', 'Enter', 'Backspace', 'Delete',
           'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
           'Home', 'End', 'PageUp', 'PageDown', 'Insert',
           'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
           'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(key)) {
        return;
      }

      // Check if this single key could start a two-key sequence
      if (prefixKeys.has(resolved) && resolved.length === 1) {
        e.preventDefault();
        pendingKey   = resolved;
        pendingTimer = setTimeout(clearPending, 1000);
        return;
      }

      // Typed key didn't match anything — clear any stale pending state
      if (pendingKey !== null) clearPending();
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      clearPending();
    };
  }, [shortcuts, isMobile]); // Re-build key map only when shortcuts or device type changes

  // Subscribe to global actions that MailApp owns
  useEffect(() => {
    const onCompose   = () => openCompose({ accountId: useStore.getState().selectedAccountId || undefined });
    const onGoInbox   = () => setSelectedAccount(null, 'INBOX');
    const onShowHelp  = () => { if (!isMobile) setShowShortcutHelp(v => !v); };

    shortcutBus.on('compose',   onCompose);
    shortcutBus.on('goInbox',   onGoInbox);
    shortcutBus.on('showHelp',  onShowHelp);
    return () => {
      shortcutBus.off('compose',   onCompose);
      shortcutBus.off('goInbox',   onGoInbox);
      shortcutBus.off('showHelp',  onShowHelp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Whole right-sidebar collapse toggle (cmd+/). Re-subscribed when applicability
  // flips so the handler never toggles a sidebar that is not rendered.
  useEffect(() => {
    const onToggleRightSidebar = () => { if (rightSidebarApplicable) toggleRightSidebarHidden(); };
    shortcutBus.on('toggleRightSidebar', onToggleRightSidebar);
    return () => shortcutBus.off('toggleRightSidebar', onToggleRightSidebar);
  }, [rightSidebarApplicable, toggleRightSidebarHidden]);

  // Close help overlay on Escape
  useEffect(() => {
    if (!showShortcutHelp) return;
    const handler = (e) => { if (e.key === 'Escape') { e.preventDefault(); setShowShortcutHelp(false); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showShortcutHelp]);

  // Cmd+K / Ctrl+K opens command palette
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Handle same-tab OAuth callback redirects (e.g. /?oauth_success=microsoft).
  // The popup case (window.opener present) is handled earlier in App.jsx before
  // auth is checked, so MailApp never mounts in that context.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('oauth_success');
    const oauthError = params.get('oauth_error');
    const oidcSuccess = params.get('oidc_success');
    const oidcError = params.get('oidc_error');

    if (provider) {
      window.history.replaceState({}, '', '/');
      api.getAccounts()
        .then(accounts => { setAccounts(accounts); })
        .catch(console.error);
      setAdminTab('accounts');
      setShowAdmin(true);
    } else if (oauthError) {
      window.history.replaceState({}, '', '/');
    } else if (oidcSuccess) {
      window.history.replaceState({}, '', '/');
      if (oidcSuccess === 'linked') {
        addNotification({ type: 'info', title: t('admin.ssoLinked.title'), body: t('admin.ssoLinked.body') });
      }
    } else if (oidcError) {
      window.history.replaceState({}, '', '/');
      addNotification({ type: 'error', title: t('admin.ssoError.title'), body: oidcError });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      width: '100vw', height: 'var(--app-height, 100svh)',
      overflow: 'hidden', background: 'var(--bg-primary)',
    }}>
    <div style={{
      display: 'flex',
      width: scale !== 1 ? `${(vpSize.w / scale).toFixed(2)}px` : '100%',
      height: scale !== 1 ? `${(vpSize.h / scale).toFixed(2)}px` : '100%',
      ...(scale !== 1 && {
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        '--app-height': `${(vpSize.h / scale).toFixed(2)}px`,
      }),
      overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      {isMobile ? (
        <>
          {/* Backdrop — covers full screen including status bar area */}
          {mobileSidebarOpen && (
            <div
              onClick={() => setMobileSidebarOpen(false)}
              style={{
                position: 'fixed', inset: 0, zIndex: 900,
                background: 'var(--overlay-scrim)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
              }}
            />
          )}
          {/* Slide-in sidebar drawer */}
          <div
            style={{
              position: 'fixed', left: 0, top: 0, bottom: 0,
              zIndex: 901, display: 'flex',
              transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.25s cubic-bezier(0.25,0.46,0.45,0.94)',
              boxShadow: mobileSidebarOpen ? 'var(--shadow-drawer)' : 'none',
            }}
            onTouchStart={(e) => {
              sidebarDragRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY };
            }}
            onTouchEnd={(e) => {
              const start = sidebarDragRef.current;
              sidebarDragRef.current = null;
              if (!start) return;
              const dx = e.changedTouches[0].clientX - start.startX;
              const dy = e.changedTouches[0].clientY - start.startY;
              if (dx < -60 && Math.abs(dy) < Math.abs(dx)) setMobileSidebarOpen(false);
            }}
          >
            <Sidebar />
          </div>
          {/* Keep all three mounted so scroll/state survive navigation. */}
          <div style={{ flex: 1, overflow: 'hidden', height: '100%', display: showContacts ? 'flex' : 'none' }}>
            <Suspense fallback={lazyFallback}><ContactsPage /></Suspense>
          </div>
          <div style={{ flex: 1, display: !showContacts && !selectedMessageId ? 'flex' : 'none', overflow: 'hidden', height: '100%' }}>
            <MessageList />
          </div>
          <div style={{ flex: 1, display: !showContacts && selectedMessageId ? 'flex' : 'none', overflow: 'hidden', height: '100%' }}>
            <MessagePane />
          </div>
        </>
      ) : (
        <>
          <Sidebar />
          {!sidebarCollapsed && (
            <div
              onMouseDown={handleSidebarResizeMouseDown}
              style={{
                width: 4, flexShrink: 0, cursor: 'col-resize',
                background: 'var(--border-subtle)',
                transition: 'background 0.15s',
                zIndex: 10,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--border-subtle)'; }}
            />
          )}
          <div style={{
            flex: 1, display: 'flex', overflow: 'hidden',
            minWidth: 0, flexDirection: currentLayout.direction,
            height: '100%',
          }}>
            {/* Keep all three mounted so scroll/state survive navigation. */}
            <div style={{ display: showContacts ? 'flex' : 'none', flex: 1, minWidth: 0, overflow: 'hidden', height: '100%' }}>
              <Suspense fallback={lazyFallback}><ContactsPage /></Suspense>
            </div>
            <div style={{ display: showContacts ? 'none' : 'flex', flex: 1, minWidth: 0, overflow: 'hidden', height: '100%', flexDirection: currentLayout.direction }}>
              <MessageList />
              {currentLayout.direction === 'row' && (
                <div
                  onMouseDown={handleListResizeMouseDown}
                  style={{
                    width: 4, flexShrink: 0, cursor: 'col-resize',
                    background: 'var(--border-subtle)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--border-subtle)'; }}
                />
              )}
              <MessagePane />
              {/* Generic right-sidebar column, populated from the content seam above. */}
              {currentLayout.direction === 'row' && rightSidebarContent != null && (
                <>
                  {/* Resize handle is omitted while the sidebar is hidden. */}
                  {!rightSidebarHidden && (
                    <div
                      onMouseDown={handleRightSidebarResizeMouseDown}
                      style={{
                        width: 4, flexShrink: 0, cursor: 'col-resize',
                        background: 'var(--border-subtle)',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--border-subtle)'; }}
                    />
                  )}
                  {/* Column wrapper collapses its width when hidden (message list reflows);
                      the inner block keeps its full width and slides off the right edge.
                      overflow:hidden clips the sidebar as it slides, kept mounted so both
                      directions animate. */}
                  <div style={{
                    position: 'relative', flexShrink: 0, overflow: 'hidden', height: '100%',
                    width: rightSidebarHidden ? 0 : 'var(--right-sidebar-width, 296px)',
                    // Disabled while dragging (mirrors Sidebar's isSidebarResizing guard):
                    // otherwise every mousemove's CSS-var write would animate toward the new
                    // width instead of tracking the cursor.
                    transition: isRightSidebarResizing ? 'none' : 'width 0.2s ease',
                  }}>
                    <div style={{
                      width: 'var(--right-sidebar-width, 296px)', height: '100%',
                      transform: rightSidebarHidden ? 'translateX(100%)' : 'translateX(0)',
                      transition: 'transform 0.2s ease',
                    }}>
                      {rightSidebarContent}
                    </div>
                  </div>
                  {/* Slim always-visible reopen affordance pinned to the right edge. */}
                  {rightSidebarHidden && (
                    <button
                      onClick={toggleRightSidebarHidden}
                      aria-label={t('rightSidebar.show')}
                      title={rightSidebarToggleHint ? `${t('rightSidebar.show')} (${rightSidebarToggleHint})` : t('rightSidebar.show')}
                      style={{
                        width: 18, flexShrink: 0, cursor: 'pointer', padding: 0,
                        border: 'none', borderLeft: '1px solid var(--border)',
                        background: 'var(--bg-secondary)', color: 'var(--text-tertiary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      <Suspense fallback={lazyFallback}>{composing && <ComposeModal />}</Suspense>
      <Suspense fallback={lazyFallback}>{showAdmin && <AdminPanel />}</Suspense>
      <NotificationToasts />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* Keyboard shortcut help overlay — toggled by the '?' key */}
      {showShortcutHelp && (
        <ShortcutHelpOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutHelp(false)}
        />
      )}
    </div>
    </div>
  );
}

function ShortcutHelpOverlay({ shortcuts, onClose }) {
  const { t } = useTranslation();
  const effective = getEffectiveShortcuts(shortcuts);
  const groups    = getGroupedActions();

  const keyBadge = (key) => {
    if (!key) return <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>;
    // Modifier combos like 'ctrl+p'
    const mod = parseModKey(key);
    if (mod) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <kbd style={kbdStyle}>{modLabel(mod.mod)}</kbd>
          <span style={{ color: 'var(--text-tertiary)', margin: '0 2px', fontSize: 10 }}>+</span>
          <kbd style={kbdStyle}>{mod.bare.toUpperCase()}</kbd>
        </span>
      );
    }
    // Special key names like 'Delete', 'ArrowUp' — single keypress, render as one badge
    if (SPECIAL_KEY_LABELS[key]) {
      return <kbd style={kbdStyle}>{SPECIAL_KEY_LABELS[key]}</kbd>;
    }
    // For two-key sequences like 'gi', render each key separately
    const parts = key.length > 1
      ? [...key].map((c, i) => (
          <span key={i}>
            <kbd style={kbdStyle}>{c}</kbd>
            {i < key.length - 1 && <span style={{ color: 'var(--text-tertiary)', margin: '0 2px', fontSize: 10 }}>{t('shortcuts.then')}</span>}
          </span>
        ))
      : [<kbd key={0} style={kbdStyle}>{key}</kbd>];
    return <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>{parts}</span>;
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 6000,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-modal)',
          width: '100%', maxWidth: 680,
          maxHeight: '80vh', overflow: 'auto',
          padding: '24px 28px',
          animation: 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('shortcuts.title')}</div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 4, display: 'flex' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
          {Object.entries(groups).map(([groupName, actions]) => (
            <div key={groupName} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                {t(groupName)}
              </div>
              {actions.map(({ action, descriptionKey }) => (
                <div key={action} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '5px 0', borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(descriptionKey)}</span>
                  {keyBadge(effective[action])}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
          {t('shortcuts.customizeHint')} &nbsp;·&nbsp; {t('shortcuts.closeHint')}
        </div>
      </div>
    </div>
  );
}

const kbdStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minWidth: 22, height: 20, padding: '0 5px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderBottomWidth: 2, borderRadius: 4,
  fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
  color: 'var(--text-primary)',
};
