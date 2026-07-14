import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { activateOnKey, collapsedTooltip } from '../utils/sidebar.js';
import { useMobile } from '../hooks/useMobile.js';
import LogoMark from './LogoMark.jsx';
import ProfileModal from './ProfileModal.jsx';

const ICONS = {
  inbox: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
    </svg>
  ),
  sent: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  ),
  drafts: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>
  ),
  trash: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
    </svg>
  ),
  spam: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
  folder: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  ),
  star: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  compose: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  ),
  logout: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
  contacts: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/>
      <path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  ),
};

function folderIcon(path, specialUse, folderMappings) {
  const p = (path || '').toLowerCase();
  const s = (specialUse || '').toLowerCase();
  if (s.includes('sent') || p.includes('sent') || folderMappings?.sent === path) return ICONS.sent;
  if (s.includes('drafts') || p.includes('draft') || folderMappings?.drafts === path) return ICONS.drafts;
  if (s.includes('trash') || p.includes('trash') || p.includes('deleted') || folderMappings?.trash === path) return ICONS.trash;
  if (s.includes('junk') || s.includes('spam') || p.includes('spam') || p.includes('junk') || folderMappings?.spam === path) return ICONS.spam;
  if (s.includes('flagged') || p.includes('starred')) return ICONS.star;
  if (p === 'inbox') return ICONS.inbox;
  return ICONS.folder;
}

// Folders that should not be renamed or deleted
function isProtectedFolder(folder, folderMappings) {
  const p = (folder.path || '').toLowerCase();
  const s = (folder.special_use || '').toLowerCase();
  if (folderMappings && Object.values(folderMappings).includes(folder.path)) return true;
  return (
    p === 'inbox' ||
    s.includes('sent') || s.includes('draft') || s.includes('trash') ||
    s.includes('junk') || s.includes('spam') || s.includes('archive') ||
    s.includes('flagged') || s.includes('all') ||
    p.includes('trash') || p.includes('deleted') ||
    p.startsWith('[gmail]/')
  );
}

