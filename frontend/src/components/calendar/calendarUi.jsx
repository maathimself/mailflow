import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export const PALETTE = ['#4f8df7', '#7c6af7', '#e5548c', '#f0624d', '#f59e42', '#d6b100', '#3fb97f', '#1fb5a5', '#8a6d4f', '#7b8794'];

// A calendar's colour as a wash over the page, so it reads in a light and a dark theme alike.
export const tint = (color, percent) => `color-mix(in srgb, ${color || 'var(--accent)'} ${percent}%, var(--bg-primary))`;

export const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)',
  fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
export const labelStyle = { fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4, display: 'block' };

const ICONS = {
  chevL: <polyline points="15 18 9 12 15 6" />,
  chevR: <polyline points="9 18 15 12 9 6" />,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  close: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></>,
  list: <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>,
  pin: <><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z" /><circle cx="12" cy="10" r="3" /></>,
  repeat: <><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 014-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 01-4 4H3" /></>,
  bell: <><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></>,
  users: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /></>,
  note: <><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
  alert: <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  sync: <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></>,
};

export function Icon({ name, size = 15, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...style }}>
      {ICONS[name]}
    </svg>
  );
}

const BTN = {
  ghost: { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' },
  primary: { background: 'var(--accent)', border: '1px solid transparent', color: 'var(--accent-text)' },
  danger: { background: 'transparent', border: '1px solid var(--red-border, rgba(248,113,113,0.4))', color: 'var(--red, #f87171)' },
  solidDanger: { background: 'var(--red)', border: '1px solid transparent', color: 'white' },
  plain: { background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)' },
};

export function Btn({ kind = 'ghost', style, disabled, ...props }) {
  return (
    <button type="button" className="btn-press" disabled={disabled} {...props} style={{
      ...BTN[kind], borderRadius: 7, fontSize: 12.5, fontWeight: 500, padding: '6px 12px',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, fontFamily: 'inherit',
      whiteSpace: 'nowrap', ...style,
    }} />
  );
}

export function IconBtn({ label, icon, onClick, active, size = 28, iconSize = 16, style, ...rest }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} {...rest}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      style={{
        width: size, height: size, borderRadius: 7, border: 'none', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        background: active ? 'var(--bg-hover)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-secondary)', ...style,
      }}>
      <Icon name={icon} size={iconSize} />
    </button>
  );
}

export function ErrorBox({ children, style }) {
  return (
    <div role="alert" style={{
      padding: '10px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.45,
      background: 'var(--red-dim, rgba(248,113,113,0.1))', border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
      color: 'var(--red, #f87171)', wordBreak: 'break-word', ...style,
    }}>{children}</div>
  );
}

// Centered panel on a desktop, a sheet from the bottom edge on a phone.
export function Modal({ title, onClose, children, footer, width = 480, mobile, label }) {
  const { t } = useTranslation();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector('[data-autofocus]');
    (first || panel)?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); } };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000, background: 'var(--overlay-scrim, rgba(0,0,0,0.5))',
        display: 'flex', alignItems: mobile ? 'flex-end' : 'center', justifyContent: 'center',
        padding: mobile ? 0 : 24, animation: 'backdrop-enter var(--motion-fast) ease both',
      }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={label || title} tabIndex={-1} style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-modal)',
        width: '100%', maxWidth: mobile ? 'none' : width, maxHeight: mobile ? '92%' : 'min(86vh, 760px)',
        borderRadius: mobile ? '16px 16px 0 0' : 12, display: 'flex', flexDirection: 'column', outline: 'none',
        paddingBottom: mobile ? 'var(--sab)' : 0,
        animation: mobile ? 'sheet-enter var(--motion-normal) var(--ease-emphasized) both' : 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
      }}>
        {title && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px 20px', flexShrink: 0 }}>
            <h2 style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0 }}>{title}</h2>
            <IconBtn label={t('common.dismiss')} icon="close" onClick={onClose} size={32} />
          </div>
        )}
        <div style={{ flex: 1, overflow: 'hidden auto', padding: title ? '4px 20px 16px' : '20px', minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '12px 20px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
