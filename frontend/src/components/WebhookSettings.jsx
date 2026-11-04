import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const fieldStyle = { width: '100%', padding: '9px 12px', boxSizing: 'border-box', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 7 };
const sectionStyle = { marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' };
const buttonStyle = { padding: '8px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)' };
function Field({ label, children }) {
  return <label style={{ display: 'block', margin: '12px 0', fontSize: 13 }}>{label}<div style={{ marginTop: 6 }}>{children}</div></label>;
}
function Check({ label, checked, onChange }) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', fontSize: 13 }}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{label}</label>;
}

export default function WebhookSettings({ isAdmin = false }) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  return <section style={sectionStyle}>
    <h3 style={{ fontSize: 15 }}>{t('webhooks.title')}</h3>
    {isAdmin && <AdminWebhookSettings onSaved={() => setRevision(r => r + 1)} />}
    <UserWebhookSettings key={revision} />
  </section>;
}

export function UserWebhookSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api.webhooks.get().then(data => { if (active) setConfig(data); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const edit = (key, value) => { setConfig(c => ({ ...c, [key]: value })); setDirty(true); setMessage(''); };
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const { enabled, format, includeSender, includeSubject } = config;
      await api.webhooks.save({ enabled, format, includeSender, includeSubject, ...(url ? { url } : {}), ...(clearToken ? { token: '' } : token ? { token } : {}) });
      // Clear secrets immediately after a successful write, even if the refresh fails.
      setUrl(''); setToken(''); setClearToken(false);
      setConfig(await api.webhooks.get()); setDirty(false); setMessage(t('webhooks.saved'));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setMessage('');
    try { await api.webhooks.test(); setMessage(t('webhooks.testSent')); }
    catch (err) { setError(err.message); }
    finally {
      try { setConfig(await api.webhooks.get()); } catch { /* Keep the delivery error visible. */ }
      setBusy(false);
    }
  }
  return <div>
    <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('webhooks.description')}</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!config && !error && <p>{t('common.loading')}</p>}
    {config && <>
      {!config.available && <p>{t('webhooks.unavailable')}</p>}
      {!config.enabled && config.failures >= 5 && <p role="alert">{t('webhooks.disabled')}</p>}
      {config.lastError && <p role="status">{config.lastError}</p>}
      <fieldset disabled={busy || !config.available} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Check label={t('webhooks.enable')} checked={!!config.enabled} onChange={v => edit('enabled', v)} />
        <Field label={t('webhooks.format')}><select style={fieldStyle} value={config.format} onChange={e => { edit('format', e.target.value); if (e.target.value === 'generic') { setToken(''); setClearToken(false); } }}><option value="generic">{t('webhooks.generic')}</option><option value="ntfy">{'ntfy'}</option><option value="gotify">{'Gotify'}</option></select></Field>
        <Field label={t('webhooks.url')}><input type="password" autoComplete="new-password" maxLength={4096} style={fieldStyle} value={url} placeholder={config.urlConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setUrl(e.target.value); setDirty(true); setMessage(''); }} /></Field>
        {config.format !== 'generic' && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}><code>{config.format === 'ntfy' ? 'https://ntfy.example.com/topic' : 'https://gotify.example.com/message'}</code></p>}
        {config.format !== 'generic' && <>
          <Field label={t('webhooks.token')}><input type="password" autoComplete="new-password" maxLength={4096} style={fieldStyle} value={token} disabled={clearToken} placeholder={config.tokenConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setToken(e.target.value); setDirty(true); setMessage(''); }} /></Field>
          {config.tokenConfigured && <Check label={t('webhooks.clearToken')} checked={clearToken} onChange={v => { setClearToken(v); setDirty(true); }} />}
        </>}
        <Check label={t('webhooks.sender')} checked={!!config.includeSender} onChange={v => edit('includeSender', v)} />
        <Check label={t('webhooks.subject')} checked={!!config.includeSubject} onChange={v => edit('includeSubject', v)} />
        <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('webhooks.testHelp')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} disabled={!dirty || (config.enabled && !url && !config.urlConfigured)} onClick={save}>{busy ? t('common.saving') : t('common.save')}</button>
          <button type="button" style={buttonStyle} disabled={dirty || !config.enabled || !config.urlConfigured} onClick={test}>{t('webhooks.test')}</button>
        </div>
      </fieldset>
    </>}
  </div>;
}

export function AdminWebhookSettings({ onSaved = () => {} }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [origins, setOrigins] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api.webhooks.getAdmin().then(data => { if (active) { setConfig(data); setOrigins(data.allowedOrigins.join('\n')); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.webhooks.saveAdmin({ enabled: config.enabled, allowedOrigins: origins.split('\n').map(s => s.trim()).filter(Boolean) });
      setMessage(t('webhooks.saved')); onSaved();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 8 }}>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!config && !error && <p>{t('common.loading')}</p>}
    {config && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Check label={t('webhooks.adminEnable')} checked={!!config.enabled} onChange={enabled => { setConfig(c => ({ ...c, enabled })); setMessage(''); }} />
      <Field label={t('webhooks.origins')}><textarea style={fieldStyle} rows={3} value={origins} onChange={e => { setOrigins(e.target.value); setMessage(''); }} /></Field>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('webhooks.originsHelp')}</p>
      <button type="button" style={buttonStyle} onClick={save}>{busy ? t('common.saving') : t('common.save')}</button>
    </fieldset>}
  </div>;
}
