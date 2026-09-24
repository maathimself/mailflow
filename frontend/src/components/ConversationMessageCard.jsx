import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { fetchMessageBodyWithRetry } from '../utils/messageBody.js';
import { scheduleMarkRead, cancelScheduledMarkRead } from '../utils/markRead.js';
import { openReplyFromMessage, openForwardFromMessage } from '../utils/composeFromMessage.js';
import { shortcutBus } from '../utils/shortcutBus.js';
import MessageBodyView from './MessageBodyView.jsx';

// One message inside a conversation.
//
// Collapsed it is a header row and nothing else: no body request, no frame, no document.
// That is what makes a long thread affordable, since an expanded body is a whole rendered
// document and a thread can run to dozens of messages. Only what the reader has opened is
// ever rendered, which is how Gmail and Thunderbird handle the same problem.
//
function CardBtn({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', background: 'none', border: '1px solid var(--border)',
        borderRadius: 4, color: 'var(--text-primary)', font: 'inherit', fontSize: 13,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// Design from #317 by YunQue0912.
export default function ConversationMessageCard({ message, expanded, onToggle, selected = false }) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const openCompose = useStore(s => s.openCompose);
  const addNotification = useStore(s => s.addNotification);
  const [body, setBody] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const iframeRef = useRef(null);
  const emailScaleRef = useRef(1);
  const remoteRequestedRef = useRef(null);
  const unsubscribingRef = useRef(false);

  // Latest message, so the mark-read effect does not have to depend on an object
  // identity that changes on every list poll.
  const messageRef = useRef(message);
  messageRef.current = message;

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
    const timer = scheduleMarkRead(messageRef.current);
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
    setLoading(true);
    setError(null);
    fetchMessageBodyWithRetry(message.id, {
      load: (id, remoteImages) => api.getMessageBody(id, remoteImages),
      isCancelled: () => !mountedRef.current,
    })
      .then(data => { if (mountedRef.current) setBody(data); })
      .catch(err => {
        if (!mountedRef.current) return;
        setError(err.message);
        // Let reopening try again rather than leaving the card permanently broken.
        fetchedRef.current = null;
      })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [expanded, message.id]);

  const loadedBody = async () => body;
  useEffect(() => {
    if (!selected) return;
    const onLoadImages = () => {
      if (!expanded || !body?.hasBlockedRemoteImages || remoteRequestedRef.current === message.id) return;
      remoteRequestedRef.current = message.id;
      api.getMessageBody(message.id, true)
        .then(data => { if (messageRef.current.id === message.id) setBody(data); })
        .catch(() => { remoteRequestedRef.current = null; });
    };
    const onUnsubscribe = async () => {
      if (!message.list_unsubscribe || message.unsubscribed_at || unsubscribingRef.current) return;
      unsubscribingRef.current = true;
      try {
        const result = await api.unsubscribeMessage(message.id);
        if (!['one-click', 'url', 'mailto'].includes(result.type)) return;
        const url = result.type === 'url' ? result.url : result.type === 'mailto' ? result.mailto : null;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
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
        addNotification({ type: 'error', title: t('message.unsubscribe.error') });
        unsubscribingRef.current = false;
      }
    };
    shortcutBus.on('loadRemoteImages', onLoadImages);
    shortcutBus.on('unsubscribe', onUnsubscribe);
    return () => {
      shortcutBus.off('loadRemoteImages', onLoadImages);
      shortcutBus.off('unsubscribe', onUnsubscribe);
    };
  }, [selected, expanded, body, message, addNotification, t]);
  const when = message.date ? new Date(message.date).toLocaleString() : '';
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
          {loading && (
            <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
              <div className="skeleton-line" style={{ height: 13, width: '74%', borderRadius: 4 }} />
            </div>
          )}
          {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13 }}>{error}</div>}
          {body?.html && (
            <MessageBodyView
              iframeRef={iframeRef}
              body={body}
              messageId={message.id}
              emailScaleRef={emailScaleRef}
              hasNativeContextTarget={false}
              onContextMenu={null}
            />
          )}
          {!body?.html && body?.text && (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body.text}</div>
          )}

          {/* Reply and forward are per message, not per thread: replying to a conversation
              means replying to one message in it, and which one decides the recipients and
              the References chain. Gmail puts these under the open message for the same
              reason. The body is already loaded here, so it is handed over, not refetched. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <CardBtn onClick={() => openReplyFromMessage(message, { accounts, openCompose, getMessageBody: loadedBody, replyAll: false })}>
              {t('message.reply')}
            </CardBtn>
            <CardBtn onClick={() => openReplyFromMessage(message, { accounts, openCompose, getMessageBody: loadedBody, replyAll: true })}>
              {t('message.replyAll')}
            </CardBtn>
            <CardBtn onClick={() => openForwardFromMessage(message, { openCompose, getMessageBody: loadedBody })}>
              {t('message.forward')}
            </CardBtn>
          </div>
        </div>
      )}
    </div>
  );
}
