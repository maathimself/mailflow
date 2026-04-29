import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

// ─── Header Viewer Modal ──────────────────────────────────────────────────────
function HeaderModal({ messageId, subject, onClose }) {
  const [headers, setHeaders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getMessageHeaders(messageId)
      .then(data => setHeaders(data.headers))
      .catch(err => setHeaders(`Error: ${err.message}`))
      .finally(() => setLoading(false));
  }, [messageId]);

  const handleCopy = () => {
    navigator.clipboard.writeText(headers || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Parse headers into key/value pairs for structured display
  const parsedHeaders = [];
  if (headers) {
    const lines = headers.split('\n');
    let current = null;
    for (const line of lines) {
      if (/^\s/.test(line) && current) {
        current.value += ' ' + line.trim();
      } else {
        const colon = line.indexOf(':');
        if (colon > 0) {
          current = { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
          parsedHeaders.push(current);
        }
      }
    }
  }

  // Highlight important headers
  const important = new Set(['from','to','cc','bcc','subject','date','message-id','reply-to',
    'return-path','received','x-mailer','mime-version','content-type','dkim-signature',
    'authentication-results','x-spam-status','x-spam-score']);

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay-scrim)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 5000, padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 14, width: '100%', maxWidth: 720,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-modal)',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              Full Headers
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2,
              maxWidth: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {subject}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCopy}
              style={{
                padding: '6px 12px', background: copied ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                border: `1px solid ${copied ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 7, color: copied ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 12,
              }}
            >
              {copied ? '✓ Copied' : 'Copy raw'}
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', padding: 6,
                color: 'var(--text-tertiary)', cursor: 'pointer', borderRadius: 6,
                display: 'flex', alignItems: 'center',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {loading && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading headers…</div>
          )}

          {!loading && parsedHeaders.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {parsedHeaders.map((h, i) => {
                  const isImportant = important.has(h.key.toLowerCase());
                  return (
                    <tr key={i} style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: isImportant ? 'rgba(124,106,247,0.04)' : 'transparent',
                    }}>
                      <td style={{
                        padding: '6px 12px 6px 0', verticalAlign: 'top',
                        color: isImportant ? 'var(--accent)' : 'var(--text-tertiary)',
                        fontWeight: isImportant ? 600 : 400,
                        whiteSpace: 'nowrap', width: 200, fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11,
                      }}>
                        {h.key}
                      </td>
                      <td style={{
                        padding: '6px 0', color: 'var(--text-primary)',
                        wordBreak: 'break-all', fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11, lineHeight: 1.6,
                      }}>
                        {h.value}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {!loading && parsedHeaders.length === 0 && (
            <pre style={{
              color: 'var(--text-primary)', fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap',
              lineHeight: 1.6, margin: 0,
            }}>
              {headers || 'No headers available'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
export default function ContextMenu({ x, y, message, onClose, onAction }) {
  const menuRef = useRef(null);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [moveView, setMoveView] = useState(false);
  const [moveFolders, setMoveFolders] = useState(null);
  const [moveFoldersLoading, setMoveFoldersLoading] = useState(false);

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

  const handleMoveClick = async () => {
    setMoveView(true);
    if (moveFolders) return; // already loaded
    setMoveFoldersLoading(true);
    try {
      const data = await api.getFolders(message.account_id);
      setMoveFolders(Array.isArray(data) ? data : (data.folders || []));
    } catch (_) {
      setMoveFolders([]);
    } finally {
      setMoveFoldersLoading(false);
    }
  };

  // Close on outside click or Escape
  useEffect(() => {
    const handleClick = () => onClose();
    const handleKey = e => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => {
      document.addEventListener('click', handleClick);
      document.addEventListener('keydown', handleKey);
    }, 0);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const items = [
    {
      group: 'Message',
      actions: [
        {
          label: 'Open',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
          action: () => onAction('open'),
        },
        {
          label: message.is_read ? 'Mark as unread' : 'Mark as read',
          icon: message.is_read
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
          action: () => onAction(message.is_read ? 'markUnread' : 'markRead'),
        },
        {
          label: message.is_starred ? 'Remove star' : 'Star message',
          icon: <svg width="14" height="14" viewBox="0 0 24 24"
            fill={message.is_starred ? 'var(--amber)' : 'none'}
            stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>,
          action: () => onAction('toggleStar'),
        },
        {
          label: 'Select',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 15 10"/></svg>,
          action: () => onAction('bulkSelect'),
        },
      ]
    },
    {
      group: 'Actions',
      actions: [
        {
          label: 'Reply',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>,
          action: () => onAction('reply'),
        },
        {
          label: 'Reply all',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>,
          action: () => onAction('replyAll'),
        },
        {
          label: 'Forward',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>,
          action: () => onAction('forward'),
        },
        {
          label: 'Move to folder',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>,
          action: handleMoveClick,
          keepOpen: true,
          hasSubmenu: true,
        },
        {
          label: 'Archive',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>,
          action: () => onAction('archive'),
        },
      ]
    },
    {
      group: 'Copy',
      actions: [
        {
          label: 'Copy subject',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
          action: () => { navigator.clipboard.writeText(message.subject || ''); onAction('copy'); },
        },
        {
          label: "Copy sender's address",
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
          action: () => { navigator.clipboard.writeText(message.from_email || ''); onAction('copy'); },
        },
      ]
    },
    {
      group: 'View',
      actions: [
        {
          label: 'View full headers',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
          action: () => { setShowHeaderModal(true); },
          keepOpen: true,
        },
      ]
    },
    {
      group: 'Danger',
      actions: [
        {
          label: 'Delete',
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
          action: () => onAction('delete'),
          danger: true,
        },
      ]
    },
  ];

  return (
    <>
      <div
        ref={menuRef}
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: pos.x, top: pos.y,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 10, zIndex: 4000,
          boxShadow: 'var(--shadow-modal)',
          minWidth: 220, overflow: 'hidden',
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
            {message.subject || '(no subject)'}
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

        {moveView ? (
          /* Folder picker view */
          <>
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
              Move to folder
            </div>
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {moveFoldersLoading ? (
                <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  Loading folders…
                </div>
              ) : moveFolders?.length === 0 ? (
                <div style={{ padding: '12px 14px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  No folders found
                </div>
              ) : (
                (moveFolders || [])
                  .filter(f => f.path !== message.folder)
                  .map(folder => (
                    <FolderMenuItem
                      key={folder.path}
                      folder={folder}
                      onClick={() => { onAction('moveTo', folder.path); onClose(); }}
                    />
                  ))
              )}
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
        <HeaderModal
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
