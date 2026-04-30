import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { THEMES } from '../themes.js';

const THEME_NAMES = Object.keys(THEMES);

function buildActions({ t, openCompose, setSelectedAccount, setShowAdmin, setAdminTab, theme, setTheme, accounts }) {
  const actions = [
    {
      id: 'compose',
      label: t('commandPalette.actions.compose'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
      run: () => openCompose({}),
    },
    {
      id: 'inbox',
      label: t('commandPalette.actions.inbox'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>,
      run: () => setSelectedAccount(null, 'INBOX'),
    },
    {
      id: 'settings',
      label: t('commandPalette.actions.settings'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
      run: () => { setShowAdmin(true); setAdminTab('accounts'); },
    },
    {
      id: 'themes',
      label: t('commandPalette.actions.themes'),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 010 20"/><path d="M12 2v20"/></svg>,
      run: () => { setShowAdmin(true); setAdminTab('appearance'); },
    },
  ];

  // Theme switch actions
  for (const themeKey of THEME_NAMES) {
    const label = THEMES[themeKey]?.label || themeKey;
    actions.push({
      id: `theme:${themeKey}`,
      label: t('commandPalette.actions.switchTheme', { theme: label }),
      icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
      active: theme === themeKey,
      run: () => setTheme(themeKey),
    });
  }

  // Per-account inbox shortcuts
  for (const a of accounts) {
    actions.push({
      id: `account:${a.id}`,
      label: t('commandPalette.actions.accountInbox', { name: a.name }),
      icon: <span style={{ width: 15, height: 15, borderRadius: '50%', background: a.color || '#6366f1', display: 'inline-block', flexShrink: 0 }} />,
      run: () => setSelectedAccount(a.id, 'INBOX'),
    });
  }

  return actions;
}

export default function CommandPalette({ open, onClose }) {
  const { t } = useTranslation();
  const { openCompose, setSelectedAccount, setShowAdmin, setAdminTab, theme, setTheme, accounts } = useStore();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [listScrolled, setListScrolled] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const actions = buildActions({ t, openCompose, setSelectedAccount, setShowAdmin, setAdminTab, theme, setTheme, accounts });

  const filtered = query.trim()
    ? actions.filter(a => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions;

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  const runAction = useCallback((action) => {
    action.run();
    onClose();
  }, [onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIdx]) runAction(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 12, width: '100%', maxWidth: 520, margin: '0 16px',
          boxShadow: 'var(--shadow-modal)',
          overflow: 'hidden',
          animation: 'compose-enter 0.15s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('commandPalette.placeholder')}
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: 15,
            }}
          />
          <kbd style={{
            fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px',
          }}>Esc</kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          onScroll={e => setListScrolled(e.currentTarget.scrollTop > 4)}
          style={{
            maxHeight: 360, overflowY: 'auto', padding: '6px 0',
            boxShadow: listScrolled ? 'inset 0 8px 8px -8px rgba(0,0,0,0.25)' : 'none',
            transition: 'box-shadow 0.2s ease',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '20px 16px', color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center' }}>
              {t('commandPalette.noResults')}
            </div>
          ) : filtered.map((action, i) => (
            <div
              key={action.id}
              onClick={() => runAction(action)}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.98)'; }}
              onMouseUp={e => { e.currentTarget.style.transform = ''; }}
              onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '9px 16px', cursor: 'pointer',
                background: i === activeIdx ? 'var(--bg-hover)' : 'transparent',
                transition: 'background 0.08s, transform 0.08s',
              }}
            >
              <span style={{ color: action.active ? 'var(--accent)' : 'var(--text-tertiary)', display: 'flex', flexShrink: 0 }}>
                {action.icon}
              </span>
              <span style={{ fontSize: 13, color: action.active ? 'var(--accent)' : 'var(--text-primary)', flex: 1 }}>
                {action.label}
              </span>
              {action.active && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </div>
          ))}
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-tertiary)' }}>
          <span><kbd style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>↑↓</kbd> {t('commandPalette.hint.navigate')}</span>
          <span><kbd style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>↵</kbd> {t('commandPalette.hint.select')}</span>
          <span><kbd style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>Esc</kbd> {t('commandPalette.hint.close')}</span>
        </div>
      </div>
    </div>
  );
}
