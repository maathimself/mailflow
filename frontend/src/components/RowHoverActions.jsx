import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginSlot } from '../plugins/PluginSlot.jsx';

// Bottom-right hover quick-actions cluster shared by the flat MessageRow and the threaded
// ThreadRow and GTD sidebar rows. Presentational and closure-free: each action
// is a handler the caller passes as (e, message); a handler's absence hides its button (the
// same convention onMove already used, now generalized). `isRead` drives the mark-read
// icon/label polarity, and `background` + `deleteTitleKey` keep each call site's prior
// rendering byte-identical. `rowActionCtx`, when present (main-list rows only), renders the
// 'row-hover-action' plugin slot — a plugin can add its own leading hover button (GTD adds
// a "done" checkmark). Sidebar rows omit it.
//
// #440: `actions` picks WHICH buttons show, in canonical order. Callers that pass nothing
// (the GTD sidebar rows) keep the pre-#440 cluster exactly; the main list passes the
// user's configured set from Settings. A key whose handler the caller did not supply is
// skipped either way, so a set naming 'snooze' is inert on a surface with no snooze.

import { DEFAULT_HOVER_ACTIONS } from '../utils/hoverActions.js';
export { HOVER_ACTION_KEYS, DEFAULT_HOVER_ACTIONS } from '../utils/hoverActions.js';

export default function RowHoverActions({ message, isRead, background, deleteTitleKey = 'common.delete', onMarkRead, onStar, onArchive, onSnooze, onDelete, onMove, actions = DEFAULT_HOVER_ACTIONS, rowActionCtx }) {
  const { t } = useTranslation();

  const buttons = {
    markRead: onMarkRead && (
      <ActionBtn
        key="markRead"
        title={isRead ? t('contextMenu.markUnread') : t('contextMenu.markRead')}
        onClick={e => onMarkRead(e, message)}
      >
        {isRead ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path style={{ strokeLinecap: 'round' }} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/><polyline style={{ strokeLinecap: 'round' }} points="16.36 9.95 12 13 2 6"/><circle style={{ strokeMiterlimit: 10, fill: 'currentColor' }} cx="19.96" cy="6" r="3"/>
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path style={{ strokeLinecap: 'round' }} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9" /><polyline points="2 9 12 2 22 9" />
          </svg>
        )}
      </ActionBtn>
    ),
    star: onStar && (
      <ActionBtn key="star" title={message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star')} onClick={e => onStar(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24"
          fill={message.is_starred ? 'var(--amber)' : 'none'}
          stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </ActionBtn>
    ),
    archive: onArchive && (
      <ActionBtn key="archive" title={t('shortcuts.actions.archive.label')} onClick={e => onArchive(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="5" rx="1"/>
          <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
          <polyline points="9 13 12 16 15 13"/>
          <line x1="12" y1="11" x2="12" y2="16"/>
        </svg>
      </ActionBtn>
    ),
    snooze: onSnooze && (
      <ActionBtn key="snooze" title={t('contextMenu.snooze.label')} onClick={e => onSnooze(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      </ActionBtn>
    ),
    delete: onDelete && (
      <ActionBtn key="delete" title={t(deleteTitleKey)} onClick={e => onDelete(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
      </ActionBtn>
    ),
    move: onMove && (
      <ActionBtn key="move" title={t('contextMenu.moveToFolder')} onClick={e => onMove(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
        </svg>
      </ActionBtn>
    ),
  };

  return (
    <div style={{
      position: 'absolute', bottom: 6, right: 8,
      display: 'flex', alignItems: 'center', gap: 2,
      background,
      borderRadius: 5,
      padding: '1px 2px',
    }}>
      {rowActionCtx && <PluginSlot name="row-hover-action" ctx={rowActionCtx} />}
      {actions.map(key => buttons[key] || null)}
    </div>
  );
}

export function ActionBtn({ children, onClick, title }) {
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
