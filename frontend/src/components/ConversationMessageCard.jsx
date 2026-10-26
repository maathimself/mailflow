import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { fetchMessageBodyWithRetry } from '../utils/messageBody.js';
import { applyMarkRead, scheduleMarkRead, cancelScheduledMarkRead, cancelScheduledMarkReadFor } from '../utils/markRead.js';
import { clearReadGuard } from '../utils/pendingReads.js';
import { markMessageUnread } from '../utils/messageHotkeys.js';
import { downloadEml } from '../utils/downloadEml.js';
import { buildPrintDocument, openPrintWindow, printInWindow } from '../utils/printMessage.js';
import { openReplyFromMessage, openForwardFromMessage } from '../utils/composeFromMessage.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import MessageBodyView from './MessageBodyView.jsx';
import AttachmentStrip from './AttachmentStrip.jsx';
import { isDarkTheme, canShowDark, showDark } from '../utils/darkScheme.js';
import AiResultBox from './AiResultBox.jsx';
import { useAiActions } from '../hooks/useAiActions.js';
import { BUILTIN_SUMMARIZE } from '../aiActions.js';
import { formatDateTime } from '../utils/formatDate.js';
import { bodyCache } from '../utils/bodyCache.js';
import { useMobile } from '../hooks/useMobile.js';
import MessageHeaderModal from './MessageHeaderModal.jsx';
import TodoistTaskModal from './TodoistTaskModal.jsx';
import {
  ActionBtn, MessageTools, ReplySplitButton, RemoteImagesNotice, UnsubscribeNotice,
  AiReplyIcon, ForwardIcon, TodoistIcon, ReadStateIcon, HeadersIcon, DownloadIcon, PrintIcon, DarkToggleIcon, StarIcon,
} from './MessageActions.jsx';

// One message inside a conversation.
//
// Collapsed it is a header row and nothing else: no body request, no frame, no document.
// That is what makes a long thread affordable, since an expanded body is a whole rendered
// document and a thread can run to dozens of messages. Only what the reader has opened is
// ever rendered, which is how Gmail and Thunderbird handle the same problem.
//

