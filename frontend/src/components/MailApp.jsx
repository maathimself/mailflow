import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { LAYOUTS } from '../layouts.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { buildKeyMap, getEffectiveShortcuts, getGroupedActions, ACTION_DEFS } from '../utils/defaultShortcuts.js';
import Sidebar from './Sidebar.jsx';
import MessageList from './MessageList.jsx';
import MessagePane from './MessagePane.jsx';
import ComposeModal from './ComposeModal.jsx';
import AdminPanel from './AdminPanel.jsx';
import NotificationToasts from './NotificationToasts.jsx';

export default function MailApp() {
  const {
    setAccounts, setUnreadCounts, showAdmin,
    setShowAdmin, setAdminTab, composing, sidebarCollapsed, layout,
    unreadCounts, selectedAccountId, openCompose, setSelectedAccount,
    shortcuts,
  } = useStore();

  const [showShortcutHelp, setShowShortcutHelp] = useState(false);

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;

  useWebSocket();

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

    // Load unread counts
    const refreshCounts = () => {
      api.getUnreadCounts()
        .then(setUnreadCounts)
        .catch(console.error);
    };
    refreshCounts();
    const interval = setInterval(refreshCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  // Update browser tab title with unread count for the selected account (or total)
  useEffect(() => {
    const count = selectedAccountId
      ? (unreadCounts.byAccount[selectedAccountId] ?? 0)
      : unreadCounts.total;
    document.title = count > 0 ? `(${count}) MailFlow` : 'MailFlow';
  }, [unreadCounts, selectedAccountId]);

  // ── Global keyboard shortcut listener ──────────────────────────────────────
  // Uses refs for composing/showAdmin so the listener doesn't need to
  // re-register every time those values change — only re-registers when the
  // user's custom shortcut map changes.
  const composingRef  = useRef(composing);
  const showAdminRef  = useRef(showAdmin);
  useEffect(() => { composingRef.current  = composing;  }, [composing]);
  useEffect(() => { showAdminRef.current  = showAdmin;  }, [showAdmin]);

  useEffect(() => {
    const keyMap = buildKeyMap(shortcuts);
    // Keys that are prefixes of two-key sequences (e.g. 'g' for 'gi')
    const prefixKeys = new Set(
      Object.keys(keyMap).filter(k => k.length > 1).map(k => k[0])
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
      // Leave browser shortcuts (Ctrl/Cmd/Alt combos) alone
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;

      // Keys we never want to intercept
      if (['Tab', 'CapsLock', 'Enter', 'Backspace', 'Delete',
           'Control', 'Meta', 'Alt', 'Shift', 'ArrowUp', 'ArrowDown',
           'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
           'Insert', 'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
           'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(key)) {
        if (key === 'Escape') clearPending();
        return;
      }

      // Resolve two-key sequences
      let resolved = key;
      if (pendingKey !== null) {
        resolved = pendingKey + key;
        clearPending();
      }

      const action = keyMap[resolved];
      if (action) {
        e.preventDefault();
        shortcutBus.emit(action);
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
  }, [shortcuts]); // Re-build key map only when user's shortcut overrides change

  // Subscribe to global actions that MailApp owns
  useEffect(() => {
    const onCompose   = () => openCompose();
    const onGoInbox   = () => setSelectedAccount(null, 'INBOX');
    const onShowHelp  = () => setShowShortcutHelp(v => !v);

    shortcutBus.on('compose',   onCompose);
    shortcutBus.on('goInbox',   onGoInbox);
    shortcutBus.on('showHelp',  onShowHelp);
    return () => {
      shortcutBus.off('compose',   onCompose);
      shortcutBus.off('goInbox',   onGoInbox);
      shortcutBus.off('showHelp',  onShowHelp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close help overlay on Escape
  useEffect(() => {
    if (!showShortcutHelp) return;
    const handler = (e) => { if (e.key === 'Escape') { e.preventDefault(); setShowShortcutHelp(false); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showShortcutHelp]);

  // Handle same-tab OAuth callback redirects (e.g. /?oauth_success=microsoft).
  // The popup case (window.opener present) is handled earlier in App.jsx before
  // auth is checked, so MailApp never mounts in that context.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('oauth_success');
    const oauthError = params.get('oauth_error');

    if (provider) {
      window.history.replaceState({}, '', '/');
      api.getAccounts()
        .then(accounts => { setAccounts(accounts); })
        .catch(console.error);
      setAdminTab('accounts');
      setShowAdmin(true);
    } else if (oauthError) {
      window.history.replaceState({}, '', '/');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      display: 'flex', height: '100vh', overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      <Sidebar />

      <div style={{
        flex: 1, display: 'flex', overflow: 'hidden',
        minWidth: 0, flexDirection: currentLayout.direction,
        height: '100%',
      }}>
        <MessageList />
        <MessagePane />
      </div>

      {composing && <ComposeModal />}
      {showAdmin && <AdminPanel />}
      <NotificationToasts />

      {/* Keyboard shortcut help overlay — toggled by the '?' key */}
      {showShortcutHelp && (
        <ShortcutHelpOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutHelp(false)}
        />
      )}
    </div>
  );
}

function ShortcutHelpOverlay({ shortcuts, onClose }) {
  const effective = getEffectiveShortcuts(shortcuts);
  const groups    = getGroupedActions();

  const keyBadge = (key) => {
    if (!key) return <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>;
    // For two-key sequences like 'gi', render each key separately
    const parts = key.length > 1 && !['##'].includes(key)
      ? [...key].map((c, i) => (
          <span key={i}>
            <kbd style={kbdStyle}>{c}</kbd>
            {i < key.length - 1 && <span style={{ color: 'var(--text-tertiary)', margin: '0 2px', fontSize: 10 }}>then</span>}
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
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          width: '100%', maxWidth: 680,
          maxHeight: '80vh', overflow: 'auto',
          padding: '24px 28px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Keyboard Shortcuts</div>
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
                {groupName}
              </div>
              {actions.map(({ action, description }) => (
                <div key={action} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '5px 0', borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{description}</span>
                  {keyBadge(effective[action])}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
          Customise shortcuts in Settings → Shortcuts &nbsp;·&nbsp; Press <kbd style={{ ...kbdStyle, fontSize: 10 }}>?</kbd> or <kbd style={{ ...kbdStyle, fontSize: 10 }}>Esc</kbd> to close
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
