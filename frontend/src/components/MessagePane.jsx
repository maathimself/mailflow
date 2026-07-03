import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { format } from 'date-fns';
import { shortcutBus } from '../utils/shortcutBus.js';
import { getEffectiveShortcuts, parseModKey, modCompactLabel } from '../utils/defaultShortcuts.js';
import { useMobile } from '../hooks/useMobile.js';
import { clearDeleteGuard, clearPendingDelete, setCompletedDelete, setPendingDelete } from '../utils/pendingDeletes.js';
import { pendingMarkReadMap, completedMarkReadMap, setPending } from '../utils/pendingReads.js';
const USE_DIV_RENDER = import.meta.env.VITE_EMAIL_DIV_RENDER === 'true';

// Module-level regex so the spam-name heuristic isn't recompiled on every
// render — same heuristic as ContextMenu.jsx, both files read this constant.
const SPAM_NAME_RE = /(spam|junk|bulk|indesiderata|spamverdacht|courrier\s*ind|posta\s*indesiderata)/i;

// Lazy-load the div-renderer utilities so PostCSS is excluded from the flag-off
// bundle. Rollup treats the import() calls inside this block as dead code when
// USE_DIV_RENDER compiles to false, stripping PostCSS and both utility modules.
// In the flag-on build they live in the same chunk, so the dynamic imports
// resolve synchronously — no perceptible delay before first render.
let prepareEmailHtml  = null;
let injectEmailStyles = null;
let removeEmailStyles = null;
if (USE_DIV_RENDER) {
  ({ prepareEmailHtml }                    = await import('../utils/scopeEmailCss.js'));
  ({ injectEmailStyles, removeEmailStyles } = await import('../utils/emailStyleRegistry.js'));
}
import { senderColor } from '../themes.js';
import MessageHeaderModal from './MessageHeaderModal.jsx';
import FolderIcon from './FolderIcon.jsx';
import TodoistTaskModal from './TodoistTaskModal.jsx';

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

