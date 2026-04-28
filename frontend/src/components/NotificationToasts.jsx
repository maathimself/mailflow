import { useEffect, useState } from 'react';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';

export default function NotificationToasts() {
  const { notifications, removeNotification } = useStore();
  const isMobile = useMobile();

  return (
    <div style={{
      position: 'fixed',
      bottom: isMobile ? 'calc(var(--sab) + 80px)' : 24,
      ...(isMobile
        ? { left: 16, right: 16, alignItems: 'stretch' }
        : { right: 24, alignItems: 'flex-end' }
      ),
      display: 'flex', flexDirection: 'column-reverse', gap: 8,
      zIndex: 3000, pointerEvents: 'none',
    }}>
      {notifications.map(n => (
        <Toast key={n.id} notification={n} onDismiss={() => removeNotification(n.id)} isMobile={isMobile} />
      ))}
    </div>
  );
}

function Toast({ notification, onDismiss, isMobile }) {
  const [exiting, setExiting] = useState(false);

  const dismiss = () => {
    setExiting(true);
    setTimeout(onDismiss, 190);
  };

  useEffect(() => {
    const t = setTimeout(dismiss, 5000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enterClass = isMobile ? 'toast-enter-mobile' : 'toast-enter';
  const exitClass  = isMobile ? 'toast-exit-mobile'  : 'toast-exit';

  return (
    <div
      className={exiting ? exitClass : enterClass}
      style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '12px 14px',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        maxWidth: isMobile ? '100%' : 320,
        boxShadow: 'var(--shadow-popover)',
        pointerEvents: 'all',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
        background: notification.type === 'error' ? 'rgba(248,113,113,0.15)' : 'var(--accent-dim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: notification.type === 'error' ? 'var(--red)' : 'var(--accent)',
      }}>
        {notification.type === 'error' ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>
          {notification.title}
        </div>
        <div style={{
          fontSize: 12, color: 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {notification.body}
        </div>
      </div>
      <button
        onClick={dismiss}
        style={{
          background: 'none', border: 'none', color: 'var(--text-tertiary)',
          cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0,
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}
