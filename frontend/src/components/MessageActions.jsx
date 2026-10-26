import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { getEffectiveShortcuts, parseModKey, modCompactLabel } from '../utils/defaultShortcuts.js';

// The action buttons of a message, shared by the single-message toolbar (MessagePane) and each
// message of a conversation (ConversationMessageCard), and the icon buttons of the conversation's
// own actions (ConversationPane). The conversation used to draw its own text buttons, and the two
// views drifted apart in look, order and what they offered (#650). Both now draw these.

const svg = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, 'aria-hidden': true };

export const ReplyIcon = () => <svg {...svg}><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>;
export const ReplyAllIcon = () => <svg {...svg}><polyline points="7 17 2 12 7 7"/><polyline points="13 17 8 12 13 7"/><path d="M20 18v-2a4 4 0 00-4-4H2"/></svg>;
export const ForwardIcon = () => <svg {...svg}><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>;
export const ArchiveIcon = () => (
  <svg {...svg}>
    <rect x="2" y="3" width="20" height="5" rx="1"/>
    <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
    <polyline points="9 13 12 16 15 13"/>
    <line x1="12" y1="11" x2="12" y2="16"/>
  </svg>
);
export const MoveIcon = () => <svg {...svg}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
export const SnoozeIcon = () => <svg {...svg}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
export const SpamIcon = () => (
  <svg {...svg}>
    <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);
export const HamIcon = () => (
  <svg {...svg}>
    <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
    <polyline points="9 12 11 14 15 10"/>
  </svg>
);
export const TodoistIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z"/>
  </svg>
);
export const HeadersIcon = () => (
  <svg {...svg}>
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>
);
export const DownloadIcon = () => (
  <svg {...svg}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
export const PrintIcon = () => (
  <svg {...svg}>
    <polyline points="6 9 6 2 18 2 18 9"/>
    <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
    <rect x="6" y="14" width="12" height="8"/>
  </svg>
);
export const AiIcon = () => (
  <svg {...svg} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
    <path d="M5 3v4M19 17v4M3 5h4M17 19h4"/>
  </svg>
);
// Reply with AI: the AI menu's sparkle, alone, so the two buttons side by side tell apart.
export const AiReplyIcon = () => (
  <svg {...svg} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
  </svg>
);
export const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
  </svg>
);
export const ChevronIcon = ({ size = 11, strokeWidth = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
export const StarIcon = ({ filled }) => (
  <svg {...svg} fill={filled ? 'var(--amber)' : 'none'} stroke={filled ? 'var(--amber)' : 'currentColor'}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);
export const TrashIcon = () => (
  <svg {...svg}>
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
  </svg>
);

// The action the read toggle offers: an envelope with an unread dot for "Mark as unread", an
// open envelope for "Mark as read". Same glyphs as the context menu.
export function ReadStateIcon({ isRead }) {
  return isRead ? (
    <svg {...svg}>
      <path style={{ strokeLinecap: 'round' }} d="M22,10.91v7.09c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V6c0-1.1.9-2,2-2h11"/>
      <polyline style={{ strokeLinecap: 'round' }} points="16.36 9.95 12 13 2 6"/>
      <circle style={{ strokeMiterlimit: 10, fill: 'currentColor' }} cx="19.96" cy="6" r="3"/>
    </svg>
  ) : (
    <svg {...svg}>
      <path style={{ strokeLinecap: 'round' }} d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/>
      <polyline points="22 9 12 16 2 9"/><polyline points="2 9 12 2 22 9"/>
    </svg>
  );
}

// A sun to go back to the original colors, a moon to show it dark.
export function DarkToggleIcon({ shownDark }) {
  return shownDark ? (
    <svg {...svg}>
      <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
    </svg>
  ) : (
    <svg {...svg}><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
  );
}

// A tooltip with the action's keyboard shortcut, as "Archive (E)". A phone has no keyboard to speak of,
// so there it is the label alone.
export function useShortcutTitle() {
  const shortcuts = useStore(s => s.shortcuts);
  const isMobile = useMobile();
  return (label, action) => {
    const key = getEffectiveShortcuts(shortcuts)[action];
    if (isMobile || !key) return label;
    const mod = parseModKey(key);
    return `${label} (${mod ? `${modCompactLabel(mod.mod)}${mod.bare.toUpperCase()}` : key.toUpperCase()})`;
  };
}

// On a phone every button is at least 44 px square, the touch target iOS and Android ask for.
export const TOUCH_TARGET = 44;

// An icon button. `label` is its accessible name, `title` its tooltip, which may add the keyboard
// shortcut. `disabled` is aria-disabled with the click ignored, not the native attribute, so the
// title still shows on hover: it is what explains why.
export function ActionBtn({
  children, onClick, label, title, danger, style: extraStyle, pressed, disabled = false, touch = false,
  popup = false, expanded, btnRef,
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      ref={btnRef}
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      aria-haspopup={popup ? 'menu' : undefined}
      aria-expanded={popup ? Boolean(expanded) : undefined}
      aria-disabled={disabled || undefined}
      className="btn-press"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--bg-tertiary)') : 'transparent',
        border: '1px solid ' + (hov ? (danger ? 'rgba(248,113,113,0.3)' : 'var(--border)') : 'transparent'),
        borderRadius: 6, padding: '6px 8px',
        color: danger ? (hov ? 'var(--red)' : 'var(--text-tertiary)') : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer', fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        transition: 'all 0.1s',
        opacity: disabled ? 0.45 : 1,
        ...(touch ? { minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET } : {}),
        ...extraStyle,
      }}
    >
      {children}
    </button>
  );
}

