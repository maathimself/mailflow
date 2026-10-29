import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import './templates.css';

export function TemplateIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 12h8M8 16h6" />
  </svg>;
}

export default function InsertTemplateButton({ context }) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const button = useRef(null);
  const popup = useRef(null);
  const selection = useRef(null);
  const capturedSession = useRef(null);
  const currentContext = useRef(context);
  currentContext.current = context;
  const request = useRef(0);
  const close = () => { request.current++; setPosition(null); };
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    if (!position) return;
    const dismiss = event => {
      if (!popup.current?.contains(event.target) && !button.current?.contains(event.target)) close();
    };
    const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); button.current?.focus(); } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape, true);
    popup.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape, true);
    };
  }, [position]);
  const open = async () => {
    if (position) { close(); return; }
    selection.current = context.captureSelection();
    capturedSession.current = context.sessionId;
    const rect = button.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.right - 300, window.innerWidth - 308)), top: Math.min(rect.bottom + 5, Math.max(8, window.innerHeight - 340)) });
    setBusy(true); setError(''); setTemplates([]);
    const token = ++request.current;
    try {
      const items = await api.get('/templates');
      if (token === request.current) setTemplates(items);
    } catch (failure) { if (token === request.current) setError(failure.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const insert = async id => {
    const token = ++request.current;
    setBusy(true); setError('');
    try {
      const template = await api.get(`/templates/${id}`);
      if (token !== request.current) return;
      if (currentContext.current.sessionId !== capturedSession.current || currentContext.current.disabled) { close(); return; }
      currentContext.current.applyPreset(template, selection.current);
      close();
    } catch (failure) { if (token === request.current) setError(failure.message); }
    finally { if (token === request.current) setBusy(false); }
  };
  return <>
    <button ref={button} type="button" className="insert-template-button" title={t('templates.insert')}
      aria-label={t('templates.insert')} aria-expanded={!!position} aria-haspopup="dialog" disabled={context.disabled}
      onMouseDown={event => event.preventDefault()} onClick={open}><TemplateIcon /></button>
    {position && createPortal(<div ref={popup} role="dialog" aria-label={t('templates.insert')} tabIndex={-1}
      className="template-picker" style={position}>
      <div className="templates-heading"><strong>{t('templates.insert')}</strong><button onClick={close}>{t('common.cancel')}</button></div>
      <p className="templates-hint">{t('templates.insertHint')}</p>
      {error && <p role="alert" className="templates-error">{error}</p>}
      {busy && <p role="status">{t('common.loading')}</p>}
      {!busy && !error && !templates.length && <p>{t('templates.empty')}</p>}
      {templates.map(template => <button key={template.id} className="template-choice" disabled={busy} onClick={() => insert(template.id)}>
        <strong>{template.name}</strong>{template.subject && <span>{template.subject}</span>}
      </button>)}
    </div>, document.body)}
  </>;
}
