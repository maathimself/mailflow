import { cloneElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import ToggleRow from './SettingsToggleRow.jsx';
import PasswordInput from './PasswordInput.jsx';

// Match AdminPanel's form fields and Notifications section spacing.
const fieldStyle = { width: '100%', padding: '9px 12px', boxSizing: 'border-box', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 7, fontSize: 13, transition: 'border-color 0.15s' };
const sectionStyle = { marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border-subtle)' };
const helpStyle = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 };
function Field({ label, children }) {
  const id = useId();
  return <div style={{ marginBottom: 14 }}>
    <label htmlFor={id} style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</label>
    {cloneElement(children, { id })}
  </div>;
}
function Check(props) {
  return <div style={{ marginBottom: 12 }}><ToggleRow {...props} /></div>;
}
function ActionButton({ primary = false, disabled, children, ...props }) {
  return <button type="button" disabled={disabled} {...props} style={{
    padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500,
    background: primary ? 'var(--accent)' : 'transparent', color: primary ? 'white' : 'var(--text-secondary)',
    border: primary ? '1px solid transparent' : '1px solid var(--border)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
  }}>{children}</button>;
}

export default function WebhookSettings({ isAdmin = false }) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  return <section style={sectionStyle}>
    <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('webhooks.title')}</h3>
    <UserWebhookSettings key={revision} />
    {isAdmin && <AdminWebhookSettings onSaved={() => setRevision(r => r + 1)} />}
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
    <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 20px', lineHeight: 1.5 }}>{t('webhooks.description')}</p>
    {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', margin: '0 0 14px' }}>{error}</p>}
    {message && <p role="status" style={{ fontSize: 13, color: 'var(--green, #22c55e)', margin: '0 0 14px' }}>{message}</p>}
    {!config && !error && <p style={helpStyle}>{t('common.loading')}</p>}
    {config && <>
      {!config.available && <p style={{ ...helpStyle, padding: '12px 16px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>{t('webhooks.unavailable')}</p>}
      {!config.enabled && config.failures >= 5 && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('webhooks.disabled')}</p>}
      {config.lastError && <p role="status" style={helpStyle}>{config.lastError}</p>}
      <fieldset disabled={busy || !config.available} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Check label={t('webhooks.enable')} checked={!!config.enabled} onChange={v => edit('enabled', v)} />
        <Field label={t('webhooks.format')}><select style={fieldStyle} value={config.format} onChange={e => { edit('format', e.target.value); if (e.target.value === 'generic') { setToken(''); setClearToken(false); } }}><option value="generic">{t('webhooks.generic')}</option><option value="ntfy">{'ntfy'}</option><option value="gotify">{'Gotify'}</option></select></Field>
        <Field label={t('webhooks.url')}><PasswordInput autoComplete="new-password" maxLength={4096} style={fieldStyle} value={url} placeholder={config.urlConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setUrl(e.target.value); setDirty(true); setMessage(''); }} /></Field>
        {config.format !== 'generic' && <p style={helpStyle}><code>{config.format === 'ntfy' ? 'https://ntfy.example.com/topic' : 'https://gotify.example.com/message'}</code></p>}
        {config.format !== 'generic' && <>
          <Field label={t('webhooks.token')}><PasswordInput autoComplete="new-password" maxLength={4096} style={fieldStyle} value={token} disabled={clearToken} placeholder={config.tokenConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setToken(e.target.value); setDirty(true); setMessage(''); }} /></Field>
          {config.tokenConfigured && <Check label={t('webhooks.clearToken')} checked={clearToken} onChange={v => { setClearToken(v); setDirty(true); }} />}
        </>}
        <Check label={t('webhooks.sender')} checked={!!config.includeSender} onChange={v => edit('includeSender', v)} />
        <Check label={t('webhooks.subject')} checked={!!config.includeSubject} onChange={v => edit('includeSubject', v)} />
        <p style={helpStyle}>{t('webhooks.testHelp')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ActionButton primary disabled={busy || !dirty || (config.enabled && !url && !config.urlConfigured)} onClick={save}>{busy ? t('common.saving') : t('common.save')}</ActionButton>
          <ActionButton disabled={busy || dirty || !config.enabled || !config.urlConfigured} onClick={test}>{t('webhooks.test')}</ActionButton>
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
  return <div style={sectionStyle}>
    {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', margin: '0 0 14px' }}>{error}</p>}
    {message && <p role="status" style={{ fontSize: 13, color: 'var(--green, #22c55e)', margin: '0 0 14px' }}>{message}</p>}
    {!config && !error && <p style={helpStyle}>{t('common.loading')}</p>}
    {config && <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Check label={t('webhooks.adminEnable')} checked={!!config.enabled} onChange={enabled => { setConfig(c => ({ ...c, enabled })); setMessage(''); }} />
      <Field label={t('webhooks.origins')}><textarea style={fieldStyle} rows={3} value={origins} onChange={e => { setOrigins(e.target.value); setMessage(''); }} /></Field>
      <p style={helpStyle}>{t('webhooks.originsHelp')}</p>
      <ActionButton primary disabled={busy} onClick={save}>{busy ? t('common.saving') : t('common.save')}</ActionButton>
    </fieldset>}
  </div>;
}