// A menu opened from a button, with the keyboard contract of role="menu": focus moves to the first
// item on open; Arrow Up and Down move between the items, wrapping, and Home and End go to the ends;
// Escape, a click outside or picking an item closes it and puts focus back on the button; Tab
// closes it and lets focus move on. `children(choose)`: choose(run) closes, refocuses, then runs.
// closeOnMouseLeave closes it, the same way, when the pointer leaves it.
function MenuPopup({ triggerRef, onClose, zIndex, style, closeOnMouseLeave = false, children }) {
  const menuRef = useRef(null);
  const items = () => [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
  useEffect(() => { items()[0]?.focus(); }, []);
  const close = (refocus = true) => {
    onClose();
    if (refocus) triggerRef.current?.focus();
  };
  const choose = run => {
    close();
    run();
  };
  const onKeyDown = e => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    const go = i => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at < 0 ? list.length - 1 : at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
      default: break;
    }
  };
  return (
    <>
      <div onClick={() => close()} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: zIndex - 1 }} />
      <div ref={menuRef} role="menu" onKeyDown={onKeyDown} onMouseLeave={closeOnMouseLeave ? () => close() : undefined} style={{ position: 'absolute', zIndex, ...style }}>
        {children(choose)}
      </div>
    </>
  );
}

const menuItemStyle = (extra = {}) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
  padding: '11px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
  fontSize: 13, color: 'var(--text-primary)', font: 'inherit', ...extra,
});
const hoverBg = {
  onMouseEnter: e => { e.currentTarget.style.background = 'var(--bg-hover)'; },
  onMouseLeave: e => { e.currentTarget.style.background = 'transparent'; },
};

