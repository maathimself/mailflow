import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { openForwardFromMessage, openReplyFromMessage } from '../utils/composeFromMessage.js';
import {
  conversationMembershipKey,
  conversationReadTargets,
  inboxConversationReadTargets,
  initialExpandedMessageIds,
  newestConversationMessage,
  unreadConversationIds,
  reconcileExpandedMessageIds,
} from '../utils/conversation.js';
import { useConversation } from '../hooks/useConversation.js';
import ConversationMessageCard from './ConversationMessageCard.jsx';

function ConversationIcon({ type }) {
  if (type === 'read') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12l5 5L20 6"/></svg>;
  if (type === 'unread') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v14H4z"/><path d="M4 7l8 6 8-6"/></svg>;
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 9l6 6 6-6"/></svg>;
}

export default function ConversationPane({ message, threadId }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const {
    accounts, openCompose, setSelectedMessage, updateMessage,
    decrementUnread, incrementUnread, adjustCategoryCount,
    markReadBehavior, markReadDelay, replyDefault, addNotification,
  } = useStore();
  const { messages, loading, error, retry } = useConversation(threadId);
  const [expandedIds, setExpandedIds] = useState(() => initialExpandedMessageIds([]));
  const previousMessagesRef = useRef([]);
  const automaticExpandedIdRef = useRef(null);
  const messagesRef = useRef(messages);
  const autoReadRunRef = useRef(null);
  const [paneScrolled, setPaneScrolled] = useState(false);
  messagesRef.current = messages;

  useEffect(() => {
    const previousMessages = previousMessagesRef.current;
    if (messages.length === 0) return;
    if (previousMessages.length === 0) {
      const initial = initialExpandedMessageIds(messages);
      setExpandedIds(initial);
      automaticExpandedIdRef.current = [...initial][0] || null;
    } else {
      setExpandedIds(current => {
        const result = reconcileExpandedMessageIds({
          previousMessages,
          nextMessages: messages,
          expandedIds: current,
          automaticExpandedId: automaticExpandedIdRef.current,
        });
        automaticExpandedIdRef.current = result.automaticExpandedId;
        return result.expandedIds;
      });
    }
    previousMessagesRef.current = messages;
  }, [messages]);

  const setConversationRead = useCallback(async read => {
    const currentMessages = messagesRef.current;
    const targets = conversationReadTargets(currentMessages, read);
    const ids = targets.map(item => item.id);
    if (ids.length === 0) return;
    const counterTargetIds = new Set(inboxConversationReadTargets(currentMessages, read).map(item => item.id));

    targets.forEach(item => {
      updateMessage(item.id, { is_read: read });
      if (!counterTargetIds.has(item.id)) return;
      if (read) {
        decrementUnread(item.account_id);
        adjustCategoryCount(item.category, -1);
      } else {
        incrementUnread(item.account_id);
        adjustCategoryCount(item.category, 1);
      }
    });

    try {
      await api.bulkRead(ids, read);
    } catch (requestError) {
      targets.forEach(item => {
        updateMessage(item.id, { is_read: !read });
        if (!counterTargetIds.has(item.id)) return;
        if (read) {
          incrementUnread(item.account_id);
          adjustCategoryCount(item.category, 1);
        } else {
          decrementUnread(item.account_id);
          adjustCategoryCount(item.category, -1);
        }
      });
      addNotification({ type: 'error', title: t('common.error', { message: requestError.message || t('message.loadingError') }) });
    }
  }, [addNotification, adjustCategoryCount, decrementUnread, incrementUnread, t, updateMessage]);

  const membershipKey = useMemo(() => conversationMembershipKey(messages), [messages]);

  useEffect(() => {
    const currentMessages = messagesRef.current;
    if (markReadBehavior === 'manual' || currentMessages.length === 0) return undefined;
    const unread = unreadConversationIds(currentMessages);
    if (unread.length === 0) return undefined;
    const runKey = `${threadId}:${membershipKey}:${markReadBehavior}`;
    if (markReadBehavior === 'immediate') {
      if (autoReadRunRef.current === runKey) return undefined;
      autoReadRunRef.current = runKey;
      setConversationRead(true);
      return undefined;
    }
    const timer = setTimeout(() => {
      if (autoReadRunRef.current === runKey) return;
      autoReadRunRef.current = runKey;
      setConversationRead(true);
    }, (markReadDelay || 1) * 1000);
    return () => clearTimeout(timer);
  }, [markReadBehavior, markReadDelay, membershipKey, setConversationRead, threadId]);

  const toggleExpanded = useCallback(id => {
    setExpandedIds(current => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        if (automaticExpandedIdRef.current === id) automaticExpandedIdRef.current = null;
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const replyTo = useCallback(async (target, replyAll = replyDefault === 'replyAll') => {
    try {
      await openReplyFromMessage(target, {
        accounts,
        openCompose,
        getMessageBody: api.getMessageBody,
        replyAll,
      });
    } catch (requestError) {
      addNotification({ type: 'error', title: t('common.error', { message: requestError.message || t('message.loadingError') }) });
    }
  }, [accounts, addNotification, openCompose, replyDefault, t]);

  const forward = useCallback(async target => {
    try {
      await openForwardFromMessage(target, { openCompose, getMessageBody: api.getMessageBody });
    } catch (requestError) {
      addNotification({ type: 'error', title: t('common.error', { message: requestError.message || t('message.loadingError') }) });
    }
  }, [addNotification, openCompose, t]);

  const newest = useMemo(() => newestConversationMessage(messages), [messages]);
  const subject = message?.subject || newest?.subject || t('common.noSubject');

  if (!message) return null;

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'calc(var(--sat) + 10px) 14px 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          <button type="button" onClick={() => setSelectedMessage(null)} title={t('common.back')} aria-label={t('common.back')} style={{ border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{subject}</span>
        </div>
      )}

      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, boxShadow: paneScrolled ? '0 1px 10px rgba(0,0,0,0.2)' : 'none' }}>
        {!isMobile && <button type="button" onClick={() => setSelectedMessage(null)} title={t('common.back')} aria-label={t('common.back')} style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: 5 }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg></button>}
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{subject}</div><div style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>{t('conversation.messages', { count: messages.length })}</div></div>
        <button type="button" onClick={() => setConversationRead(messages.some(item => !item.is_read))} title={messages.some(item => !item.is_read) ? t('contextMenu.markRead') : t('contextMenu.markUnread')} aria-label={messages.some(item => !item.is_read) ? t('contextMenu.markRead') : t('contextMenu.markUnread')} style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: 6 }}><ConversationIcon type={messages.some(item => !item.is_read) ? 'read' : 'unread'} /></button>
      </div>

      <div onScroll={event => setPaneScrolled(event.currentTarget.scrollTop > 4)} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}><div className="skeleton-line" style={{ height: 18, width: '40%' }}/><div className="skeleton-line" style={{ height: 54, width: '100%' }}/><div className="skeleton-line" style={{ height: 54, width: '100%' }}/></div>}
        {error && !loading && <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}><div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{error}</div><button type="button" onClick={retry} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 12px', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>{t('common.retry')}</button></div>}
        {!loading && !error && messages.map(item => <ConversationMessageCard key={item.id} message={item} expanded={expandedIds.has(item.id)} onToggle={() => toggleExpanded(item.id)} onReply={target => replyTo(target)} onForward={target => forward(target)} />)}
        {!loading && !error && newest && <div style={{ padding: isMobile ? '18px 14px 28px' : '22px 14px 34px', display: 'flex', justifyContent: 'center' }}><button type="button" onClick={() => replyTo(newest)} title={t('conversation.replyLatest')} style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '8px 14px', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>{t('conversation.replyLatest')}</button></div>}
      </div>
    </div>
  );
}
