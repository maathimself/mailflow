import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

export default function MessageHeaderModal({ messageId, subject, onClose }) {
  const { t } = useTranslation();
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
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contextMenu.headers.title')}
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
              {copied ? t('contextMenu.headers.copied') : t('contextMenu.headers.copyRaw')}
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

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {loading && (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('contextMenu.headers.loading')}</div>
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
              {headers || t('contextMenu.headers.noHeaders')}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
