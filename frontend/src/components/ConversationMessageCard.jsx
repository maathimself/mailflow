import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDate } from '../utils/formatDate.js';
import MessageBodyView from './MessageBodyView.jsx';
import MessageHeaderModal from './MessageHeaderModal.jsx';

function addresses(raw) {
  try {
    const list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return list.map(item => item.name ? `${item.name} <${item.email}>` : item.email).filter(Boolean).join(', ');
  } catch {
    return '';
  }
}

export default function ConversationMessageCard({ message, expanded, onToggle, onReply, onForward }) {
  const { t } = useTranslation();
  const { updateMessage, addNotification } = useStore();
  const [body, setBody] = useState(null);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [starBusy, setStarBusy] = useState(false);

  const sender = message.from_name || message.from_email || t('common.unknown');
  const recipients = addresses(message.to_addresses);
  const toggleStar = async event => {
    event.stopPropagation();
    if (starBusy) return;
    const starred = !message.is_starred;
    setStarBusy(true);
    updateMessage(message.id, { is_starred: starred });
    try {
      await api.markStarred(message.id, starred);
    } catch {
      updateMessage(message.id, { is_starred: !starred });
      addNotification({ type: 'error', title: t('common.error', { message: t('message.star') }) });
    } finally {
      setStarBusy(false);
    }
  };

  return (
    <article
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: expanded ? 'var(--bg-primary)' : 'var(--bg-secondary)',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', border: 'none', background: 'transparent',
          color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{
          width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', background: message.account_color || 'var(--accent)',
          fontSize: 13, fontWeight: 700,
        }}>
          {sender[0]?.toUpperCase() || '?'}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 13, fontWeight: message.is_read ? 500 : 700,
            }}>{sender}</span>
            {message.from_name && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{message.from_email}</span>}
          </span>
          <span style={{ display: 'block', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)', fontSize: 11 }}>
            {recipients ? `${t('compose.to')}: ${recipients}` : (message.snippet || '')}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          {message.has_attachments && <span title={t('message.attachment', { count: 1 })} aria-label={t('message.attachment', { count: 1 })}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></span>}
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDate(message.date)}</span>
          <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', display: 'flex' }}>{expanded ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15"/></svg> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>}</span>
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 14px 16px 56px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
            <button type="button" onClick={() => onReply(message)} title={t('message.reply')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>{t('message.reply')}</button>
            <button type="button" onClick={() => onForward(message)} title={t('message.forward')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>{t('message.forward')}</button>
            <button type="button" onClick={toggleStar} disabled={starBusy} title={message.is_starred ? t('contextMenu.unstar') : t('message.star')} aria-label={message.is_starred ? t('contextMenu.unstar') : t('message.star')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: message.is_starred ? 'var(--amber)' : 'var(--text-secondary)', background: 'transparent', cursor: starBusy ? 'wait' : 'pointer' }}>{message.is_starred ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}</button>
            <button type="button" onClick={() => setShowHeaderModal(true)} title={t('contextMenu.viewHeaders')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>{t('contextMenu.viewHeaders')}</button>
          </div>
          <MessageBodyView
            message={message}
            eager={expanded}
            onBodyLoaded={setBody}
            inset={false}
            framed={false}
          />
          {body && <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 11 }}>{t('compose.from')}: {message.account_email || message.account_name || ''}</div>}
        </div>
      )}

      {showHeaderModal && <MessageHeaderModal messageId={message.id} subject={message.subject} onClose={() => setShowHeaderModal(false)} />}
    </article>
  );
}
