import { cloneElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { webhookErrorText } from '../utils/webhookErrors.js';
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
function ActionButton({ primary = false, danger = false, disabled, children, ...props }) {
  return <button type="button" disabled={disabled} {...props} style={{
    padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500,
    background: danger ? 'rgba(248,113,113,0.1)' : primary ? 'var(--accent)' : 'transparent', color: danger ? 'var(--red)' : primary ? 'white' : 'var(--text-secondary)',
    border: danger ? '1px solid rgba(248,113,113,0.3)' : primary ? '1px solid transparent' : '1px solid var(--border)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
  }}>{children}</button>;
}

export default function WebhookSettings() {
  const { t } = useTranslation();
  return <section style={sectionStyle}>
    <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('webhooks.title')}</h3>
    <UserWebhookSettings />
  </section>;
}

export function UserWebhookSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [useToken, setUseToken] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api.webhooks.get().then(data => { if (active) { setConfig(data); setUseToken(!!data.tokenConfigured); } }).catch(err => { if (active) setError(err); });
    return () => { active = false; };
  }, []);
  const edit = (key, value) => { setConfig(c => ({ ...c, [key]: value })); setDirty(true); setMessage(''); };
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const { enabled, format, includeSender, includeSubject } = config;
      await api.webhooks.save({ enabled, format, includeSender, includeSubject, ...(url ? { url } : {}), ...(format === 'generic' ? {} : !useToken ? { token: '' } : token ? { token } : {}) });
      // Clear secrets immediately after a successful write, even if the refresh fails.
      setUrl(''); setToken('');
      const saved = await api.webhooks.get();
      setConfig(saved); setUseToken(!!saved.tokenConfigured); setDirty(false); setMessage(t('webhooks.saved'));
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.webhooks.remove();
      setUrl(''); setToken(''); setDirty(false);
      setConfig(c => ({ ...c, enabled: false, urlConfigured: false, tokenConfigured: false, failures: 0, lastError: null }));
      setConfirmRemove(false); setUseToken(false);
      setMessage(t('webhooks.removed'));
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setMessage('');
    try { await api.webhooks.test(); setMessage(t('webhooks.testSent')); }
    catch (err) { setError(err); }
    finally {
      try { setConfig(await api.webhooks.get()); } catch { /* Keep the delivery error visible. */ }
      setBusy(false);
    }
  }
  if (config && !config.available) {
    return <p style={helpStyle}>{t('webhooks.unavailable')}</p>;
  }
  return <div>
    <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 20px', lineHeight: 1.5 }}>{t('webhooks.description')}</p>
    {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', margin: '0 0 14px' }}>{webhookErrorText(error, t)}</p>}
    {message && <p role="status" style={{ fontSize: 13, color: 'var(--green, #22c55e)', margin: '0 0 14px' }}>{message}</p>}
    {!config && !error && <p style={helpStyle}>{t('common.loading')}</p>}
    {config && <>
      {!config.enabled && config.failures >= 5 && <p role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{t('webhooks.disabled')}</p>}
      {config.lastError && <p role="status" style={helpStyle}>{webhookErrorText(config.lastError, t)}</p>}
      <fieldset disabled={busy || !config.available} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Check label={t('webhooks.enable')} checked={!!config.enabled} onChange={v => edit('enabled', v)} />
        {config.enabled && <>
          <Field label={t('webhooks.format')}><select style={fieldStyle} value={config.format} onChange={e => { edit('format', e.target.value); if (e.target.value === 'generic') { setToken(''); setUseToken(false); } }}><option value="generic">{t('webhooks.generic')}</option><option value="ntfy">{'ntfy'}</option><option value="gotify">{'Gotify'}</option></select></Field>
          <Field label={t('webhooks.url')}><PasswordInput autoComplete="new-password" maxLength={4096} style={fieldStyle} value={url} placeholder={config.urlConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setUrl(e.target.value); setDirty(true); setMessage(''); }} /></Field>
          {config.format !== 'generic' && <p style={helpStyle}><code>{config.format === 'ntfy' ? 'https://ntfy.example.com/topic' : 'https://gotify.example.com/message'}</code></p>}
          {config.format !== 'generic' && <>
            <Check label={t('webhooks.useToken')} checked={useToken} onChange={v => { setUseToken(v); setDirty(true); setMessage(''); }} />
            {useToken && <Field label={t('webhooks.token')}><PasswordInput autoComplete="new-password" maxLength={4096} style={fieldStyle} value={token} placeholder={config.tokenConfigured ? t('webhooks.secretKept') : undefined} onChange={e => { setToken(e.target.value); setDirty(true); setMessage(''); }} /></Field>}
          </>}
          <Check label={t('webhooks.sender')} checked={!!config.includeSender} onChange={v => edit('includeSender', v)} />
          <Check label={t('webhooks.subject')} checked={!!config.includeSubject} onChange={v => edit('includeSubject', v)} />
          <p style={helpStyle}>{t('webhooks.testHelp')}</p>
        </>}
        {(config.enabled || dirty || config.urlConfigured) && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(config.enabled || dirty) && <ActionButton primary disabled={busy || !dirty || (config.enabled && !url && !config.urlConfigured)} onClick={save}>{busy ? t('common.saving') : t('common.save')}</ActionButton>}
          {config.enabled && <ActionButton disabled={busy || dirty || !config.urlConfigured} onClick={test}>{t('webhooks.test')}</ActionButton>}
          {config.urlConfigured && !confirmRemove && <div style={{ marginLeft: 'auto' }}><ActionButton danger disabled={busy} onClick={() => setConfirmRemove(true)}>{t('webhooks.remove')}</ActionButton></div>}
        </div>}
        {config.urlConfigured && confirmRemove && <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <span style={{ ...helpStyle, flex: '1 1 200px' }}>{t('webhooks.removeConfirm')}</span>
          <ActionButton danger disabled={busy} onClick={remove}>{t('common.delete')}</ActionButton>
          <ActionButton autoFocus disabled={busy} onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</ActionButton>
        </div>}
      </fieldset>
    </>}
  </div>;
}

export function AdminWebhookSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [origins, setOrigins] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    api.webhooks.getAdmin().then(data => { if (active) { setConfig(data); setOrigins(data.allowedOrigins.join('\n')); } }).catch(err => { if (active) setError(err); });
    return () => { active = false; };
  }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      await api.webhooks.saveAdmin({ enabled: config.enabled, allowedOrigins: origins.split('\n').map(s => s.trim()).filter(Boolean) });
      setMessage(t('webhooks.saved'));
    } catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  return <div>
    <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 20px' }}>{t('webhooks.title')}</h3>
    {error && <p role="alert" style={{ fontSize: 13, color: 'var(--red)', margin: '0 0 14px' }}>{webhookErrorText(error, t)}</p>}
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
