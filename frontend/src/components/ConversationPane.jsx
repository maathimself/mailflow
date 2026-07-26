import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { openForwardFromMessage, openReplyFromMessage } from '../utils/composeFromMessage.js';
import {
  conversationMembershipKey,
  conversationReadTargets,
  conversationUnreadCount,
  inboxConversationReadTargets,
  initialExpandedMessageIds,
  newestConversationMessage,
  unreadConversationIds,
  reconcileExpandedMessageIds,
} from '../utils/conversation.js';
import { useConversation } from '../hooks/useConversation.js';
import {
  conversationActionIds,
  conversationSpamTargets,
  groupConversationMessagesByAccount,
  newestSnoozeTarget,
} from '../utils/conversationActions.js';
import ConversationMessageCard from './ConversationMessageCard.jsx';

function ConversationIcon({ type }) {
  if (type === 'read') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12l5 5L20 6"/></svg>;
  if (type === 'unread') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v14H4z"/><path d="M4 7l8 6 8-6"/></svg>;
  if (type === 'archive') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="5"/><path d="M5 9v11h14V9"/><path d="M9 13h6"/></svg>;
  if (type === 'move') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h7l2 3h9v11H3z"/></svg>;
  if (type === 'spam') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l8 4v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V7z"/><path d="M12 8v5"/><path d="M12 17h.01"/></svg>;
  if (type === 'snooze') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
  if (type === 'delete') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/></svg>;
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 9l6 6 6-6"/></svg>;
}

function ToolbarButton({ title, onClick, disabled, danger = false, children }) {
  return <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title} style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: danger ? 'var(--red, #e53e3e)' : 'var(--text-secondary)', cursor: disabled ? 'wait' : 'pointer', padding: 6, opacity: disabled ? 0.55 : 1, display: 'flex', alignItems: 'center' }}>{children}</button>;
}

