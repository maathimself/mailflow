import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { GTD_STATES, GTD_COLORS, resolveAccountGtdFolders, gtdStatesInFolders } from '../utils/gtd.js';
import MessageHeaderModal from './MessageHeaderModal.jsx';

// Module-level regex — spam-name heuristic shared with MessagePane.jsx so
// it isn't recompiled on every render. Mirrors resolveAllSpamPaths on the
// backend; keep these three in sync when adding a new locale.
const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier\s*ind|posta\s*indesiderata)/i;

// ─── Context Menu ─────────────────────────────────────────────────────────────
const CATEGORIES = ['primary', 'newsletter', 'promotion', 'automated', 'social'];

export default function ContextMenu({ x, y, message, onClose, onAction, defaultMoveView = false, variant = 'inbox' }) {
  const { t } = useTranslation();
  // GTD sidebar entries reuse this menu but trim it to a compact triage set:
  // it drops actions that need inbox-list context (select) or MailApp/compose flows the
  // the sidebar cannot cheaply reach (reply/forward/archive/snooze/categorize/rule/blocklist/spam),
  // and adds the GTD "done" checkmark. read/star/move/classify+remove/delete stay.
  const gtdSidebarEntry = variant === 'gtdSidebar';
  const recentFolders = useStore(s => s.recentFolders);
  const favoriteFolders = useStore(s => s.favoriteFolders);
  // Pull the current account so we can render the spam/ham visibility based on
  // folder_mappings.spam + special_use heuristics instead of a fragile name match.
  const account = useStore(s => s.accounts.find(a => a.id === message.account_id));
  const accountFolders = useStore(s => s.folders[message.account_id] || []);
  const categorizationEnabled = useStore(s => s.categorizationEnabled);
  const categorizationActive = categorizationEnabled || !!account?.categorization_enabled;
  // GTD classify is available only for accounts with GTD enabled. "Remove from
  // <state>" is offered only for the states this thread is actually labelled with
  // (its folders[] — present on GTD entries, absent on plain inbox rows).
  const gtdActive = !!account?.gtd_enabled;
  const gtdFolders = resolveAccountGtdFolders(account);
  const gtdRemovableStates = gtdStatesInFolders(message.folders, gtdFolders);
  const menuRef = useRef(null);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [gtdView, setGtdView] = useState(false);
  const [moveView, setMoveView] = useState(defaultMoveView);
  const [moveFolders, setMoveFolders] = useState(null);
  const [moveFoldersLoading, setMoveFoldersLoading] = useState(defaultMoveView);
  const [snoozeView, setSnoozeView] = useState(false);
  const [customSnoozeView, setCustomSnoozeView] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [customTime, setCustomTime] = useState('09:00');
  const [categorizeView, setCategorizeView] = useState(false);
  const [folderSearch, setFolderSearch] = useState('');
  const unreadCount = Number.parseInt(message.unread_count, 10);
  const hasUnread = Number.isFinite(unreadCount) ? unreadCount > 0 : !message.is_read;

  // A folder is "spam-like" when either the user mapped it as spam or the IMAP
  // server tagged it with \Junk special-use. Falls back to a multilingual name
  // heuristic so unconfigured accounts still get sensible context-menu items.
  // Mirrors resolveAllSpamPaths on the backend so server and client agree.
  const spamFolderPaths = (() => {
    const mapped = account?.folder_mappings?.spam;
    if (mapped) return new Set([mapped]);
    return new Set(accountFolders.filter(f =>
      f.special_use === '\\Junk' || SPAM_NAME_RE.test(f.name || '')
    ).map(f => f.path));
  })();
  const inSpamFolder = spamFolderPaths.has(message.folder);

  // Adjust position to stay within viewport
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: Math.max(0, x + rect.width  > vw ? x - rect.width  : x),
      y: Math.max(0, y + rect.height > vh ? y - rect.height : y),
    });
  }, [x, y]);

  // Auto-load folders when opened directly in move mode (e.g. from row folder icon)
  useEffect(() => {
    if (!defaultMoveView) return;
    api.getFolders(message.account_id)
      .then(data => setMoveFolders(Array.isArray(data) ? data : (data.folders || [])))
      .catch(() => setMoveFolders([]))
      .finally(() => setMoveFoldersLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMoveClick = async () => {
    setMoveView(true);
    if (moveFolders) return; // already loaded
    setMoveFoldersLoading(true);
    try {
      const data = await api.getFolders(message.account_id);
      setMoveFolders(Array.isArray(data) ? data : (data.folders || []));
    } catch {
      setMoveFolders([]);
    } finally {
      setMoveFoldersLoading(false);
    }
  };

  // Close on Escape. Outside-click/tap dismissal is handled by the transparent full-screen
  // scrim rendered behind the menu (see the return below), which is strictly more robust than
  // a document click listener: it catches taps inside the email <iframe> (pointer/click events
  // never cross the frame boundary to reach `document`) and it can't be defeated by a row
  // calling stopPropagation() on its click.
  useEffect(() => {
    const handleKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const items = [
    {
      group: 'Message',
      actions: [
        {
          label: t('contextMenu.open'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
          action: () => onAction('open'),
        },
        {
          label: hasUnread ? t('contextMenu.markRead') : t('contextMenu.markUnread'),
          icon: hasUnread
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path style={{strokeLinecap: 'round'}} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9"/><polyline points="2 9 12 2 22 9"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path style={{strokeLinecap: 'round'}} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{strokeLinecap: 'round'}} points="16.36 9.95 12 13 2 6"/><circle style={{strokeMiterlimit: 10, fill: 'currentColor'}} cx="19.96" cy="6" r="3"/></svg>,
          action: () => onAction(hasUnread ? 'markRead' : 'markUnread'),
        },
        {
          label: message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24"
            fill={message.is_starred ? 'var(--amber)' : 'none'}
            stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>,
          action: () => onAction('toggleStar'),
        },
        ...(gtdSidebarEntry ? [] : [{
          label: t('contextMenu.select'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 15 10"/></svg>,
          action: () => onAction('bulkSelect'),
        }]),
      ]
    },
    {
      group: 'Actions',
      actions: [
        ...(gtdSidebarEntry ? [] : [{
          label: t('contextMenu.reply'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>,
          action: () => onAction('reply'),
        },
        {
          label: t('contextMenu.replyAll'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>,
          action: () => onAction('replyAll'),
        },
        {
          label: t('contextMenu.forward'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>,
          action: () => onAction('forward'),
        }]),
        {
          label: t('contextMenu.moveToFolder'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
          action: handleMoveClick,
          keepOpen: true,
          hasSubmenu: true,
        },
        ...(gtdSidebarEntry ? [] : [{
          label: t('contextMenu.archive'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>,
          action: () => onAction('archive'),
        }]),
        ...(message.folder !== 'Snoozed' && !gtdSidebarEntry ? [{
          label: t('contextMenu.snooze.label'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
          action: () => setSnoozeView(true),
          keepOpen: true,
          hasSubmenu: true,
        }] : []),
        ...(categorizationActive && !gtdSidebarEntry ? [{
          label: t('contextMenu.categorize'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
          action: () => setCategorizeView(true),
          keepOpen: true,
          hasSubmenu: true,
        }] : []),
        ...(gtdActive ? [{
          label: t('gtd.title'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
          action: () => setGtdView(true),
          keepOpen: true,
          hasSubmenu: true,
        }] : []),
        // The sidebar's "done" checkmark — mirrors the row's hover cluster. Section-scoped
        // stripping happens in the GTD content's onAction (it knows the entry's section).
        ...(gtdSidebarEntry ? [{
          label: t('gtd.done'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="20 6 9 17 4 12"/></svg>,
          action: () => onAction('gtdDone'),
        }] : []),
        ...(gtdSidebarEntry ? [] : [{
          label: t('contextMenu.createRule'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
          action: () => onAction('createRuleFromMessage'),
        },
        {
          label: t('contextMenu.addToBlockList'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
          action: () => onAction('addToBlockList'),
        }]),
        // Spam / ham are only shown when there's a real destination for the
        // action: "Mark as Spam" when the message isn't already in a spam-like
        // folder, "Mark as Not Spam" when it is. They live next to "Move to
        // folder" so the antispam workflow stays discoverable.
        ...(spamFolderPaths.size > 0 && !inSpamFolder && !gtdSidebarEntry ? [{
          label: t('contextMenu.markAsSpam'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
          action: () => onAction('markSpam'),
        }] : []),
        ...(inSpamFolder && !gtdSidebarEntry ? [{
          label: t('contextMenu.markAsHam'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><polyline points="9 12 11 14 15 10"/></svg>,
          action: () => onAction('markHam'),
        }] : []),
      ]
    },
    ...(gtdSidebarEntry ? [] : [{
      group: 'Copy',
      actions: [
        {
          label: t('contextMenu.copySubject'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
          action: () => { navigator.clipboard.writeText(message.subject || ''); onAction('copy'); },
        },
        {
          label: t('contextMenu.copySender'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
          action: () => { navigator.clipboard.writeText(message.from_email || ''); onAction('copy'); },
        },
      ]
    },
    {
      group: 'View',
      actions: [
        {
          label: t('contextMenu.viewHeaders'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
          action: () => { setShowHeaderModal(true); },
          keepOpen: true,
        },
      ]
    }]),
    {
      group: 'Danger',
      actions: [
        {
          label: t('contextMenu.delete'),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
          action: () => onAction('delete'),
          danger: true,
        },
      ]
    },
  ];

  return (
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 3999 }} />
      <div
        ref={menuRef}
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: pos.x, top: pos.y,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 10, zIndex: 4000,
          boxShadow: 'var(--shadow-modal)',
          width: 320, overflow: 'hidden',
          animation: 'contextMenuIn 0.12s ease',
        }}
      >
        <style>{`
          @keyframes contextMenuIn {
            from { opacity: 0; transform: scale(0.95) translateY(-4px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
          }
        `}</style>

        {/* Message info header */}
        <div style={{
          padding: '10px 14px 8px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            fontSize: 12, fontWeight: 500, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {message.subject || t('common.noSubject')}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {message.from_name
              ? `${message.from_name} <${message.from_email}>`
              : message.from_email}
          </div>
        </div>

        {gtdView ? (
          <>
            <div
              onClick={() => setGtdView(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', cursor: 'pointer',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)', fontSize: 12,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              {t('gtd.title')}
            </div>
            {GTD_STATES.map(state => (
              <div
                key={state}
                onClick={() => { onAction('gtdClassify', state); onClose(); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: GTD_COLORS[state] }} />
                <span style={{ flex: 1 }}>{t(`gtd.state.${state}`)}</span>
              </div>
            ))}
            {gtdRemovableStates.length > 0 && (
              <>
                <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                {gtdRemovableStates.map(state => (
                  <div
                    key={`rm-${state}`}
                    onClick={() => { onAction('gtdRemove', state); onClose(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span style={{ flex: 1 }}>{t('gtd.removeFrom', { state: t(`gtd.state.${state}`) })}</span>
                  </div>
                ))}
              </>
            )}
          </>
        ) : categorizeView ? (
          <>
            <div
              onClick={() => setCategorizeView(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', cursor: 'pointer',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)', fontSize: 12,
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              {t('contextMenu.categorize')}
            </div>
            {CATEGORIES.map(cat => {
              const isCurrent = (message.category || 'primary') === cat;
              return (
                <div
                  key={cat}
                  onClick={() => { if (!isCurrent) { onAction('setCategory', cat); onClose(); } }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '7px 14px', cursor: isCurrent ? 'default' : 'pointer',
                    fontSize: 13, color: isCurrent ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  }}
                  onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ flex: 1 }}>{t(`messageList.categories.${cat}`)}</span>
                  {isCurrent && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </div>
              );
            })}
          </>
        ) : snoozeView ? (
          customSnoozeView ? (
            /* Custom date/time picker */
            <>
              <div
                onClick={() => setCustomSnoozeView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t('contextMenu.snooze.label')}
              </div>
              <div style={{ padding: '10px 14px 12px' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    type="date"
                    value={customDate}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={e => setCustomDate(e.target.value)}
                    style={{
                      flex: 1, background: 'var(--bg-hover)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
                      padding: '5px 6px', outline: 'none', colorScheme: 'dark light',
                    }}
                  />
                  <input
                    type="time"
                    value={customTime}
                    onChange={e => setCustomTime(e.target.value)}
                    style={{
                      width: 80, background: 'var(--bg-hover)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
                      padding: '5px 6px', outline: 'none', colorScheme: 'dark light',
                    }}
                  />
                </div>
                <button
                  disabled={!customDate || !customTime}
                  onClick={() => {
                    const d = new Date(`${customDate}T${customTime}`);
                    if (isNaN(d.getTime())) return;
                    onAction('snooze', d.toISOString());
                    onClose();
                  }}
                  style={{
                    width: '100%', background: 'var(--accent)', color: 'var(--accent-text)',
                    border: 'none', borderRadius: 6, padding: '7px 0',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer',
                    opacity: (!customDate || !customTime) ? 0.5 : 1,
                  }}
                >
                  {t('contextMenu.snooze.label')}
                </button>
              </div>
            </>
          ) : (
            /* Snooze preset picker */
            <>
              <div
                onClick={() => setSnoozeView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t('contextMenu.snooze.label')}
              </div>
              {[
                {
                  label: t('contextMenu.snooze.threeHours'),
                  getDate: () => { const d = new Date(); d.setHours(d.getHours() + 3); return d; },
                },
                {
                  label: t('contextMenu.snooze.tomorrowMorning'),
                  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; },
                },
                {
                  label: t('contextMenu.snooze.nextWeek'),
                  getDate: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; },
                },
              ].map(({ label, getDate }) => (
                <div
                  key={label}
                  onClick={() => { onAction('snooze', getDate().toISOString()); onClose(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {label}
                </div>
              ))}
              <div
                onClick={() => {
                  const d = new Date();
                  d.setDate(d.getDate() + 1);
                  setCustomDate(d.toISOString().slice(0, 10));
                  setCustomTime('09:00');
                  setCustomSnoozeView(true);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                {t('contextMenu.snooze.custom')}
              </div>
            </>
          )
        ) : moveView ? (
          /* Folder picker view */
          <>
            {defaultMoveView ? (
              <div style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 11, fontWeight: 600,
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {t('contextMenu.folders.back')}
              </div>
            ) : (
              <div
                onClick={() => setMoveView(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {t('contextMenu.folders.back')}
              </div>
            )}
            <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
              <input
                autoFocus
                value={folderSearch}
                onChange={e => setFolderSearch(e.target.value)}
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
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {moveFoldersLoading ? (
                <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : moveFolders?.length === 0 ? (
                <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.empty')}
                </div>
              ) : (() => {
                const searchQuery = folderSearch.trim().toLowerCase();
                if (searchQuery) {
                  const filtered = (moveFolders || [])
                    .filter(f => f.path !== message.folder && f.name.toLowerCase().includes(searchQuery));
                  return filtered.length === 0 ? (
                    <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      {t('contextMenu.folders.empty')}
                    </div>
                  ) : (
                    <>
                      {filtered.map(folder => (
                        <FolderMenuItem
                          key={folder.path}
                          folder={folder}
                          onClick={() => { onAction('moveTo', folder.path); onClose(); }}
                        />
                      ))}
                    </>
                  );
                }
                const recentForAccount = recentFolders
                  .filter(r => r.accountId === message.account_id && r.path !== message.folder)
                  .map(r => (moveFolders || []).find(f => f.path === r.path))
                  .filter(Boolean);
                const favoritesForAccount = favoriteFolders
                  .filter(fav => fav.accountId === message.account_id && fav.path !== message.folder)
                  .map(fav => (moveFolders || []).find(f => f.path === fav.path))
                  .filter(Boolean)
                  .filter(f => !recentForAccount.some(r => r.path === f.path));
                return (
                  <>
                    {recentForAccount.length > 0 && (
                      <>
                        <div style={{ padding: '5px 14px 3px', color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {t('contextMenu.folders.recent')}
                        </div>
                        {recentForAccount.map(folder => (
                          <FolderMenuItem
                            key={`recent-${folder.path}`}
                            folder={folder}
                            onClick={() => { onAction('moveTo', folder.path); onClose(); }}
                          />
                        ))}
                        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                      </>
                    )}
                    {favoritesForAccount.length > 0 && (
                      <>
                        <div style={{ padding: '5px 14px 3px', color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {t('contextMenu.folders.favorites')}
                        </div>
                        {favoritesForAccount.map(folder => (
                          <FolderMenuItem
                            key={`fav-${folder.path}`}
                            folder={folder}
                            onClick={() => { onAction('moveTo', folder.path); onClose(); }}
                          />
                        ))}
                        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                      </>
                    )}
                    {(moveFolders || [])
                      .filter(f => f.path !== message.folder)
                      .map(folder => (
                        <FolderMenuItem
                          key={folder.path}
                          folder={folder}
                          onClick={() => { onAction('moveTo', folder.path); onClose(); }}
                        />
                      ))
                    }
                  </>
                );
              })()}
            </div>
          </>
        ) : (
          /* Normal groups */
          <>
            {items.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />}
                {group.actions.map((item, ai) => (
                  <MenuItem
                    key={ai}
                    icon={item.icon}
                    label={item.label}
                    danger={item.danger}
                    hasSubmenu={item.hasSubmenu}
                    onClick={() => {
                      item.action();
                      if (!item.keepOpen) onClose();
                    }}
                  />
                ))}
              </div>
            ))}
            <div style={{ height: 4 }} />
          </>
        )}
      </div>

      {showHeaderModal && (
        <MessageHeaderModal
          messageId={message.id}
          subject={message.subject}
          onClose={() => { setShowHeaderModal(false); onClose(); }}
        />
      )}
    </>
  );
}

function MenuItem({ icon, label, onClick, danger, hasSubmenu }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: 'pointer',
        background: hov ? (danger ? 'rgba(248,113,113,0.08)' : 'var(--bg-hover)') : 'transparent',
        color: danger ? (hov ? 'var(--red)' : 'var(--text-secondary)') : 'var(--text-primary)',
        transition: 'background 0.08s, color 0.08s',
        fontSize: 13,
      }}
    >
      <span style={{ flexShrink: 0, color: danger && hov ? 'var(--red)' : 'var(--text-tertiary)', display: 'flex' }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {hasSubmenu && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      )}
    </div>
  );
}

function FolderMenuItem({ folder, onClick }) {
  const [hov, setHov] = useState(false);
  const su = (folder.special_use || '').toLowerCase();
  const icon = su.includes('sent')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    : su.includes('trash')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
    : su.includes('draft')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
    : su.includes('spam') || su.includes('junk')
    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: 'pointer',
        background: hov ? 'var(--bg-hover)' : 'transparent',
        color: 'var(--text-primary)',
        transition: 'background 0.08s',
        fontSize: 13,
      }}
    >
      <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {folder.name || folder.path}
      </span>
    </div>
  );
}