function linkifyText(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit">${url}</a>`
  );
}

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
    imageWhitelist, addToImageWhitelist, blockRemoteImages, threadMessages,
    replyDefault, shortcuts, recentFolders, favoriteFolders, todoistConnected,
    categorizationEnabled, setCategoryCounts, adjustCategoryCount,
  } = useStore();

  const isMobile = useMobile();
  const defaultReplyAll = replyDefault === 'replyAll';

  const effectiveShortcuts = getEffectiveShortcuts(shortcuts);
  const shortcutLabel = (action) => {
    const k = effectiveShortcuts[action];
    if (!k) return null;
    const mod = parseModKey(k);
    return mod ? `${modCompactLabel(mod.mod)}${mod.bare.toUpperCase()}` : k.toUpperCase();
  };
  // Navigate to a message and mark it as read in one shot.
  // Arrow buttons and swipe gestures bypass handleSelect in MessageList, so they
  // must duplicate the mark-as-read logic here to keep state consistent.
  const selectAndMarkRead = useCallback((msg) => {
    setSelectedMessage(msg.id);
    if (!msg.is_read) {
      updateMessage(msg.id, { is_read: true });
      decrementUnread(msg.account_id);
      adjustCategoryCount(msg.category, -1);
      setPending(msg.id, msg.account_id);
      api.bulkRead([msg.id], true)
        .then(() => {
          pendingMarkReadMap.delete(msg.id);
          completedMarkReadMap.set(msg.id, msg.account_id);
          setTimeout(() => completedMarkReadMap.delete(msg.id), 10000);
        })
        .catch(e => {
          console.error('markRead failed:', e.message);
          updateMessage(msg.id, { is_read: false });
          incrementUnread(msg.account_id);
          adjustCategoryCount(msg.category, 1);
          pendingMarkReadMap.delete(msg.id);
        });
    }
  }, [setSelectedMessage, updateMessage, decrementUnread, incrementUnread, adjustCategoryCount]);

  const paneRef = useRef(null);
  const mountedRef = useRef(true);
  const swipeBackTimerRef = useRef(null);
  useEffect(() => () => {
    mountedRef.current = false;
    if (swipeBackTimerRef.current) clearTimeout(swipeBackTimerRef.current);
  }, []);

  const resetPaneSwipeStyles = useCallback(() => {
    const el = paneRef.current;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
  }, []);

  // The mobile swipe-back gesture writes transform/transition inline for the
  // dismiss animation. MessagePane stays mounted while hidden, so clear those
  // inline styles before painting the next selected email. Also cancel the
  // swipe-back timer so it can't fire history.back() after a new email has
  // already been selected (race: user selects email B within the 220ms window).
  useLayoutEffect(() => {
    if (!isMobile || !selectedMessageId) return;
    if (swipeBackTimerRef.current) {
      clearTimeout(swipeBackTimerRef.current);
      swipeBackTimerRef.current = null;
    }
    resetPaneSwipeStyles();
  }, [isMobile, selectedMessageId, resetPaneSwipeStyles]);

  // Reset scroll position and iframe height synchronously before the browser
  // paints the new message, so the user never sees stale blank space from the
  // previous (possibly taller) email.
  useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    if (iframeRef.current) iframeRef.current.style.height = '300px';
  }, [selectedMessageId]);

  useEffect(() => {
    setAiSummary(null);
    aiSummarizeAbortRef.current?.abort();
  }, [selectedMessageId]);

  const allMessages = searchQuery.trim() ? searchResults : messages;
  const message = allMessages.find(m => m.id === selectedMessageId)
    ?? Object.values(threadMessages).flat().find(m => m.id === selectedMessageId);

  // Antispam (v0.1) — toolbar visibility for the spam / ham buttons.
  // Mirrors the heuristic in ContextMenu.jsx so the toolbar matches the menu.
  const account = accounts.find(a => a.id === message?.account_id);
  const accountFolders = useStore(s => s.folders[message?.account_id] || []);
  const spamFolderPaths = (() => {
    const mapped = account?.folder_mappings?.spam;
    if (mapped) return new Set([mapped]);
    return new Set(accountFolders.filter(f =>
      f.special_use === '\\Junk' || SPAM_NAME_RE.test(f.name || '')
    ).map(f => f.path));
  })();
  const inSpamFolder = message ? spamFolderPaths.has(message.folder) : false;
  const hasSpamFolder = spamFolderPaths.size > 0;

  // Mark current message as spam / ham from the MessagePane toolbar.
  // Mirrors MessageList.performSpamLabel (single-message variant). Kept inline
  // here so the MessagePane doesn't need to reach into MessageList internals.
  const performSingleSpamLabel = useCallback(async (label) => {
    if (!message) return;
    const wasUnread = !message.is_read;
    removeMessage(message.id);
    if (wasUnread) decrementUnread(message.account_id);
    let settled = false;
    const undo = () => {
      settled = true;
      useStore.getState().restoreMessages([message]);
      if (wasUnread) incrementUnread(message.account_id);
    };
    setTimeout(async () => {
      if (settled) return;
      try {
        const fn = label === 'spam' ? api.markSpam : api.markHam;
        await fn(message.id);
      } catch (err) {
        useStore.getState().restoreMessages([message]);
        if (wasUnread) incrementUnread(message.account_id);
        addNotification({
          type: 'error',
          title: t(label === 'spam' ? 'spam.failTitle' : 'spam.failHamTitle'),
          body: err.message || t(label === 'spam' ? 'spam.failBody' : 'spam.failHamBody'),
        });
      }
    }, 4500);
    addNotification({
      title: label === 'spam' ? t('spam.movedToSpam') : t('spam.movedToInbox'),
      body: message.subject || t('common.noSubject'),
      onUndo: undo,
    });
  }, [message, removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  const currentIdx = allMessages.findIndex(m => m.id === selectedMessageId);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < allMessages.length - 1;

  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingBody, setLoadingBody] = useState(false);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [showReplyMenu, setShowReplyMenu] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);
  const [paneScrolled, setPaneScrolled] = useState(false);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [movePickerFolders, setMovePickerFolders] = useState([]);
  const [movePickerLoading, setMovePickerLoading] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showTodoistModal, setShowTodoistModal] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [aiClassifying, setAiClassifying] = useState(false);
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null); // null | 'loading' | 'done' | 'error'
  const moveBtnRef = useRef(null);
  const moreMenuRef = useRef(null);
  const aiSummarizeAbortRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const iframeRef = useRef(null);
  const roRef = useRef(null);
  // useMemo so prepared is available in the same render as body.html — no extra frame,
  // no flash of empty content between skeleton-gone and email-shown.
  const prepared = useMemo(() => {
    if (!USE_DIV_RENDER || !body?.html) return null;
    return prepareEmailHtml(body.html, String(message?.id ?? 'preview'));
  }, [body?.html, message?.id]);
  const outerRef = useRef(null);
  const scaleRef = useRef(null);
  const innerRef = useRef(null);
  const bodyCache = useRef({}); // messageId -> body, so revisiting is instant (capped at 50)
  const bodyCacheOrder = useRef([]); // insertion-order keys for LRU eviction
  // Session-scoped set of message IDs where the user has clicked "Load images once"
  const imagesRequestedRef = useRef(new Set());
  // Ref holding the latest pane action handlers so shortcut subscriptions ([] deps) never go stale
  const paneActionsRef = useRef({});
  const emailScaleRef = useRef(1); // scale applied to wide emails that resist CSS reflow

  // Track previous blocking policy so we can detect tightening vs loosening.
  const prevBlockingPolicyRef = useRef(null);

  // Flush body cache when the image-blocking policy changes:
  // - Tightening (blocking ON, or whitelist entry removed): evict unblocked entries so they
  //   re-fetch with blocking applied. Also clear imagesRequestedRef for evicted IDs so a
  //   prior "load images once" click doesn't silently bypass the re-tightened policy.
  // - Loosening globally (blocking turned OFF): evict blocked entries so the current email
  //   immediately shows images without requiring navigation. Whitelist additions are handled
  //   directly in handleAllowSender/Domain to avoid triggering a double-eviction here.
  useEffect(() => {
    const prev = prevBlockingPolicyRef.current;
    const curr = {
      blockRemoteImages,
      addrCount: (imageWhitelist?.addresses || []).length,
      domainCount: (imageWhitelist?.domains || []).length,
    };
    prevBlockingPolicyRef.current = curr;
    if (!prev) return; // skip initial mount

    const tightened =
      (!prev.blockRemoteImages && curr.blockRemoteImages) ||
      prev.addrCount > curr.addrCount ||
      prev.domainCount > curr.domainCount;
    const loosenedGlobally = prev.blockRemoteImages && !curr.blockRemoteImages;
    // Whitelist additions from any source (email banner or Admin Privacy tab) need
    // blocked cache entries evicted. The email banner handlers also do this directly
    // but a second eviction pass on an already-empty slot is harmless.
    const loosenedViaWhitelist = !tightened && (
      curr.addrCount > prev.addrCount || curr.domainCount > prev.domainCount
    );

    let evicted = false;
    if (tightened) {
      for (const id of Object.keys(bodyCache.current)) {
        if (!bodyCache.current[id]?.hasBlockedRemoteImages) {
          delete bodyCache.current[id];
          imagesRequestedRef.current.delete(id); // clear "load once" so policy is respected
          evicted = true;
        }
      }
    }
    if (loosenedGlobally || loosenedViaWhitelist) {
      for (const id of Object.keys(bodyCache.current)) {
        if (bodyCache.current[id]?.hasBlockedRemoteImages) {
          delete bodyCache.current[id];
          evicted = true;
        }
      }
    }
    if (evicted) {
      bodyCacheOrder.current = bodyCacheOrder.current.filter(id => bodyCache.current[id]);
      setRetryKey(k => k + 1);
    }
  }, [blockRemoteImages, imageWhitelist]);

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
      // Scale visual height to match the proportional scale applied to the
      // email wrapper (1 for normal emails, <1 for wide fixed-layout emails).
      const scaled = Math.round(h * emailScaleRef.current);
      if (scaled > lastH) {
        lastH = scaled;
        iframe.style.height = scaled + 'px';
      }
    };

    const onLoaded = () => {
      emailScaleRef.current = 1; // reset for each new email

      const doc = iframe.contentDocument;
      if (!doc) return;

      // Some marketing emails (e.g. Avis) use class-based !important rules that
      // lock layout to a fixed pixel width and cannot be overridden by our injected
      // CSS. Measure the rendered content width and, if it exceeds the iframe,
      // scale the entire wrapper div down proportionally so all content is visible.
      const iframeW = iframe.offsetWidth;
      if (iframeW > 0) {
        // iOS Safari clamps scrollWidth to the iframe viewport when overflow:hidden
        // is set on html/body, so wide fixed-layout emails are never detected.
        // Temporarily expose overflow-x inline (beating the !important stylesheet
        // rule) to let scrollWidth reflect the true content width, then restore.
        // Note: overflow-x:visible is coerced to auto when overflow-y is non-visible —
        // that's fine; auto still returns the real scrollable content width.
        const b = doc.body;
        const h = doc.documentElement;
        if (b) b.style.setProperty('overflow-x', 'visible', 'important');
        if (h) h.style.setProperty('overflow-x', 'visible', 'important');
        const contentW = Math.max(
          h ? h.scrollWidth : 0,
          b ? b.scrollWidth : 0,
        );
        if (b) b.style.removeProperty('overflow-x');
        if (h) h.style.removeProperty('overflow-x');

        const wrapper = doc.getElementById('mf-scale-wrapper');
        if (contentW > iframeW + 2) { // +2 absorbs sub-pixel rounding
          const scale = iframeW / contentW;
          emailScaleRef.current = scale;
          if (wrapper) {
            wrapper.style.transform       = `scale(${scale})`;
            wrapper.style.transformOrigin = 'top left';
            // Lock the wrapper at its natural content width so the scale
            // maps exactly contentW → iframeW with no clipping.
            wrapper.style.width           = `${contentW}px`;
          }
        }
      }

      lastH = 0; // recalculate from scratch with the new scale
      setHeight();
      rafId = requestAnimationFrame(setHeight);

      // Intercept all link clicks so they always open in a real browser tab.
      // Without this, relative hrefs (e.g. href="/") resolve to the mailflow
      // origin via allow-same-origin and open a new mailflow tab instead of
      // the intended destination.  We read the raw attribute to bypass
      // browser resolution and only forward absolute http(s)/mailto links.
      doc.addEventListener('click', (ev) => {
        const anchor = ev.target.closest('a[href]');
        if (!anchor) return;
        ev.preventDefault();
        let raw = anchor.getAttribute('href') || '';
        if (raw.startsWith('//')) raw = 'https:' + raw;
        if (/^https?:\/\//i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        } else if (/^mailto:/i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        }
      });

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
      emailScaleRef.current = 1;
    };
  }, [body?.html, selectedMessageId]);

  // Inject scoped email styles before paint so there is no flash of unstyled content.
  // useLayoutEffect runs synchronously after DOM mutations and before the browser paints,
  // so the <style> tag is in <head> before the email div becomes visible.
  useLayoutEffect(() => {
    if (!prepared) return;
    injectEmailStyles(prepared.prefix, prepared.styleBlocks);
    return () => removeEmailStyles(prepared.prefix);
  }, [prepared]);

  // Div render path — scale-to-fit for wide fixed-layout emails.
  // Uses outer/inner refs: measures inner (natural dimensions, unaffected by transform),
  // sets height/overflow on outer (not observed by the ResizeObserver, preventing loops).
  useEffect(() => {
    if (!USE_DIV_RENDER || !prepared) return;

    let rafId = null;

    const applyScale = () => {
      const inner  = innerRef.current;
      const outer  = outerRef.current;
      const scaler = scaleRef.current;
      if (!inner || !outer || !scaler) return;

      // Reset first so we measure natural/unscaled dimensions.
      // Transform goes on scaleRef (not innerRef) so the base normalize's
      // transform:none!important on .email-* never cancels the scale.
      scaler.style.transform       = '';
      scaler.style.transformOrigin = '';
      outer.style.height    = '';
      outer.style.overflowX = '';

      const containerW = outer.clientWidth;
      const contentW   = inner.scrollWidth; // unaffected by ancestor transforms

      if (containerW > 0 && contentW > containerW + 2) {
        const scale = containerW / contentW;
        scaler.style.transform       = `scale(${scale})`;
        scaler.style.transformOrigin = 'top left';
        outer.style.height           = Math.round(inner.scrollHeight * scale) + 'px';
        // Transform does not change layout width; hide the scrollbar in scaled mode.
        outer.style.overflowX        = 'hidden';
      }
    };

    const scheduleScale = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { rafId = null; applyScale(); });
    };

    // Store image listeners so we can remove them if the message changes mid-load.
    const imageListeners = [];
    innerRef.current?.querySelectorAll('img').forEach(img => {
      if (!img.complete) {
        const handler = () => scheduleScale();
        img.addEventListener('load', handler, { once: true });
        imageListeners.push({ img, handler });
      }
    });

    // Watch inner for content reflow (web fonts, dynamic content).
    // Do NOT observe outer — we set outer.style.height ourselves, which would
    // immediately re-fire the observer and produce a measurement loop.
    let ro;
    if (window.ResizeObserver && innerRef.current) {
      ro = new ResizeObserver(scheduleScale);
      ro.observe(innerRef.current);
    }

    scheduleScale();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      imageListeners.forEach(({ img, handler }) => img.removeEventListener('load', handler));
    };
  }, [prepared]);

  // Fade in pane content when switching messages on desktop
  useEffect(() => {
    if (isMobile || !selectedMessageId || !paneRef.current) return;
    const el = paneRef.current;
    el.style.animation = 'none';
    el.offsetHeight; // force reflow to restart animation
    el.style.animation = 'pane-fade-in 0.15s ease';
  }, [selectedMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swipe-back gesture: right-swipe from left edge returns to message list on mobile
  useEffect(() => {
    if (!isMobile) return;
    const el = paneRef.current;
    if (!el) return;

    let startX = 0, startY = 0, dir = null, active = false, fromEdge = false;

    const onStart = (e) => {
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      fromEdge = t.clientX <= 32;
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
      if (dir === 'v') return;
      if (fromEdge) {
        if (dx < 0) return;
        e.preventDefault();
        active = true;
        el.style.transition = 'none';
        el.style.transform = `translateX(${dx}px)`;
      } else {
        if (Math.abs(dx) < 5) return;
        e.preventDefault();
        active = true;
      }
    };

    const onEnd = (e) => {
      if (!active) return;
      active = false;
      // Prevent the browser's synthesized click that fires ~300ms after touchend.
      // Without this, after a swipe-back the pane hides and the list becomes
      // visible at the same coordinates — the phantom click then hits a list row
      // and ghost-selects an email the user never tapped.
      e.preventDefault();
      const dx = e.changedTouches[0].clientX - startX;
      if (fromEdge) {
        if (dx > 80) {
          el.style.transition = 'transform 0.22s ease';
          el.style.transform = `translateX(${window.innerWidth}px)`;
          if (swipeBackTimerRef.current) clearTimeout(swipeBackTimerRef.current);
          swipeBackTimerRef.current = setTimeout(() => {
            swipeBackTimerRef.current = null;
            resetPaneSwipeStyles();
            if (mountedRef.current) history.back();
          }, 220);
        } else {
          el.style.transition = 'transform 0.25s ease';
          el.style.transform = 'translateX(0)';
        }
      } else {
        const { messages: msgs, searchResults: sr, searchQuery: sq, selectedMessageId: selId, setSelectedMessage: setSel, updateMessage: updMsg, decrementUnread: decUnread, incrementUnread: incUnread, adjustCategoryCount: adjCat } = useStore.getState();
        const list = sq.trim() ? sr : msgs;
        const idx = list.findIndex(m => m.id === selId);
        let target = null;
        if (dx < -60 && idx >= 0 && idx < list.length - 1) {
          target = list[idx + 1];
        } else if (dx > 60 && idx > 0) {
          target = list[idx - 1];
        }
        if (target) {
          setSel(target.id);
          if (!target.is_read) {
            updMsg(target.id, { is_read: true });
            decUnread(target.account_id);
            adjCat(target.category, -1);
            setPending(target.id, target.account_id);
            api.bulkRead([target.id], true)
              .then(() => {
                pendingMarkReadMap.delete(target.id);
                completedMarkReadMap.set(target.id, target.account_id);
                setTimeout(() => completedMarkReadMap.delete(target.id), 10000);
              })
              .catch(e => {
                console.error('markRead failed:', e.message);
                updMsg(target.id, { is_read: false });
                incUnread(target.account_id);
                adjCat(target.category, 1);
                pendingMarkReadMap.delete(target.id);
              });
          }
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    // Non-passive so onEnd can call e.preventDefault() to suppress the phantom click.
    el.addEventListener('touchend', onEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [isMobile, setSelectedMessage, resetPaneSwipeStyles]);

  const handleReply = (replyAll = false) => {
    if (!message) return;
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const safeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
    const fromStr = safeName
      ? `${safeName} <${message.from_email}>`
      : message.from_email || '';
    const quotedText = body?.text
      ? `\n\n---\nOn ${date}, ${fromStr} wrote:\n${body.text.split('\n').map(l => '> ' + l).join('\n')}`
      : '';
    const quotedBodyHtml = body?.html
      ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${date}, ${fromStr} wrote:</p>${body.html}</div>`
      : null;

    const replyToArr = Array.isArray(message.reply_to)
      ? message.reply_to
      : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
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
        const fromEmail = (message.from_email || '').toLowerCase();
        const match = aliases.find(al => {
          const aliasEmail = al.email.toLowerCase();
          return allEmails.includes(aliasEmail) || fromEmail === aliasEmail;
        });
        return match ? match.id : null;
      } catch { return null; }
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
      } catch { return []; }
    })();

    const referencesChain = [message.in_reply_to, message.message_id]
      .filter(Boolean).join(' ').trim() || null;

    const rawSubject = (message.subject || '').trim();
    const reSubject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';

    setShowReplyMenu(false);
    openCompose({
      to: sender,
      cc: replyAll ? allRecipients : [],
      subject: reSubject,
      body: '',
      quotedBody: quotedText,
      quotedBodyHtml,
      inReplyTo: message.message_id,
      references: referencesChain,
      accountId: message.account_id,
      aliasId: replyAliasId,
      isReply: true,
      isReplyAll: replyAll,
      originalFrom: sender,
      allRecipients,
      threadId: message.thread_id,
    });
  };

  const handleForward = () => {
    if (!message) return;
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const safeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
    const fromStr = safeName
      ? `${safeName} <${message.from_email}>`
      : message.from_email || '';
    const safeSubject = (message.subject || '').replace(/[\r\n]+/g, ' ');

    const toStr = parseAddressField(message.to_addresses);
    const ccStr = parseAddressField(message.cc_addresses);

    const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${safeSubject}${toStr ? `\nTo: ${toStr}` : ''}${ccStr ? `\nCc: ${ccStr}` : ''}\n\n${body?.text || ''}`;
    const fwdHtml = body?.html
      ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${fromStr}<br>Date: ${date}<br>Subject: ${safeSubject}${toStr ? `<br>To: ${toStr}` : ''}${ccStr ? `<br>Cc: ${ccStr}` : ''}</p>${body.html}</div>`
      : null;
    openCompose({
      subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      body: '',
      quotedBody: fwdText,
      quotedBodyHtml: fwdHtml,
      accountId: message.account_id,
      isForward: true,
      forwardedAttachments: (body?.attachments || []).map(att => ({
        messageId: message.id,
        part: att.part,
        filename: att.filename || 'attachment',
        type: att.type || 'application/octet-stream',
        size: att.size || 0,
      })),
    });
  };

  const handleStarToggle = async () => {
    if (!message) return;
    const newVal = !message.is_starred;
    await api.markStarred(message.id, newVal);
    updateMessage(message.id, { is_starred: newVal });
  };

  const handlePrint = () => {
    if (!message) return;
    const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const date = message.date ? new Date(message.date).toLocaleString() : '';
    const fromStr = message.from_name
      ? `${esc(message.from_name)} &lt;${esc(message.from_email)}&gt;`
      : esc(message.from_email);

    const parseList = (raw) => {
      try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; }
    };
    const fmtAddr = (r) => r.name ? `${esc(r.name)} &lt;${esc(r.email)}&gt;` : esc(r.email);
    const toStr = parseList(message.to_addresses).map(fmtAddr).join(', ');
    const ccStr = parseList(message.cc_addresses).map(fmtAddr).join(', ');

    const bodyContent = body?.html
      ? body.html
      : body?.text
        ? `<pre style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${esc(body.text)}</pre>`
        : '';

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(message.subject)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 32px; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 18px; margin: 0 0 12px; }
  .meta { font-size: 13px; color: #444; line-height: 1.8; }
  .meta span { font-weight: 600; color: #111; }
  @media print { body { margin: 16px; } }
</style></head><body>
<div class="header">
  <h1>${esc(message.subject) || '(no subject)'}</h1>
  <div class="meta">
    <div><span>From:</span> ${fromStr}</div>
    <div><span>To:</span> ${toStr}</div>
    ${ccStr ? `<div><span>Cc:</span> ${ccStr}</div>` : ''}
    <div><span>Date:</span> ${date}</div>
  </div>
</div>
${bodyContent}
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
  };

  const handleSummarize = async () => {
    const textContent = body?.text
      || body?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      || '';
    if (!textContent) return;
    aiSummarizeAbortRef.current?.abort();
    const ctrl = new AbortController();
    aiSummarizeAbortRef.current = ctrl;
    setAiSummary({ status: 'loading', text: '' });
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: ctrl.signal,
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: `Summarize this email concisely in 2-4 sentences. Focus on the key points and any action items.\n\n${textContent.slice(0, 6000)}`,
          }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setAiSummary({ status: 'error', text: err.error || res.statusText });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const chunk = line.slice(6).trim();
          if (chunk === '[DONE]') break;
          try {
            const delta = JSON.parse(chunk)?.choices?.[0]?.delta?.content;
            if (delta) { fullText += delta; setAiSummary({ status: 'loading', text: fullText }); }
          } catch { /* skip */ }
        }
      }
      setAiSummary({ status: 'done', text: fullText || '' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setAiSummary({ status: 'error', text: err.message });
    }
  };

  // Keep pane action refs current every render
  paneActionsRef.current = {
    reply:      () => handleReply(defaultReplyAll),
    replyAll:   () => handleReply(true),
    forward:    handleForward,
    toggleStar: handleStarToggle,
    print:      handlePrint,
  };

  // Subscribe to keyboard shortcut actions that belong to the message pane.
  // Registered once ([] deps); live state is accessed through paneActionsRef.
  useEffect(() => {
    const onReply        = () => paneActionsRef.current.reply();
    const onReplyAll     = () => paneActionsRef.current.replyAll();
    const onForward      = () => paneActionsRef.current.forward();
    const onToggleStar   = () => paneActionsRef.current.toggleStar();
    const onPrintMessage = () => paneActionsRef.current.print?.();

    shortcutBus.on('reply',         onReply);
    shortcutBus.on('replyAll',      onReplyAll);
    shortcutBus.on('forward',       onForward);
    shortcutBus.on('toggleStar',    onToggleStar);
    shortcutBus.on('printMessage',  onPrintMessage);

    return () => {
      shortcutBus.off('reply',         onReply);
      shortcutBus.off('replyAll',      onReplyAll);
      shortcutBus.off('forward',       onForward);
      shortcutBus.off('toggleStar',    onToggleStar);
      shortcutBus.off('printMessage',  onPrintMessage);
    };
  }, []);

  useEffect(() => {
    api.ai.status().then(setAiStatus).catch(() => {});
    return () => { aiSummarizeAbortRef.current?.abort(); };
  }, []);

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

  const handleOpenMovePicker = useCallback(async () => {
    if (!message) return;
    if (showMovePicker) { setShowMovePicker(false); return; }
    setShowMovePicker(true);
    setMovePickerLoading(true);
    try {
      const data = await api.getFolders(message.account_id);
      setMovePickerFolders(Array.isArray(data) ? data : (data.folders || []));
    } catch (err) {
      console.error('Failed to load folders:', err);
      setMovePickerFolders([]);
    } finally {
      setMovePickerLoading(false);
    }
  }, [showMovePicker, message?.account_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMarkUnread = useCallback(() => {
    if (!message || !message.is_read) return;
    updateMessage(message.id, { is_read: false });
    incrementUnread(message.account_id);
    adjustCategoryCount(message.category, 1);
    completedMarkReadMap.delete(message.id);
    pendingMarkReadMap.delete(message.id);
    api.bulkRead([message.id], false).catch(e => {
      console.error('markUnread failed:', e.message);
      updateMessage(message.id, { is_read: true });
      decrementUnread(message.account_id);
      adjustCategoryCount(message.category, -1);
    });
    if (isMobile) setSelectedMessage(null);
  }, [message, updateMessage, incrementUnread, decrementUnread, adjustCategoryCount, isMobile, setSelectedMessage]);

  const handleEmailClick = useCallback((ev) => {
    const anchor = ev.target.closest('a[href]');
    if (!anchor) return;
    ev.preventDefault();
    let raw = anchor.getAttribute('href') || '';
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (/^https?:\/\//i.test(raw)) {
      window.open(raw, '_blank', 'noopener,noreferrer');
    } else if (/^mailto:/i.test(raw)) {
      window.open(raw, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handleMoveToFolder = useCallback((folder) => {
    if (!message) return;
    setShowMovePicker(false);
    const moved = message;
    removeMessage(moved.id);
    if (!moved.is_read) decrementUnread(moved.account_id);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.bulkMove([moved.id], folder);
        useStore.getState().recordRecentFolder({ accountId: moved.account_id, path: folder });
      } catch (err) {
        console.error('Move failed:', err);
        useStore.getState().restoreMessages([moved]);
        if (!moved.is_read) incrementUnread(moved.account_id);
        addNotification({ title: t('message.moved.failTitle'), body: t('message.moved.failBody') });
      }
    }, 4500);
    addNotification({
      title: t('message.moved.title'),
      body: folder,
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        useStore.getState().restoreMessages([moved]);
        if (!moved.is_read) incrementUnread(moved.account_id);
      },
    });
  }, [message, removeMessage, decrementUnread, incrementUnread, addNotification, t]);

  // Close move picker when the selected message changes and handle click-outside
  useEffect(() => {
    setShowMovePicker(false);
    setShowHeaderModal(false);
    setShowMoreMenu(false);
    setUnsubscribeStatus(null);
    setAiClassifying(false);
  }, [selectedMessageId]);

  useEffect(() => {
    if (!showMovePicker) return;
    const onPointer = (e) => {
      if (moveBtnRef.current && !moveBtnRef.current.contains(e.target)) {
        setShowMovePicker(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [showMovePicker]);

  useEffect(() => {
    if (!showMoreMenu) return;
    const onPointer = (e) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [showMoreMenu]);

  const recentForMove = message
    ? recentFolders
        .filter(r => r.accountId === message.account_id && r.path !== message.folder)
        .map(r => movePickerFolders.find(f => f.path === r.path))
        .filter(Boolean)
    : [];
  const favoritesForMove = message
    ? favoriteFolders
        .filter(fav => fav.accountId === message.account_id && fav.path !== message.folder)
        .map(fav => movePickerFolders.find(f => f.path === fav.path))
        .filter(Boolean)
        .filter(f => !recentForMove.some(r => r.path === f.path))
    : [];

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

  const handleDelete = () => {
    const deleted = message;
    setPendingDelete(deleted.id);
    removeMessage(deleted.id);
    if (!deleted.is_read) decrementUnread(deleted.account_id);
    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.deleteMessage(deleted.id);
        setCompletedDelete(deleted.id);
      } catch {
        clearDeleteGuard(deleted.id);
        useStore.getState().restoreMessages([deleted]);
        if (!deleted.is_read) incrementUnread(deleted.account_id);
        addNotification({ type: 'error', title: t('messageList.deleted.failTitle'), body: t('messageList.deleted.failBody') });
      }
    }, 4500);
    addNotification({
      title: t('messageList.deleted.title'),
      body: t('messageList.deleted.body'),
      onUndo: () => {
        undone = true;
        clearTimeout(timer);
        clearPendingDelete(deleted.id);
        useStore.getState().restoreMessages([deleted]);
        if (!deleted.is_read) incrementUnread(deleted.account_id);
      },
    });
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
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type: 'address', value: senderEmail });
      // Evict all blocked cache entries so they re-fetch with images unblocked
      for (const id of Object.keys(bodyCache.current)) {
        if (bodyCache.current[id]?.hasBlockedRemoteImages) delete bodyCache.current[id];
      }
      bodyCacheOrder.current = bodyCacheOrder.current.filter(id => bodyCache.current[id]);
      setRetryKey(k => k + 1);
    } catch {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!message) return;
    setUnsubscribeStatus('loading');
    try {
      const result = await api.unsubscribeMessage(message.id);
      if (result.type === 'one-click') {
        setUnsubscribeStatus('done');
        addNotification({ title: t('message.unsubscribe.done') });
      } else if (result.type === 'url' && result.url) {
        setUnsubscribeStatus('done');
        window.open(result.url, '_blank', 'noopener,noreferrer');
      } else if (result.type === 'mailto' && result.mailto) {
        setUnsubscribeStatus('done');
        window.open(result.mailto, '_blank', 'noopener,noreferrer');
      } else {
        setUnsubscribeStatus('error');
      }
    } catch {
      setUnsubscribeStatus('error');
      addNotification({ type: 'error', title: t('message.unsubscribe.error') });
    }
  };

  const handleAiClassify = async () => {
    if (!message || aiClassifying) return;
    setAiClassifying(true);
    try {
      const result = await api.categories.aiClassify(message.id);
      if (result.category) {
        updateMessage(message.id, { category: result.category === 'primary' ? null : result.category });
        // Refresh category counts since this message may have moved tabs.
        const acct = accounts.find(a => a.id === message.account_id);
        if (acct) {
          const params = message.account_id ? { accountId: message.account_id } : {};
          api.getCategoryCounts(params).then(d => setCategoryCounts(d.counts || {})).catch(() => {});
        }
        addNotification({ title: t('message.aiClassify.done', { category: t(`messageList.categories.${result.category}`) }) });
      }
    } catch {
      addNotification({ type: 'error', title: t('message.aiClassify.error') });
    } finally {
      setAiClassifying(false);
    }
  };

  const handleAllowDomain = async () => {
    const senderEmail = message.from_email?.toLowerCase() || '';
    const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
    if (!senderDomain) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type: 'domain', value: senderDomain });
      // Evict all blocked cache entries so they re-fetch with images unblocked
      for (const id of Object.keys(bodyCache.current)) {
        if (bodyCache.current[id]?.hasBlockedRemoteImages) delete bodyCache.current[id];
      }
      bodyCacheOrder.current = bodyCacheOrder.current.filter(id => bodyCache.current[id]);
      setRetryKey(k => k + 1);
    } catch {
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
    } catch { return []; }
  })();

  const ccList = (() => {
    try {
      return Array.isArray(message.cc_addresses)
        ? message.cc_addresses
        : JSON.parse(message.cc_addresses || '[]');
    } catch { return []; }
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
          <button
            disabled={!hasPrev}
            onClick={() => selectAndMarkRead(allMessages[currentIdx - 1])}
            title={t('message.previousMessage')}
            style={{
              background: 'none', border: 'none', flexShrink: 0,
              color: 'var(--text-secondary)', cursor: hasPrev ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', padding: '4px 6px',
              opacity: hasPrev ? 1 : 0.3,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
          <button
            disabled={!hasNext}
            onClick={() => selectAndMarkRead(allMessages[currentIdx + 1])}
            title={t('message.nextMessage')}
            style={{
              background: 'none', border: 'none', flexShrink: 0,
              color: 'var(--text-secondary)', cursor: hasNext ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', padding: '4px 6px',
              opacity: hasNext ? 1 : 0.3,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
      )}

      {/* Toolbar — always pinned at top, never scrolls */}
      <div style={{
        padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        boxShadow: paneScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
        transition: 'box-shadow 0.2s ease',
      }}>
        {/* Split Reply button */}
        <div style={{ position: 'relative', display: 'flex' }}>
          <PaneBtn onClick={() => handleReply(defaultReplyAll)} style={{ borderRadius: '6px 0 0 6px' }} title={isMobile ? (defaultReplyAll ? t('message.replyAll') : t('message.reply')) : `${defaultReplyAll ? t('message.replyAll') : t('message.reply')}${shortcutLabel(defaultReplyAll ? 'replyAll' : 'reply') ? ` (${shortcutLabel(defaultReplyAll ? 'replyAll' : 'reply')})` : ''}`}>
            {defaultReplyAll ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polyline points="7 17 2 12 7 7"/><polyline points="13 17 8 12 13 7"/><path d="M20 18v-2a4 4 0 00-4-4H2"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/>
              </svg>
            )}
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
                defaultReplyAll
                  ? { label: t('message.reply'), replyAll: false }
                  : { label: t('message.replyAll'), replyAll: true },
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

        <PaneBtn onClick={handleForward} title={isMobile ? t('message.forward') : `${t('message.forward')}${shortcutLabel('forward') ? ` (${shortcutLabel('forward')})` : ''}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/>
          </svg>
        </PaneBtn>

        <PaneBtn onClick={handleArchive} title={isMobile ? t('message.archive') : `${t('message.archive')}${shortcutLabel('archive') ? ` (${shortcutLabel('archive')})` : ''}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="2" y="3" width="20" height="5" rx="1"/>
            <path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/>
            <polyline points="9 13 12 16 15 13"/>
            <line x1="12" y1="11" x2="12" y2="16"/>
          </svg>
        </PaneBtn>

        {/* Move to folder */}
        <div style={{ position: 'relative' }} ref={moveBtnRef}>
          <PaneBtn onClick={handleOpenMovePicker} title={t('contextMenu.moveToFolder')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </PaneBtn>
          {/* Desktop dropdown */}
          {showMovePicker && !isMobile && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 8, boxShadow: 'var(--shadow-popover)',
              minWidth: 200, maxWidth: 280, maxHeight: 320, overflowY: 'auto',
              zIndex: 200,
            }}>
              {movePickerLoading ? (
                <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : movePickerFolders.length === 0 ? (
                <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.empty')}
                </div>
              ) : (
                <>
                  {recentForMove.length > 0 && (
                    <>
                      <div style={{ padding: '5px 12px 3px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {t('contextMenu.folders.recent')}
                      </div>
                      {recentForMove.map(f => (
                        <button
                          key={`recent-${f.path}`}
                          onClick={() => handleMoveToFolder(f.path)}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} /></span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        </button>
                      ))}
                      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                    </>
                  )}
                  {favoritesForMove.length > 0 && (
                    <>
                      <div style={{ padding: '5px 12px 3px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {t('contextMenu.folders.favorites')}
                      </div>
                      {favoritesForMove.map(f => (
                        <button
                          key={`fav-${f.path}`}
                          onClick={() => handleMoveToFolder(f.path)}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} /></span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        </button>
                      ))}
                      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                    </>
                  )}
                  {movePickerFolders
                    .filter(f => f.path !== message.folder)
                    .map(f => (
                      <button
                        key={f.path}
                        onClick={() => handleMoveToFolder(f.path)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} /></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      </button>
                    ))
                  }
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {isMobile ? (
          <div style={{ position: 'relative' }} ref={moreMenuRef}>
            <PaneBtn onClick={() => setShowMoreMenu(v => !v)} title={t('message.more')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
              </svg>
            </PaneBtn>
            {showMoreMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, overflow: 'hidden', zIndex: 100,
                boxShadow: '0 4px 20px rgba(0,0,0,0.4)', minWidth: 190,
              }}>
                {message.is_read && (
                  <div
                    onClick={() => { setShowMoreMenu(false); handleMarkUnread(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                      <path d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V9"/>
                      <polyline points="22 9 12 16 2 9"/>
                      <polyline points="22 9 12 2 22 9"/>
                    </svg>
                    {t('contextMenu.markUnread')}
                  </div>
                )}
                {hasSpamFolder && !inSpamFolder && message && (
                  <div
                    onClick={() => { performSingleSpamLabel('spam'); setShowMoreMenu(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    {t('contextMenu.markAsSpam')}
                  </div>
                )}
                {inSpamFolder && message && (
                  <div
                    onClick={() => { performSingleSpamLabel('ham'); setShowMoreMenu(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
                      <polyline points="9 12 11 14 15 10"/>
                    </svg>
                    {t('contextMenu.markAsHam')}
                  </div>
                )}
                {todoistConnected && (
                  <div
                    onClick={() => { setShowTodoistModal(true); setShowMoreMenu(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z"/>
                    </svg>
                    {t('todoist.title')}
                  </div>
                )}
                <div
                  onClick={() => { setShowHeaderModal(true); setShowMoreMenu(false); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                  </svg>
                  {t('contextMenu.viewHeaders')}
                </div>
                <div
                  onClick={() => { handlePrint(); setShowMoreMenu(false); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)', borderBottom: aiStatus?.enabled && aiStatus?.features?.summarize && body ? '1px solid var(--border-subtle)' : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <polyline points="6 9 6 2 18 2 18 9"/>
                    <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
                    <rect x="6" y="14" width="12" height="8"/>
                  </svg>
                  {t('message.print')}
                </div>
                {aiStatus?.enabled && aiStatus?.features?.summarize && body && (
                  <div
                    onClick={() => { handleSummarize(); setShowMoreMenu(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                      <path d="M5 3v4M19 17v4M3 5h4M17 19h4"/>
                    </svg>
                    {t('message.summarize')}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {hasSpamFolder && !inSpamFolder && message && (
              <PaneBtn onClick={() => performSingleSpamLabel('spam')} title={t('contextMenu.markAsSpam')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </PaneBtn>
            )}
            {inSpamFolder && message && (
              <PaneBtn onClick={() => performSingleSpamLabel('ham')} title={t('contextMenu.markAsHam')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/>
                  <polyline points="9 12 11 14 15 10"/>
                </svg>
              </PaneBtn>
            )}
            {todoistConnected && (
              <PaneBtn onClick={() => setShowTodoistModal(true)} title={t('todoist.title')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z"/>
                </svg>
              </PaneBtn>
            )}
            {message.is_read && (
              <PaneBtn onClick={handleMarkUnread} title={t('contextMenu.markUnread')}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                  <path d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V9"/>
                  <polyline points="22 9 12 16 2 9"/>
                  <polyline points="22 9 12 2 22 9"/>
                </svg>
              </PaneBtn>
            )}
            <PaneBtn onClick={() => setShowHeaderModal(true)} title={t('contextMenu.viewHeaders')}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </PaneBtn>
            <PaneBtn onClick={handlePrint} title={`${t('message.print')}${shortcutLabel('printMessage') ? ` (${shortcutLabel('printMessage')})` : ''}`}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polyline points="6 9 6 2 18 2 18 9"/>
                <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>
            </PaneBtn>
            {aiStatus?.enabled && aiStatus?.features?.summarize && body && (
              <PaneBtn onClick={handleSummarize} title={t('message.summarize')}
                style={aiSummary ? { color: 'var(--accent)' } : {}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                  <path d="M5 3v4M19 17v4M3 5h4M17 19h4"/>
                </svg>
              </PaneBtn>
            )}
          </>
        )}

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
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg-primary)' }}
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
              background: senderColor(message.from_email || message.from_name),
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
                  {ccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>Cc </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {ccList.map((r, i) => (
                          <span key={i}>{r.name || r.email}{i < ccList.length - 1 ? ', ' : ''}</span>
                        ))}
                      </span>
                    </div>
                  )}
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
                  {ccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      <span>Cc </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {ccList.map((r, i) => (
                          <span key={i}>
                            {r.name ? `${r.name} <${r.email}>` : r.email}
                            {i < ccList.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>
                {t('message.attachment', { count: attachments.length })}
              </div>
              {attachments.length > 1 && (
                <a
                  href={`/api/mail/messages/${message.id}/attachments.zip`}
                  download
                  style={{
                    fontSize: 12, color: 'var(--accent)', textDecoration: 'none',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  {t('message.downloadAll')}
                </a>
              )}
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

        {/* AI summary panel */}
        {aiSummary && (
          <div style={{
            marginBottom: 16,
            padding: '12px 16px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: 8,
            fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('message.summary')}
              </span>
              <button onClick={() => setAiSummary(null)} aria-label={t('message.summaryDismiss')} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-tertiary)', padding: '2px 4px', fontSize: 14, lineHeight: 1,
              }}>×</button>
            </div>
            {aiSummary.status === 'loading' && !aiSummary.text && (
              <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{t('compose.toolbar.aiGenerating')}</span>
            )}
            {aiSummary.status === 'error' ? (
              <span style={{ color: 'var(--red)' }}>{t('compose.toolbar.aiError', { message: aiSummary.text })}</span>
            ) : (
              <span>{aiSummary.text}</span>
            )}
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
          {/* Unsubscribe banner — shown for newsletter messages that have a List-Unsubscribe header */}
          {message.list_unsubscribe && unsubscribeStatus !== 'done' && (
            <div style={{
              marginBottom: 10, padding: '9px 14px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--text-tertiary)',
              borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <span style={{ flex: 1 }}>{t('message.unsubscribe.info')}</span>
              <button
                onClick={handleUnsubscribe}
                disabled={unsubscribeStatus === 'loading'}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  borderRadius: 5, padding: '3px 9px',
                  cursor: unsubscribeStatus === 'loading' ? 'default' : 'pointer',
                  color: unsubscribeStatus === 'error' ? 'var(--red, #e53e3e)' : 'var(--text-primary)',
                  fontSize: 11, fontWeight: 500,
                  opacity: unsubscribeStatus === 'loading' ? 0.5 : 1,
                }}
              >
                {unsubscribeStatus === 'loading' ? t('common.loading') :
                 unsubscribeStatus === 'error' ? t('message.unsubscribe.error') :
                 t('message.unsubscribe.button')}
              </button>
            </div>
          )}

          {/* AI classify banner — shown for messages with no category signal when AI is available */}
          {!message.category && (categorizationEnabled || accounts.find(a => a.id === message.account_id)?.categorization_enabled) && aiStatus?.enabled && (
            <div style={{
              marginBottom: 10, padding: '9px 14px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--text-tertiary)',
              borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <span style={{ flex: 1 }}>{t('message.aiClassify.info')}</span>
              <button
                onClick={handleAiClassify}
                disabled={aiClassifying}
                style={{
                  background: 'none', border: '1px solid var(--border)',
                  borderRadius: 5, padding: '3px 9px',
                  cursor: aiClassifying ? 'default' : 'pointer',
                  color: 'var(--text-primary)',
                  fontSize: 11, fontWeight: 500,
                  opacity: aiClassifying ? 0.5 : 1,
                }}
              >
                {aiClassifying ? t('common.loading') : t('message.aiClassify.button')}
              </button>
            </div>
          )}

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
            position: 'relative',
            padding: '14px 16px 12px',
            background: 'white',
            borderRadius: isMobile ? 0 : 10,
            border: isMobile ? 'none' : '1px solid var(--border-subtle)',
            overflow: 'hidden',
            // contain:layout establishes a containing block for any position:fixed
            // descendants (including the inner email div if email CSS repositions it).
            contain: 'layout',
          }}>
            {USE_DIV_RENDER ? (
              // Three-layer structure keeps concerns separate:
              // Outer  — click interception, height/overflow for scale-to-fit,
              //          position:relative + parent contain:layout contain hostile CSS.
              // Scale  — receives the CSS transform for scale-to-fit; carries no
              //          email CSS class so transform:none!important on .email-*
              //          never cancels the scale.
              // Inner  — scoped email CSS root (.email-* class + data attribute);
              //          transform:none!important here neutralises hostile body CSS
              //          without touching the scale wrapper above it.
              <div
                ref={outerRef}
                style={{ position: 'relative', width: '100%' }}
                onClick={handleEmailClick}
              >
                <div ref={scaleRef}>
                  <div
                    ref={innerRef}
                    data-mailflow-email={prepared?.prefix}
                    className={prepared?.prefix ?? ''}
                    dangerouslySetInnerHTML={prepared ? { __html: prepared.html } : undefined}
                  />
                </div>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <meta name="color-scheme" content="only light">
                <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
                <base target="_blank">
              </head><body><div id="mf-scale-wrapper">${
                body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
              }</div><style>
                  /* Injected AFTER email HTML so our rules win the source-order tiebreak
                     for same-specificity !important declarations inside the email's own
                     <style> blocks (which land in <body> after the email HTML). */
                  html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
                  body { margin: 0 !important; padding: 0 !important;
                         background-color: #ffffff !important; color-scheme: light;
                         font-family: -apple-system, Arial, sans-serif;
                         font-size: 14px; line-height: 1.6; color: #1a1a1a;
                         word-wrap: break-word; overflow-wrap: break-word; }
                  img { max-width: 100% !important; height: auto !important; }
                  /* Force top-level wrapper tables to fill the viewport. Selectors cover
                     both the legacy body > table pattern and the mf-scale-wrapper layer. */
                  body > table, body > center > table,
                  body > div > table, body > center > div > table,
                  #mf-scale-wrapper > table, #mf-scale-wrapper > center > table,
                  #mf-scale-wrapper > div > table, #mf-scale-wrapper > center > div > table {
                    width: 100% !important;
                  }
                  /* Reset min-width on cells only — not on table elements, because fluid
                     grid systems (e.g. Oracle Eloqua "tolkien") set min-width on inline-table
                     column elements as a layout fallback when their calc() width resolves to 0. */
                  td, th { min-width: 0 !important; }
                  td { word-break: break-word; }
                  th { overflow-wrap: normal; word-break: normal; }
                  a { color: #6366f1; }
                  pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
                  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
                </style></body></html>`}
                scrolling="no"
                style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px' }}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                title={t('message.emailFrameTitle')}
              />
            )}
          </div>
        </div>
      )}

      {/* Plain-text email — no internal scroll, outer container handles it */}
      {!loadingBody && !bodyError && body?.text && !body?.html && (
        <div style={{
          padding: isMobile ? '0 0px 16px' : '0 28px 24px',
        }}>
          {message.list_unsubscribe && unsubscribeStatus !== 'done' && (
            <div style={{
              marginBottom: 10, padding: '9px 14px',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderLeft: '3px solid var(--text-tertiary)', borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <span style={{ flex: 1 }}>{t('message.unsubscribe.info')}</span>
              <button onClick={handleUnsubscribe} disabled={unsubscribeStatus === 'loading'}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 5,
                  padding: '3px 9px', cursor: unsubscribeStatus === 'loading' ? 'default' : 'pointer',
                  color: unsubscribeStatus === 'error' ? 'var(--red, #e53e3e)' : 'var(--text-primary)',
                  fontSize: 11, fontWeight: 500, opacity: unsubscribeStatus === 'loading' ? 0.5 : 1,
                }}>
                {unsubscribeStatus === 'loading' ? t('common.loading') :
                 unsubscribeStatus === 'error' ? t('message.unsubscribe.error') :
                 t('message.unsubscribe.button')}
              </button>
            </div>
          )}
          {!message.category && (categorizationEnabled || accounts.find(a => a.id === message.account_id)?.categorization_enabled) && aiStatus?.enabled && (
            <div style={{
              marginBottom: 10, padding: '9px 14px',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderLeft: '3px solid var(--text-tertiary)', borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <span style={{ flex: 1 }}>{t('message.aiClassify.info')}</span>
              <button onClick={handleAiClassify} disabled={aiClassifying}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 5,
                  padding: '3px 9px', cursor: aiClassifying ? 'default' : 'pointer',
                  color: 'var(--text-primary)', fontSize: 11, fontWeight: 500,
                  opacity: aiClassifying ? 0.5 : 1,
                }}>
                {aiClassifying ? t('common.loading') : t('message.aiClassify.button')}
              </button>
            </div>
          )}
          <div style={{
            margin: 0, padding: '14px 16px 12px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontSize: 14, color: '#1a1a1a', lineHeight: 1.7,
            fontFamily: 'DM Sans, sans-serif', background: 'white',
            borderRadius: isMobile ? 0 : 10,
            border: isMobile ? 'none' : '1px solid var(--border-subtle)',
            overflow: 'hidden',
          }}
            dangerouslySetInnerHTML={{ __html: linkifyText(body.text) }}
          />
        </div>
      )}
      </div>{/* end single scroll container */}

      {/* Mobile move-to-folder bottom sheet */}
      {showMovePicker && isMobile && (
        <>
          <div
            onClick={() => setShowMovePicker(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 3000,
              background: 'var(--overlay-scrim)',
              backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            }}
          />
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0,
            zIndex: 3001,
            background: 'var(--bg-secondary)',
            borderRadius: '16px 16px 0 0',
            boxShadow: '0 -4px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
            animation: 'sheet-enter 0.2s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
            </div>
            <div style={{ padding: '4px 20px 12px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contextMenu.moveToFolder')}
            </div>
            <div style={{ borderTop: '1px solid var(--border-subtle)', overflowY: 'auto', maxHeight: '60vh' }}>
              {movePickerLoading ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : movePickerFolders.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('contextMenu.folders.empty')}
                </div>
              ) : (
                <>
                  {recentForMove.length > 0 && (
                    <>
                      <div style={{ padding: '8px 20px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {t('contextMenu.folders.recent')}
                      </div>
                      {recentForMove.map(f => (
                        <button
                          key={`recent-${f.path}`}
                          onClick={() => handleMoveToFolder(f.path)}
                          style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 20px', background: 'none', border: 'none', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 15, cursor: 'pointer', textAlign: 'left' }}
                        >
                          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} size={18} /></span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        </button>
                      ))}
                      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                    </>
                  )}
                  {favoritesForMove.length > 0 && (
                    <>
                      <div style={{ padding: '8px 20px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {t('contextMenu.folders.favorites')}
                      </div>
                      {favoritesForMove.map(f => (
                        <button
                          key={`fav-${f.path}`}
                          onClick={() => handleMoveToFolder(f.path)}
                          style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 20px', background: 'none', border: 'none', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 15, cursor: 'pointer', textAlign: 'left' }}
                        >
                          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} size={18} /></span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        </button>
                      ))}
                      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                    </>
                  )}
                  {movePickerFolders
                    .filter(f => f.path !== message.folder)
                    .map(f => (
                      <button
                        key={f.path}
                        onClick={() => handleMoveToFolder(f.path)}
                        style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 20px', background: 'none', border: 'none', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 15, cursor: 'pointer', textAlign: 'left' }}
                      >
                        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}><FolderIcon specialUse={f.special_use} size={18} /></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      </button>
                    ))
                  }
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showHeaderModal && (
        <MessageHeaderModal
          messageId={message.id}
          subject={message.subject}
          onClose={() => setShowHeaderModal(false)}
        />
      )}

      {showTodoistModal && (
        <TodoistTaskModal
          message={message}
          onClose={() => setShowTodoistModal(false)}
        />
      )}
    </div>
  );
}

function PaneBtn({ children, onClick, title, danger, style: extraStyle }) {
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
        borderRadius: 6, padding: '6px 8px',
        color: danger ? (hov ? 'var(--red)' : 'var(--text-tertiary)') : 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 13,
        display: 'flex', alignItems: 'center', gap: 5,
        transition: 'all 0.1s',
        ...extraStyle,
      }}
    >
      {children}
    </button>
  );
}