export default function ConversationPane({ message, threadId }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const {
    accounts, openCompose, setSelectedMessage, updateMessage,
    decrementUnread, incrementUnread, adjustCategoryCount,
    markReadBehavior, markReadDelay, replyDefault, addNotification,
    selectedAccountId, selectedFolder, setSelectedAccount,
    setUnreadCounts, setCategoryCounts,
  } = useStore();
  const { messages, loading, error, retry } = useConversation(threadId);
  const [expandedIds, setExpandedIds] = useState(() => initialExpandedMessageIds([]));
  const previousMessagesRef = useRef([]);
  const automaticExpandedIdRef = useRef(null);
  const messagesRef = useRef(messages);
  const autoReadRunRef = useRef(null);
  const [paneScrolled, setPaneScrolled] = useState(false);
  const [actionBusy, setActionBusy] = useState(null);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [moveFolders, setMoveFolders] = useState([]);
  const [moveFoldersLoading, setMoveFoldersLoading] = useState(false);
  const [moveSearch, setMoveSearch] = useState('');
  const [showSnoozePicker, setShowSnoozePicker] = useState(false);
  const [customSnoozeValue, setCustomSnoozeValue] = useState('');
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
    const previousUnreadCount = conversationUnreadCount(currentMessages);
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
    updateMessage(message?.id, {
      is_read: read,
      unread_count: read ? 0 : currentMessages.length,
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
      updateMessage(message?.id, {
        is_read: previousUnreadCount === 0,
        unread_count: previousUnreadCount,
      });
      addNotification({ type: 'error', title: t('common.error', { message: requestError.message || t('message.loadingError') }) });
    }
  }, [addNotification, adjustCategoryCount, decrementUnread, incrementUnread, message?.id, t, updateMessage]);

  const membershipKey = useMemo(() => conversationMembershipKey(messages), [messages]);

  useEffect(() => {
    const currentMessages = messagesRef.current;
    if (markReadBehavior === 'manual') {
      autoReadRunRef.current = null;
      return undefined;
    }
    if (currentMessages.length === 0) return undefined;
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
  const actionIds = useMemo(() => conversationActionIds(messages), [messages]);

  const refreshAndClose = useCallback(async () => {
    const [unreadResult, categoryResult] = await Promise.allSettled([
      api.getUnreadCounts(),
      api.getCategoryCounts(selectedAccountId ? { accountId: selectedAccountId } : {}),
    ]);
    if (unreadResult.status === 'fulfilled') setUnreadCounts(unreadResult.value);
    if (categoryResult.status === 'fulfilled') setCategoryCounts(categoryResult.value.counts || {});
    setSelectedAccount(selectedAccountId, selectedFolder);
  }, [selectedAccountId, selectedFolder, setCategoryCounts, setSelectedAccount, setUnreadCounts]);

  const archiveConversation = useCallback(async () => {
    if (!actionIds.length || actionBusy) return;
    setActionBusy('archive');
    try {
      const result = await api.bulkArchive(actionIds);
      const succeeded = new Set(result.archived || []);
      const failed = actionIds.length - succeeded.size;
      addNotification(failed ? {
        type: 'error',
        title: result.noArchiveFolder?.length ? t('messageList.bulkArchived.noFolderTitle') : t('messageList.bulkArchived.failTitle'),
        body: result.noArchiveFolder?.length ? t('messageList.bulkArchived.noFolderBody') : t('messageList.bulkArchived.failBody', { count: failed }),
      } : { title: t('messageList.bulkArchived.title', { count: succeeded.size }), body: t('messageList.bulkArchived.body') });
      if (succeeded.size) await refreshAndClose();
    } catch (requestError) {
      addNotification({ type: 'error', title: t('messageList.bulkArchived.failTitle'), body: requestError.message || t('messageList.bulkArchived.failBody', { count: actionIds.length }) });
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, actionIds, addNotification, refreshAndClose, t]);

  const deleteConversation = useCallback(async () => {
    if (!actionIds.length || actionBusy) return;
    setActionBusy('delete');
    try {
      const result = await api.bulkDelete(actionIds);
      const succeeded = new Set(result.deleted || []);
      const failed = actionIds.length - succeeded.size;
      addNotification(failed ? {
        type: 'error', title: t('messageList.bulkDeleted.failTitle'), body: t('messageList.bulkDeleted.failBody', { count: failed }),
      } : { title: t('messageList.bulkDeleted.title', { count: succeeded.size }), body: t('messageList.bulkDeleted.body') });
      if (succeeded.size) await refreshAndClose();
    } catch (requestError) {
      addNotification({ type: 'error', title: t('messageList.bulkDeleted.failTitle'), body: requestError.message || t('messageList.bulkDeleted.failBody', { count: actionIds.length }) });
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, actionIds, addNotification, refreshAndClose, t]);

  const openMovePicker = useCallback(async () => {
    if (showMovePicker) {
      setShowMovePicker(false);
      return;
    }
    setShowSnoozePicker(false);
    setShowMovePicker(true);
    setMoveSearch('');
    setMoveFoldersLoading(true);
    try {
      const accountIds = Object.keys(groupConversationMessagesByAccount(messages));
      const folderLists = await Promise.all(accountIds.map(accountId => api.getFolders(accountId)
        .then(data => Array.isArray(data) ? data : (data.folders || []))));
      const availableInEveryAccount = (folderLists[0] || []).filter(folder =>
        folderLists.every(list => list.some(candidate => candidate.path === folder.path))
        && messages.some(item => item.folder !== folder.path));
      setMoveFolders(availableInEveryAccount);
    } catch {
      setMoveFolders([]);
    } finally {
      setMoveFoldersLoading(false);
    }
  }, [messages, showMovePicker]);

  const moveConversation = useCallback(async folder => {
    if (!folder || actionBusy) return;
    setShowMovePicker(false);
    setActionBusy('move');
    const groups = Object.values(groupConversationMessagesByAccount(messages));
    try {
      const results = await Promise.allSettled(groups.map(group => api.bulkMove(group.map(item => item.id), folder)));
      const succeeded = new Set(results.flatMap(result => result.status === 'fulfilled' ? (result.value.moved || []) : []));
      const failed = actionIds.length - succeeded.size;
      addNotification(failed ? {
        type: 'error', title: t('messageList.bulkMoved.failTitle'), body: t('messageList.bulkMoved.failBody', { count: failed }),
      } : { title: t('messageList.bulkMoved.title', { count: succeeded.size }), body: folder });
      if (succeeded.size) await refreshAndClose();
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, actionIds.length, addNotification, messages, refreshAndClose, t]);

  const spamConversation = useCallback(async () => {
    if (actionBusy) return;
    const targets = conversationSpamTargets(messages, accounts);
    if (!targets.length) return;
    setActionBusy('spam');
    try {
      const results = await Promise.allSettled(targets.map(item => api.markSpam(item.id)));
      const succeeded = results.filter(result => result.status === 'fulfilled').length;
      const failed = targets.length - succeeded;
      addNotification(failed ? {
        type: 'error', title: t('spam.failTitle'), body: t('spam.failBodyBulk', { count: failed }),
      } : { title: t('spam.movedToSpamBulk', { count: succeeded }) });
      if (succeeded) await refreshAndClose();
    } finally {
      setActionBusy(null);
    }
  }, [accounts, actionBusy, addNotification, messages, refreshAndClose, t]);

  const snoozeConversation = useCallback(async until => {
    const target = newestSnoozeTarget(messages);
    if (!target || !until || actionBusy) return;
    setShowSnoozePicker(false);
    setActionBusy('snooze');
    try {
      await api.snoozeMessage(target.id, until);
      addNotification({ title: t('message.snoozed.title'), body: subject });
      await refreshAndClose();
    } catch (requestError) {
      addNotification({ type: 'error', title: t('message.snoozed.failTitle'), body: requestError.message || t('message.snoozed.failBody') });
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, addNotification, messages, refreshAndClose, subject, t]);

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
        <ToolbarButton onClick={archiveConversation} disabled={Boolean(actionBusy)} title={t('message.archive')}><ConversationIcon type="archive" /></ToolbarButton>
        <div style={{ position: 'relative' }}>
          <ToolbarButton onClick={openMovePicker} disabled={Boolean(actionBusy)} title={t('contextMenu.moveToFolder')}><ConversationIcon type="move" /></ToolbarButton>
          {showMovePicker && <>
            <div aria-hidden onClick={() => setShowMovePicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
            <div style={{ position: 'absolute', top: 'calc(100% + 5px)', right: 0, width: 230, maxHeight: 300, overflowY: 'auto', zIndex: 30, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-popover)' }}>
              {!moveFoldersLoading && moveFolders.length > 0 && <div style={{ padding: 6, borderBottom: '1px solid var(--border-subtle)' }}><input autoFocus value={moveSearch} onChange={event => setMoveSearch(event.target.value)} placeholder={t('contextMenu.folders.search')} style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} /></div>}
              {moveFoldersLoading ? <div style={{ padding: 14, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('contextMenu.folders.loading')}</div>
                : moveFolders.length === 0 ? <div style={{ padding: 14, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('contextMenu.folders.empty')}</div>
                  : moveFolders.filter(folder => (folder.name || folder.path).toLowerCase().includes(moveSearch.trim().toLowerCase())).map(folder => <button type="button" key={folder.path} onClick={() => moveConversation(folder.path)} style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '8px 11px', textAlign: 'left', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name || folder.path}</button>)}
            </div>
          </>}
        </div>
        <ToolbarButton onClick={spamConversation} disabled={Boolean(actionBusy) || conversationSpamTargets(messages, accounts).length === 0} title={t('contextMenu.markAsSpam')}><ConversationIcon type="spam" /></ToolbarButton>
        <div style={{ position: 'relative' }}>
          <ToolbarButton onClick={() => { setShowMovePicker(false); setShowSnoozePicker(value => !value); }} disabled={Boolean(actionBusy) || !newestSnoozeTarget(messages)} title={t('contextMenu.snooze.label')}><ConversationIcon type="snooze" /></ToolbarButton>
          {showSnoozePicker && <>
            <div aria-hidden onClick={() => setShowSnoozePicker(false)} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
            <div style={{ position: 'absolute', top: 'calc(100% + 5px)', right: 0, width: 220, zIndex: 30, border: '1px solid var(--border)', borderRadius: 7, padding: 5, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-popover)' }}>
              {[
                { label: t('contextMenu.snooze.threeHours'), date: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
                { label: t('contextMenu.snooze.tomorrowMorning'), date: () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date; } },
                { label: t('contextMenu.snooze.nextWeek'), date: () => { const date = new Date(); date.setDate(date.getDate() + 7); date.setHours(9, 0, 0, 0); return date; } },
              ].map(option => <button type="button" key={option.label} onClick={() => snoozeConversation(option.date().toISOString())} style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }}>{option.label}</button>)}
              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
              <div style={{ display: 'flex', gap: 5, padding: 5 }}>
                <input type="datetime-local" value={customSnoozeValue} onChange={event => setCustomSnoozeValue(event.target.value)} aria-label={t('contextMenu.snooze.custom')} style={{ minWidth: 0, flex: 1, padding: '5px 6px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', colorScheme: 'dark light' }} />
                <button type="button" disabled={!customSnoozeValue} onClick={() => snoozeConversation(new Date(customSnoozeValue).toISOString())} title={t('contextMenu.snooze.custom')} style={{ border: '1px solid var(--border)', borderRadius: 5, background: 'transparent', color: 'var(--text-primary)', cursor: customSnoozeValue ? 'pointer' : 'default', opacity: customSnoozeValue ? 1 : 0.5 }}>{t('common.save')}</button>
              </div>
            </div>
          </>}
        </div>
        <ToolbarButton onClick={() => setConversationRead(messages.some(item => !item.is_read))} disabled={Boolean(actionBusy)} title={messages.some(item => !item.is_read) ? t('contextMenu.markRead') : t('contextMenu.markUnread')}><ConversationIcon type={messages.some(item => !item.is_read) ? 'read' : 'unread'} /></ToolbarButton>
        <ToolbarButton onClick={deleteConversation} disabled={Boolean(actionBusy)} danger title={t('message.delete')}><ConversationIcon type="delete" /></ToolbarButton>
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
