import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { formatDate } from '../utils/formatDate.js';
import { BUILTIN_SUMMARIZE } from '../aiActions.js';
import { resolveConversationMessageDisclosure } from '../utils/conversation.js';
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
  const { updateMessage, addNotification, aiActions } = useStore();
  const [body, setBody] = useState(null);
  const [showHeaderModal, setShowHeaderModal] = useState(false);
  const [starBusy, setStarBusy] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [unsubscribeStatus, setUnsubscribeStatus] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [hasBeenExpanded, setHasBeenExpanded] = useState(expanded);
  const [visuallyExpanded, setVisuallyExpanded] = useState(expanded);
  const aiAbortRef = useRef(null);

  useEffect(() => () => aiAbortRef.current?.abort(), []);
  useEffect(() => {
    if (expanded) setHasBeenExpanded(true);
  }, [expanded]);
  useEffect(() => {
    if (!expanded) {
      setVisuallyExpanded(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => setVisuallyExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [expanded]);
  useEffect(() => {
    if (!expanded) setShowMoreMenu(false);
  }, [expanded]);

  const sender = message.from_name || message.from_email || t('common.unknown');
  const recipients = addresses(message.to_addresses);
  const disclosure = resolveConversationMessageDisclosure({ expanded, hasBeenExpanded });
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

  const toggleMoreMenu = () => {
    const next = !showMoreMenu;
    setShowMoreMenu(next);
    if (next && !aiStatus) api.ai.status().then(setAiStatus).catch(() => setAiStatus({ enabled: false }));
  };

  const unsubscribe = async () => {
    if (unsubscribeStatus === 'loading') return;
    setShowMoreMenu(false);
    setUnsubscribeStatus('loading');
    try {
      const result = await api.unsubscribeMessage(message.id);
      const succeeded = ['one-click', 'url', 'mailto'].includes(result.type);
      if (!succeeded) throw new Error(t('message.unsubscribe.error'));
      if (result.type === 'url' && result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
      if (result.type === 'mailto' && result.mailto) window.open(result.mailto, '_blank', 'noopener,noreferrer');
      setUnsubscribeStatus('done');
      addNotification({ title: t('message.unsubscribe.done') });
    } catch {
      setUnsubscribeStatus('error');
      addNotification({ type: 'error', title: t('message.unsubscribe.error') });
    }
  };

  const runAiAction = async action => {
    const textContent = body?.text
      || body?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      || '';
    if (!action?.id || !textContent) return;
    setShowMoreMenu(false);
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    const label = action.id === BUILTIN_SUMMARIZE.id ? t('message.summary') : action.label;
    setAiResult({ status: 'loading', label, text: '' });
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MailFlow' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({ messages: [{ role: 'user', content: `${action.prompt}\n\n${textContent.slice(0, 6000)}` }] }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const chunk = line.slice(6).trim();
          if (chunk === '[DONE]') continue;
          try {
            const delta = JSON.parse(chunk)?.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              setAiResult({ status: 'loading', label, text: fullText });
            }
          } catch { /* Ignore malformed streaming chunks. */ }
        }
      }
      setAiResult({ status: 'done', label, text: fullText });
    } catch (requestError) {
      if (requestError.name !== 'AbortError') setAiResult({ status: 'error', label, text: requestError.message });
    }
  };

  return (
    <article
      className={`conversation-message-card${visuallyExpanded ? ' conversation-message-card--expanded' : ''}`}
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
          <span aria-hidden="true" className="conversation-message-card__chevron"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg></span>
        </span>
      </button>

      {disclosure.renderShell && (
        <div
          className="conversation-message-card__disclosure"
          aria-hidden={disclosure.ariaHidden}
          inert={disclosure.inert}
        >
          {disclosure.renderContent && (
            <div className="conversation-message-card__clip">
              <div className="conversation-message-card__body">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                  <button type="button" onClick={() => onReply(message)} title={t('message.reply')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>{t('message.reply')}</button>
                  <button type="button" onClick={() => onForward(message)} title={t('message.forward')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>{t('message.forward')}</button>
                  <button type="button" onClick={toggleStar} disabled={starBusy} title={message.is_starred ? t('contextMenu.unstar') : t('message.star')} aria-label={message.is_starred ? t('contextMenu.unstar') : t('message.star')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: message.is_starred ? 'var(--amber)' : 'var(--text-secondary)', background: 'transparent', cursor: starBusy ? 'wait' : 'pointer' }}>{message.is_starred ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}</button>
                  <div style={{ position: 'relative' }}>
                    <button type="button" onClick={toggleMoreMenu} title={t('message.more')} aria-label={t('message.more')} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>...</button>
                    {showMoreMenu && <>
                      <div aria-hidden onClick={() => setShowMoreMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
                      <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 190, zIndex: 20, padding: 4, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-popover)' }}>
                        <button type="button" onClick={() => { setShowMoreMenu(false); setShowHeaderModal(true); }} style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }}>{t('contextMenu.viewHeaders')}</button>
                        {message.list_unsubscribe && !message.unsubscribed_at && unsubscribeStatus !== 'done' && <button type="button" disabled={unsubscribeStatus === 'loading'} onClick={unsubscribe} style={{ width: '100%', border: 'none', background: 'transparent', color: unsubscribeStatus === 'error' ? 'var(--red, #e53e3e)' : 'var(--text-primary)', padding: '8px 10px', textAlign: 'left', cursor: unsubscribeStatus === 'loading' ? 'wait' : 'pointer' }}>{unsubscribeStatus === 'loading' ? t('common.loading') : t('message.unsubscribe.button')}</button>}
                        {aiStatus?.enabled && aiStatus?.features?.summarize && body && <>
                          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '3px 0' }} />
                          <button type="button" onClick={() => runAiAction(BUILTIN_SUMMARIZE)} style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }}>{t('message.summarize')}</button>
                          {(aiActions || []).map(action => <button type="button" key={action.id} onClick={() => runAiAction(action)} style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }}>{action.label}</button>)}
                        </>}
                      </div>
                    </>}
                  </div>
                </div>
                {aiResult && <div style={{ marginBottom: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: aiResult.text ? 7 : 0 }}><strong style={{ flex: 1, color: 'var(--text-primary)' }}>{aiResult.label}</strong><span>{aiResult.status === 'loading' ? t('common.loading') : aiResult.status === 'error' ? t('common.error', { message: aiResult.text }) : ''}</span><button type="button" onClick={() => setAiResult(null)} title={t('common.dismiss')} aria-label={t('common.dismiss')} style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}>x</button></div>
                  {aiResult.status !== 'error' && aiResult.text && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{aiResult.text}</div>}
                </div>}
                <MessageBodyView
                  message={message}
                  eager={expanded}
                  onBodyLoaded={setBody}
                  inset={false}
                  framed={false}
                />
                {body && <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 11 }}>{t('compose.from')}: {message.account_email || message.account_name || ''}</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {showHeaderModal && <MessageHeaderModal messageId={message.id} subject={message.subject} onClose={() => setShowHeaderModal(false)} />}
    </article>
  );
}