// Build a nested tree from a flat sorted folder list using the IMAP delimiter.
// Folders whose parent path isn't in the list are attached to the root.
function buildFolderTree(folders) {
  const delimiter = folders.find(f => f.delimiter)?.delimiter || '/';
  const map = {};
  for (const f of folders) map[f.path] = { ...f, children: [] };

  // Synthesize placeholder nodes for any intermediate paths missing from the DB
  // (e.g. INBOX when the server omits it from LIST, or any deeper gap). This is a
  // safety net; the backend also ensures INBOX always has a row after syncFolders.
  for (const f of folders) {
    const parts = f.path.split(delimiter);
    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorPath = parts.slice(0, depth).join(delimiter);
      if (!map[ancestorPath]) {
        map[ancestorPath] = {
          path: ancestorPath,
          name: parts[depth - 1],
          delimiter,
          special_use: null,
          account_id: f.account_id,
          children: [],
        };
      }
    }
  }

  const roots = [];
  // Sort all nodes (real + synthesized) by path so parents are always processed
  // before their children and the sidebar order stays alphabetical.
  const allNodes = Object.values(map).sort((a, b) => a.path.localeCompare(b.path));
  for (const node of allNodes) {
    const parts = node.path.split(delimiter);
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join(delimiter) : null;
    if (parentPath && map[parentPath] && parentPath !== node.path) {
      map[parentPath].children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ─── Sidebar context menu (folders + accounts) ────────────────────────────────
function SidebarCtxMenu({ x, y, items, title, subtitle, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + rect.width > vw ? Math.max(0, x - rect.width) : x,
      y: y + rect.height > vh ? Math.max(0, y - rect.height) : y,
    });
  }, [x, y]);

  // Keep a ref so the listener registered once on mount always calls the latest onClose
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const handleMouseDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onCloseRef.current();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed', left: pos.x, top: pos.y,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 10, zIndex: 4000,
        boxShadow: 'var(--shadow-modal)',
        minWidth: 210, overflow: 'hidden',
        animation: 'ctxIn 0.1s ease',
      }}
    >
      <style>{`
        @keyframes ctxIn {
          from { opacity: 0; transform: scale(0.96) translateY(-3px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>

      {/* Header */}
      {(title || subtitle) && (
        <div style={{
          padding: '9px 13px 7px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          {title && (
            <div style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {title}
            </div>
          )}
          {subtitle && (
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {subtitle}
            </div>
          )}
        </div>
      )}

      <div style={{ padding: '4px 0' }}>
        {items.map((item, i) => {
          if (item.separator) {
            return <div key={i} style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />;
          }
          return (
            <CtxMenuItem
              key={i}
              icon={item.icon}
              label={item.label}
              danger={item.danger}
              disabled={item.disabled}
              onClick={() => {
                item.action();
                if (!item.keepOpen) onClose();
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function CtxMenuItem({ icon, label, onClick, danger, disabled }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '6px 13px', cursor: disabled ? 'default' : 'pointer',
        background: hov ? (danger ? 'rgba(248,113,113,0.08)' : 'var(--bg-hover)') : 'transparent',
        color: disabled
          ? 'var(--text-tertiary)'
          : danger ? (hov ? 'var(--red)' : 'var(--text-secondary)') : 'var(--text-primary)',
        transition: 'background 0.08s, color 0.08s',
        fontSize: 13, opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        flexShrink: 0, display: 'flex',
        color: disabled ? 'var(--text-tertiary)' : (danger && hov ? 'var(--red)' : 'var(--text-tertiary)'),
      }}>
        {icon}
      </span>
      {label}
    </div>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────
export default function Sidebar() {
  const { t } = useTranslation();
  const {
    accounts, unreadCounts, selectedAccountId, selectedFolder,
    setSelectedAccount, setShowAdmin, setAdminTab, openCompose,
    folders, setFolders, setAccounts, user, setUser, setLocked, sidebarCollapsed: sidebarCollapsedPref, toggleSidebar,
    blockRemoteImages, setBlockRemoteImages, setMobileSidebarOpen, addNotification,
    searchAllFolders, setSearchAllFolders,
    hiddenFolders, setHiddenFolders,
    favoriteFolders, addFavoriteFolder, removeFavoriteFolder, renameFavoriteFolder, reorderFavoriteFolders,
    expandedAccounts, setExpandedAccounts,
    collapsedFolders, toggleCollapsedFolder,
    accountsReady,
    sidebarWidth,
    isSidebarResizing,
    showContacts, setShowContacts,
  } = useStore();

  const isMobile = useMobile();
  // On mobile the sidebar is always expanded (shown as an overlay drawer)
  const sidebarCollapsed = isMobile ? false : sidebarCollapsedPref;

  // Close the mobile drawer whenever the user navigates to a different folder/account
  useEffect(() => {
    if (isMobile) setMobileSidebarOpen(false);
  }, [selectedAccountId, selectedFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  const [msgDragTarget, setMsgDragTarget] = useState(null);

  // Clear any stale msgDragTarget when a drag operation ends anywhere on the page
  useEffect(() => {
    const clear = () => setMsgDragTarget(null);
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, []);

  const handleMsgDrop = useCallback((e, targetFolder) => {
    e.preventDefault();
    setMsgDragTarget(null);
    const raw = e.dataTransfer.getData('application/x-mailflow-message');
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const state = useStore.getState();
    const pool = [...state.messages, ...state.searchResults];
    const ids = payload.messageIds ?? [payload.messageId];
    const msgs = ids
      .map(id => pool.find(m => m.id === id))
      .filter(m => m != null && m.folder !== targetFolder);
    if (!msgs.length) return;
    msgs.forEach(msg => {
      state.removeMessage(msg.id);
      if (!msg.is_read) state.decrementUnread(msg.account_id);
    });
    const movedIds = msgs.map(m => m.id);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        const result = await api.bulkMove(movedIds, targetFolder);
        const movedSet = new Set(result.moved ?? []);
        const failedMsgs = msgs.filter(m => !movedSet.has(m.id));
        const s = useStore.getState();
        if (failedMsgs.length > 0) {
          s.restoreMessages(failedMsgs);
          failedMsgs.forEach(m => { if (!m.is_read) s.incrementUnread(m.account_id); });
          s.addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: failedMsgs.length }) });
        } else {
          s.recordRecentFolder({ accountId: msgs[0].account_id, path: targetFolder });
        }
      } catch {
        const s = useStore.getState();
        s.restoreMessages(msgs);
        msgs.forEach(m => { if (!m.is_read) s.incrementUnread(m.account_id); });
        s.addNotification({ title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: movedIds.length }) });
      }
    }, 4500);
    state.addNotification({
      title: t('messageList.bulkMoved.title', { count: msgs.length }),
      body: targetFolder,
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        const s = useStore.getState();
        s.restoreMessages(msgs);
        msgs.forEach(m => { if (!m.is_read) s.incrementUnread(m.account_id); });
      },
    });
  }, [t]);

  const [showProfile, setShowProfile] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userMenuPos, setUserMenuPos] = useState({ bottom: 0, left: 0 });
  const [bottomExpanded, setBottomExpanded] = useState(false);
  const userMenuBtnRef = useRef(null);
  const userMenuPopoverRef = useRef(null);

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e) => {
      if (
        userMenuBtnRef.current && !userMenuBtnRef.current.contains(e.target) &&
        userMenuPopoverRef.current && !userMenuPopoverRef.current.contains(e.target)
      ) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  const openUserMenu = () => {
    if (!userMenuBtnRef.current) return;
    const rect = userMenuBtnRef.current.getBoundingClientRect();
    setUserMenuPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
    setUserMenuOpen(v => !v);
  };

  // Context menus
  const [folderCtxMenu, setFolderCtxMenu] = useState(null); // {x, y, accountId, folderObj}
  const [accountCtxMenu, setAccountCtxMenu] = useState(null); // {x, y, account}

  // Inline rename (IMAP folder)
  const [renamingFolder, setRenamingFolder] = useState(null); // {accountId, path, value}
  const renameInputRef = useRef(null);

  // Inline rename (favorite alias)
  const [renamingFav, setRenamingFav] = useState(null); // {accountId, path, value}
  const renameFavInputRef = useRef(null);

  // Drag-and-drop state for favorites reorder
  const [favDragIdx, setFavDragIdx] = useState(null);
  const [favDropIdx, setFavDropIdx] = useState(null);
  const favLongPressTimer = useRef(null);
  const favTouchStart = useRef(null); // { x, y } captured at touchstart for movement threshold

  // Inline create folder
  const [creatingFolder, setCreatingFolder] = useState(null); // {accountId}
  const [createName, setCreateName] = useState('');
  const createInputRef = useRef(null);

  // Per-account toggle to reveal hidden folders
  const [showHiddenFor, setShowHiddenFor] = useState(new Set()); // Set of accountIds
  const toggleShowHidden = useCallback((accountId) => {
    setShowHiddenFor(prev => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
      return next;
    });
  }, []);

  const hideFolderFn = useCallback((accountId, path) => {
    const current = hiddenFolders[accountId] || [];
    if (current.includes(path)) return;
    setHiddenFolders({ ...hiddenFolders, [accountId]: [...current, path] });
  }, [hiddenFolders, setHiddenFolders]);

  const unhideFolderFn = useCallback((accountId, path) => {
    const current = hiddenFolders[accountId] || [];
    const next = current.filter(p => p !== path);
    const updated = { ...hiddenFolders };
    if (next.length === 0) delete updated[accountId]; else updated[accountId] = next;
    setHiddenFolders(updated);
  }, [hiddenFolders, setHiddenFolders]);

  // Loading state for folder ops
  const [folderOpLoading, setFolderOpLoading] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm }

  const toggleAccount = (id) => {
    setExpandedAccounts(prev => ({ ...prev, [id]: !prev[id] }));
    if (!expandedAccounts[id] && !folders[id]) {
      api.getFolders(id).then(f => setFolders(id, f)).catch(console.error);
    }
  };

  // When accounts finish loading, fetch folders for any account that was
  // persisted as expanded OR has at least one favorited folder — the latter
  // ensures folderObj is always defined when the favorites context menu opens,
  // even if the user never expands that account's folder tree.
  useEffect(() => {
    if (!accountsReady) return;
    accounts.forEach(account => {
      const needsFolders = (expandedAccounts[account.id] || favoriteFolders.some(f => f.accountId === account.id))
        && !folders[account.id];
      if (needsFolders) {
        api.getFolders(account.id).then(f => setFolders(account.id, f)).catch(console.error);
      }
    });
  }, [accountsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = async () => {
    await api.logout();
    // Appearance/localization prefs (theme, font, layout, language) are deliberately
    // NOT cleared: keeping them means the login screen and the next visit retain the
    // last-used look instead of snapping back to the default dark theme (issue #208).
    // They are re-synced from the account's server-side preferences after login.
    // The keys below are mailbox/session state that can reference the previous user's
    // accounts or folders, so they are cleared on sign-out.
    [
      'mailflow_notification_sound', 'mailflow_custom_sound', 'mailflow_custom_sound_name',
      'mailflow_page_size', 'mailflow_scroll_mode', 'mailflow_sync_interval',
      'mailflow_threaded_view', 'mailflow_plaintext_email',
      'mailflow_hover_quick_actions', 'mailflow_swipe_actions',
      'mailflow_expanded_accounts', 'mailflow_collapsed_folders',
    ].forEach(k => localStorage.removeItem(k));
    setUser(null);
    window.location.href = '/login';
  };

  const isUnified = selectedAccountId === null;

  // Focus rename/create inputs when they appear
  useEffect(() => {
    if (renamingFolder && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingFolder]);
  useEffect(() => {
    if (renamingFav && renameFavInputRef.current) renameFavInputRef.current.focus();
  }, [renamingFav]);
  useEffect(() => {
    if (creatingFolder && createInputRef.current) createInputRef.current.focus();
  }, [creatingFolder]);

  // ── Folder context menu items ──────────────────────────────────────────────
  const openFolderCtxMenu = useCallback((e, accountId, folderObj) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderCtxMenu({ x: e.clientX, y: e.clientY, accountId, folderObj });
    setAccountCtxMenu(null);
  }, []);

  const openAccountCtxMenu = useCallback((e, account) => {
    e.preventDefault();
    e.stopPropagation();
    setAccountCtxMenu({ x: e.clientX, y: e.clientY, account });
    setFolderCtxMenu(null);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleMarkAllRead = async (accountId, folder) => {
    try {
      await api.markAllRead(accountId, folder);
      window.dispatchEvent(new CustomEvent('mailflow:refresh'));
      api.getUnreadCounts().then(counts => {
        useStore.setState({ unreadCounts: counts });
      }).catch(() => {});
      api.getFolders(accountId).then(f => setFolders(accountId, f)).catch(() => {});
    } catch (err) { console.error('markAllRead failed:', err.message); }
  };

  const handleSyncFolder = (accountId, folder) => {
    api.syncFolder(accountId, folder).catch(err => console.error('syncFolder failed:', err.message));
  };

  const handleStartRename = (accountId, folderObj) => {
    setRenamingFolder({ accountId, path: folderObj.path, value: folderObj.name, originalName: folderObj.name });
  };

  const handleRenameSubmit = async () => {
    if (!renamingFolder || !renamingFolder.value.trim()) {
      setRenamingFolder(null);
      return;
    }
    if (renamingFolder.value.trim() === renamingFolder.originalName) {
      setRenamingFolder(null);
      return;
    }
    setFolderOpLoading(true);
    try {
      const { newPath } = await api.renameFolder(renamingFolder.accountId, renamingFolder.path, renamingFolder.value.trim());
      const updated = await api.getFolders(renamingFolder.accountId);
      setFolders(renamingFolder.accountId, updated);
      // If we were viewing the renamed folder, navigate to it
      if (selectedAccountId === renamingFolder.accountId && selectedFolder === renamingFolder.path) {
        setSelectedAccount(renamingFolder.accountId, newPath || 'INBOX');
      }
      setRenamingFolder(null);
    } catch (err) {
      addNotification({ title: t('sidebar.renameFailed'), body: err.message });
    } finally {
      setFolderOpLoading(false);
    }
  };

  const handleDeleteFolder = (accountId, folderPath) => {
    const account = accounts.find(a => a.id === accountId);
    const accountFolders = folders[accountId] || [];
    const delimiter = accountFolders.find(f => f.delimiter)?.delimiter || '/';
    const name = folderPath.split(delimiter).pop();
    const accountLabel = account?.name || account?.email_address || '';
    setConfirmDialog({
      message: t('sidebar.confirmDelete', { name }),
      account: accountLabel,
      onConfirm: async () => {
        try {
          await api.deleteFolder(accountId, folderPath);
          const updated = await api.getFolders(accountId);
          setFolders(accountId, updated);
          if (selectedAccountId === accountId && selectedFolder === folderPath) {
            setSelectedAccount(accountId, 'INBOX');
          }
        } catch (err) {
          addNotification({ title: t('sidebar.deleteFailed'), body: err.message });
        }
      },
    });
  };

  const handleEmptyFolder = (accountId, folderPath) => {
    const account = accounts.find(a => a.id === accountId);
    const accountFolders = folders[accountId] || [];
    const delimiter = accountFolders.find(f => f.delimiter)?.delimiter || '/';
    const name = folderPath.split(delimiter).pop();
    const accountLabel = account?.name || account?.email_address || '';
    setConfirmDialog({
      message: t('sidebar.confirmEmpty', { name }),
      account: accountLabel,
      onConfirm: async () => {
        try {
          await api.emptyFolder(accountId, folderPath);
          window.dispatchEvent(new CustomEvent('mailflow:refresh'));
          api.getFolders(accountId).then(f => setFolders(accountId, f)).catch(() => {});
        } catch (err) {
          addNotification({ title: t('sidebar.emptyFailed'), body: err.message });
        }
      },
    });
  };

  const handleStartCreateFolder = (accountId) => {
    setCreatingFolder({ accountId });
    setCreateName('');
    if (!expandedAccounts[accountId]) {
      setExpandedAccounts(prev => ({ ...prev, [accountId]: true }));
      if (!folders[accountId]) {
        api.getFolders(accountId).then(f => setFolders(accountId, f)).catch(console.error);
      }
    }
  };

  const handleCreateFolderSubmit = async () => {
    if (!creatingFolder || !createName.trim()) {
      setCreatingFolder(null);
      setCreateName('');
      return;
    }
    try {
      await api.createFolder(creatingFolder.accountId, createName.trim());
      const updated = await api.getFolders(creatingFolder.accountId);
      setFolders(creatingFolder.accountId, updated);
      setCreatingFolder(null);
      setCreateName('');
    } catch (err) {
      addNotification({ title: t('sidebar.createFailed'), body: err.message });
    }
  };

  const handleMoveAccount = useCallback(async (account, direction) => {
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= accounts.length) return;
    const targetAccount = accounts[targetIdx];
    const newOrder = [...accounts];
    newOrder[idx] = accounts[targetIdx];
    newOrder[targetIdx] = accounts[idx];
    setAccounts(newOrder);
    try {
      await Promise.all([
        api.updateAccount(account.id, { sort_order: targetIdx }),
        api.updateAccount(targetAccount.id, { sort_order: idx }),
      ]);
    } catch (err) {
      setAccounts(accounts);
      addNotification({ title: t('sidebar.accountMenu.moveFailed'), body: err.message });
    }
  }, [accounts, setAccounts, addNotification, t]);

  // ── Folder context menu items ──────────────────────────────────────────────
  const buildFolderMenuItems = (accountId, folderObj) => {
    const accountForFolder = accounts.find(a => a.id === accountId);
    const isProtected = isProtectedFolder(folderObj, accountForFolder?.folder_mappings);
    const isHidden = (hiddenFolders[accountId] || []).includes(folderObj.path);
    const isFavorite = favoriteFolders.some(f => f.accountId === accountId && f.path === folderObj.path);
    return [
      {
        label: t('sidebar.folderMenu.markAllRead'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
        action: () => handleMarkAllRead(accountId, folderObj.path),
      },
      {
        label: t('sidebar.folderMenu.syncFolder'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
        action: () => handleSyncFolder(accountId, folderObj.path),
      },
      { separator: true },
      {
        label: isFavorite ? t('sidebar.folderMenu.unfavorite', 'Remove from Favorites') : t('sidebar.folderMenu.favorite', 'Add to Favorites'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill={isFavorite ? 'var(--amber)' : 'none'} stroke={isFavorite ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
        action: () => isFavorite
          ? removeFavoriteFolder({ accountId, path: folderObj.path })
          : addFavoriteFolder({ accountId, path: folderObj.path }),
      },
      ...(isFavorite ? [{
        label: t('sidebar.folderMenu.renameFavorite', 'Rename favorite'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="M8 8h5"/></svg>,
        action: () => {
          const fav = favoriteFolders.find(f => f.accountId === accountId && f.path === folderObj.path);
          setRenamingFav({ accountId, path: folderObj.path, value: fav?.label || folderObj.name || folderObj.path.split('/').pop() || folderObj.path });
        },
      }] : []),
      { separator: true },
      {
        label: t('sidebar.folderMenu.rename'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>,
        action: () => handleStartRename(accountId, folderObj),
        disabled: isProtected,
      },
      {
        label: t('sidebar.folderMenu.createSubfolder'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>,
        action: () => {
          setCreatingFolder({ accountId, parentPath: folderObj.path });
          setCreateName('');
          if (!expandedAccounts[accountId]) setExpandedAccounts(prev => ({ ...prev, [accountId]: true }));
        },
      },
      { separator: true },
      {
        label: isHidden ? t('sidebar.folderMenu.unhide') : t('sidebar.folderMenu.hide'),
        icon: isHidden
          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
        action: () => isHidden ? unhideFolderFn(accountId, folderObj.path) : hideFolderFn(accountId, folderObj.path),
      },
      { separator: true },
      {
        label: t('sidebar.folderMenu.empty'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>,
        action: () => handleEmptyFolder(accountId, folderObj.path),
        danger: true,
      },
      {
        label: t('sidebar.folderMenu.delete'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
        action: () => handleDeleteFolder(accountId, folderObj.path),
        danger: true,
        disabled: isProtected,
      },
    ];
  };

  // ── Account context menu items ─────────────────────────────────────────────
  const buildAccountMenuItems = (account) => {
    const idx = accounts.findIndex(a => a.id === account.id);
    const isFirst = idx === 0;
    const isLast = idx === accounts.length - 1;
    const items = [
      {
        label: t('sidebar.accountMenu.newFolder'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>,
        action: () => handleStartCreateFolder(account.id),
      },
      {
        label: t('sidebar.accountMenu.markAllRead'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
        action: () => handleMarkAllRead(account.id, 'INBOX'),
      },
      {
        label: t('sidebar.accountMenu.syncNow'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
        action: () => api.syncNow(account.id).catch(console.error),
      },
      { separator: true },
    ];
    if (accounts.length > 1) {
      items.push(
        {
          label: t('sidebar.accountMenu.moveUp'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="18 15 12 9 6 15"/></svg>,
          action: () => handleMoveAccount(account, 'up'),
          disabled: isFirst,
        },
        {
          label: t('sidebar.accountMenu.moveDown'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="6 9 12 15 18 9"/></svg>,
          action: () => handleMoveAccount(account, 'down'),
          disabled: isLast,
        },
        { separator: true },
      );
    }
    items.push(
      {
        label: t('sidebar.accountMenu.settings'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
        action: () => { setAdminTab('accounts'); setShowAdmin(true); },
      },
      {
        label: t('sidebar.accountMenu.reconnect'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
        action: () => api.reconnectAccount(account.id).catch(console.error),
      },
    );
    return items;
  };

  return (
    <div style={{
      width: sidebarCollapsed ? 60 : sidebarWidth,
      minWidth: sidebarCollapsed ? 60 : sidebarWidth,
      height: isMobile ? '100%' : '100%',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      transition: isSidebarResizing ? 'none' : 'width 0.2s ease, min-width 0.2s ease',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        paddingTop: 'calc(var(--sat) + 16px)',
        paddingBottom: 16, paddingLeft: 12, paddingRight: 12,
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)',
        minHeight: 56, flexShrink: 0,
      }}>
        {!sidebarCollapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <LogoMark size={24} />
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
              <span style={{
                fontFamily: "'Syne', sans-serif",
                fontSize: 17, fontWeight: 700,
                color: 'var(--text-primary)',
                letterSpacing: '-0.02em', whiteSpace: 'nowrap',
              }}>
                Mail
              </span>
              <span style={{
                fontFamily: "'Syne', sans-serif",
                fontSize: 17, fontWeight: 600,
                color: 'var(--accent)',
                letterSpacing: '-0.02em', whiteSpace: 'nowrap',
              }}>
                Flow
              </span>
            </span>
          </div>
        )}
        <button
          onClick={isMobile ? () => setMobileSidebarOpen(false) : toggleSidebar}
          title={t('sidebar.toggleSidebar')}
          className="btn-press"
          style={{
            background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)',
            cursor: 'pointer', padding: 6, borderRadius: 6, transition: 'all 0.1s',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginLeft: sidebarCollapsed ? 'auto' : 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
        >
          {isMobile ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          )}
        </button>
      </div>

      {/* Compose button */}
      <div style={{ padding: '12px 10px' }}>
        <button
          onClick={() => openCompose({ accountId: selectedAccountId || undefined })}
          className="btn-press"
          style={{
            width: '100%', padding: sidebarCollapsed ? '10px' : '10px 14px',
            background: 'var(--accent)', border: 'none', borderRadius: 8,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            gap: 8, transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          {ICONS.compose}
          {!sidebarCollapsed && t('sidebar.compose')}
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflow: 'hidden auto', padding: '4px 8px' }}>
        {/* Unified Inbox — only shown with 2+ enabled accounts */}
        {accounts.filter(a => a.enabled).length >= 2 && (
          <NavItem
            icon={ICONS.inbox}
            label={t('sidebar.allInboxes')}
            active={isUnified && !showContacts}
            collapsed={sidebarCollapsed}
            badge={unreadCounts.total}
            onClick={() => setSelectedAccount(null, 'INBOX')}
          />
        )}

        {/* Favorites section */}
        {!sidebarCollapsed && favoriteFolders.length > 0 && (() => {
          const visibleFaves = favoriteFolders.filter(({ accountId }) => accounts.some(a => a.id === accountId));
          if (!visibleFaves.length) return null;
          return (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-tertiary)', padding: '8px 10px 3px' }}>
                {t('sidebar.favorites', 'Favorites')}
              </div>
              {visibleFaves.map((fav, idx) => {
                const { accountId, path, label } = fav;
                const account = accounts.find(a => a.id === accountId);
                if (!account) return null;
                const accountFolders = folders[accountId] || [];
                const folderObj = accountFolders.find(f => f.path === path);
                const isActive = selectedAccountId === accountId && selectedFolder === path;
                const unreadCount = folderObj?.unread_count || 0;
                const isRenamingThis = renamingFav?.accountId === accountId && renamingFav?.path === path;
                const isDragging = favDragIdx === idx;
                const isDropTarget = favDropIdx === idx && favDragIdx !== null && favDragIdx !== idx;
                const canDrag = visibleFaves.length >= 2;
                return (
                  <div
                    key={`${accountId}:${path}`}
                    className="no-callout"
                    onDragOver={e => {
                      e.preventDefault();
                      if (e.dataTransfer.types.includes('application/x-mailflow-message')) {
                        e.dataTransfer.dropEffect = 'move';
                        setMsgDragTarget(`${accountId}:${path}`);
                      } else if (canDrag) {
                        setFavDropIdx(idx);
                      }
                    }}
                    onDragLeave={e => {
                      if (!e.currentTarget.contains(e.relatedTarget)) setMsgDragTarget(null);
                    }}
                    onDrop={e => {
                      if (e.dataTransfer.types.includes('application/x-mailflow-message')) {
                        handleMsgDrop(e, path);
                        return;
                      }
                      e.preventDefault();
                      if (canDrag && favDragIdx !== null && favDragIdx !== idx) {
                        const fullArr = [...favoriteFolders];
                        const fromItem = visibleFaves[favDragIdx];
                        const toItem = visibleFaves[idx];
                        const fromFullIdx = fullArr.findIndex(f => f.accountId === fromItem.accountId && f.path === fromItem.path);
                        const toFullIdx = fullArr.findIndex(f => f.accountId === toItem.accountId && f.path === toItem.path);
                        if (fromFullIdx !== -1 && toFullIdx !== -1) {
                          const [moved] = fullArr.splice(fromFullIdx, 1);
                          fullArr.splice(toFullIdx, 0, moved);
                          reorderFavoriteFolders(fullArr);
                        }
                      }
                      setFavDragIdx(null);
                      setFavDropIdx(null);
                    }}
                    onDragEnd={canDrag ? () => { setFavDragIdx(null); setFavDropIdx(null); } : undefined}
                    onClick={() => { if (!isRenamingThis) setSelectedAccount(accountId, path); }}
                    onTouchStart={e => {
                      if (isRenamingThis) return;
                      // Prevent iOS from processing this touch natively (drag mode,
                      // text selection, "Copy | Look Up | Translate" callout).
                      // touch-action: pan-y on the row lets the sidebar still scroll
                      // vertically despite this preventDefault call.
                      e.preventDefault();
                      const touch = e.touches[0];
                      const x = touch.clientX;
                      const y = touch.clientY;
                      favTouchStart.current = { x, y };
                      favLongPressTimer.current = setTimeout(() => {
                        favLongPressTimer.current = null;
                        favTouchStart.current = null;
                        window.getSelection()?.removeAllRanges();
                        if (folderObj) {
                          setFolderCtxMenu({ x, y, accountId, folderObj });
                          setAccountCtxMenu(null);
                        }
                      }, 500);
                    }}
                    onTouchMove={e => {
                      if (!favLongPressTimer.current || !favTouchStart.current) return;
                      const touch = e.touches[0];
                      const dx = Math.abs(touch.clientX - favTouchStart.current.x);
                      const dy = Math.abs(touch.clientY - favTouchStart.current.y);
                      if (dx > 10 || dy > 10) {
                        clearTimeout(favLongPressTimer.current);
                        favLongPressTimer.current = null;
                        favTouchStart.current = null;
                      }
                    }}
                    onTouchEnd={() => {
                      if (favLongPressTimer.current) {
                        // Timer still pending → short tap, not a long-press
                        clearTimeout(favLongPressTimer.current);
                        favLongPressTimer.current = null;
                        favTouchStart.current = null;
                        if (!isRenamingThis) setSelectedAccount(accountId, path);
                      }
                    }}
                    onTouchCancel={() => {
                      clearTimeout(favLongPressTimer.current);
                      favLongPressTimer.current = null;
                      favTouchStart.current = null;
                    }}
                    onContextMenu={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Desktop right-click only — touch is fully handled above
                      if (e.pointerType !== 'touch' && folderObj) {
                        setFolderCtxMenu({ x: e.clientX, y: e.clientY, accountId, folderObj });
                        setAccountCtxMenu(null);
                      }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center',
                      gap: 8, padding: '7px 10px',
                      borderRadius: 7, cursor: 'pointer',
                      touchAction: 'pan-y',
                      background: (msgDragTarget === `${accountId}:${path}`) ? 'var(--accent-dim)' : isActive ? 'var(--bg-hover)' : 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      transition: 'background 0.1s, color 0.1s',
                      opacity: isDragging ? 0.4 : 1,
                      borderTop: isDropTarget ? '2px solid var(--accent)' : '2px solid transparent',
                    }}
                    onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-primary)'; } }}
                    onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
                  >
                    {canDrag && (
                      <span
                        draggable={!isMobile}
                        onDragStart={!isMobile ? () => { setFavDragIdx(idx); setFavDropIdx(null); } : undefined}
                        style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex', opacity: 0.4, cursor: isMobile ? 'default' : 'grab' }}
                      >
                        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                          <circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>
                          <circle cx="2" cy="7" r="1.5"/><circle cx="8" cy="7" r="1.5"/>
                          <circle cx="2" cy="12" r="1.5"/><circle cx="8" cy="12" r="1.5"/>
                        </svg>
                      </span>
                    )}
                    <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex' }}>
                      {folderIcon(path, folderObj?.special_use, account.folder_mappings)}
                    </span>
                    {isRenamingThis ? (
                      <input
                        ref={renameFavInputRef}
                        value={renamingFav.value}
                        onChange={e => setRenamingFav(prev => ({ ...prev, value: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            renameFavoriteFolder({ accountId, path, label: renamingFav.value.trim() });
                            setRenamingFav(null);
                          }
                          if (e.key === 'Escape') setRenamingFav(null);
                          e.stopPropagation();
                        }}
                        onBlur={() => setRenamingFav(null)}
                        onClick={e => e.stopPropagation()}
                        style={{
                          flex: 1, fontSize: 13, background: 'var(--bg-primary)',
                          border: '1px solid var(--accent)', borderRadius: 4,
                          color: 'var(--text-primary)', padding: '2px 6px', outline: 'none', minWidth: 0,
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: isActive ? 500 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label || folderObj?.name || path.split('/').pop() || path}
                      </span>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                      {unreadCount > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 8 }}>
                          {unreadCount}
                        </span>
                      )}
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: account.color, flexShrink: 0 }} />
                    </div>
                  </div>
                );
              })}
              {favDragIdx !== null && (
                <div
                  onDragOver={e => { e.preventDefault(); setFavDropIdx(visibleFaves.length); }}
                  onDrop={e => {
                    e.preventDefault();
                    if (favDragIdx !== null && favDragIdx !== visibleFaves.length - 1) {
                      const fullArr = [...favoriteFolders];
                      const fromItem = visibleFaves[favDragIdx];
                      const fromFullIdx = fullArr.findIndex(f => f.accountId === fromItem.accountId && f.path === fromItem.path);
                      if (fromFullIdx !== -1) {
                        const [moved] = fullArr.splice(fromFullIdx, 1);
                        fullArr.push(moved);
                        reorderFavoriteFolders(fullArr);
                      }
                    }
                    setFavDragIdx(null);
                    setFavDropIdx(null);
                  }}
                  style={{ height: 6, borderTop: favDropIdx === visibleFaves.length ? '2px solid var(--accent)' : '2px solid transparent' }}
                />
              )}
              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 4px 4px' }} />
            </>
          );
        })()}

        {/* Per-account */}
        {accounts.map(account => {
          const unread = unreadCounts.byAccount[account.id] || 0;
          const expanded = expandedAccounts[account.id];
          const isSelected = selectedAccountId === account.id;
          const accountFolders = folders[account.id] || [];

          const selectInbox = () => setSelectedAccount(account.id, 'INBOX');
          const rowLabel = collapsedTooltip(account.email_address, sidebarCollapsed);

          return (
            <div key={account.id}>
              {/* Only the collapsed row may carry a button role: expanded, it holds
                  the expand toggle, and a button cannot nest inside a button. */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: sidebarCollapsed ? '8px' : '7px 10px',
                  borderRadius: 7, cursor: 'pointer',
                  background: isSelected && selectedFolder === 'INBOX'
                    ? 'var(--bg-hover)' : 'transparent',
                  transition: 'background 0.1s',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                }}
                onMouseEnter={e => {
                  if (!(isSelected && selectedFolder === 'INBOX'))
                    e.currentTarget.style.background = 'var(--bg-tertiary)';
                }}
                onMouseLeave={e => {
                  if (!(isSelected && selectedFolder === 'INBOX'))
                    e.currentTarget.style.background = 'transparent';
                }}
                onClick={selectInbox}
                onContextMenu={!sidebarCollapsed ? (e) => openAccountCtxMenu(e, account) : undefined}
                title={rowLabel}
                aria-label={rowLabel}
                role={sidebarCollapsed ? 'button' : undefined}
                tabIndex={sidebarCollapsed ? 0 : undefined}
                onKeyDown={sidebarCollapsed ? activateOnKey(selectInbox) : undefined}
              >
                {/* Account indicator */}
                {sidebarCollapsed ? (
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: account.color + '22',
                    border: `1px solid ${account.color}66`,
                    flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 600, color: account.color,
                    outline: account.sync_error ? '2px solid rgba(248,113,113,0.5)' : 'none',
                    userSelect: 'none',
                  }}>
                    {(account.name || account.email_address || '?').charAt(0).toUpperCase()}
                  </div>
                ) : (
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: account.color, flexShrink: 0,
                    boxShadow: account.sync_error ? '0 0 0 2px rgba(248,113,113,0.4)' : 'none',
                  }} />
                )}

                {!sidebarCollapsed && (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, color: 'var(--text-primary)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        fontWeight: unread > 0 ? 500 : 400,
                      }}>
                        {account.name}
                      </div>
                      {!account.sync_error && (
                        <div style={{
                          fontSize: 11, color: 'var(--text-tertiary)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {account.email_address}
                        </div>
                      )}
                      {account.sync_error && (
                        <div style={{ fontSize: 11, color: 'var(--red)' }}>
                          {t('sidebar.connectionError')}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {unread > 0 && (
                        <span style={{
                          fontSize: 11, fontWeight: 600, color: 'white',
                          background: account.color, padding: '1px 6px',
                          borderRadius: 10, minWidth: 20, textAlign: 'center',
                        }}>
                          {unread > 999 ? '999+' : unread}
                        </span>
                      )}
                      {/* Expand toggle */}
                      <button
                        onClick={e => { e.stopPropagation(); toggleAccount(account.id); }}
                        style={{
                          background: 'none', border: 'none', padding: 2,
                          color: 'var(--text-tertiary)', cursor: 'pointer',
                          display: 'flex', alignItems: 'center',
                          transform: expanded ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.15s',
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Folder tree */}
              {expanded && !sidebarCollapsed && (() => {
                const BASE_INDENT = 26;
                const DEPTH_INDENT = 14;

                const createFolderInput = (indent) => (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: `6px 10px 6px ${indent}px`, borderRadius: 7,
                  }}>
                    <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex' }}>{ICONS.folder}</span>
                    <input
                      ref={createInputRef}
                      value={createName}
                      onChange={e => setCreateName(e.target.value)}
                      placeholder={creatingFolder?.parentPath ? t('sidebar.subfolderPh') : t('sidebar.folderPh')}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleCreateFolderSubmit();
                        if (e.key === 'Escape') { setCreatingFolder(null); setCreateName(''); }
                        e.stopPropagation();
                      }}
                      style={{
                        flex: 1, fontSize: 12, background: 'var(--bg-primary)',
                        border: '1px solid var(--accent)', borderRadius: 4,
                        color: 'var(--text-primary)', padding: '2px 6px', outline: 'none', minWidth: 0,
                      }}
                    />
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      <button onClick={handleCreateFolderSubmit} style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: 'var(--accent-text)', padding: '2px 6px', cursor: 'pointer', fontSize: 11 }}>✓</button>
                      <button onClick={() => { setCreatingFolder(null); setCreateName(''); }} style={{ background: 'var(--bg-tertiary)', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', padding: '2px 6px', cursor: 'pointer', fontSize: 11 }}>✕</button>
                    </div>
                  </div>
                );

                const accountHiddenPaths = hiddenFolders[account.id] || [];
                const showingHidden = showHiddenFor.has(account.id);

                const renderNode = (node, depth) => {
                  const { children, ...folder } = node;
                  const isHidden = accountHiddenPaths.includes(folder.path);
                  if (isHidden && !showingHidden) return null;

                  const isRenaming = renamingFolder?.accountId === account.id && renamingFolder?.path === folder.path;
                  const isFolderSelected = selectedAccountId === account.id && selectedFolder === folder.path;
                  const visibleChildren = showingHidden ? children : children.filter(c => !accountHiddenPaths.includes(c.path));
                  const hasChildren = visibleChildren.length > 0;
                  const collapseKey = `${account.id}:${folder.path}`;
                  const isExpanded = !collapsedFolders.includes(collapseKey);
                  const indent = BASE_INDENT + depth * DEPTH_INDENT;

                  return (
                    <div key={folder.path} style={isHidden ? { opacity: 0.45 } : undefined}>
                      <div
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: `6px 10px 6px ${indent}px`, borderRadius: 7,
                          cursor: isRenaming ? 'default' : 'pointer',
                          background: (msgDragTarget === `${account.id}:${folder.path}`) ? 'var(--accent-dim)' : isFolderSelected ? 'var(--bg-hover)' : 'transparent',
                          transition: 'background 0.1s',
                        }}
                        onMouseEnter={e => { if (!isFolderSelected && !isRenaming) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                        onMouseLeave={e => { if (!isFolderSelected) e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => !isRenaming && setSelectedAccount(account.id, folder.path)}
                        onContextMenu={e => openFolderCtxMenu(e, account.id, folder)}
                        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setMsgDragTarget(`${account.id}:${folder.path}`); }}
                        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setMsgDragTarget(null); }}
                        onDrop={e => handleMsgDrop(e, folder.path)}
                      >
                        {/* Chevron toggle for parent folders; invisible spacer for leaf folders to align icons */}
                        {hasChildren ? (
                          <button
                            onClick={e => { e.stopPropagation(); toggleCollapsedFolder(account.id, folder.path); }}
                            style={{
                              background: 'none', border: 'none', padding: 2, margin: 0, flexShrink: 0,
                              color: 'var(--text-tertiary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center',
                              transform: isExpanded ? 'rotate(90deg)' : 'none',
                              transition: 'transform 0.15s',
                            }}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                          </button>
                        ) : (
                          <span style={{ width: 14, flexShrink: 0 }} />
                        )}

                        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex' }}>
                          {folderIcon(folder.path, folder.special_use, account.folder_mappings)}
                        </span>

                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            value={renamingFolder.value}
                            onChange={e => setRenamingFolder(prev => ({ ...prev, value: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleRenameSubmit();
                              if (e.key === 'Escape') setRenamingFolder(null);
                              e.stopPropagation();
                            }}
                            onClick={e => e.stopPropagation()}
                            style={{
                              flex: 1, fontSize: 12, background: 'var(--bg-primary)',
                              border: '1px solid var(--accent)', borderRadius: 4,
                              color: 'var(--text-primary)', padding: '2px 6px', outline: 'none', minWidth: 0,
                            }}
                          />
                        ) : (
                          <span style={{
                            fontSize: 12, color: 'var(--text-secondary)',
                            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {folder.name}
                          </span>
                        )}

                        {isRenaming ? (
                          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                            <button onClick={handleRenameSubmit} disabled={folderOpLoading} style={{ background: 'var(--accent)', border: 'none', borderRadius: 4, color: 'var(--accent-text)', padding: '2px 6px', cursor: 'pointer', fontSize: 11 }}>
                              {folderOpLoading ? '…' : '✓'}
                            </button>
                            <button onClick={() => setRenamingFolder(null)} style={{ background: 'var(--bg-tertiary)', border: 'none', borderRadius: 4, color: 'var(--text-secondary)', padding: '2px 6px', cursor: 'pointer', fontSize: 11 }}>✕</button>
                          </div>
                        ) : (
                          folder.unread_count > 0 && (
                            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 8, flexShrink: 0 }}>
                              {folder.unread_count}
                            </span>
                          )
                        )}
                      </div>

                      {/* Children — shown when expanded */}
                      {hasChildren && isExpanded && (
                        <>
                          {visibleChildren.map(child => renderNode(child, depth + 1))}
                          {creatingFolder?.accountId === account.id && creatingFolder?.parentPath === folder.path &&
                            createFolderInput(BASE_INDENT + (depth + 1) * DEPTH_INDENT)}
                        </>
                      )}
                    </div>
                  );
                };

                const tree = buildFolderTree(accountFolders);
                return (
                  <div>
                    {tree.map(node => renderNode(node, 0))}
                    {/* Show/hide hidden folders toggle */}
                    {accountHiddenPaths.length > 0 && (
                      <button
                        onClick={() => toggleShowHidden(account.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '4px 10px 4px 26px', borderRadius: 7,
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: showingHidden ? 'var(--accent)' : 'var(--text-tertiary)',
                          fontSize: 11, width: '100%', transition: 'color 0.1s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = showingHidden ? 'var(--accent)' : 'var(--text-secondary)'}
                        onMouseLeave={e => e.currentTarget.style.color = showingHidden ? 'var(--accent)' : 'var(--text-tertiary)'}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          {showingHidden
                            ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                            : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>
                          }
                        </svg>
                        {showingHidden ? t('sidebar.hideHidden') : t('sidebar.hiddenFolders', { count: accountHiddenPaths.length })}
                      </button>
                    )}
                    {/* Root-level create or "New folder" button */}
                    {creatingFolder?.accountId === account.id && !creatingFolder?.parentPath
                      ? createFolderInput(BASE_INDENT)
                      : (
                        <button
                          onClick={() => handleStartCreateFolder(account.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '5px 10px 5px 26px', borderRadius: 7,
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--text-tertiary)', fontSize: 11, width: '100%',
                            transition: 'color 0.1s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                          {t('sidebar.newFolder')}
                        </button>
                      )
                    }
                  </div>
                );
              })()}
            </div>
          );
        })}
      </nav>

      {/* Bottom — mobile: inline user section; desktop: user menu button */}
      {isMobile ? (
        <div style={{ borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          {/* User identity — tap to expand/collapse actions */}
          <div
            onClick={() => setBottomExpanded(prev => !prev)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              paddingTop: 12, paddingLeft: 14, paddingRight: 14,
              paddingBottom: bottomExpanded ? 10 : 'calc(var(--sab) + 10px)',
              cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onTouchEnd={e => e.currentTarget.style.background = ''}
            onTouchCancel={e => e.currentTarget.style.background = ''}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <div style={{
                width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                background: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700, color: 'var(--accent-text)',
              }}>
                {((user?.displayName || user?.username || '?')[0]).toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {user?.displayName || user?.username || 'Account'}
              </div>
              {user?.email && (
                <div style={{
                  fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {user.email}
                </div>
              )}
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ flexShrink: 0, color: 'var(--text-tertiary)', transform: bottomExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>

          {bottomExpanded && (
          <>
          {/* Block remote images */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 14px', cursor: 'default',
          }}>
            <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.blockImages')}</span>
            <button
              onClick={async () => {
                try { await setBlockRemoteImages(!blockRemoteImages); }
                catch { addNotification({ title: t('message.whitelistFail.title') }); }
              }}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: blockRemoteImages ? 'var(--accent)' : 'var(--bg-tertiary)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                background: 'white', transition: 'left 0.2s',
                left: blockRemoteImages ? 18 : 2,
              }} />
            </button>
          </div>

          {/* Search all folders */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 14px', cursor: 'default',
          }}>
            <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                <circle cx="11.5" cy="13.5" r="2.5"/><line x1="15" y1="17" x2="13.3" y2="15.3"/>
              </svg>
            </span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.searchAllFolders')}</span>
            <button
              onClick={() => setSearchAllFolders(!searchAllFolders)}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: searchAllFolders ? 'var(--accent)' : 'var(--bg-tertiary)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                background: 'white', transition: 'left 0.2s',
                left: searchAllFolders ? 18 : 2,
              }} />
            </button>
          </div>

          {/* Edit Profile */}
          <div
            onClick={() => { setShowProfile(true); setMobileSidebarOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 14px', cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onTouchEnd={e => e.currentTarget.style.background = ''}
            onTouchCancel={e => e.currentTarget.style.background = ''}
          >
            <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
              </svg>
            </span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('profile.editProfile')}</span>
          </div>

          {/* Settings */}
          <div
            onClick={() => { setAdminTab('accounts'); setShowAdmin(true); setMobileSidebarOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 14px', cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onTouchEnd={e => e.currentTarget.style.background = ''}
            onTouchCancel={e => e.currentTarget.style.background = ''}
          >
            <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
            </span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.settings')}</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" style={{ flexShrink: 0 }}>
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </div>

          {/* Lock */}
          {user?.hasPassword && (
            <div
              onClick={() => { setMobileSidebarOpen(false); setLocked(true); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px', cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
              onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
              onTouchEnd={e => e.currentTarget.style.background = ''}
              onTouchCancel={e => e.currentTarget.style.background = ''}
            >
              <span style={{ color: 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <rect x="3" y="11" width="18" height="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
              </span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.lock')}</span>
            </div>
          )}

          {/* Sign out */}
          <div
            onClick={handleLogout}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              paddingTop: 8, paddingLeft: 14, paddingRight: 14,
              paddingBottom: 'calc(var(--sab) + 12px)', cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
            onTouchStart={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onTouchEnd={e => e.currentTarget.style.background = ''}
            onTouchCancel={e => e.currentTarget.style.background = ''}
          >
            <span style={{ color: 'var(--red, #f87171)', display: 'flex', flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--red, #f87171)' }}>{t('sidebar.signOut')}</span>
          </div>
          </>
          )}
        </div>
      ) : (
        <>
          <div style={{ padding: '4px 8px', display: 'flex', justifyContent: sidebarCollapsed ? 'center' : 'flex-start' }}>
            <button
              onClick={() => { setShowContacts(!showContacts); if (isMobile) setMobileSidebarOpen(false); }}
              title={t('contacts.title')}
              style={{
                width: 28, height: 28, borderRadius: 7,
                border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: showContacts ? 'var(--bg-hover)' : 'transparent',
                color: showContacts ? 'var(--accent)' : 'var(--text-tertiary)',
                transition: 'background 0.1s, color 0.1s',
              }}
              onMouseEnter={e => { if (!showContacts) { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
              onMouseLeave={e => { if (!showContacts) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; } }}
            >
              {ICONS.contacts}
            </button>
          </div>
          <div style={{ padding: '8px', borderTop: '1px solid var(--border-subtle)' }}>
          <div
            ref={userMenuBtnRef}
            onClick={openUserMenu}
            style={{
              display: 'flex', alignItems: 'center',
              gap: 8, padding: sidebarCollapsed ? '7px' : '7px 10px',
              borderRadius: 8, cursor: 'pointer',
              background: userMenuOpen ? 'var(--bg-hover)' : 'transparent',
              transition: 'background 0.1s',
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            }}
            onMouseEnter={e => { if (!userMenuOpen) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { if (!userMenuOpen) e.currentTarget.style.background = 'transparent'; }}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, color: 'var(--accent-text)',
              }}>
                {((user?.displayName || user?.username || '?')[0]).toUpperCase()}
              </div>
            )}
            {!sidebarCollapsed && (
              <>
                <span style={{
                  flex: 1, fontSize: 13, fontWeight: 500,
                  color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {user?.displayName || user?.username || 'Account'}
                </span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="var(--text-tertiary)" strokeWidth="2" style={{ flexShrink: 0 }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </>
            )}
          </div>
        </div>
        </>
      )}

      {/* User menu — desktop popover */}
      {userMenuOpen && !isMobile && (
        <div
          ref={userMenuPopoverRef}
          style={{
            position: 'fixed',
            bottom: userMenuPos.bottom,
            left: userMenuPos.left,
            width: 230,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            zIndex: 4000,
            boxShadow: 'var(--shadow-modal)',
            overflow: 'hidden',
            animation: 'popover-in var(--motion-fast) var(--ease-emphasized) both',
          }}
        >
          <div style={{ padding: '10px 13px 9px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {user?.displayName || user?.username || 'Account'}
            </div>
            {user?.email && (
              <div style={{
                fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {user.email}
              </div>
            )}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 13px', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ color: 'var(--text-tertiary)', display: 'flex' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.blockImages')}</span>
            </div>
            <button
              onClick={async () => {
                try { await setBlockRemoteImages(!blockRemoteImages); }
                catch { addNotification({ title: t('message.whitelistFail.title') }); }
              }}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: blockRemoteImages ? 'var(--accent)' : 'var(--bg-tertiary)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                background: 'white', transition: 'left 0.2s',
                left: blockRemoteImages ? 18 : 2,
              }} />
            </button>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 13px', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ color: 'var(--text-tertiary)', display: 'flex' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  <circle cx="11.5" cy="13.5" r="2.5"/><line x1="15" y1="17" x2="13.3" y2="15.3"/>
                </svg>
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{t('sidebar.searchAllFolders')}</span>
            </div>
            <button
              onClick={() => setSearchAllFolders(!searchAllFolders)}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: searchAllFolders ? 'var(--accent)' : 'var(--bg-tertiary)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
                background: 'white', transition: 'left 0.2s',
                left: searchAllFolders ? 18 : 2,
              }} />
            </button>
          </div>
          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '2px 0' }} />
          <CtxMenuItem icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>} label={t('profile.editProfile')}
            onClick={() => { setUserMenuOpen(false); setShowProfile(true); }} />
          <CtxMenuItem icon={ICONS.settings} label={t('sidebar.settings')}
            onClick={() => { setAdminTab('accounts'); setShowAdmin(true); setUserMenuOpen(false); }} />
          {user?.hasPassword && (
            <CtxMenuItem
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
              label={t('sidebar.lock')}
              onClick={() => { setUserMenuOpen(false); setLocked(true); }}
            />
          )}
          <CtxMenuItem icon={ICONS.logout} label={t('sidebar.signOut')} danger
            onClick={() => { setUserMenuOpen(false); handleLogout(); }} />
        </div>
      )}


      {/* Context menus */}
      {folderCtxMenu && (
        <SidebarCtxMenu
          x={folderCtxMenu.x}
          y={folderCtxMenu.y}
          title={folderCtxMenu.folderObj.name}
          subtitle={folderCtxMenu.folderObj.path}
          items={buildFolderMenuItems(folderCtxMenu.accountId, folderCtxMenu.folderObj)}
          onClose={() => setFolderCtxMenu(null)}
        />
      )}
      {accountCtxMenu && (
        <SidebarCtxMenu
          x={accountCtxMenu.x}
          y={accountCtxMenu.y}
          title={accountCtxMenu.account.name}
          subtitle={accountCtxMenu.account.email_address}
          items={buildAccountMenuItems(accountCtxMenu.account)}
          onClose={() => setAccountCtxMenu(null)}
        />
      )}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}

      {confirmDialog && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }} onClick={() => setConfirmDialog(null)}>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
            borderRadius: 12, padding: '24px 24px 20px', maxWidth: 360, width: '100%',
            boxShadow: 'var(--shadow-modal)',
          }} onClick={e => e.stopPropagation()}>
            {confirmDialog.account && (
              <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-secondary)' }}>
                {confirmDialog.account}
              </p>
            )}
            <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {confirmDialog.message}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDialog(null)} className="btn-press" style={{
                padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-subtle)',
                background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
              }}>{t('common.cancel')}</button>
              <button onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); fn(); }} className="btn-press" style={{
                padding: '7px 16px', borderRadius: 7, border: 'none',
                background: 'var(--red)', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              }}>{t('common.delete')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function NavItem({ icon, label, active, collapsed, badge, onClick }) {
  return (
    <div
      onClick={onClick}
      onKeyDown={activateOnKey(onClick)}
      role="button"
      tabIndex={0}
      title={collapsedTooltip(label, collapsed)}
      aria-label={collapsedTooltip(label, collapsed)}
      style={{
        display: 'flex', alignItems: 'center',
        gap: 8, padding: collapsed ? '9px' : '8px 10px',
        borderRadius: 7, cursor: 'pointer',
        background: active ? 'var(--bg-hover)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        transition: 'background 0.1s, color 0.1s',
        justifyContent: collapsed ? 'center' : 'flex-start',
        position: 'relative',
      }}
      onMouseEnter={e => {
        if (!active) { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-primary)'; }
      }}
      onMouseLeave={e => {
        if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }
      }}
    >
      <span style={{ flexShrink: 0 }}>{icon}</span>
      {!collapsed && (
        <>
          <span style={{ fontSize: 13, fontWeight: active ? 500 : 400, flex: 1 }}>{label}</span>
          {badge > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 600, color: 'var(--accent-text)',
              background: 'var(--accent)', padding: '1px 7px',
              borderRadius: 10, minWidth: 20, textAlign: 'center',
            }}>
              {badge > 999 ? '999+' : badge}
            </span>
          )}
        </>
      )}
      {collapsed && badge > 0 && (
        <div style={{
          position: 'absolute', top: 6, right: 6,
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--accent)',
        }} />
      )}
    </div>
  );
}