// Reply, split: the button replies the way the reader's setting says, the arrow offers the other.
export function ReplySplitButton({ defaultReplyAll, onReply, title, touch = false }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const label = defaultReplyAll ? t('message.replyAll') : t('message.reply');
  const other = defaultReplyAll
    ? { label: t('message.reply'), replyAll: false }
    : { label: t('message.replyAll'), replyAll: true };
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <ActionBtn onClick={() => { setOpen(false); onReply(defaultReplyAll); }} label={label} title={title ?? label} touch={touch} style={{ borderRadius: '6px 0 0 6px' }}>
        {defaultReplyAll ? <ReplyAllIcon /> : <ReplyIcon />}
      </ActionBtn>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        title={t('message.replyOptions')}
        aria-label={t('message.replyOptions')}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          background: 'transparent', border: '1px solid transparent',
          borderLeft: '1px solid var(--border-subtle)',
          borderRadius: '0 6px 6px 0', padding: '5px 6px',
          color: 'var(--text-secondary)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          ...(touch ? { minWidth: 28, minHeight: TOUCH_TARGET } : {}),
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <ChevronIcon />
      </button>
      {open && (
        <MenuPopup
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          zIndex={100}
          closeOnMouseLeave
          style={{
            top: '100%', left: 0, marginTop: 4,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: 150,
          }}
        >
          {choose => (
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(() => onReply(other.replyAll))}
              style={menuItemStyle({ padding: '9px 14px', minHeight: touch ? TOUCH_TARGET : undefined })}
              {...hoverBg}
            >
              {other.label}
            </button>
          )}
        </MenuPopup>
      )}
    </div>
  );
}

// The AI actions dropdown: the built-in summary, the reader's own actions, and a way to manage them.
function AiMenuButton({ ai, touch }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const item = (choose, key, label, run, muted = false) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      onClick={() => choose(run)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%',
        padding: '8px 10px', cursor: 'pointer', fontSize: 13, borderRadius: 6, border: 'none',
        background: 'transparent', font: 'inherit', textAlign: 'left',
        color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
        minHeight: touch ? TOUCH_TARGET : undefined,
      }}
      {...hoverBg}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {ai.results?.[key]?.status === 'done' && <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--accent)', flexShrink: 0 }}>●</span>}
    </button>
  );
  return (
    <div style={{ position: 'relative' }}>
      <ActionBtn btnRef={triggerRef} onClick={() => setOpen(v => !v)} label={t('message.aiActions')} touch={touch} popup expanded={open}
        style={Object.keys(ai.results || {}).length ? { color: 'var(--accent)' } : {}}>
        <AiIcon />
        <ChevronIcon strokeWidth={2.5} />
      </ActionBtn>
      {open && (
        <MenuPopup
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          zIndex={50}
          style={{
            top: '100%', right: 0, marginTop: 6, minWidth: 220,
            background: 'var(--bg-elevated, var(--bg-secondary))', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.25)', padding: 4,
          }}
        >
          {choose => <>
            {ai.items.map(a => item(choose, a.id, a.label, () => ai.onRun(a)))}
            {ai.onManage && <>
              <div role="separator" style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
              {item(choose, '__manage', t('message.manageAiActions'), ai.onManage, true)}
            </>}
          </>}
        </MenuPopup>
      )}
    </div>
  );
}

// The phone More menu's order, the reading pane's since before the views shared these buttons: the
// read toggle first, as the action reached for most. Reply with AI is a toolbar button on a desktop.
export const MORE_MENU_ORDER = ['read', 'aiReply', 'spam', 'ham', 'todoist', 'headers', 'print', 'dark', 'eml'];

