import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import ComposeContentEditor from '../../components/ComposeContentEditor.jsx';
import TemplateEditorActions from './TemplateEditorActions.jsx';
import './templates.css';

const emptyTemplate = (body = '', subject = '') => ({ name: '', subject, body });

export default function TemplateLibrary({ onInsert, onClose, captureContent, captureSubject }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  useEffect(() => {
    let active = true;
    api.get('/templates').then(items => { if (active) setTemplates(items); })
      .catch(failure => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const edit = async id => {
    setBusy(true); setError('');
    try {
      const template = await api.get(`/templates/${id}`);
      setForm({ id: template.id, name: template.name, subject: template.subject || '', body: template.body });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const payload = { name: form.name, subject: form.subject, body: form.body };
      const saved = form.id ? await api.put(`/templates/${form.id}`, payload) : await api.post('/templates', payload);
      setTemplates(items => [saved, ...items.filter(item => item.id !== saved.id)]);
      setForm(null);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const remove = async id => {
    setBusy(true); setError('');
    try {
      await api.delete(`/templates/${id}`);
      setTemplates(items => items.filter(item => item.id !== id));
      setDeleting(null);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const field = (key, label, maxLength) => <label className="template-field" key={key}>
    <span>{label}</span><input value={form[key]} maxLength={maxLength} disabled={busy}
      required={key === 'name'} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />
  </label>;
  return <section className="template-library">
    <div className="templates-heading"><h2>{t('templates.title')}</h2>
      {onClose && <button disabled={busy} onClick={onClose}>{t('common.cancel')}</button>}
    </div>
    <p className="templates-hint">{t('templates.hint')}</p>
    {!form && <div className="templates-actions">
      <button disabled={busy || loading} onClick={() => { setError(''); setDeleting(null); setForm(emptyTemplate()); }}>{t('templates.new')}</button>
      {captureContent && <button disabled={busy || loading} onClick={() => { setError(''); setDeleting(null); setForm(emptyTemplate(captureContent(), captureSubject?.() || '')); }}>{t('templates.saveContent')}</button>}
    </div>}
    {error && <p role="alert" className="templates-error">{error}</p>}
    {loading ? <p>{t('common.loading')}</p> : form ? <div>
      <div className="templates-fields">
        {field('name', t('templates.name'), 200)}
        {field('subject', t('compose.subject'), 2000)}
      </div>
      <div className="templates-body-label">{t('templates.content')}</div>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <ComposeContentEditor key={form.id || 'new'} value={form.body} disabled={busy}
          renderActions={context => <TemplateEditorActions context={context} />}
          onChange={body => setForm(current => current ? { ...current, body } : current)} />
      </fieldset>
      <div className="templates-actions">
        <button disabled={busy || !form.name.trim()} onClick={save}>{t('common.save')}</button>
        <button disabled={busy} onClick={() => { setForm(null); setError(''); }}>{t('common.cancel')}</button>
      </div>
    </div> : <>
      {!templates.length && <p>{t('templates.empty')}</p>}
      {templates.map(template => <div key={template.id} className="template-row">
        <div className="template-summary"><strong>{template.name}</strong></div>
        {deleting === template.id ? <div className="templates-actions">
          <span>{t('templates.deleteConfirm')}</span>
          <button disabled={busy} onClick={() => remove(template.id)}>{t('common.delete')}</button>
          <button disabled={busy} onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
        </div> : <div className="templates-actions">
          {onInsert && <button className="template-choice" disabled={busy} aria-label={`${t('templates.insert')}: ${template.name}`} onClick={async () => {
            setBusy(true); setError('');
            try { await onInsert(await api.get(`/templates/${template.id}`)); }
            catch (failure) { setError(failure.message); }
            finally { setBusy(false); }
          }}>{t('templates.insert')}</button>}
          <button disabled={busy} onClick={() => edit(template.id)} aria-label={`${t('common.edit')}: ${template.name}`}>{t('common.edit')}</button>
          <button disabled={busy} onClick={() => setDeleting(template.id)} aria-label={`${t('common.delete')}: ${template.name}`}>{t('common.delete')}</button>
        </div>}
      </div>)}
    </>}
  </section>;
}