// Design from #317 by YunQue0912.
// `onUpdate(id, patch)` applies a flag change to the conversation's own copy of the message and to
// the list's, since the pane holds the thread apart from the list.
export default function ConversationMessageCard({ message, expanded, onToggle, onUpdate, aiEnabled = false, aiReplyEnabled = false, selected = false }) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const openCompose = useStore(s => s.openCompose);
  const addNotification = useStore(s => s.addNotification);
  const incrementUnread = useStore(s => s.incrementUnread);
  const decrementUnread = useStore(s => s.decrementUnread);
  const adjustCategoryCount = useStore(s => s.adjustCategoryCount);
  const replyDefault = useStore(s => s.replyDefault);
  const todoistConnected = useStore(s => s.todoistConnected);
  const addToImageWhitelist = useStore(s => s.addToImageWhitelist);
  const isMobile = useMobile();
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [showTodoistModal, setShowTodoistModal] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);
  // null | 'loading' | 'done' | 'error', as the reading pane's unsubscribe notice.
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null);
  const [body, setBody] = useState(null);
  const [error, setError] = useState(null);
  // Dark email bodies (#228): the setting, and this card's own choice made with its toggle.
  const theme = useStore(s => s.theme);
  const darkEmailBodies = useStore(s => s.darkEmailBodies);
  const [darkChoice, setDarkChoice] = useState(undefined);
  // What the frame last showed (see MessageBodyView onDarkResult).
  const [darkResult, setDarkResult] = useState(null);
  const bodyDark = showDark({ body, themeKey: theme, setting: darkEmailBodies, override: darkChoice });
  const darkToggleShown = isDarkTheme(theme) && canShowDark(body);
  // HTML asked for dark is left as sent when showing it dark would make text unreadable
  // (utils/darkBody.js); until the frame says, it is taken as dark so the card does not flash.
  const darkRefused = Boolean(body?.html) && bodyDark && darkResult?.requested === true && darkResult.outcome === 'light';
  const shownDark = bodyDark && !darkRefused;
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef(null);
  const emailScaleRef = useRef(1);
  const remoteRequestedRef = useRef(null);
  const unsubscribingRef = useRef(false);

  // Latest message, so the mark-read effect does not have to depend on an object
  // identity that changes on every list poll.
  const messageRef = useRef(message);
  messageRef.current = message;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // Which message id this card has already scheduled a mark-read for, so a
  // re-render cannot decrement the unread badge twice for one open.
  const markScheduledRef = useRef(null);

  // Expanding a message marks it read, the same as opening one in the reading pane
  // and the same as Gmail. It goes through the shared protocol so the optimistic
  // flag, the unread badge and the category count stay in step, and it honors the
  // user's markReadBehavior/markReadDelay preferences.
  useEffect(() => {
    if (!expanded || markScheduledRef.current === message.id) return;
    markScheduledRef.current = message.id;
    // The card's copy of the message follows the read, so its read toggle offers the right thing.
    const id = message.id;
    const timer = scheduleMarkRead(messageRef.current, { onChange: read => onUpdateRef.current?.(id, { is_read: read }) });
    // A null timer means it was applied already, or there was nothing to do. Only a
    // deferred mark needs cancelling, and cancelling it un-books the card so that
    // reopening starts the delay again instead of never marking it at all.
    if (!timer) return;
    return () => {
      cancelScheduledMarkRead(timer);
      markScheduledRef.current = null;
    };
  }, [expanded, message.id]);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Which message id has already been fetched, or is being fetched right now. A ref, not
  // state: deriving this from the body/loading state and listing them as dependencies made
  // the effect re-run on its own setLoading, and the re-run's cleanup cancelled the request
  // it had just started, so the card sat on the loading skeleton forever.
  const fetchedRef = useRef(null);

  // The body is fetched the first time this card is opened and kept afterwards, so
  // collapsing and reopening does not cost another round trip. Collapsing mid-flight does
  // not abort it either: the reply is cheap to keep and makes reopening instant.
  useEffect(() => {
    if (!expanded || fetchedRef.current === message.id) return;
    fetchedRef.current = message.id;
    // Seen before, in this view or the reading pane, or loaded ahead: no round trip.
    const cached = bodyCache.get(message.id);
    if (cached) {
      setBody(cached);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchMessageBodyWithRetry(message.id, {
      load: (id, remoteImages) => api.getMessageBody(id, remoteImages),
      isCancelled: () => !mountedRef.current,
    })
      .then(data => {
        bodyCache.set(message.id, data);
        if (mountedRef.current) setBody(data);
      })
      .catch(err => {
        if (!mountedRef.current) return;
        setError(err.message);
        // Let reopening try again rather than leaving the card permanently broken.
        fetchedRef.current = null;
      })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [expanded, message.id]);

  const loadedBody = async () => body;
  const ai = useAiActions(message.id, body, message.subject);

  // Fills at once, as in the list and the reading pane; put back if the server refuses it.
  const handleStar = async () => {
    const starred = !message.is_starred;
    onUpdate?.(message.id, { is_starred: starred });
    try {
      await api.markStarred(message.id, starred);
    } catch (err) {
      onUpdate?.(message.id, { is_starred: !starred });
      addNotification({ type: 'error', title: t('common.error', { message: err.message }) });
    }
  };

  // Explicit unread wins over the automatic read this card scheduled when it opened. Clearing
  // markScheduledRef lets the next open mark it read again, as reopening a message does.
  const handleMarkUnread = () => {
    markMessageUnread(message, {
      cancel: () => {
        cancelScheduledMarkReadFor(message.id);
        clearReadGuard(message.id);
        markScheduledRef.current = null;
      },
      update: onUpdate, incrementUnread, decrementUnread, adjustCategoryCount,
      patch: api.bulkRead,
    });
  };

  // The read toggle's other half: a card marked unread could not be marked read again (#650).
  // Explicit, so it ignores markReadBehavior, as the reading pane's does, and a delayed auto-read
  // still pending is cancelled first so the message is not counted twice.
  const handleMarkRead = () => {
    if (message.is_read) return;
    cancelScheduledMarkReadFor(message.id);
    applyMarkRead(message, { onChange: read => onUpdate?.(message.id, { is_read: read }) });
  };
  const handleToggleRead = () => (message.is_read ? handleMarkUnread() : handleMarkRead());

  const handlePrint = () => {
    if (!body) return;
    printInWindow(openPrintWindow(), buildPrintDocument([{ message, body }]));
  };
  // Remote images for this message, as the reading pane's "Load images" and the shortcut do.
  const loadRemoteImages = () => {
    if (!body?.hasBlockedRemoteImages || remoteRequestedRef.current === message.id) return;
    remoteRequestedRef.current = message.id;
    const id = message.id;
    api.getMessageBody(id, true)
      .then(data => {
        bodyCache.set(id, data);
        if (mountedRef.current && messageRef.current.id === id) setBody(data);
      })
      .catch(() => { remoteRequestedRef.current = null; });
  };

  // Always load them from this sender, or its domain: the server lets them through from now on.
  const allowImagesFrom = async (entry) => {
    if (!entry.value) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist(entry);
      bodyCache.evict(cached => cached.hasBlockedRemoteImages);
      const id = message.id;
      const data = await api.getMessageBody(id);
      bodyCache.set(id, data);
      if (mountedRef.current && messageRef.current.id === id) setBody(data);
    } catch {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      if (mountedRef.current) setSavingAllow(false);
    }
  };
  const senderEmail = message.from_email?.toLowerCase() || '';
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';

  const handleUnsubscribe = async () => {
    if (!message.list_unsubscribe || message.unsubscribed_at || unsubscribingRef.current) return;
    unsubscribingRef.current = true;
    setUnsubscribeStatus('loading');
    try {
      const result = await api.unsubscribeMessage(message.id);
      if (!['one-click', 'url', 'mailto'].includes(result.type)) {
        if (mountedRef.current) setUnsubscribeStatus('error');
        unsubscribingRef.current = false;
        return;
      }
      const url = result.type === 'url' ? result.url : result.type === 'mailto' ? result.mailto : null;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      if (mountedRef.current) setUnsubscribeStatus('done');
      addNotification({
        title: t('message.unsubscribe.done'),
        actionLabel: t('message.unsubscribe.moveToTrash'),
        onAction: () => {
          const { removeMessage, decrementUnread, restoreMessages, incrementUnread } = useStore.getState();
          removeMessage(message.id);
          if (!message.is_read) decrementUnread(message.account_id);
          api.deleteMessage(message.id).catch(() => {
            restoreMessages([message]);
            if (!message.is_read) incrementUnread(message.account_id);
          });
        },
      });
    } catch {
      if (mountedRef.current) setUnsubscribeStatus('error');
      addNotification({ type: 'error', title: t('message.unsubscribe.error') });
      unsubscribingRef.current = false;
    }
  };

  const shortcutRef = useRef(null);
  shortcutRef.current = { loadRemoteImages, handleUnsubscribe, print: handlePrint };
  useEffect(() => {
    if (!selected) return;
    const onLoadImages = () => { if (expanded) shortcutRef.current.loadRemoteImages(); };
    const onUnsubscribe = () => shortcutRef.current.handleUnsubscribe();
    // Print the selected message, as the print shortcut does in the single-message pane.
    const onPrint = () => { if (expanded) shortcutRef.current.print(); };
    shortcutBus.on('loadRemoteImages', onLoadImages);
    shortcutBus.on('unsubscribe', onUnsubscribe);
    shortcutBus.on('printMessage', onPrint);
    return () => {
      shortcutBus.off('loadRemoteImages', onLoadImages);
      shortcutBus.off('unsubscribe', onUnsubscribe);
      shortcutBus.off('printMessage', onPrint);
    };
  }, [selected, expanded]);

  // The message's tools, the reading pane's minus what the conversation does for all of it
  // (spam, archive, move, delete: ConversationPane).
  const darkLabel = darkRefused ? t('message.cannotShowDark') : shownDark ? t('message.showOriginal') : t('message.showDark');
  // By Reply, or in More on a phone, as in the reading pane.
  const aiReply = () => openReplyFromMessage(message, { accounts, openCompose, getMessageBody: loadedBody, replyAll: replyDefault === 'replyAll', aiReply: true });
  const toolItems = [
    aiReplyEnabled && isMobile && { key: 'aiReply', label: t('compose.toolbar.aiReply'), icon: <AiReplyIcon />, onClick: aiReply },
    todoistConnected && { key: 'todoist', label: t('todoist.title'), icon: <TodoistIcon />, onClick: () => setShowTodoistModal(true) },
    { key: 'read', label: message.is_read ? t('contextMenu.markUnread') : t('contextMenu.markRead'), icon: <ReadStateIcon isRead={message.is_read} />, onClick: handleToggleRead },
    { key: 'headers', label: t('contextMenu.viewHeaders'), icon: <HeadersIcon />, onClick: () => setShowHeaderModal(true) },
    { key: 'eml', label: t('message.downloadEml'), icon: <DownloadIcon />, onClick: () => downloadEml(message.id) },
    { key: 'print', label: t('message.print'), icon: <PrintIcon />, onClick: handlePrint },
    darkToggleShown && { key: 'dark', label: darkLabel, icon: <DarkToggleIcon shownDark={shownDark} />, onClick: () => setDarkChoice(bodyDark ? 'original' : 'dark'), pressed: shownDark, disabled: darkRefused },
  ].filter(Boolean);
  const aiTools = aiEnabled && body ? {
    items: [{ ...BUILTIN_SUMMARIZE, label: t('message.summarize') }, ...(ai.aiActions || [])],
    results: ai.results,
    onRun: action => ai.run(action),
    onManage: () => { const st = useStore.getState(); st.setAdminTab('ai-actions'); st.setShowAdmin(true); },
  } : null;

  const when = formatDateTime(message.date);
  const who = message.from_name || message.from_email || '';

  return (
    <div
      // The pane scrolls to this when the reader picks this message in the list.
      data-message-id={message.id}
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6, marginBottom: 8, background: 'var(--bg-primary)',
      }}
    >
      <button
        onClick={() => onToggle(message.id)}
        aria-expanded={expanded}
        style={{
          width: '100%', display: 'flex', alignItems: 'baseline', gap: 8, textAlign: 'left',
          background: 'none', border: 'none', padding: '10px 12px', cursor: 'pointer',
          color: 'var(--text-primary)', font: 'inherit',
        }}
      >
        <span style={{ fontWeight: message.is_read ? 400 : 600, flex: '0 1 auto' }}>{who}</span>
        {!expanded && (
          <span style={{ color: 'var(--text-secondary)', fontSize: 13, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {message.snippet || ''}
          </span>
        )}
        <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 'auto', flex: '0 0 auto' }}>{when}</span>
      </button>

      {expanded && (
        <div style={{ padding: '0 12px 12px' }}>
          {/* The reading pane's toolbar, from the same buttons in the same order (#650), less what the
              conversation's own bar does for all of it. Reply and forward are per message, not per
              thread: replying to a conversation means replying to one message in it, and which one
              decides the recipients and the References chain. The body is already loaded here, so
              it is handed over, not refetched. Keyed by message, as the reading pane's. */}
          <div role="group" aria-label={t('shortcuts.groups.messageActions')} style={{
            display: 'flex', alignItems: 'center', gap: isMobile ? 0 : 6, margin: '0 -4px 8px',
          }}>
            <ReplySplitButton
              key={`reply-${message.id}`}
              defaultReplyAll={replyDefault === 'replyAll'}
              onReply={replyAll => openReplyFromMessage(message, { accounts, openCompose, getMessageBody: loadedBody, replyAll })}
              touch={isMobile}
            />
            {aiReplyEnabled && !isMobile && (
              <ActionBtn onClick={aiReply} label={t('compose.toolbar.aiReply')}>
                <AiReplyIcon />
              </ActionBtn>
            )}
            <ActionBtn onClick={() => openForwardFromMessage(message, { openCompose, getMessageBody: loadedBody })} label={t('message.forward')} touch={isMobile}>
              <ForwardIcon />
            </ActionBtn>
            <div style={{ flex: 1 }} />
            <MessageTools key={`tools-${message.id}`} isMobile={isMobile} items={toolItems} ai={aiTools} />
            <ActionBtn onClick={handleStar} label={t('message.star')} pressed={Boolean(message.is_starred)} touch={isMobile}>
              <StarIcon filled={message.is_starred} />
            </ActionBtn>
          </div>
          {loading && (
            <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '74%', borderRadius: 4 }} />
            </div>
          )}
          {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13 }}>{error}</div>}
          {/* Attachments, the reading pane's strip (#634), where the reading pane has it: above the
              message. The body response already carries them. */}
          <AttachmentStrip messageId={message.id} attachments={body?.attachments} style={{ marginBottom: 12 }} />
          {/* AI results pinned above the message, as in the reading pane (#204). */}
          {Object.keys(ai.results).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '4px 0 12px' }}>
              {Object.entries(ai.results).map(([key, result]) => {
                const action = ai.actionFor(key);
                return (
                  <AiResultBox
                    key={key}
                    result={result}
                    canRegen={!!action}
                    onRegen={() => action && ai.run(action, { force: true })}
                    onDismiss={() => ai.dismiss(key)}
                  />
                );
              })}
            </div>
          )}
          {/* The reading pane's notices, above the message as there: unsubscribe for any body,
              remote images only for HTML, which is all that has any. */}
          {body && (body.html || body.text) && message.list_unsubscribe && !message.unsubscribed_at && unsubscribeStatus !== 'done' && (
            <UnsubscribeNotice status={unsubscribeStatus} onUnsubscribe={handleUnsubscribe} />
          )}
          {body?.html && body.hasBlockedRemoteImages && (
            <RemoteImagesNotice
              fromEmail={message.from_email}
              onLoad={loadRemoteImages}
              onAllowSender={() => allowImagesFrom({ type: 'address', value: senderEmail })}
              onAllowDomain={() => allowImagesFrom({ type: 'domain', value: senderDomain })}
              saving={savingAllow}
            />
          )}
          {body?.html && (
            // The same white padded card the reading pane wraps its body in. The frame's
            // stylesheet zeroes body margin and padding, so the only gutter an email has
            // is what the surrounding card provides: the reading pane gives every body
            // 16px, while this card put the frame straight on the dark background and
            // hand-typed mail (which brings no margins of its own) rendered flush against
            // the frame edge. Now both views agree, and newsletters and fixed layouts are
            // untouched — they keep whatever padding their own HTML carries, inside the
            // same card the reading pane already gives them.
            <div className="msg-card" style={{
              padding: '14px 16px 12px',
              // The frame's own background, so the card and the body read as one surface: the
              // sender's dark background where their design sets one, otherwise the theme's.
              background: shownDark ? (darkResult?.surface || 'var(--bg-primary)') : 'white',
              borderRadius: 4,
              border: shownDark ? 'none' : '1px solid var(--border-subtle)',
              overflow: 'hidden',
            }}>
              <MessageBodyView
                iframeRef={iframeRef}
                body={body}
                dark={bodyDark}
                onDarkResult={setDarkResult}
                messageId={message.id}
                emailScaleRef={emailScaleRef}
              />
            </div>
          )}
          {!body?.html && body?.text && (
            // translate="yes" undoes <body>'s translate="no" for the message itself; React writes
            // it as the element's whole text, so a translator has no React text node to break.
            <div translate="yes" style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              // Plain text follows a dark theme; switched to its original colors it gets the
              // reading pane's white card (#228). A light theme leaves it as it always was.
              ...(darkToggleShown && !bodyDark ? {
                padding: '14px 16px 12px', background: 'white', color: '#1a1a1a',
                borderRadius: 4, border: '1px solid var(--border-subtle)',
              } : {}),
            }}>{body.text}</div>
          )}

        </div>
      )}

      {showHeaderModal && (
        <MessageHeaderModal
          messageId={message.id}
          subject={message.subject}
          onClose={() => setShowHeaderModal(false)}
          onSubjectResolved={subject => onUpdate?.(message.id, { subject })}
        />
      )}
      {showTodoistModal && (
        <TodoistTaskModal message={message} onClose={() => setShowTodoistModal(false)} />
      )}
    </div>
  );
}
