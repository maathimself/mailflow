import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Bottom-right hover quick-actions cluster shared by the flat MessageRow and the threaded
// ThreadRow and GTD sidebar rows. Presentational and closure-free: each action
// is a handler the caller passes as (e, message); a handler's absence hides its button (the
// same convention onMove already uses). `isRead` drives the mark-read icon/label polarity,
// and `background` + `deleteTitleKey` keep each call site's prior rendering byte-identical.
// `onGtdDone`, when present, adds the GTD "done" checkmark (inbox rows on a GTD-enabled account).
export default function RowHoverActions({ message, isRead, background, deleteTitleKey = 'common.delete', onMarkRead, onStar, onDelete, onMove, onGtdDone }) {
  const { t } = useTranslation();
  return (
    <div style={{
      position: 'absolute', bottom: 6, right: 8,
      display: 'flex', alignItems: 'center', gap: 2,
      background,
      borderRadius: 5,
      padding: '1px 2px',
    }}>
      {onGtdDone && (
        <ActionBtn title={t('gtd.done')} onClick={e => onGtdDone(e, message)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </ActionBtn>
      )}

      <ActionBtn
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

      <ActionBtn title={message.is_starred ? t('contextMenu.unstar') : t('contextMenu.star')} onClick={e => onStar(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24"
          fill={message.is_starred ? 'var(--amber)' : 'none'}
          stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </ActionBtn>

      <ActionBtn title={t(deleteTitleKey)} onClick={e => onDelete(e, message)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
      </ActionBtn>

      {onMove && (
        <ActionBtn title={t('contextMenu.moveToFolder')} onClick={e => onMove(e, message)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </ActionBtn>
      )}
    </div>
  );
}

function ActionBtn({ children, onClick, title }) {
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
