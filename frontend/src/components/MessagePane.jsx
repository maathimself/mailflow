import { useEffect, useState, useRef } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format } from 'date-fns';

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.startsWith('image/')) return '🖼';
  if (t === 'application/pdf') return '📄';
  if (t.includes('word') || t.includes('document')) return '📝';
  if (t.includes('sheet') || t.includes('excel') || t.includes('csv')) return '📊';
  if (t.includes('zip') || t.includes('compressed') || t.includes('archive')) return '🗜';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  return '📎';
}

export default function MessagePane() {
  const {
    messages, searchResults, searchQuery, selectedMessageId,
    updateMessage, removeMessage, decrementUnread, openCompose, accounts,
  } = useStore();

  const allMessages = searchQuery.trim() ? searchResults : messages;
  const message = allMessages.find(m => m.id === selectedMessageId);

  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingBody, setLoadingBody] = useState(false);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [showReplyMenu, setShowReplyMenu] = useState(false);
  const iframeRef = useRef(null);
  const roRef = useRef(null); // ResizeObserver watching the iframe body
  const bodyCache = useRef({}); // messageId -> body, so revisiting is instant (capped at 50)
  const bodyCacheOrder = useRef([]); // insertion-order keys for LRU eviction

  useEffect(() => {
    if (!selectedMessageId) {
      setBody(null);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }

    // Serve from cache when available — avoids re-fetching on revisit.
    // Only use the cache if the body has actual content; a cached empty result
    // should be re-fetched so transient failures don't stick permanently.
    const cached = bodyCache.current[selectedMessageId];
    if (cached && (cached.html || cached.text)) {
      setBody(cached);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }

    // Clear previous content immediately so stale body never shows for a new message
    setBody(null);
    setBodyError(null);
    setLoadingBody(true);

    // Cancellation flag — prevents a slow in-flight fetch for a previous message
    // from overwriting state after the user has already moved to a different message.
    let cancelled = false;

    // Auto-retry helper: retries on transient errors (not-found race, dead IMAP
    // connection, etc.) with a short delay before surfacing a permanent error.
    const fetchWithRetry = async (id, attemptsLeft = 3) => {
      try {
        return await api.getMessageBody(id);
      } catch (err) {
        const isNotFound = /not found/i.test(err.message);
        const isTransient = /Command failed|Command canceled|timed out|ECONNRESET|socket hang up|EPIPE/i.test(err.message);
        if ((isNotFound || isTransient) && attemptsLeft > 0 && !cancelled) {
          await new Promise(r => setTimeout(r, 1500));
          if (cancelled) throw err; // user navigated away during wait
          return fetchWithRetry(id, attemptsLeft - 1);
        }
        throw err;
      }
    };

    fetchWithRetry(selectedMessageId)
      .then(data => {
        if (cancelled) return;
        // Only cache if there's real content — empty results can be retried
        if (data.html || data.text) {
          bodyCache.current[selectedMessageId] = data;
          bodyCacheOrder.current.push(selectedMessageId);
          // Evict oldest entry when cache exceeds 50 messages
          if (bodyCacheOrder.current.length > 50) {
            const evicted = bodyCacheOrder.current.shift();
            delete bodyCache.current[evicted];
          }
        }
        setBody(data);
      })
      .catch(err => {
        if (cancelled) return;
        setBodyError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingBody(false);
      });

    return () => { cancelled = true; };
  }, [selectedMessageId, retryKey]);

  // Resize the iframe to fit its content. Runs whenever body changes.
  // Uses allow-same-origin to read contentDocument directly — safe because
  // allow-scripts is NOT set, so no JavaScript (including email scripts)
  // can run inside the iframe and escape the sandbox.
  useEffect(() => {
    if (!iframeRef.current || !body?.html) return;
    const iframe = iframeRef.current;

    const setHeight = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        // Use body.scrollHeight (excludes body margins) and add the 32px of
        // margin we inject (16px top + 16px bottom) to get the exact content height.
        // documentElement.scrollHeight already includes those margins, so using it
        // and adding 32 again causes double-counting and extra blank space.
        const h = doc.body.scrollHeight;
        if (h && h > 0) iframe.style.height = (h + 32) + 'px';
      } catch (_) {}
    };

    const onLoaded = () => {
      setHeight();

      // Watch the iframe body for layout changes triggered by images or
      // web fonts loading after the initial paint.
      try {
        roRef.current?.disconnect();
        if (window.ResizeObserver && iframe.contentDocument?.body) {
          roRef.current = new ResizeObserver(setHeight);
          roRef.current.observe(iframe.contentDocument.body);
        }
      } catch (_) {}

      // Additionally attach load listeners directly to any images that
      // haven't finished loading yet — ResizeObserver won't fire for images
      // that are fully loaded before they're observed.
      try {
        const imgs = iframe.contentDocument?.querySelectorAll('img') ?? [];
        imgs.forEach(img => {
          if (!img.complete) {
            img.addEventListener('load',  setHeight, { once: true });
            img.addEventListener('error', setHeight, { once: true });
          }
        });
      } catch (_) {}
    };

    // React effects run after the paint. If the iframe's srcDoc loaded
    // synchronously (common for small emails), the load event has already
    // fired before we get here — setting iframe.onload would be too late.
    // Check readyState first; fall back to the load event for slow loads.
    if (iframe.contentDocument?.readyState === 'complete') {
      onLoaded();
    } else {
      iframe.addEventListener('load', onLoaded, { once: true });
    }

    return () => {
      iframe.removeEventListener('load', onLoaded);
      roRef.current?.disconnect();
      roRef.current = null;
    };
  }, [body]);

  const handleDownload = async (messageId, part, filename) => {
    setDownloadingPart(part);
    try {
      const res = await fetch(`/api/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setDownloadingPart(null);
    }
  };

  if (!message) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)', flexDirection: 'column', gap: 12,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14,
          background: 'var(--bg-secondary)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
        </div>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 14, margin: 0 }}>
          Select a message to read
        </p>
      </div>
    );
  }

  const handleReply = (replyAll = false) => {
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const fromStr = message.from_name
      ? `${message.from_name} <${message.from_email}>`
      : message.from_email || '';
    const quotedText = body?.text
      ? `\n\n---\nOn ${date}, ${fromStr} wrote:\n${body.text.split('\n').map(l => '> ' + l).join('\n')}`
      : '';
    const sender = (message.from_email || message.from_name)
      ? [{ name: message.from_name || '', email: message.from_email || '' }]
      : [];
    const myEmail = accounts.find(a => a.id === message.account_id)?.email_address || '';
    const ccList = (() => {
      if (!replyAll) return [];
      try {
        const arr = Array.isArray(message.to_addresses)
          ? message.to_addresses
          : JSON.parse(message.to_addresses || '[]');
        return arr.filter(t => t.email && t.email !== myEmail);
      } catch (_) { return []; }
    })();
    setShowReplyMenu(false);
    openCompose({
      to: sender,
      cc: ccList,
      subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      body: quotedText,
      inReplyTo: message.message_id,
      accountId: message.account_id,
      isReply: true,
      isReplyAll: replyAll,
    });
  };

  const handleForward = () => {
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const fromStr = message.from_name
      ? `${message.from_name} <${message.from_email}>`
      : message.from_email || '';
    const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${message.subject || ''}\n\n${body?.text || ''}`;
    openCompose({
      subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      body: fwdText,
      accountId: message.account_id,
      isForward: true,
    });
  };

  const handleDelete = async () => {
    try {
      await api.deleteMessage(message.id);
      removeMessage(message.id);
    } catch (err) { console.error(err); }
  };

  const handleStarToggle = async () => {
    const newVal = !message.is_starred;
    await api.markStarred(message.id, newVal);
    updateMessage(message.id, { is_starred: newVal });
  };

  const toList = (() => {
    try {
      return Array.isArray(message.to_addresses)
        ? message.to_addresses
        : JSON.parse(message.to_addresses || '[]');
    } catch (_) { return []; }
  })();

  const attachments = body?.attachments || [];

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', background: 'var(--bg-primary)',
    }}>
      {/* Toolbar */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        {/* Split Reply button */}
        <div style={{ position: 'relative', display: 'flex' }}>
          <PaneBtn onClick={() => handleReply(false)} title="Reply">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/>
            </svg>
            Reply
          </PaneBtn>
          <button
            onClick={() => setShowReplyMenu(v => !v)}
            title="Reply options"
            style={{
              background: 'transparent', border: '1px solid transparent',
              borderLeft: '1px solid var(--border-subtle)',
              borderRadius: '0 6px 6px 0', padding: '5px 6px',
              color: 'var(--text-secondary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {showReplyMenu && (
            <div
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, overflow: 'hidden', zIndex: 100,
                boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: 150,
              }}
              onMouseLeave={() => setShowReplyMenu(false)}
            >
              {[
                { label: 'Reply', replyAll: false },
                { label: 'Reply All', replyAll: true },
              ].map(opt => (
                <div
                  key={opt.label}
                  onClick={() => handleReply(opt.replyAll)}
                  style={{
                    padding: '9px 14px', cursor: 'pointer', fontSize: 13,
                    color: 'var(--text-primary)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {opt.label}
                </div>
              ))}
            </div>
          )}
        </div>

        <PaneBtn onClick={handleForward} title="Forward">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/>
          </svg>
          Forward
        </PaneBtn>

        <div style={{ flex: 1 }} />

        <PaneBtn onClick={handleStarToggle} title="Star">
          <svg width="15" height="15" viewBox="0 0 24 24"
            fill={message.is_starred ? 'var(--amber)' : 'none'}
            stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </PaneBtn>

        <PaneBtn onClick={handleDelete} title="Delete" danger>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
        </PaneBtn>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>

        {/* Sender card — subject lives here as the card header */}
        <div style={{
          marginBottom: 24, background: 'var(--bg-secondary)',
          borderRadius: 10, border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
        }}>
          {/* Subject */}
          <div style={{
            padding: '14px 16px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 17, fontWeight: 600,
            color: 'var(--text-primary)', lineHeight: 1.3,
            fontFamily: 'inherit',
          }}>
            {message.subject || '(no subject)'}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}>
            {/* Avatar */}
            <div style={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
              background: message.account_color || 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: 'white',
            }}>
              {(message.from_name || message.from_email || '?')[0].toUpperCase()}
            </div>

            {/* Sender info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {message.from_name || message.from_email}
                </span>
                {message.from_name && (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    &lt;{message.from_email}&gt;
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                <span>To: </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {toList.length > 0
                    ? toList.map((t, i) => (
                        <span key={i}>
                          {t.name ? `${t.name} <${t.email}>` : t.email}
                          {i < toList.length - 1 ? ', ' : ''}
                        </span>
                      ))
                    : (message.account_email || message.account_name || '')
                  }
                </span>
              </div>
            </div>

            {/* Date + account */}
            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {message.date ? format(new Date(message.date), 'MMM d, yyyy h:mm a') : ''}
              </div>
              <div style={{
                fontSize: 11, marginTop: 4,
                display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: message.account_color || 'var(--accent)',
                }} />
                <span style={{ color: 'var(--text-tertiary)' }}>{message.account_name}</span>
              </div>
            </div>
          </div>

        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, fontWeight: 500 }}>
              {attachments.length} attachment{attachments.length !== 1 ? 's' : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {attachments.map((att, i) => (
                <button
                  key={i}
                  onClick={() => handleDownload(message.id, att.part, att.filename)}
                  disabled={downloadingPart === att.part}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 8,
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    cursor: downloadingPart === att.part ? 'wait' : 'pointer',
                    color: 'var(--text-primary)',
                    transition: 'background 0.1s',
                    maxWidth: 240,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                >
                  <span style={{ fontSize: 18, lineHeight: 1 }}>{fileIcon(att.type)}</span>
                  <div style={{ minWidth: 0, textAlign: 'left' }}>
                    <div style={{
                      fontSize: 12, fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {att.filename}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {downloadingPart === att.part ? 'Downloading…' : formatBytes(att.size)}
                    </div>
                  </div>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke="var(--text-tertiary)" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        {loadingBody && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 14, padding: '20px 0' }}>
            Loading…
          </div>
        )}

        {!loadingBody && bodyError && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
            gap: 12, padding: '20px 0',
          }}>
            <div style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 10, padding: '16px 20px', maxWidth: 480,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                Unable to load message body
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {bodyError}
              </div>
            </div>
            <button
              onClick={() => { delete bodyCache.current[selectedMessageId]; setRetryKey(k => k + 1); }}
              style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
                color: 'var(--text-secondary)', fontSize: 13,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              Retry
            </button>
          </div>
        )}

        {!loadingBody && !bodyError && body && (
          body.html ? (
            <div style={{
              background: 'white', borderRadius: 10, overflow: 'hidden',
              border: '1px solid var(--border-subtle)',
            }}>
              <iframe
                ref={iframeRef}
                srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8">
                  <meta name="viewport" content="width=device-width,initial-scale=1">
                  <base target="_blank">
                  <style>
                    body { margin: 16px; font-family: -apple-system, Arial, sans-serif;
                           font-size: 14px; line-height: 1.6; color: #1a1a1a; word-wrap: break-word; }
                    img { max-width: 100%; height: auto; }
                    a { color: #6366f1; }
                    pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
                    blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
                    table { max-width: 100%; }
                  </style>
                </head><body>${
                  // Add rel="noopener noreferrer" to all links so new tabs don't retain an
                  // opener reference. Without this, sites with COOP: same-origin (e.g. Stripe)
                  // block the navigation and show a browser security warning.
                  body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
                }</body></html>`}
                style={{ width: '100%', minHeight: 100, border: 'none', display: 'block' }}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                title="Email content"
              />
            </div>
          ) : body.text ? (
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.7,
              fontFamily: 'DM Sans, sans-serif', margin: 0,
            }}>
              {body.text}
            </pre>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '20px 0' }}>
              <div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
                No message content found.
              </div>
              <button
                onClick={() => { delete bodyCache.current[selectedMessageId]; setRetryKey(k => k + 1); }}
                style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
                  color: 'var(--text-secondary)', fontSize: 13,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              >
                Retry
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function PaneBtn({ children, onClick, title, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--bg-tertiary)') : 'transparent',
        border: '1px solid ' + (hov ? (danger ? 'rgba(248,113,113,0.3)' : 'var(--border)') : 'transparent'),
        borderRadius: 6, padding: '5px 10px',
        color: danger ? (hov ? 'var(--red)' : 'var(--text-tertiary)') : 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 13,
        display: 'flex', alignItems: 'center', gap: 5,
        transition: 'all 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function MetaField({ label, value, mono, truncate }) {
  return (
    <div style={{ fontSize: 11 }}>
      <span style={{ color: 'var(--text-tertiary)', marginRight: 4 }}>{label}:</span>
      <span style={{
        color: 'var(--text-secondary)',
        fontFamily: mono ? 'JetBrains Mono, monospace' : 'inherit',
        fontSize: mono ? 10 : 11,
        ...(truncate ? {
          display: 'inline-block', maxWidth: 180,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', verticalAlign: 'bottom',
        } : {}),
      }}>
        {value}
      </span>
    </div>
  );
}
