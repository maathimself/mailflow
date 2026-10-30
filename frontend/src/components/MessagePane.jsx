import { Fragment, useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import AccountMark from './AccountMark.jsx';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatMessageDateTime } from '../utils/formatDate.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import { canHandlePaneShortcut } from '../utils/shortcutApplicability.js';
import { useMobile } from '../hooks/useMobile.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import SwipePager from './SwipePager.jsx';
import { clearDeleteGuard, clearPendingDelete, setCompletedDelete, setPendingDelete } from '../utils/pendingDeletes.js';
import { clearReadGuard } from '../utils/pendingReads.js';
import { applyMarkRead, scheduleMarkRead, cancelScheduledMarkRead, cancelScheduledMarkReadFor } from '../utils/markRead.js';
import { advanceSelectionAfterRemoval, adjacentRow, openAdjacentRow } from '../utils/listSelection.js';
import { selectListedMessage } from '../utils/conversation.js';
import { bodyCache, prefetchBody as prefetchCachedBody } from '../utils/bodyCache.js';
import { unsnooze, changeSnooze, refreshCounts } from '../utils/snoozeActions.js';
import { isDarkTheme, canShowDark, showDark } from '../utils/darkScheme.js';
import { markMessageUnread } from '../utils/messageHotkeys.js';
import { BUILTIN_SUMMARIZE } from '../aiActions.js';
import { openReplyFromMessage, openForwardFromMessage, openForwardAsAttachmentFromMessage } from '../utils/composeFromMessage.js';
import { aiReplyAvailable } from '../utils/aiReply.js';
import MessageBodyView from './MessageBodyView.jsx';
import { copyToClipboard } from '../utils/clipboard.js';
import { saveSenderCategory } from '../utils/senderCategory.js';
import { buildMovePickerSections, movePickerSectionHeading, movePickerFoldersEmpty, runMovePickerAction } from '../utils/folderDisplay.js';
import { usePluginCollected } from '../plugins/PluginSlot.jsx';
import FolderPathLabel from './FolderPathLabel.jsx';
import SpamBadge from './SpamBadge.jsx';
import SpamExplainModal from './SpamExplainModal.jsx';
import { downloadEml } from '../utils/downloadEml.js';
import { buildPrintDocument, openPrintWindow, printInWindow } from '../utils/printMessage.js';
import AiResultBox from './AiResultBox.jsx';
import { useAiActions } from '../hooks/useAiActions.js';
import AttachmentStrip from './AttachmentStrip.jsx';
import {
  ActionBtn, MessageTools, ReplySplitButton, RemoteImagesNotice, UnsubscribeNotice, TOUCH_MIN,
  AiReplyIcon, ForwardIcon, ArchiveIcon, MoveIcon, SpamIcon, HamIcon, TodoistIcon, ReadStateIcon, HeadersIcon,
  DownloadIcon, PrintIcon, DarkToggleIcon, StarIcon, TrashIcon, useShortcutTitle,
} from './MessageActions.jsx';
const USE_DIV_RENDER = import.meta.env.VITE_EMAIL_DIV_RENDER === 'true';
const MESSAGE_OPENING_EVENT = 'mailflow:message-opening';

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
import SenderAvatarImage from './SenderAvatarImage.jsx';
import ContextMenu from './ContextMenu.jsx';

function linkifyText(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit">${url}</a>`
  );
}

