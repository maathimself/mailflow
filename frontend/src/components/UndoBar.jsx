import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UNDO_WINDOW_MS } from '../utils/undoableAction.js';

// The undo bar anchored to the bottom of a list on desktop: the message list's, and the
// Scheduled view's. On phones NotificationToasts shows the same notification as an action bar.
export default function UndoBar({ notification, onDismiss, showTopBorder }) {
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

  // Undo send brings its own window; everything else uses the standard one.
  const windowMs = notification.undoMs ?? UNDO_WINDOW_MS;
  useEffect(() => {
    const timer = setTimeout(dismiss, windowMs);
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
        animation: `action-bar-progress ${windowMs}ms linear forwards`,
      }} />
      <span style={{
        flex: 1, minWidth: 0,
        fontSize: 13, color: 'var(--text-secondary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {notification.title}
      </span>
      {notification.onAction && (
        <button
          onClick={() => { notification.onAction(); dismiss(); }}
          style={{
            background: 'none', border: 'none',
            color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600,
            cursor: 'pointer', padding: '2px 4px', flexShrink: 0,
          }}
        >
          {notification.actionLabel || t('common.view')}
        </button>
      )}
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
