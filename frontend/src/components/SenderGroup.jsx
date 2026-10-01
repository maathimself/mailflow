import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDate } from '../utils/formatDate.js';

export default function SenderGroup({ message, cacheKey, params, expanded, onToggle, renderRow, applyReadGuard }) {
  const { t } = useTranslation();
  const generation = useRef(0);
  const saving = useStore(s => s.senderGroupingSaving);
  const rows = useStore(s => s.threadMessages[cacheKey] || []);
  const setThreadMessages = useStore(s => s.setThreadMessages);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const paramsJson = JSON.stringify(params);
  const refreshToken = useStore(s => s.messagesRefreshToken);
  const unreadCount = message.sender_unread_count;

  useEffect(() => {
    const version = ++generation.current;
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    api.getMessages({ ...JSON.parse(paramsJson), sender: message.sender_group, limit: 50, offset: 0 })
      .then(data => {
        if (cancelled) return;
        setThreadMessages(cacheKey, applyReadGuard(data.messages));
        setTotal(data.total);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; generation.current = version + 1; };
  }, [expanded, cacheKey, paramsJson, message.sender_group, message.date, refreshToken, retry, setThreadMessages, applyReadGuard]);

  const loadMore = async () => {
    const version = generation.current;
    setLoading(true);
    setError(false);
    try {
      const data = await api.getMessages({ ...params, sender: message.sender_group, limit: 50, offset: rows.length });
      if (generation.current !== version) return;
      const current = useStore.getState().threadMessages[cacheKey] || [];
      const ids = new Set(current.map(row => row.id));
      setThreadMessages(cacheKey, [...current, ...applyReadGuard(data.messages).filter(row => !ids.has(row.id))]);
      setTotal(data.total);
    } catch {
      if (generation.current === version) setError(true);
    } finally {
      if (generation.current === version) setLoading(false);
    }
  };

  return (
    <section data-sender-group={message.sender_group} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <button type="button" aria-expanded={expanded} onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 16px',
        background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: 0, cursor: 'pointer', textAlign: 'left',
      }}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: unreadCount ? 700 : 500 }}>{message.from_name || message.sender_group}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>{message.sender_group}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message.subject}</span>
          <span style={{ fontSize: 12 }}>{t('messageList.senderGroupCounts', { unread: unreadCount, count: message.sender_message_count })}</span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatDate(message.date)}</span>
      </button>
      {expanded && <div style={{ borderLeft: '2px solid var(--accent)', marginLeft: 12 }}>
        {rows.map(renderRow)}
        {error && <button type="button" onClick={() => setRetry(v => v + 1)}>{t('messageList.senderGroupLoadError')}</button>}
        {loading && <div role="status" style={{ padding: 12 }}>{t('common.loading')}</div>}
        {!loading && !error && rows.length < total && <button type="button" onClick={loadMore}>{t('messageList.loadMore')}</button>}
        <button type="button" disabled={saving} onClick={() => useStore.getState().toggleSenderGrouping(message.sender_group)
          .catch(err => useStore.getState().addNotification({ type: 'error', title: t('common.error'), body: err.message }))}
          style={{ margin: 8 }}>{t('contextMenu.ungroupSender')}</button>
      </div>}
    </section>
  );
}
