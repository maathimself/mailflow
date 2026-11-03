import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { useUiScale, descale } from '../hooks/useUiScale.js';
import { DEFAULT_LIST_ORDER, LIST_SORTS, isDefaultListOrder, listOrderFor, pickListSort } from '../utils/listSort.js';

const SORT_LABEL_KEYS = { date: 'messageList.sortDate', from: 'messageList.sortSender', subject: 'messageList.sortSubject' };

// What the button says when the folder is not in the default order, so a sorted list never reads
// as an Inbox with its newest mail missing: "Sender, A to Z", "Starred on top".
export function listOrderLabel(order, t) {
  const parts = [];
  if (order.sort !== 'date' || order.dir !== 'desc') {
    parts.push(t('messageList.sortSummary', {
      sort: t(SORT_LABEL_KEYS[order.sort]),
      dir: t(directionKey(order.sort, order.dir)),
    }));
  }
  if (order.starredFirst) parts.push(t('messageList.starredOnTop'));
  return parts.join(' · ');
}

function directionKey(sort, dir) {
  if (sort === 'date') return dir === 'asc' ? 'messageList.sortOldestFirst' : 'messageList.sortNewestFirst';
  return dir === 'asc' ? 'messageList.sortAToZ' : 'messageList.sortZToA';
}

// The list header's sort button and menu (#528, #196). Each folder keeps its own order.
export default function ListSortMenu({ accountId, folder, compact = false }) {
  const { t } = useTranslation();
  const uiScale = useUiScale();
  const orderKey = useStore(s => JSON.stringify(listOrderFor(s.listSort, accountId, folder)));
  const order = useMemo(() => JSON.parse(orderKey), [orderKey]);
  const setListOrder = useStore(s => s.setListOrder);
  const [pos, setPos] = useState(null);
  const [left, setLeft] = useState(null);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const open = pos !== null;
  const custom = !isDefaultListOrder(order);
  const summary = custom ? listOrderLabel(order, t) : '';

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // The list's own Escape clears its selection; closing the menu is all this press means.
      e.stopPropagation();
      setPos(null);
      buttonRef.current?.focus();
    };
    const onPointer = (e) => { if (!wrapRef.current?.contains(e.target)) setPos(null); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Under the button, its right edge on the button's, but kept on screen: on a phone the button
  // sits left of the middle and a right-aligned menu ran off the left edge.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) { setLeft(null); return; }
    const width = menuRef.current.getBoundingClientRect().width;
    setLeft(Math.max(8, Math.min(pos.anchorRight - width, window.innerWidth - width - 8)));
  }, [open, pos]);

  const toggle = () => {
    if (open) { setPos(null); return; }
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, anchorRight: rect.right });
  };
  const choose = (next) => setListOrder(accountId, folder, next);

  const item = (key, checked, label, onSelect, role = 'menuitemradio') => (
    <button
      key={key}
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onSelect}
      onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: compact ? '10px 14px' : '7px 12px', minHeight: compact ? 44 : undefined,
        background: checked ? 'var(--accent-dim)' : 'transparent', border: 'none', textAlign: 'left',
        color: checked ? 'var(--accent)' : 'var(--text-primary)', fontWeight: checked ? 500 : 400,
        fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {checked && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </button>
  );
  const heading = (text) => (
    <div role="presentation" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', padding: '6px 12px 4px' }}>
      {text}
    </div>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={custom ? t('messageList.sortedBy', { order: summary }) : t('messageList.sort')}
        title={custom ? t('messageList.sortedBy', { order: summary }) : t('messageList.sort')}
        style={{
          background: open || custom ? 'var(--accent-dim)' : 'none',
          border: `1px solid ${open || custom ? 'var(--accent)' : compact ? 'transparent' : 'var(--border)'}`,
          borderRadius: 6, padding: compact ? '5px 7px' : '4px 8px',
          color: open || custom ? 'var(--accent)' : 'var(--text-tertiary)',
          cursor: 'pointer', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 5, maxWidth: 220,
          minHeight: compact ? 44 : undefined, minWidth: compact ? 44 : undefined, justifyContent: 'center',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M7 4v16M3 16l4 4 4-4"/><path d="M14 6h7M14 12h5M14 18h3"/>
        </svg>
        {!compact && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {custom ? summary : t('messageList.sort')}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('messageList.sort')}
          style={{
            position: 'fixed', top: descale(pos.top, uiScale), left: descale(left ?? 0, uiScale),
            visibility: left === null ? 'hidden' : 'visible',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: 'var(--shadow-popover)', minWidth: 200, zIndex: 1000, padding: '4px 0',
          }}
        >
          {heading(t('messageList.sortBy'))}
          {LIST_SORTS.map(sort => item(`sort-${sort}`, order.sort === sort, t(SORT_LABEL_KEYS[sort]),
            () => choose(pickListSort(order, sort))))}
          <div role="separator" style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {['desc', 'asc'].map(dir => item(`dir-${dir}`, order.dir === dir,
            t(directionKey(order.sort, dir)), () => choose({ ...order, dir })))}
          <div role="separator" style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {item('starred', order.starredFirst, t('messageList.starredOnTop'),
            () => choose({ ...order, starredFirst: !order.starredFirst }), 'menuitemcheckbox')}
          {custom && (
            <>
              <div role="separator" style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <button
                type="button"
                role="menuitem"
                onClick={() => { choose(DEFAULT_LIST_ORDER); setPos(null); }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                style={{
                  display: 'block', width: '100%', padding: compact ? '10px 14px' : '7px 12px',
                  minHeight: compact ? 44 : undefined, background: 'transparent', border: 'none',
                  textAlign: 'left', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {t('messageList.sortReset')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
