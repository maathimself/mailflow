import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format } from 'date-fns';
import { shortcutBus } from '../utils/shortcutBus.js';
import { useMobile } from '../hooks/useMobile.js';

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type) {
  const t = (type || '').toLowerCase();
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 };
  if (t.startsWith('image/')) return (
    <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
  );
  if (t === 'application/pdf') return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('word') || t.includes('document')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('sheet') || t.includes('excel') || t.includes('csv')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="10" y1="13" x2="10" y2="17"/><line x1="8" y1="15" x2="12" y2="15"/></svg>
  );
  if (t.includes('zip') || t.includes('compressed') || t.includes('archive')) return (
    <svg {...p}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="11" x2="16" y2="11"/></svg>
  );
  if (t.startsWith('video/')) return (
    <svg {...p}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
  );
  if (t.startsWith('audio/')) return (
    <svg {...p}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
  );
  return (
    <svg {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
  );
}

export default function MessagePane() {
  const { t } = useTranslation();
  const {
    messages, searchResults, searchQuery, selectedMessageId, setSelectedMessage,
    updateMessage, removeMessage, decrementUnread, incrementUnread, openCompose, accounts, addNotification,
    imageWhitelist, setImageWhitelist,
  } = useStore();

  const isMobile = useMobile();
  const paneRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const allMessages = searchQuery.trim() ? searchResults : messages;
  const message = allMessages.find(m => m.id === selectedMessageId);

  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingBody, setLoadingBody] = useState(false);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [showReplyMenu, setShowReplyMenu] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);
  const [paneScrolled, setPaneScrolled] = useState(false);
  const scrollContainerRef = useRef(null);
  const iframeRef = useRef(null);
  const roRef = useRef(null);
  const bodyCache = useRef({}); // messageId -> body, so revisiting is instant (capped at 50)
  const bodyCacheOrder = useRef([]); // insertion-order keys for LRU eviction
  // Session-scoped set of message IDs where the user has clicked "Load images once"
  const imagesRequestedRef = useRef(new Set());
  // Ref holding the latest pane action handlers so shortcut subscriptions ([] deps) never go stale
  const paneActionsRef = useRef({});

  useEffect(() => {
    if (!selectedMessageId) {
      setBody(null);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }

    // Serve from cache when available — avoids re-fetching on revisit.
    // Skip the cache (or clear a stale blocked entry) when the user has explicitly
    // requested images for this message so we re-fetch with ?remoteImages=1.
    const wantsImages = imagesRequestedRef.current.has(selectedMessageId);
    const cached = bodyCache.current[selectedMessageId];
    if (cached && (cached.html || cached.text)) {
      if (!wantsImages || !cached.hasBlockedRemoteImages) {
        setBody(cached);
        setBodyError(null);
        setLoadingBody(false);
        return;
      }
      // Cache has the blocked version but user wants images — evict and re-fetch
      delete bodyCache.current[selectedMessageId];
    }

    // Clear previous content immediately so stale body never shows for a new message
    setBody(null);
    setBodyError(null);
    setLoadingBody(true);

    // Cancellation flag — prevents a slow in-flight fetch for a previous message
    // from overwriting state after the user has already moved to a different message.
    let cancelled = false;

    // Auto-retry helper: retries on transient errors (not-found race, dead IMAP
    // connection, etc.) with exponential backoff before surfacing a permanent error.
    const fetchWithRetry = async (id, attemptsLeft = 2, delay = 500) => {
      try {
        return await api.getMessageBody(id, imagesRequestedRef.current.has(id));
      } catch (err) {
        const isNotFound = /not found/i.test(err.message);
        const isTransient = /Command failed|Command canceled|timed out|ECONNRESET|socket hang up|EPIPE/i.test(err.message);
        if ((isNotFound || isTransient) && attemptsLeft > 0 && !cancelled) {
          await new Promise(r => setTimeout(r, delay));
          if (cancelled) throw err; // user navigated away during wait
          return fetchWithRetry(id, attemptsLeft - 1, delay * 2);
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

  // Size the iframe to its full content height so no internal scrollbar appears.
  // The outer overflow:auto container is the only scrollbar the user sees.
  //
  // Key design: overflow:hidden is injected via the srcDoc <style> (with !important)
  // so email CSS can never make html/body fill the iframe height.  We never toggle
  // overflow here, which eliminates the feedback loop where clearing overflow lets
  // percentage-height elements expand → body grows → observer fires → repeat.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !body?.html) return;

    let rafId;
    let lastH = 0;

    const setHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const el = doc.documentElement;
      const b  = doc.body;
      const h  = Math.max(
        el ? el.scrollHeight : 0,
        el ? el.offsetHeight : 0,
        b  ? b.scrollHeight  : 0,
        b  ? b.offsetHeight  : 0,
      );
      if (h > lastH) {
        lastH = h;
        iframe.style.height = h + 'px';
      }
    };

    const onLoaded = () => {
      setHeight();
      rafId = requestAnimationFrame(setHeight);

      const doc = iframe.contentDocument;
      if (!doc) return;

      // Re-measure after each lazy-loaded image settles
      doc.querySelectorAll('img').forEach(img => {
        if (!img.complete) {
          img.addEventListener('load',  () => requestAnimationFrame(setHeight), { once: true });
          img.addEventListener('error', () => requestAnimationFrame(setHeight), { once: true });
        }
      });

      // Watch for content that reflows after load (web fonts, dynamic content).
      // Guard: only grow — never shrink on observer fires — so any residual loop
      // stalls immediately once height stabilises.
      const root = doc.body || doc.documentElement;
      if (window.ResizeObserver && root) {
        roRef.current = new ResizeObserver(() => requestAnimationFrame(setHeight));
        roRef.current.observe(root);
      }
    };

    iframe.addEventListener('load', onLoaded, { once: true });
    if (iframe.contentDocument?.readyState === 'complete') {
      onLoaded();
    }

    return () => {
      cancelAnimationFrame(rafId);
      if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
      iframe.removeEventListener('load', onLoaded);
    };
  }, [body?.html, selectedMessageId]);

  // Fade in pane content when switching messages on desktop
  useEffect(() => {
    if (isMobile || !selectedMessageId || !paneRef.current) return;
    const el = paneRef.current;
    el.style.animation = 'none';
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight; // force reflow to restart animation
    el.style.animation = 'pane-fade-in 0.15s ease';
  }, [selectedMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe-back gesture: right-swipe from left edge returns to message list on mobile
  useEffect(() => {
    if (!isMobile) return;
    const el = paneRef.current;
    if (!el) return;

    let startX = 0, startY = 0, dir = null, active = false;

    const onStart = (e) => {
      const t = e.touches[0];
      if (t.clientX > 32) return; // only activate from the left edge
      startX = t.clientX; startY = t.clientY;
      dir = null; active = false;
    };

    const onMove = (e) => {
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!dir) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
      if (dir === 'v' || dx < 0) return;
      e.preventDefault();
      active = true;
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx}px)`;
    };

    const onEnd = (e) => {
      if (!active) return;
      active = false;
      const dx = e.changedTouches[0].clientX - startX;
      if (dx > 80) {
        el.style.transition = 'transform 0.22s ease';
        el.style.transform = `translateX(${window.innerWidth}px)`;
        setTimeout(() => { if (mountedRef.current) history.back(); }, 220);
      } else {
        el.style.transition = 'transform 0.25s ease';
        el.style.transform = 'translateX(0)';
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [isMobile, setSelectedMessage]);

  const handleReply = (replyAll = false) => {
    if (!message) return;
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const fromStr = message.from_name
      ? `${message.from_name} <${message.from_email}>`
      : message.from_email || '';
    const quotedText = body?.text
      ? `\n\n---\nOn ${date}, ${fromStr} wrote:\n${body.text.split('\n').map(l => '> ' + l).join('\n')}`
      : '';

    const replyToArr = Array.isArray(message.reply_to)
      ? message.reply_to
      : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch (_) { return []; } })();
    const replyTarget = (replyToArr.length && replyToArr[0].email)
      ? replyToArr[0]
      : { name: message.from_name || '', email: message.from_email || '' };
    const sender = replyTarget.email ? [replyTarget] : [];

    const myAccount = accounts.find(a => a.id === message.account_id);
    const myEmail = myAccount?.email_address || '';

    const replyAliasId = (() => {
      const aliases = myAccount?.aliases || [];
      if (!aliases.length) return null;
      try {
        const toArr = Array.isArray(message.to_addresses)
          ? message.to_addresses
          : JSON.parse(message.to_addresses || '[]');
        const ccArr = Array.isArray(message.cc_addresses)
          ? message.cc_addresses
          : JSON.parse(message.cc_addresses || '[]');
        const allEmails = [...toArr, ...ccArr].map(t => t.email?.toLowerCase()).filter(Boolean);
        const match = aliases.find(al => allEmails.includes(al.email.toLowerCase()));
        return match ? match.id : null;
      } catch (_) { return null; }
    })();

    const myAddresses = new Set([
      myEmail.toLowerCase(),
      ...(myAccount?.aliases || []).map(al => al.email.toLowerCase()),
    ]);
    const allRecipients = (() => {
      try {
        const toArr = Array.isArray(message.to_addresses)
          ? message.to_addresses
          : JSON.parse(message.to_addresses || '[]');
        const ccArr = Array.isArray(message.cc_addresses)
          ? message.cc_addresses
          : JSON.parse(message.cc_addresses || '[]');
        return [...toArr, ...ccArr].filter(
          t => t.email && !myAddresses.has(t.email.toLowerCase()) && t.email !== replyTarget.email
        );
      } catch (_) { return []; }
    })();

    const referencesChain = [message.in_reply_to, message.message_id]
      .filter(Boolean).join(' ').trim() || null;

    setShowReplyMenu(false);
    openCompose({
      to: sender,
      cc: replyAll ? allRecipients : [],
      subject: message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      body: '',
      quotedBody: quotedText,
      inReplyTo: message.message_id,
      references: referencesChain,
      accountId: message.account_id,
      aliasId: replyAliasId,
      isReply: true,
      isReplyAll: replyAll,
      originalFrom: sender,
      allRecipients,
    });
  };

  const handleForward = () => {
    if (!message) return;
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const fromStr = message.from_name
      ? `${message.from_name} <${message.from_email}>`
      : message.from_email || '';
    const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${message.subject || ''}\n\n${body?.text || ''}`;
    openCompose({
      subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      body: '',
      quotedBody: fwdText,
      accountId: message.account_id,
      isForward: true,
    });
  };

  const handleStarToggle = async () => {
    if (!message) return;
    const newVal = !message.is_starred;
    await api.markStarred(message.id, newVal);
    updateMessage(message.id, { is_starred: newVal });
  };

  // Keep pane action refs current every render
  paneActionsRef.current = {
    reply:      () => handleReply(false),
    replyAll:   () => handleReply(true),
    forward:    handleForward,
    toggleStar: handleStarToggle,
  };

  // Subscribe to keyboard shortcut actions that belong to the message pane.
  // Registered once ([] deps); live state is accessed through paneActionsRef.
  useEffect(() => {
    const onReply      = () => paneActionsRef.current.reply();
    const onReplyAll   = () => paneActionsRef.current.replyAll();
    const onForward    = () => paneActionsRef.current.forward();
    const onToggleStar = () => paneActionsRef.current.toggleStar();

    shortcutBus.on('reply',      onReply);
    shortcutBus.on('replyAll',   onReplyAll);
    shortcutBus.on('forward',    onForward);
    shortcutBus.on('toggleStar', onToggleStar);

    return () => {
      shortcutBus.off('reply',      onReply);
      shortcutBus.off('replyAll',   onReplyAll);
      shortcutBus.off('forward',    onForward);
      shortcutBus.off('toggleStar', onToggleStar);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        flex: 1, display: 'flex', flexDirection: 'column',
        background: 'var(--bg-primary)',
      }}>
        {isMobile && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-secondary)', flexShrink: 0,
          }}>
            <button
              onClick={() => setSelectedMessage(null)}
              style={{
                background: 'none', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                gap: 2, padding: '4px 0', fontSize: 15, fontWeight: 500,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              {t('common.back')}
            </button>
          </div>
        )}
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12,
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
            {t('message.selectToRead')}
          </p>
        </div>
      </div>
    );
  }

  const handleDelete = async () => {
    try {
      await api.deleteMessage(message.id);
      removeMessage(message.id);
    } catch (err) { console.error(err); }
  };

  const handleArchive = () => {
    const archived = message;
    removeMessage(archived.id);
    if (!archived.is_read) decrementUnread(archived.account_id);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        const result = await api.bulkArchive([archived.id]);
        if (result.noArchiveFolder?.length) {
          addNotification({ title: t('message.archived.noFolderTitle'), body: t('message.archived.noFolderBody') });
        }
      } catch (err) {
        console.error('Archive failed:', err);
        addNotification({ title: t('message.archived.failTitle'), body: t('message.archived.failBody') });
      }
    }, 4500);
    addNotification({
      title: t('message.archived.title'),
      body: archived.subject || t('common.noSubject'),
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        const state = useStore.getState();
        state.setMessages([...state.messages, archived].sort((a, b) => new Date(b.date) - new Date(a.date)));
        if (!archived.is_read) incrementUnread(archived.account_id);
      },
    });
  };

  const handleLoadImages = () => {
    imagesRequestedRef.current.add(selectedMessageId);
    delete bodyCache.current[selectedMessageId];
    setRetryKey(k => k + 1);
  };

  const handleAllowSender = async () => {
    const senderEmail = message.from_email?.toLowerCase();
    if (!senderEmail) return;
    const newList = {
      ...imageWhitelist,
      addresses: [...new Set([...(imageWhitelist.addresses || []), senderEmail])],
    };
    setSavingAllow(true);
    try {
      await api.savePreferences({ imageWhitelist: newList });
      setImageWhitelist(newList);
      // Evict all blocked cache entries so they re-fetch with images unblocked
      for (const id of Object.keys(bodyCache.current)) {
        if (bodyCache.current[id]?.hasBlockedRemoteImages) delete bodyCache.current[id];
      }
      bodyCacheOrder.current = bodyCacheOrder.current.filter(id => bodyCache.current[id]);
      setRetryKey(k => k + 1);
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
  };

  const handleAllowDomain = async () => {
    const senderEmail = message.from_email?.toLowerCase() || '';
    const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
    if (!senderDomain) return;
    const newList = {
      ...imageWhitelist,
      domains: [...new Set([...(imageWhitelist.domains || []), senderDomain])],
    };
    setSavingAllow(true);
    try {
      await api.savePreferences({ imageWhitelist: newList });
      setImageWhitelist(newList);
      // Evict all blocked cache entries so they re-fetch with images unblocked
      for (const id of Object.keys(bodyCache.current)) {
        if (bodyCache.current[id]?.hasBlockedRemoteImages) delete bodyCache.current[id];
      }
      bodyCacheOrder.current = bodyCacheOrder.current.filter(id => bodyCache.current[id]);
      setRetryKey(k => k + 1);
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
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
    <div
      ref={paneRef}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', background: 'var(--bg-primary)',
        animation: isMobile ? 'mobileSlideIn 0.22s ease' : 'none',
      }}
    >
      {isMobile && <style>{`@keyframes mobileSlideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }`}</style>}

      {/* Mobile back bar */}
      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingTop: 'calc(var(--sat) + 10px)',
          paddingBottom: 10, paddingLeft: 14, paddingRight: 14,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-secondary)', flexShrink: 0,
          boxShadow: paneScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
          transition: 'box-shadow 0.2s ease',
        }}>
          <button
            onClick={() => history.back()}
            style={{
              background: 'none', border: 'none', color: 'var(--accent)',
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              gap: 2, padding: '4px 0', fontSize: 15, fontWeight: 500,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            {t('common.back')}
          </button>
          <div style={{
            flex: 1, minWidth: 0,
            fontSize: 14, fontWeight: 500, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {message?.subject || ''}
          </div>
        </div>
      )}

      {/* Toolbar — always pinned at top, never scrolls */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        boxShadow: paneScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
        transition: 'box-shadow 0.2s ease',
      }}>
        {/* Split Reply button */}
        <div style={{ position: 'relative', display: 'flex' }}>
          <PaneBtn onClick={() => handleReply(false)} title={isMobile ? t('message.reply') : `${t('message.reply')} (R)`}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/>
            </svg>
            {t('message.reply')}
            {!isMobile && <kbd style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>R</kbd>}
          </PaneBtn>
          <button
            onClick={() => setShowReplyMenu(v => !v)}
            title={t('message.replyOptions')}
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
                { label: t('message.reply'), replyAll: false },
                { label: t('message.replyAll'), replyAll: true },
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

        <PaneBtn onClick={handleForward} title={isMobile ? t('message.forward') : `${t('message.forward')} (F)`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/>
          </svg>
          {t('message.forward')}
          {!isMobile && <kbd style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>F</kbd>}
        </PaneBtn>

        <PaneBtn onClick={handleArchive} title={isMobile ? t('message.archive') : `${t('message.archive')} (E)`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="2" y="3" width="20" height="5" rx="1"/>
            <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
            <polyline points="9 13 12 16 15 13"/>
            <line x1="12" y1="11" x2="12" y2="16"/>
          </svg>
          {t('message.archive')}
          {!isMobile && <kbd style={{ fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>E</kbd>}
        </PaneBtn>

        <div style={{ flex: 1 }} />

        <PaneBtn onClick={handleStarToggle} title={t('message.star')}>
          <svg width="15" height="15" viewBox="0 0 24 24"
            fill={message.is_starred ? 'var(--amber)' : 'none'}
            stroke={message.is_starred ? 'var(--amber)' : 'currentColor'} strokeWidth="1.75">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </PaneBtn>

        <PaneBtn onClick={handleDelete} title={t('message.delete')} danger>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
        </PaneBtn>
      </div>

      {/* Single scroll container — sender card + email body scroll together */}
      <div
        ref={scrollContainerRef}
        onScroll={e => setPaneScrolled(e.currentTarget.scrollTop > 4)}
        style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}
      >
      <div style={{ padding: isMobile ? '12px 0 0' : '24px 28px 0' }}>

        {/* Sender card — subject lives here as the card header */}
        <div style={{
          marginBottom: isMobile ? 12 : 24,
          marginLeft: isMobile ? 0 : undefined,
          marginRight: isMobile ? 0 : undefined,
          background: 'var(--bg-secondary)',
          borderRadius: isMobile ? 0 : 10,
          border: isMobile ? 'none' : '1px solid var(--border-subtle)',
          borderBottom: '1px solid var(--border-subtle)',
          borderLeft: message?.account_color ? `3px solid ${message.account_color}` : undefined,
          overflow: 'hidden',
          boxShadow: isMobile ? 'none' : 'var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}>
          {/* Subject */}
          <div style={{
            padding: '14px 16px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 17, fontWeight: 600,
            color: 'var(--text-primary)', lineHeight: 1.3,
            fontFamily: 'var(--font-display)',
          }}>
            {message.subject || t('message.noSubject')}
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
              {isMobile ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message.from_name || message.from_email}
                  </div>
                  {message.from_name && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {message.from_email}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span>{t('message.to')} </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {toList.length > 0
                        ? toList.map((r, i) => (
                            <span key={i}>{r.name || r.email}{i < toList.length - 1 ? ', ' : ''}</span>
                          ))
                        : (message.account_email || message.account_name || '')}
                    </span>
                  </div>
                </>
              ) : (
                <>
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
                    <span>{t('message.to')} </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {toList.length > 0
                        ? toList.map((r, i) => (
                            <span key={i}>
                              {r.name ? `${r.name} <${r.email}>` : r.email}
                              {i < toList.length - 1 ? ', ' : ''}
                            </span>
                          ))
                        : (message.account_email || message.account_name || '')}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Date + account */}
            <div style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                {message.date ? format(new Date(message.date), isMobile ? 'MMM d, h:mm a' : 'MMM d, yyyy h:mm a') : ''}
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
              {t('message.attachment', { count: attachments.length })}
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
                  <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-secondary)' }}>{fileIcon(att.type)}</span>
                  <div style={{ minWidth: 0, textAlign: 'left' }}>
                    <div style={{
                      fontSize: 12, fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {att.filename}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {downloadingPart === att.part ? t('message.downloading') : formatBytes(att.size)}
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

        {/* Loading — skeleton body lines */}
        {loadingBody && (
          <div style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '75%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '50%', borderRadius: 4, marginBottom: 8 }} />
            <div className="skeleton-line" style={{ height: 13, width: '82%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '68%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '90%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '58%', borderRadius: 4 }} />
          </div>
        )}

        {/* Error */}
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
                {t('message.loadingError')}
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
              {t('common.retry')}
            </button>
          </div>
        )}

        {/* No content */}
        {!loadingBody && !bodyError && body && !body.html && !body.text && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '20px 0' }}>
            <div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
              {t('message.noContent')}
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
              {t('common.retry')}
            </button>
          </div>
        )}
      </div>

      {/* HTML email — iframe sized to full content height; outer container scrolls */}
      {!loadingBody && !bodyError && body?.html && (
        <div style={{ padding: isMobile ? '0 0 16px' : '0 28px 24px' }}>
          {body.hasBlockedRemoteImages && (
            <div style={{
              marginBottom: 10, padding: '9px 14px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--accent)',
              borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              <span>{t('message.remoteImagesBlocked')}</span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {[
                  { label: t('message.loadImages'), handler: handleLoadImages, disabled: false },
                  message.from_email && {
                    label: t('message.allowSender', { email: message.from_email }),
                    handler: handleAllowSender, disabled: savingAllow,
                  },
                  (message.from_email?.includes('@')) && {
                    label: t('message.allowDomain', { domain: message.from_email.split('@')[1] }),
                    handler: handleAllowDomain, disabled: savingAllow,
                  },
                ].filter(Boolean).map(({ label, handler, disabled }) => (
                  <button key={label} onClick={handler} disabled={disabled}
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
          )}
          <div style={{
            background: 'white',
            borderRadius: isMobile ? 0 : 10,
            border: isMobile ? 'none' : '1px solid var(--border-subtle)',
            overflow: 'hidden',
          }}>
            <iframe
              ref={iframeRef}
              srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <base target="_blank">
                <style>
                  /* Prevent percentage-height elements from filling the iframe,
                     which would cause a ResizeObserver growth feedback loop. */
                  html, body { height: auto !important; min-height: 0 !important; overflow-x: hidden; }
                  body { margin: 16px; font-family: -apple-system, Arial, sans-serif;
                         font-size: 14px; line-height: 1.6; color: #1a1a1a; word-wrap: break-word; }
                  /* !important overrides inline width styles and HTML width attributes common
                     in marketing email templates (e.g. <table width="600">) that would otherwise
                     overflow the iframe viewport on narrow mobile screens. */
                  img { max-width: 100% !important; height: auto !important; }
                  table { max-width: 100% !important; }
                  td, th { word-break: break-word; }
                  a { color: #6366f1; }
                  pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
                  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
                </style>
              </head><body>${
                body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
              }</body></html>`}
              scrolling="no"
              style={{ width: '100%', border: 'none', display: 'block', height: '300px' }}
              sandbox="allow-same-origin allow-popups"
              title="Email content"
            />
          </div>
        </div>
      )}

      {/* Plain-text email — no internal scroll, outer container handles it */}
      {!loadingBody && !bodyError && body?.text && !body?.html && (
        <pre style={{
          margin: 0, padding: isMobile ? '0 12px 16px' : '0 28px 24px',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.7,
          fontFamily: 'DM Sans, sans-serif',
        }}>
          {body.text}
        </pre>
      )}
      </div>{/* end single scroll container */}
    </div>
  );
}

function PaneBtn({ children, onClick, title, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      className="btn-press"
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