// The message's tools: buttons on a desktop, a More menu on a phone, where the toolbar has no room.
//
// items: [{ key, label, title?, icon, onClick, disabled?, pressed? }], in toolbar order; the More
// menu lists them in MORE_MENU_ORDER. ai: null, or { items, results, onRun, onManage? }: the AI
// dropdown on a desktop, its actions as menu items on a phone.
export function MessageTools({ isMobile, items, ai = null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  if (!isMobile) {
    return (
      <>
        {items.map(item => (
          <ActionBtn key={item.key} onClick={item.onClick} label={item.label} title={item.title}
            pressed={item.pressed} disabled={item.disabled}>
            {item.icon}
          </ActionBtn>
        ))}
        {ai && <AiMenuButton ai={ai} />}
      </>
    );
  }
  const rank = key => (MORE_MENU_ORDER.includes(key) ? MORE_MENU_ORDER.indexOf(key) : MORE_MENU_ORDER.length);
  const menuItems = [...items].sort((a, b) => rank(a.key) - rank(b.key));
  const aiItems = ai ? ai.items : [];
  const all = [
    ...menuItems.map(item => ({
      key: item.key, label: item.label, icon: item.icon, disabled: item.disabled, run: item.onClick,
    })),
    ...aiItems.map(a => ({ key: `ai-${a.id}`, label: a.label, icon: <AiIcon />, run: () => ai.onRun(a) })),
  ];
  return (
    <div style={{ position: 'relative' }}>
      <ActionBtn btnRef={triggerRef} onClick={() => setOpen(v => !v)} label={t('message.more')} touch popup expanded={open}>
        <MoreIcon />
      </ActionBtn>
      {open && (
        <MenuPopup
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          zIndex={100}
          style={{
            top: '100%', right: 0, marginTop: 4,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: 190,
          }}
        >
          {choose => all.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              onClick={() => choose(() => { if (!item.disabled) item.run(); })}
              style={menuItemStyle({
                minHeight: TOUCH_TARGET,
                cursor: item.disabled ? 'default' : 'pointer',
                opacity: item.disabled ? 0.55 : 1,
                borderBottom: i < all.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              })}
              {...hoverBg}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </MenuPopup>
      )}
    </div>
  );
}

const noticeStyle = accent => ({
  marginBottom: 10, padding: '9px 14px',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderLeft: `3px solid ${accent}`,
  borderRadius: 8,
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  fontSize: 12, color: 'var(--text-secondary)',
});

// Remote images were blocked: load them for this message, or always for the sender or its domain.
export function RemoteImagesNotice({ fromEmail, onLoad, onAllowSender, onAllowDomain, saving = false }) {
  const { t } = useTranslation();
  const domain = fromEmail?.includes('@') ? fromEmail.split('@')[1] : '';
  return (
    <div className="msg-notice" style={noticeStyle('var(--accent)')}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }} aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <span>{t('message.remoteImagesBlocked')}</span>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
        {[
          { label: t('message.loadImages'), handler: onLoad, disabled: false },
          fromEmail && { label: t('message.allowSender', { email: fromEmail }), handler: onAllowSender, disabled: saving },
          domain && { label: t('message.allowDomain', { domain }), handler: onAllowDomain, disabled: saving },
        ].filter(Boolean).map(({ label, handler, disabled }) => (
          <button key={label} type="button" onClick={handler} disabled={disabled}
            style={{
              background: 'none', border: '1px solid var(--border)',
              borderRadius: 5, padding: '3px 9px', cursor: disabled ? 'default' : 'pointer',
              color: 'var(--accent)', fontSize: 11, fontWeight: 500,
              opacity: disabled ? 0.5 : 1,
            }}
            onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >{label}</button>
        ))}
      </div>
    </div>
  );
}

// A newsletter with a List-Unsubscribe header. status: null | 'loading' | 'error'.
export function UnsubscribeNotice({ status, onUnsubscribe }) {
  const { t } = useTranslation();
  return (
    <div className="msg-notice" style={noticeStyle('var(--text-tertiary)')}>
      <span style={{ flex: 1 }}>{t('message.unsubscribe.info')}</span>
      <button
        type="button"
        onClick={onUnsubscribe}
        disabled={status === 'loading'}
        style={{
          background: 'none', border: '1px solid var(--border)',
          borderRadius: 5, padding: '3px 9px',
          cursor: status === 'loading' ? 'default' : 'pointer',
          color: status === 'error' ? 'var(--red, #e53e3e)' : 'var(--text-primary)',
          fontSize: 11, fontWeight: 500,
          opacity: status === 'loading' ? 0.5 : 1,
        }}
      >
        {status === 'loading' ? t('common.loading') :
         status === 'error' ? t('message.unsubscribe.error') :
         t('message.unsubscribe.button')}
      </button>
    </div>
  );
}
