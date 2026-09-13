import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import MessageWindow from './MessageWindow.jsx';

// Renders all detached message windows (#219): open ones as floating frames, minimized
// ones as pills in a bottom-left dock so several minimized windows lay out side by side
// instead of stacking. Mounted once (desktop only) by MailApp.
const Z_BASE = 1400; // sits below ComposeModal (1999) so an active compose stays on top.

export default function WindowLayer() {
  const { t } = useTranslation();
  const windows = useStore(s => s.messageWindows);
  const setMinimized = useStore(s => s.setMessageWindowMinimized);
  const closeWindow = useStore(s => s.closeMessageWindow);
  const messages = useStore(s => s.messages);
  const searchResults = useStore(s => s.searchResults);
  const searchQuery = useStore(s => s.searchQuery);
  const threadMessages = useStore(s => s.threadMessages);

  if (!windows.length) return null;

  const open = windows.filter(w => !w.minimized);
  const minimized = windows.filter(w => w.minimized);
  // Normalize the monotonic z stamps into a compact, bounded band so stacking order
  // is preserved without the raw counter creeping toward the compose modal's z-index.
  const zOrder = [...open].sort((a, b) => a.z - b.z).map(w => w.winId);

  const resolveTitle = (messageId) => {
    const list = searchQuery.trim() ? searchResults : messages;
    const msg = list.find(m => m.id === messageId)
      ?? Object.values(threadMessages).flat().find(m => m.id === messageId);
    return {
      title: msg?.subject?.trim() || t('common.noSubject'),
      accent: msg?.account_color || 'var(--accent)',
    };
  };

  return (
    <>
      {open.map(win => (
        <MessageWindow key={win.winId} win={win} zIndex={Z_BASE + zOrder.indexOf(win.winId)} />
      ))}

      {minimized.length > 0 && (
        <div style={{
          position: 'fixed', left: 12, bottom: 12, zIndex: Z_BASE - 1,
          display: 'flex', flexWrap: 'wrap', gap: 8, maxWidth: 'calc(100vw - 24px)',
        }}>
          {minimized.map(win => {
            const { title, accent } = resolveTitle(win.messageId);
            return (
              <div
                key={win.winId}
                className="mailexpert-window-min"
                onClick={() => setMinimized(win.winId, false)}
                title={title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  maxWidth: 240, height: 34, padding: '0 6px 0 10px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8, cursor: 'pointer',
                  boxShadow: 'var(--shadow-drawer, 0 4px 14px rgba(0,0,0,0.2))',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: accent }} />
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {title}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); closeWindow(win.winId); }}
                  title={t('window.close')}
                  aria-label={t('window.close')}
                  style={{
                    width: 22, height: 22, flexShrink: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: 5,
                    color: 'var(--text-secondary)', cursor: 'pointer',
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