export default function MessagePane({ windowMessageId = null, onWindowClose = null } = {}) {
  const { t } = useTranslation();
  const {
    messages, searchResults, searchQuery, selectedMessageId: globalSelectedId, setSelectedMessage,
    updateMessage, removeMessage, decrementUnread, incrementUnread, openCompose, accounts, addNotification,
    imageWhitelist, addToImageWhitelist, blockRemoteImages, threadMessages,
    replyDefault, recentFolders, favoriteFolders, todoistConnected,
    categorizationEnabled, setCategoryCounts, adjustCategoryCount,
    aiActions, setShowAdmin, setAdminTab, plaintextEmail,
  } = useStore();

  // Detached-window mode (#219): when a message id is passed in, this pane renders that
  // specific message independently of the global list selection. Shadowing selectedMessageId
  // lets the entire component below run unchanged — for the main reading pane windowMode is
  // false and selectedMessageId === the global selection, so behavior is byte-identical.
  const windowMode = windowMessageId != null;
  const selectedMessageId = windowMode ? windowMessageId : globalSelectedId;
  // Closing actions (archive/trash/move/spam/snooze) should dismiss the window they run in;
  // in the main pane this is a no-op and the store's own selection handling applies.
  const closeWindowIfWindowed = useCallback(() => {
    if (windowMode) onWindowClose?.();
  }, [windowMode, onWindowClose]);

  const isMobile = useMobile();
  // A tooltip with the action's keyboard shortcut, on a desktop.
  const withShortcut = useShortcutTitle();
  const defaultReplyAll = replyDefault === 'replyAll';

  // Navigate to a message and mark it as read in one shot.
  // The arrow buttons bypass handleSelect in MessageList, so they must pick the row as it
  // does and duplicate the mark-as-read logic here to keep state consistent.
  const selectAndMarkRead = useCallback((msg) => {
    window.dispatchEvent(new CustomEvent(MESSAGE_OPENING_EVENT));
    api.getMessageBody(msg.id).catch(() => {});
    selectListedMessage(useStore, msg.id);
    cancelScheduledMarkRead(autoMarkReadTimerRef.current);
    autoMarkReadTimerRef.current = scheduleMarkRead(msg);
  }, []);

  const paneRef = useRef(null);
  const autoMarkReadTimerRef = useRef(null);
  useEffect(() => () => {
    cancelScheduledMarkRead(autoMarkReadTimerRef.current);
  }, []);

  // Reset scroll position and iframe height synchronously before the browser
  // paints the new message, so the user never sees stale blank space from the
  // previous (possibly taller) email.
  useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    if (iframeRef.current) iframeRef.current.style.height = '300px';
  }, [selectedMessageId]);

  const allMessages = searchQuery.trim() ? searchResults : messages;
  const message = allMessages.find(m => m.id === selectedMessageId)
    ?? Object.values(threadMessages).flat().find(m => m.id === selectedMessageId);

  useEffect(() => {
    setResolvedSubject(null);
  }, [message?.id]);

  // In window mode, if the message leaves the store (archived/moved from another view,
  // a background sync, or an action taken here), close the window rather than showing an
  // empty pane. The ref guards the initial mount, where the store copy can momentarily be
  // absent, from self-closing before the message has ever resolved.
  const sawMessageRef = useRef(false);
  useEffect(() => {
    if (!windowMode) return;
    if (message) { sawMessageRef.current = true; return; }
    if (sawMessageRef.current) onWindowClose?.();
  }, [windowMode, message, onWindowClose]);

  // Antispam (v0.1) — toolbar visibility for the spam / ham buttons.
  // Mirrors the heuristic in ContextMenu.jsx so the toolbar matches the menu.
  const account = accounts.find(a => a.id === message?.account_id);
  const accountFolders = useStore(s => s.folders[message?.account_id] || []);
  // Dark email bodies (#228): the setting, and each message's own choice made with the toggle.
  const theme = useStore(s => s.theme);
  const darkEmailBodies = useStore(s => s.darkEmailBodies);
  const [darkChoice, setDarkChoice] = useState({});
  // What the frame last showed, for which message (see MessageBodyView onDarkResult).
  const [darkResult, setDarkResult] = useState(null);
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
    advanceSelectionAfterRemoval(message.id);
    removeMessage(message.id);
    closeWindowIfWindowed();
    if (wasUnread) decrementUnread(message.account_id, 1, { undoable: true });
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
  }, [message, removeMessage, decrementUnread, incrementUnread, addNotification, t, closeWindowIfWindowed]);

  const currentIdx = allMessages.findIndex(m => m.id === selectedMessageId);
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < allMessages.length - 1;

  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingBody, setLoadingBody] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);
  const [paneScrolled, setPaneScrolled] = useState(false);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [resolvedSubject, setResolvedSubject] = useState(null);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [movePickerFolders, setMovePickerFolders] = useState([]);
  const [movePickerLoading, setMovePickerLoading] = useState(false);
  const [moveSearch, setMoveSearch] = useState('');
  // Bumped to close the toolbar's menus, which are remounted under a new key.
  const [menuEpoch, setMenuEpoch] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  const [spamExplainMessageId, setSpamExplainMessageId] = useState(null);
  const [findDialogOpen, setFindDialogOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchCase, setFindMatchCase] = useState(false);
  const [findMatchIndex, setFindMatchIndex] = useState(-1);
  const findInputRef = useRef(null);
  const [showTodoistModal, setShowTodoistModal] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);
  // Per-action results for the current message: { [actionKey]: { status, text, label } }.
  // status: 'loading' | 'done' | 'error'. Restored from localStorage on message change.
  const ai = useAiActions(selectedMessageId, body, message?.subject);
  const aiResults = ai.results;
  const [aiClassifying, setAiClassifying] = useState(false);
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null); // null | 'loading' | 'done' | 'error'
  const moveBtnRef = useRef(null);
  // In-flight AI actions live in a module-level registry, keyed by message AND action, so they
  // outlive this component. Navigating, closing a pop-out and changing layout all deliberately
  // leave them running: the result is saved against the message it was started from, so letting
  // the request finish is what puts it there when you return (#428). utils/aiRunRegistry.js.
  // The message currently on screen, read inside async callbacks that outlive a navigation.
  const scrollContainerRef = useRef(null);
  const iframeRef = useRef(null);
  // useMemo so prepared is available in the same render as body.html — no extra frame,
  // no flash of empty content between skeleton-gone and email-shown.
  const prepared = useMemo(() => {
    if (!USE_DIV_RENDER || !body?.html) return null;
    return prepareEmailHtml(body.html, windowMode ? `w${message?.id ?? 'preview'}` : String(message?.id ?? 'preview'));
  }, [body?.html, message?.id, windowMode]);
  const outerRef = useRef(null);
  const scaleRef = useRef(null);
  const innerRef = useRef(null);
  // Session-scoped set of message IDs where the user has clicked "Load images once"
  const imagesRequestedRef = useRef(new Set());
  // Ref holding the latest pane action handlers so shortcut subscriptions ([] deps) never go stale
  const paneActionsRef = useRef({});
  const emailScaleRef = useRef(1); // scale applied to wide emails that resist CSS reflow

  const getPaneSelectionText = useCallback(() => {
    const iframeDoc = iframeRef.current?.contentDocument;
    const iframeSelection = iframeDoc?.getSelection?.().toString() || '';
    if (iframeSelection.trim()) return iframeSelection;
    return window.getSelection?.().toString() || '';
  }, []);

  const isSelectionContextTarget = useCallback((event, doc = document) => {
    const selection = doc.getSelection?.();
    if (!selection?.toString().trim() || selection.rangeCount === 0) return false;
    const target = event.target;
    if (!target || target === doc.body || target === doc.documentElement) return false;
    try {
      return selection.containsNode(target, true) || selection.getRangeAt(0).intersectsNode(target);
    } catch {
      return false;
    }
  }, []);

  const hasNativeContextTarget = useCallback((event, doc = document) => {
    if (isSelectionContextTarget(event, doc)) return true;
    return Boolean(event.target?.closest?.(
      'a[href], img, input, textarea, select, button, [role="button"], [contenteditable="true"], [contenteditable=""]'
    ));
  }, [isSelectionContextTarget]);

  const openPaneContextMenu = useCallback((x, y, options = {}) => {
    if (!message) return;
    setShowMovePicker(false);
    setMenuEpoch(e => e + 1);
    setContextMenu({
      x,
      y,
      message,
      source: options.source || 'pane',
      selectedText: options.selectedText ?? getPaneSelectionText(),
    });
  }, [getPaneSelectionText, message]);

  const handlePaneContextMenu = useCallback((event) => {
    if (hasNativeContextTarget(event, event.currentTarget?.ownerDocument || document)) return;
    event.preventDefault();
    event.stopPropagation();
    openPaneContextMenu(event.clientX, event.clientY, {
      selectedText: getPaneSelectionText(),
      source: 'pane',
    });
  }, [getPaneSelectionText, hasNativeContextTarget, openPaneContextMenu]);

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
      evicted = bodyCache.evict((cached, id) => {
        if (cached.hasBlockedRemoteImages) return false;
        imagesRequestedRef.current.delete(id); // clear "load once" so policy is respected
        return true;
      }) || evicted;
    }
    if (loosenedGlobally || loosenedViaWhitelist) {
      evicted = bodyCache.evict(cached => cached.hasBlockedRemoteImages) || evicted;
    }
    if (evicted) setRetryKey(k => k + 1);
  }, [blockRemoteImages, imageWhitelist]);

  useLayoutEffect(() => {
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
    const cached = bodyCache.get(selectedMessageId);
    if (cached && (cached.html || cached.text)) {
      if (!wantsImages || !cached.hasBlockedRemoteImages) {
        setBody(cached);
        setBodyError(null);
        setLoadingBody(false);
        return;
      }
      // Cache has the blocked version but user wants images — evict and re-fetch
      bodyCache.delete(selectedMessageId);
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
        // Only real content is cached (bodyCache.set): empty results can be retried
        bodyCache.set(selectedMessageId, data);
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
  // The email body frame lives in MessageBodyView, which owns the effect that sizes it and
  // wires its document. The frame node is forwarded back here, so selection, find, the
  // context menu and the height reset above all still reach it directly.

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
    const expandedEls = new Set();

    // Neutralize nested sender-created scroll containers (overflow:auto/scroll +
    // fixed height) so iOS scrolls the message pane instead of an inner block —
    // the same fix the iframe renderer applies. Runs on the unscaled content and
    // re-grows previously-expanded elements as lazy images add height.
    const expandScrollContainers = (root) => {
      if (!root) return;
      Array.from(root.querySelectorAll('*')).reverse().forEach(el => {
        const oy = window.getComputedStyle(el).overflowY;
        const isScroll = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
        const grew = expandedEls.has(el) && el.scrollHeight > el.clientHeight + 2;
        if (isScroll || grew) {
          expandedEls.add(el);
          el.style.setProperty('overflow-y', 'hidden', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('height', el.scrollHeight + 'px', 'important');
        }
      });
    };

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
      scaler.style.width           = '';
      outer.style.height    = '';
      outer.style.overflowX = '';
      outer.style.overflowY = '';

      // Expand nested scroll containers before measuring so the outer height and
      // scale account for their full (un-scrolled) content.
      expandScrollContainers(inner);

      const containerW = outer.clientWidth;
      const contentW   = inner.scrollWidth; // unaffected by ancestor transforms

      if (containerW > 0 && contentW > containerW + 2) {
        const scale = containerW / contentW;
        // Lock scaler to the email's natural content width before applying the
        // transform so scale(containerW/contentW) maps contentW → containerW
        // exactly. Without this, scaler inherits innerRef's max-width:100% (=
        // containerW) and the transform scales the wrong box entirely.
        scaler.style.width           = `${contentW}px`;
        scaler.style.transform       = `scale(${scale})`;
        scaler.style.transformOrigin = 'top left';
        outer.style.height           = Math.round(inner.scrollHeight * scale) + 'px';
        // Transform does not change layout dimensions; hide both axes so the
        // scaled outer wrapper is never treated as a scroll container.  Setting
        // only overflowX would coerce overflowY from visible to auto (CSS
        // overflow invariant), creating an accidental vertical scroll container
        // that iOS scrolls before the outer pane's scrollContainerRef.
        outer.style.overflowX        = 'hidden';
        outer.style.overflowY        = 'hidden';
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

  // Fade in pane content when switching messages on desktop. Before the paint: started after it,
  // the new message showed at full opacity for a frame, then blinked out and faded back in.
  useLayoutEffect(() => {
    if (isMobile || !selectedMessageId || !paneRef.current) return;
    const el = paneRef.current;
    el.style.animation = 'none';
    el.offsetHeight; // force reflow to restart animation
    el.style.animation = 'pane-fade-in 0.15s ease';
  }, [selectedMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A neighbor's body, loaded ahead into the cache this pane reads first, so a swipe opens a
  // message that is ready to show (#229).
  const prefetchBody = useCallback((row) => {
    if (row) prefetchCachedBody(row.id, imagesRequestedRef.current.has(row.id));
  }, []);

  // On a desktop too, the next and previous messages are loaded once this one has shown, so j/k
  // and opening the next after a delete show a message at once instead of waiting on the server
  // (on a phone the swipe pager does this). Briefly deferred, so a run of j presses does not
  // fetch every message it passes.
  useEffect(() => {
    if (isMobile || !body || !selectedMessageId) return undefined;
    const timer = setTimeout(() => {
      prefetchBody(adjacentRow('next'));
      prefetchBody(adjacentRow('prev'));
    }, 400);
    return () => clearTimeout(timer);
  }, [body, selectedMessageId, isMobile, prefetchBody]);

  // Swiping on a phone (#229): from the left edge back to the list (hooks/useSwipeBack.js); left and
  // right for the next and previous message is the SwipePager around the content below.
  useSwipeBack({
    enabled: isMobile && !windowMode,
    rootRef: paneRef,
    navKey: selectedMessageId,
    onBack: () => history.back(),
  });

  // Both drafts are built by the shared util, so replying from the list, from the
  // reading pane, from a conversation and from GTD triage all produce the same draft.
  // The body is already loaded here, so it is handed over rather than refetched.
  const loadedBody = async () => body;

  const handleReply = (replyAll = false, { aiReply = false } = {}) => {
    if (!message) return;
    openReplyFromMessage(message, { accounts, openCompose, getMessageBody: loadedBody, replyAll, aiReply });
  };

  const handleForward = () => {
    if (!message) return;
    openForwardFromMessage(message, { openCompose, getMessageBody: loadedBody });
  };

  // The star fills at once, as in the list: the server answers only once the mail server has
  // the flag, which takes seconds on Gmail. Put back, with a notice, if that fails.
  const handleStarToggle = async () => {
    if (!message) return;
    const { id } = message;
    const newVal = !message.is_starred;
    updateMessage(id, { is_starred: newVal });
    try {
      await api.markStarred(id, newVal);
    } catch (err) {
      updateMessage(id, { is_starred: !newVal });
      addNotification({ type: 'error', title: t('common.error', { message: err.message }) });
    }
  };

  const handlePrint = () => {
    if (!message) return;
    printInWindow(openPrintWindow(), buildPrintDocument([{ message, body }]));
  };

  // In-flight runs are deliberately not aborted when the reader moves on: they persist their own
  // result against the message they were started from (#428), restored per message by useAiActions
  // (#204). Only dismissal, re-running the same action, and an identity change cancel a run.
  const runAiAction = (action, opts) => ai.run(action, opts);
  const dismissAiResult = ai.dismiss;

  // Keep pane action refs current every render
  paneActionsRef.current = {
    reply:      () => handleReply(defaultReplyAll),
    replyAll:   () => handleReply(true),
    toggleStar: handleStarToggle,
    print:      handlePrint,
    unsubscribe: () => {
      if (!windowMode && message?.list_unsubscribe && !message.unsubscribed_at && unsubscribeStatus !== 'loading' && unsubscribeStatus !== 'done') handleUnsubscribe();
    },
    loadRemoteImages: async () => {
      if (windowMode || !message) return;
      const id = message.id;
      const currentBody = body ?? await api.getMessageBody(id).catch(() => null);
      if (useStore.getState().selectedMessageId === id && currentBody?.hasBlockedRemoteImages) handleLoadImages();
    },
  };

  // Subscribe to keyboard shortcut actions that belong to the message pane.
  // Registered once ([] deps); live state is accessed through paneActionsRef.
  useEffect(() => {
    const active = () => canHandlePaneShortcut(windowMessageId, useStore.getState());
    const onReply        = () => { if (active()) paneActionsRef.current.reply(); };
    const onReplyAll     = () => { if (active()) paneActionsRef.current.replyAll(); };
    const onToggleStar   = () => { if (active()) paneActionsRef.current.toggleStar(); };
    const onPrintMessage = () => { if (active()) paneActionsRef.current.print?.(); };
    const onUnsubscribe = () => { if (active()) paneActionsRef.current.unsubscribe?.(); };
    const onLoadRemoteImages = () => { if (active()) paneActionsRef.current.loadRemoteImages?.(); };
    const onExplicitUnread = () => {
      if (!active()) return;
      cancelScheduledMarkRead(autoMarkReadTimerRef.current);
      autoMarkReadTimerRef.current = null;
    };

    shortcutBus.on('reply',         onReply);
    shortcutBus.on('replyAll',      onReplyAll);
    shortcutBus.on('toggleStar',    onToggleStar);
    shortcutBus.on('printMessage',  onPrintMessage);
    shortcutBus.on('unsubscribe', onUnsubscribe);
    shortcutBus.on('loadRemoteImages', onLoadRemoteImages);
    shortcutBus.on('markUnread', onExplicitUnread);

    return () => {
      shortcutBus.off('reply',         onReply);
      shortcutBus.off('replyAll',      onReplyAll);
      shortcutBus.off('toggleStar',    onToggleStar);
      shortcutBus.off('printMessage',  onPrintMessage);
      shortcutBus.off('unsubscribe', onUnsubscribe);
      shortcutBus.off('loadRemoteImages', onLoadRemoteImages);
      shortcutBus.off('markUnread', onExplicitUnread);
    };
  }, [windowMessageId]);

  useEffect(() => {
    api.ai.status().then(setAiStatus).catch(() => {});
    // No abort on unmount: the pane also unmounts when a pop-out closes or the layout changes,
    // and a run the user is still waiting for must survive that. Identity changes cancel runs
    // instead, from the store, where logout and account switch are actually known about.
  }, []);

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
    if (markMessageUnread(message, {
      cancel: () => {
        cancelScheduledMarkRead(autoMarkReadTimerRef.current);
        autoMarkReadTimerRef.current = null;
        cancelScheduledMarkReadFor(message.id);
        clearReadGuard(message.id);
      },
      // The GTD rail shows its own copy of the thread, as the u hotkey keeps it in step.
      update: (id, fields) => {
        updateMessage(id, fields);
        useStore.getState().markGtdThreadRead(message.message_id || message.id, fields.is_read);
      },
      incrementUnread, decrementUnread, adjustCategoryCount,
      patch: api.bulkRead,
    }) && isMobile) setSelectedMessage(null);
  }, [message, updateMessage, incrementUnread, decrementUnread, adjustCategoryCount, isMobile, setSelectedMessage]);

  // The toolbar's read toggle. It used to render only for a read message, so it vanished the
  // moment "Mark as unread" worked and the message could not be marked read again from here
  // (#683). Explicit "mark read" ignores markReadBehavior, as the context menu's does.
  const handleMarkRead = useCallback(() => {
    if (!message || message.is_read) return;
    // A delayed auto-read still pending would mark it read a second time and count it twice.
    cancelScheduledMarkRead(autoMarkReadTimerRef.current);
    autoMarkReadTimerRef.current = null;
    cancelScheduledMarkReadFor(message.id);
    applyMarkRead(message);
    useStore.getState().markGtdThreadRead(message.message_id || message.id, true);
  }, [message]);

  const handleToggleRead = useCallback(() => {
    if (!message) return;
    if (message.is_read) handleMarkUnread();
    else handleMarkRead();
  }, [message, handleMarkUnread, handleMarkRead]);

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

  const getFindRoot = useCallback(() => {
    if (!USE_DIV_RENDER && body?.html && iframeRef.current?.contentDocument?.body) {
      return {
        doc: iframeRef.current.contentDocument,
        root: iframeRef.current.contentDocument.body,
        iframe: iframeRef.current,
      };
    }
    return {
      doc: document,
      root: innerRef.current || scrollContainerRef.current,
      iframe: null,
    };
  }, [body?.html]);

  const collectFindMatches = useCallback((query, matchCase) => {
    const { doc, root } = getFindRoot();
    if (!query || !root) return [];

    const needle = matchCase ? query : query.toLowerCase();
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const matches = [];
    let node = walker.nextNode();
    while (node) {
      const haystack = matchCase ? node.nodeValue : node.nodeValue.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        matches.push({ doc, node, start: index, end: index + query.length });
        index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
      }
      node = walker.nextNode();
    }
    return matches;
  }, [getFindRoot]);

  const selectFindMatch = useCallback((match) => {
    if (!match) return;
    const range = match.doc.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);
    const selection = match.doc.getSelection?.();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const rect = range.getBoundingClientRect();
    if (match.doc === document) {
      const container = scrollContainerRef.current;
      if (container && rect.height) {
        const containerRect = container.getBoundingClientRect();
        container.scrollTop += rect.top - containerRect.top - Math.max(32, container.clientHeight * 0.25);
      }
    } else if (iframeRef.current && rect.height) {
      const iframeRect = iframeRef.current.getBoundingClientRect();
      const container = scrollContainerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        container.scrollTop += iframeRect.top + rect.top - containerRect.top - Math.max(32, container.clientHeight * 0.25);
      }
    }
  }, []);

  const runMessageFind = useCallback((direction = 1) => {
    const matches = collectFindMatches(findQuery, findMatchCase);
    if (matches.length === 0) {
      setFindMatchIndex(-1);
      return;
    }
    const nextIndex = findMatchIndex < 0
      ? (direction < 0 ? matches.length - 1 : 0)
      : (findMatchIndex + direction + matches.length) % matches.length;
    setFindMatchIndex(nextIndex);
    selectFindMatch(matches[nextIndex]);
  }, [collectFindMatches, findMatchCase, findMatchIndex, findQuery, selectFindMatch]);

  useEffect(() => {
    if (!findDialogOpen) return;
    setTimeout(() => findInputRef.current?.focus(), 0);
  }, [findDialogOpen]);

  const handleMoveToFolder = useCallback((folder) => {
    if (!message) return;
    setShowMovePicker(false);
    const moved = message;
    advanceSelectionAfterRemoval(moved.id);
    removeMessage(moved.id);
    closeWindowIfWindowed();
    if (!moved.is_read) decrementUnread(moved.account_id, 1, { undoable: true });
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
  }, [message, removeMessage, decrementUnread, incrementUnread, addNotification, t, closeWindowIfWindowed]);

  // Close move picker when the selected message changes and handle click-outside
  useEffect(() => {
    setShowMovePicker(false);
    setShowHeaderModal(false);
    setContextMenu(null);
    setUnsubscribeStatus(null);
    setAiClassifying(false);
  }, [selectedMessageId]);

  // The reading-pane dropdown menus (move / more / AI) each dismiss via a transparent
  // full-screen scrim rendered behind the menu — see their JSX below. A document-level
  // pointerdown/click listener CANNOT catch taps inside the email <iframe> body (pointer
  // events never cross the frame boundary), so tapping the message left the menu stuck open.
  // The scrim sits above the iframe and closes the menu on any outside tap (mobile + desktop).
  // It also can't be defeated by an ancestor's stopPropagation the way a bubbling handler can.

  useEffect(() => {
    if (!showMovePicker) setMoveSearch('');
  }, [showMovePicker]);

  const movePluginSections = usePluginCollected('move-picker-sections', {
    account, messages: message ? [message] : [], currentFolder: message?.folder,
    onClose: () => setShowMovePicker(false), t,
  });
  const moveSections = message
    ? buildMovePickerSections({
        folders: movePickerFolders, recents: recentFolders, favorites: favoriteFolders,
        pluginSections: movePluginSections, accountId: message.account_id,
        currentFolder: message.folder, query: moveSearch,
      })
    : [];
  const moveFoldersEmpty = movePickerFoldersEmpty(moveSections, movePickerFolders);
  const closeMovePicker = () => setShowMovePicker(false);

  if (!message) {
    // A detached window with no message is mid-close (see auto-close effect above) —
    // render nothing rather than the list's "select a message" placeholder.
    if (windowMode) return null;
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
    advanceSelectionAfterRemoval(deleted.id);
    removeMessage(deleted.id);
    closeWindowIfWindowed();
    if (!deleted.is_read) decrementUnread(deleted.account_id, 1, { undoable: true });
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
    advanceSelectionAfterRemoval(archived.id);
    removeMessage(archived.id);
    closeWindowIfWindowed();
    if (!archived.is_read) decrementUnread(archived.account_id, 1, { undoable: true });
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

  const handlePaneContextAction = async (action, data) => {
    if (!message) return;

    switch (action) {
      case 'open':
      case 'bulkSelect':
        break;
      case 'copy':
      case 'copySelection': {
        const text = getPaneSelectionText();
        if (text) copyToClipboard(text);
        break;
      }
      case 'selectAllContent': {
        const selection = window.getSelection?.();
        selection?.removeAllRanges();
        if (contextMenu?.source === 'iframe' && iframeRef.current?.contentDocument?.body) {
          const doc = iframeRef.current.contentDocument;
          const range = doc.createRange();
          range.selectNodeContents(doc.body);
          doc.getSelection?.().removeAllRanges();
          doc.getSelection?.().addRange(range);
        } else if (scrollContainerRef.current) {
          const range = document.createRange();
          range.selectNodeContents(scrollContainerRef.current);
          selection?.addRange(range);
        }
        break;
      }
      case 'findInContent': {
        setFindDialogOpen(true);
        setFindMatchIndex(-1);
        break;
      }
      case 'print':
        handlePrint();
        break;
      case 'markRead':
        // Explicit "mark read" ignores markReadBehavior: the user just asked for it.
        handleMarkRead();
        break;
      case 'markUnread':
        handleMarkUnread();
        break;
      case 'toggleStar':
        await handleStarToggle();
        break;
      case 'reply':
        handleReply(false);
        break;
      case 'replyAll':
        handleReply(true);
        break;
      case 'forward':
        handleForward();
        break;
      case 'forwardAsAttachment':
        if (message) openForwardAsAttachmentFromMessage(message, { openCompose });
        break;
      case 'archive':
        handleArchive();
        break;
      case 'moveTo':
        if (data) handleMoveToFolder(data);
        break;
      case 'delete':
        handleDelete();
        break;
      case 'markSpam':
        performSingleSpamLabel('spam');
        break;
      case 'markHam':
        performSingleSpamLabel('ham');
        break;
      case 'snooze':
        if (data) {
          const snoozedMsg = message;
          advanceSelectionAfterRemoval(snoozedMsg.id);
          removeMessage(snoozedMsg.id);
          closeWindowIfWindowed();
          if (!snoozedMsg.is_read) decrementUnread(snoozedMsg.account_id);
          addNotification({ title: t('message.snoozed.title'), body: snoozedMsg.subject || t('common.noSubject') });
          api.snoozeMessage(snoozedMsg.id, data).then(refreshCounts).catch(err => {
            console.error('Snooze failed:', err.message);
            useStore.getState().restoreMessages([snoozedMsg]);
            if (!snoozedMsg.is_read) incrementUnread(snoozedMsg.account_id);
            addNotification({ title: t('message.snoozed.failTitle'), body: t('message.snoozed.failBody') });
          });
        }
        break;
      case 'unsnooze':
        // Gone from the Snoozed view, so the next one there opens, as after any removal.
        unsnooze(message, { t, before: (m) => { advanceSelectionAfterRemoval(m.id); closeWindowIfWindowed(); } });
        break;
      case 'changeSnooze':
        if (data) changeSnooze(message, data, { t });
        break;
      case 'createRuleFromMessage': {
        const store = useStore.getState();
        store.setRulesPreFill?.({ fromEmail: message.from_email, fromName: message.from_name });
        store.setAdminTab('rules');
        store.setShowAdmin(true);
        break;
      }
      case 'addToBlockList': {
        const email = message.from_email;
        if (!email) break;
        api.addToBlockList(email).then(() => {
          addNotification({ title: t('blockList.blocked'), body: email });
        }).catch(() => {
          addNotification({ title: t('blockList.errorAdd'), body: email });
        });
        break;
      }
      case 'setCategory': {
        // Stored as chosen, 'primary' included, as the server does (#489).
        const newCategory = data || 'primary';
        try {
          await api.setMessageCategory(message.id, newCategory);
          updateMessage(message.id, { category: newCategory });
          const params = message.account_id ? { accountId: message.account_id } : {};
          api.getCategoryCounts(params).then(d => setCategoryCounts(d.counts || {})).catch(() => {});
        } catch (err) {
          console.error('setCategory failed:', err?.message);
        }
        break;
      }
      case 'setCategoryAlways': {
        // "Always for this sender/domain" (#490).
        const category = data?.category;
        const saved = await saveSenderCategory(message, data?.scope, category, {
          t, api, getState: useStore.getState, onMatch: loaded => updateMessage(loaded.id, { category }),
        });
        if (saved) {
          updateMessage(message.id, { category });
          const params = message.account_id ? { accountId: message.account_id } : {};
          api.getCategoryCounts(params).then(d => setCategoryCounts(d.counts || {})).catch(() => {});
        }
        break;
      }
      default:
        break;
    }
  };

  const handleLoadImages = () => {
    imagesRequestedRef.current.add(selectedMessageId);
    bodyCache.delete(selectedMessageId);
    setRetryKey(k => k + 1);
  };

  const handleAllowSender = async () => {
    const senderEmail = message.from_email?.toLowerCase();
    if (!senderEmail) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type: 'address', value: senderEmail });
      // Evict all blocked cache entries so they re-fetch with images unblocked
      bodyCache.evict(cached => cached.hasBlockedRemoteImages);
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
    const msg = message;
    try {
      const result = await api.unsubscribeMessage(msg.id);
      const succeeded = result.type === 'one-click' || result.type === 'url' || result.type === 'mailto';
      if (!succeeded) { setUnsubscribeStatus('error'); return; }
      if (result.type === 'url' && result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
      else if (result.type === 'mailto' && result.mailto) window.open(result.mailto, '_blank', 'noopener,noreferrer');
      setUnsubscribeStatus('done');
      addNotification({
        title: t('message.unsubscribe.done'),
        actionLabel: t('message.unsubscribe.moveToTrash'),
        onAction: () => {
          const { removeMessage, decrementUnread, restoreMessages, incrementUnread } = useStore.getState();
          advanceSelectionAfterRemoval(msg.id);
          removeMessage(msg.id);
          if (!msg.is_read) decrementUnread(msg.account_id);
          api.deleteMessage(msg.id).catch(() => {
            restoreMessages([msg]);
            if (!msg.is_read) incrementUnread(msg.account_id);
          });
        },
      });
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
      bodyCache.evict(cached => cached.hasBlockedRemoteImages);
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

  // Shown dark, and whether this message offers the toggle: only in a dark theme, and only for a
  // body that can be shown dark (utils/darkScheme.js). The experimental div renderer does not
  // apply a sender's dark design, so with it HTML stays as sent.
  const darkCapable = Boolean(message) && !(USE_DIV_RENDER && body?.html);
  const bodyDark = darkCapable && showDark({ body, themeKey: theme, setting: darkEmailBodies, override: darkChoice[message.id] });
  const darkToggleShown = darkCapable && isDarkTheme(theme) && canShowDark(body);
  // What the frame actually shows: HTML asked for dark is left as sent when showing it dark would
  // make text unreadable (utils/darkBody.js). Until the frame says, it is taken as dark, so the
  // card does not flash white.
  const frameResult = darkResult?.id === selectedMessageId ? darkResult : null;
  const darkRefused = Boolean(body?.html) && bodyDark && frameResult?.requested === true && frameResult.outcome === 'light';
  const shownDark = bodyDark && !darkRefused;
  const toggleDark = () => {
    if (darkRefused) return;
    setDarkChoice(choice => ({ ...choice, [message.id]: bodyDark ? 'original' : 'dark' }));
  };
  const darkToggleLabel = darkRefused ? t('message.cannotShowDark') : shownDark ? t('message.showOriginal') : t('message.showDark');

  // The toolbar's tools, in order: buttons on a desktop, the More menu on a phone (MessageTools).
  // Reply with AI sits by Reply. A phone's toolbar only just fits its buttons at large font sizes,
  // so there it is in More.
  const aiReplyShown = aiReplyAvailable(aiStatus, plaintextEmail);
  const handleAiReply = () => handleReply(defaultReplyAll, { aiReply: true });
  const toolItems = message ? [
    aiReplyShown && isMobile && { key: 'aiReply', label: t('compose.toolbar.aiReply'), icon: <AiReplyIcon />, onClick: handleAiReply },
    hasSpamFolder && !inSpamFolder && { key: 'spam', label: t('contextMenu.markAsSpam'), icon: <SpamIcon />, onClick: () => performSingleSpamLabel('spam') },
    inSpamFolder && { key: 'ham', label: t('contextMenu.markAsHam'), icon: <HamIcon />, onClick: () => performSingleSpamLabel('ham') },
    todoistConnected && { key: 'todoist', label: t('todoist.title'), icon: <TodoistIcon />, onClick: () => setShowTodoistModal(true) },
    { key: 'read', label: message.is_read ? t('contextMenu.markUnread') : t('contextMenu.markRead'), icon: <ReadStateIcon isRead={message.is_read} />, onClick: handleToggleRead },
    { key: 'headers', label: t('contextMenu.viewHeaders'), icon: <HeadersIcon />, onClick: () => setShowHeaderModal(true) },
    // The raw RFC 822 source as an .eml file (#381).
    { key: 'eml', label: t('message.downloadEml'), icon: <DownloadIcon />, onClick: () => downloadEml(message.id) },
    { key: 'print', label: t('message.print'), title: withShortcut(t('message.print'), 'printMessage'), icon: <PrintIcon />, onClick: handlePrint },
    darkToggleShown && { key: 'dark', label: darkToggleLabel, icon: <DarkToggleIcon shownDark={shownDark} />, onClick: toggleDark, pressed: shownDark, disabled: darkRefused },
  ].filter(Boolean) : [];
  const aiTools = aiStatus?.enabled && aiStatus?.features?.summarize && body ? {
    items: [{ ...BUILTIN_SUMMARIZE, label: t('message.summarize') }, ...(aiActions || [])],
    results: aiResults,
    onRun: action => runAiAction(action),
    onManage: () => { setAdminTab('ai-actions'); setShowAdmin(true); },
  } : null;

  // Only messages you sent (or drafts you saved) have a Bcc on record (#585).
  const bccList = Array.isArray(body?.bccAddresses) ? body.bccAddresses : [];

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
          paddingBottom: 'calc(10px - var(--sat-trim))', paddingLeft: 14, paddingRight: 14,
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

      {/* Toolbar, always pinned at top, never scrolls. The buttons are MessageActions', which every
          message of a conversation shares (#650). On a phone each is a 44 px touch target, edge to edge,
          giving way down to TOUCH_MIN when a larger font size leaves the row too narrow.
          A labeled group of plain buttons, each its own Tab stop, rather than role="toolbar", which
          promises arrow-key movement between them that the pane has never had. */}
      <div role="group" aria-label={t('shortcuts.groups.messageActions')} style={{
        padding: isMobile ? '0 8px' : '8px 16px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: isMobile ? 0 : 6, flexShrink: 0,
        boxShadow: paneScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none',
        transition: 'box-shadow 0.2s ease',
      }}>
        <ReplySplitButton
          key={`reply-${message.id}-${menuEpoch}`}
          defaultReplyAll={defaultReplyAll}
          onReply={handleReply}
          title={withShortcut(defaultReplyAll ? t('message.replyAll') : t('message.reply'), defaultReplyAll ? 'replyAll' : 'reply')}
          touch={isMobile}
        />

        {aiReplyShown && !isMobile && (
          <ActionBtn onClick={handleAiReply} label={t('compose.toolbar.aiReply')}>
            <AiReplyIcon />
          </ActionBtn>
        )}

        <ActionBtn onClick={handleForward} label={t('message.forward')} title={withShortcut(t('message.forward'), 'forward')} touch={isMobile}>
          <ForwardIcon />
        </ActionBtn>

        <ActionBtn onClick={handleArchive} label={t('message.archive')} title={withShortcut(t('message.archive'), 'archive')} touch={isMobile}>
          <ArchiveIcon />
        </ActionBtn>

        {/* Move to folder */}
        <div style={{ position: 'relative', display: 'flex', ...(isMobile ? { minWidth: TOUCH_MIN } : {}) }} ref={moveBtnRef}>
          <ActionBtn onClick={handleOpenMovePicker} label={t('contextMenu.moveToFolder')} touch={isMobile} popup expanded={showMovePicker}>
            <MoveIcon />
          </ActionBtn>
          {/* Desktop dropdown */}
          {showMovePicker && !isMobile && (<>
            <div onClick={() => setShowMovePicker(false)} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 8, boxShadow: 'var(--shadow-popover)',
              minWidth: 200, maxWidth: 320,
              zIndex: 200,
            }}>
              {movePickerLoading ? (
                <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : movePickerFolders.length === 0 && moveSections.length === 0 ? (
                <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {t('contextMenu.folders.empty')}
                </div>
              ) : (
                <>
                  {movePickerFolders.length > 0 && <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <input
                      autoFocus
                      value={moveSearch}
                      onChange={e => setMoveSearch(e.target.value)}
                      placeholder={t('contextMenu.folders.search')}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '5px 8px', fontSize: 12,
                        background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                        borderRadius: 5, color: 'var(--text-primary)',
                        outline: 'none',
                      }}
                    />
                  </div>}
                  <div style={{ maxHeight: 285, overflowY: 'auto' }}>
                  {moveSections.map((section, i) => {
                    const heading = movePickerSectionHeading(section, t);
                    return (
                      <Fragment key={section.key}>
                        {heading && (
                          <div style={{ padding: '5px 12px 3px', fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            {heading}
                          </div>
                        )}
                        {section.rows.map(row => {
                          const isAction = row.kind === 'action';
                          const f = row.folder;
                          return (
                            <button
                              key={isAction ? `action-${row.item.key}` : f.path}
                              onClick={isAction ? () => runMovePickerAction(row.item, closeMovePicker) : () => handleMoveToFolder(f.path)}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'none'}
                            >
                              <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{isAction ? row.item.renderIcon(13) : <FolderIcon specialUse={f.special_use} />}</span>
                              {isAction ? <FolderPathLabel label={row.item.label} /> : <FolderPathLabel folder={f} label={f.favoriteLabel} />}
                            </button>
                          );
                        })}
                        {(i < moveSections.length - 1 || moveFoldersEmpty) && <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />}
                      </Fragment>
                    );
                  })}
                  {moveFoldersEmpty && (
                    <div style={{ padding: '12px 12px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
                      {t('contextMenu.folders.empty')}
                    </div>
                  )}
                  </div>
                </>
              )}
            </div>
          </>)}
        </div>

        <div style={{ flex: 1 }} />

        {/* Keyed by message, so a menu left open does not carry over to the next one. */}
        <MessageTools key={`tools-${message.id}-${menuEpoch}`} isMobile={isMobile} items={toolItems} ai={aiTools} />

        <ActionBtn onClick={handleStarToggle} label={t('message.star')} pressed={Boolean(message.is_starred)} touch={isMobile}>
          <StarIcon filled={message.is_starred} />
        </ActionBtn>

        <ActionBtn onClick={handleDelete} label={t('message.delete')} danger touch={isMobile}>
          <TrashIcon />
        </ActionBtn>
      </div>

      {/* Swiping between messages on a phone (#229): the next and previous rows of the list, opened
          as a click on them does (utils/listSelection.js openAdjacentRow). */}
      <SwipePager
        enabled={isMobile && !windowMode}
        prev={isMobile && !windowMode ? adjacentRow('prev') : null}
        next={isMobile && !windowMode ? adjacentRow('next') : null}
        navKey={selectedMessageId}
        onNavigate={(dir) => openAdjacentRow(dir)}
        onPrefetch={prefetchBody}
      >
      {/* Single scroll container — sender card + email body scroll together */}
      <div
        ref={scrollContainerRef}
        onScroll={e => setPaneScrolled(e.currentTarget.scrollTop > 4)}
        onContextMenu={handlePaneContextMenu}
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg-primary)' }}
      >
      <div style={{ padding: isMobile ? '12px 0 0' : '24px 28px 0' }}>

        {/* Sender card — subject lives here as the card header */}
        <div className="msg-card" style={{
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
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <span>
                {(() => {
                  const paneSubject = resolvedSubject || message.subject;
                  return (paneSubject && paneSubject !== '(no subject)')
                    ? paneSubject
                    : t('message.noSubject');
                })()}
              </span>
              <SpamBadge message={message} onClick={(m) => setSpamExplainMessageId(m.id)} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}>
            {/* Avatar */}
            <div style={{
              width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
              background: senderColor(message.from_email || message.from_name),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: 'white',
              position: 'relative', overflow: 'hidden',
            }}>
              {(message.from_name || message.from_email || '?')[0].toUpperCase()}
              <SenderAvatarImage
                email={message.from_email}
                hasContactPhoto={message.has_contact_photo}
              />
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
                  {body?.senderEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>{t('message.via')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.senderName ? `${body.senderName} <${body.senderEmail}>` : body.senderEmail}</span>
                    </div>
                  )}
                  {body?.forwardedFromEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>{t('message.forwardedFrom', { service: body.forwardedVia })} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.forwardedFromName ? `${body.forwardedFromName} <${body.forwardedFromEmail}>` : body.forwardedFromEmail}</span>
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
                  {bccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>Bcc </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {bccList.map((r, i) => (
                          <span key={i}>{r.name || r.email}{i < bccList.length - 1 ? ', ' : ''}</span>
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
                  {body?.senderEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                      <span>{t('message.via')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.senderName ? `${body.senderName} <${body.senderEmail}>` : body.senderEmail}</span>
                    </div>
                  )}
                  {body?.forwardedFromEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                      <span>{t('message.forwardedFrom', { service: body.forwardedVia })} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.forwardedFromName ? `${body.forwardedFromName} <${body.forwardedFromEmail}>` : body.forwardedFromEmail}</span>
                    </div>
                  )}
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
                  {bccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      <span>Bcc </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {bccList.map((r, i) => (
                          <span key={i}>
                            {r.name ? `${r.name} <${r.email}>` : r.email}
                            {i < bccList.length - 1 ? ', ' : ''}
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
                {formatMessageDateTime(message.date, { withYear: !isMobile })}
              </div>
              <div style={{
                fontSize: 11, marginTop: 4,
                display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
              }}>
                <AccountMark accountId={message.account_id} color={message.account_color || 'var(--accent)'} size={6} />
                <span style={{ color: 'var(--text-tertiary)' }}>{message.account_name}</span>
              </div>
              {/* With images allowed, open-tracking images are still never loaded (the backend's
                  image proxy): how many, with the email's other facts. */}
              {!body?.hasBlockedRemoteImages && body?.trackersBlocked > 0 && (
                <div title={t('message.trackersBlockedHint')} style={{
                  fontSize: 11, marginTop: 4, marginLeft: 'auto', maxWidth: 170,
                  display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
                  color: 'var(--text-tertiary)',
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }} aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  <span>{t('message.trackersBlocked', { count: body.trackersBlocked })}</span>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <AttachmentStrip key={message.id} messageId={message.id} attachments={attachments} />
          </div>
        )}

        {/* AI action results — pinned boxes above the message (#204) */}
        {Object.keys(aiResults).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {Object.entries(aiResults).map(([key, result]) => {
              const action = key === BUILTIN_SUMMARIZE.id
                ? BUILTIN_SUMMARIZE
                : (aiActions || []).find(a => a.id === key);
              return (
                <AiResultBox
                  key={key}
                  result={result}
                  canRegen={!!action}
                  onRegen={() => action && runAiAction(action, { force: true })}
                  onDismiss={() => dismissAiResult(key)}
                />
              );
            })}
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
              onClick={() => { bodyCache.delete(selectedMessageId); setRetryKey(k => k + 1); }}
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
              onClick={() => { bodyCache.delete(selectedMessageId); setRetryKey(k => k + 1); }}
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
          {message.list_unsubscribe && !message.unsubscribed_at && unsubscribeStatus !== 'done' && (
            <UnsubscribeNotice status={unsubscribeStatus} onUnsubscribe={handleUnsubscribe} />
          )}

          {/* AI classify banner — shown for messages with no category signal when AI is available */}
          {!message.category && (categorizationEnabled || accounts.find(a => a.id === message.account_id)?.categorization_enabled) && aiStatus?.enabled && (
            <div className="msg-notice" style={{
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
            <RemoteImagesNotice
              fromEmail={message.from_email}
              onLoad={handleLoadImages}
              onAllowSender={handleAllowSender}
              onAllowDomain={handleAllowDomain}
              saving={savingAllow}
            />
          )}
          <div className="msg-card" style={{
            position: 'relative',
            padding: '14px 16px 12px',
            // The frame's own background, so the card and the body read as one surface: the
            // sender's dark background where their design sets one, otherwise the theme's.
            background: shownDark ? (frameResult?.surface || 'var(--bg-primary)') : 'white',
            borderRadius: isMobile ? 0 : 10,
            border: isMobile || shownDark ? 'none' : '1px solid var(--border-subtle)',
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
                onContextMenu={handlePaneContextMenu}
              >
                <div ref={scaleRef}>
                  <div
                    ref={innerRef}
                    data-mailflow-email={prepared?.prefix}
                    className={prepared?.prefix ?? ''}
                    translate="yes"
                    dangerouslySetInnerHTML={prepared ? { __html: prepared.html } : undefined}
                  />
                </div>
              </div>
            ) : (
              <MessageBodyView
                iframeRef={iframeRef}
                body={body}
                dark={bodyDark}
                onDarkResult={result => setDarkResult({ id: selectedMessageId, ...result })}
                messageId={selectedMessageId}
                emailScaleRef={emailScaleRef}
                hasNativeContextTarget={hasNativeContextTarget}
                onContextMenu={openPaneContextMenu}
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
          {message.list_unsubscribe && !message.unsubscribed_at && unsubscribeStatus !== 'done' && (
            <UnsubscribeNotice status={unsubscribeStatus} onUnsubscribe={handleUnsubscribe} />
          )}
          {!message.category && (categorizationEnabled || accounts.find(a => a.id === message.account_id)?.categorization_enabled) && aiStatus?.enabled && (
            <div className="msg-notice" style={{
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
          <div className="msg-card" style={{
            margin: 0, padding: '14px 16px 12px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontSize: 14, color: bodyDark ? 'var(--text-primary)' : '#1a1a1a', lineHeight: 1.7,
            fontFamily: 'DM Sans, sans-serif', background: bodyDark ? 'var(--bg-primary)' : 'white',
            borderRadius: isMobile ? 0 : 10,
            border: isMobile || bodyDark ? 'none' : '1px solid var(--border-subtle)',
            overflow: 'hidden',
          }}
            // <body> is translate="no" so a browser translator cannot break React's DOM (see
            // index.html). A message someone sent in another language should still translate,
            // and React writes this body in one piece, so the translator has nothing of React's
            // to break in here.
            translate="yes"
            dangerouslySetInnerHTML={{ __html: linkifyText(body.text) }}
          />
        </div>
      )}
      </div>{/* end single scroll container */}
      </SwipePager>

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
            <div style={{ padding: '0 20px 12px' }}>
              <input
                value={moveSearch}
                onChange={e => setMoveSearch(e.target.value)}
                placeholder={t('contextMenu.folders.search')}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '8px 12px', fontSize: 14,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--border-subtle)', overflowY: 'auto', maxHeight: '60vh' }}>
              {movePickerLoading ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('contextMenu.folders.loading')}
                </div>
              ) : (
                <>
                {moveSections.map((section, i) => {
                  const heading = movePickerSectionHeading(section, t);
                  return (
                    <Fragment key={section.key}>
                      {heading && (
                        <div style={{ padding: '8px 20px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          {heading}
                        </div>
                      )}
                      {section.rows.map(row => {
                        const isAction = row.kind === 'action';
                        const f = row.folder;
                        return (
                          <button
                            key={isAction ? `action-${row.item.key}` : f.path}
                            onClick={isAction ? () => runMovePickerAction(row.item, closeMovePicker) : () => handleMoveToFolder(f.path)}
                            style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', minHeight: 48, padding: '0 20px', background: 'none', border: 'none', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: 15, cursor: 'pointer', textAlign: 'left' }}
                          >
                            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{isAction ? row.item.renderIcon(18) : <FolderIcon specialUse={f.special_use} size={18} />}</span>
                            {isAction ? <FolderPathLabel label={row.item.label} /> : <FolderPathLabel folder={f} label={f.favoriteLabel} />}
                          </button>
                        );
                      })}
                      {i < moveSections.length - 1 && <div style={{ height: 6 }} />}
                    </Fragment>
                  );
                })}
                {moveFoldersEmpty && (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
                    {t('contextMenu.folders.empty')}
                  </div>
                )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          message={contextMenu.message}
          variant="messagePane"
          selectedText={getPaneSelectionText()}
          onClose={() => setContextMenu(null)}
          onAction={handlePaneContextAction}
        />
      )}

      {findDialogOpen && (
        <div
          style={{
            position: 'fixed',
            top: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 4100,
            width: 456,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: 'var(--shadow-modal)',
            color: 'var(--text-primary)',
            padding: '10px 16px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 500 }}>{t('message.find.title')}</div>
            <button
              onClick={() => setFindDialogOpen(false)}
              aria-label={t('message.find.close')}
              style={{
                background: 'none', border: 'none', color: 'var(--text-secondary)',
                cursor: 'pointer', padding: 2, fontSize: 28, lineHeight: 1,
              }}
            >
              &times;
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 14 }}>
            <span>{t('message.find.label')}</span>
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={e => { setFindQuery(e.target.value); setFindMatchIndex(-1); }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runMessageFind(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  setFindDialogOpen(false);
                }
              }}
              style={{
                flex: 1,
                height: 34,
                boxSizing: 'border-box',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '5px 8px',
                outline: 'none',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 22px 4px', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={findMatchCase}
              onChange={e => { setFindMatchCase(e.target.checked); setFindMatchIndex(-1); }}
              style={{ width: 17, height: 17 }}
            />
            {t('message.find.matchCase')}
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              onClick={() => runMessageFind(-1)}
              disabled={!findQuery}
              style={{
                minWidth: 88, height: 38, border: 'none', borderRadius: 4,
                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                cursor: findQuery ? 'pointer' : 'default', opacity: findQuery ? 1 : 0.55,
                fontSize: 14,
              }}
            >
              {t('message.find.previous')}
            </button>
            <button
              onClick={() => runMessageFind(1)}
              disabled={!findQuery}
              style={{
                minWidth: 88, height: 38, border: 'none', borderRadius: 4,
                background: 'var(--accent)', color: 'var(--accent-text)',
                cursor: findQuery ? 'pointer' : 'default', opacity: findQuery ? 1 : 0.55,
                fontSize: 14,
              }}
            >
              {t('message.find.next')}
            </button>
            <button
              onClick={() => setFindDialogOpen(false)}
              style={{
                minWidth: 88, height: 38, border: 'none', borderRadius: 4,
                background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                cursor: 'pointer', fontSize: 14,
              }}
            >
              {t('message.find.closeButton')}
            </button>
          </div>
        </div>
      )}

      {showHeaderModal && (
        <MessageHeaderModal
          messageId={message.id}
          subject={resolvedSubject || message.subject}
          onClose={() => setShowHeaderModal(false)}
          onSubjectResolved={(s) => {
            setResolvedSubject(s);
            updateMessage(message.id, { subject: s });
          }}
        />
      )}

      {spamExplainMessageId && (
        <SpamExplainModal
          messageId={spamExplainMessageId}
          onClose={() => setSpamExplainMessageId(null)}
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
