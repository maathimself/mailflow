import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 };

const buttonStyle = { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer' };

export default function MailProxySettings() {
  const { t } = useTranslation();
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.admin.getMailProxy().then(setForm).catch(err => setError(err.message));
  }, []);
  const set = (key, value) => { setSaved(false); setForm(f => ({ ...f, [key]: value })); };
  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const result = await api.admin.saveMailProxy(form);
      setForm(result); setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  return <section style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
    <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{t('admin.mailProxy.title')}</h3>
    <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.mailProxy.description')}</p>
    {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    {form && <>
      <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> {t('admin.mailProxy.enabled')}</label>
      <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>{t('admin.mailProxy.type')}<select style={inputStyle} value="http" onChange={e => set('type', e.target.value)}><option value="http">HTTP CONNECT</option></select></label>
      {['host', 'port', 'username', 'password'].map(key => <label key={key} style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
        {t(`admin.mailProxy.${key}`)}
        <input style={inputStyle} type={key === 'password' ? 'password' : key === 'port' ? 'number' : 'text'}
          autoComplete={key === 'password' ? 'new-password' : 'off'}
          min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined}
          value={form[key] ?? ''} onChange={e => set(key, e.target.value)}
          placeholder={form[`has${key[0].toUpperCase()}${key.slice(1)}`] && form[key] === undefined ? t('admin.mailProxy.keepSecret') : ''} />
      </label>)}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.mailProxy.secretHelp')}</p>
      <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}><input type="checkbox" checked={form.allowPrivate} onChange={e => set('allowPrivate', e.target.checked)} /> {t('admin.mailProxy.allowPrivate')}</label>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.mailProxy.scope')}</p>
      <button style={{ ...buttonStyle, background: 'var(--accent)', color: 'white' }} type="button" onClick={save} disabled={saving}>{t(saving ? 'admin.mailProxy.saving' : 'admin.mailProxy.save')}</button>
      {saved && <p role="status">{t('admin.mailProxy.saved')}</p>}
    </>}
  </section>;
}

export function AccountProxySettings({ form, set, accountId, savedAccount }) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(null);
  const [testing, setTesting] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    api.getMailProxyStatus().then(d => setAvailable(d.enabled)).catch(() => setAvailable(false));
  }, []);
  const test = async protocol => {
    setTesting(protocol); setResult('');
    try {
      const data = await api.testAccountConnection(accountId, protocol);
      setResult(t('admin.mailProxy.testPassed', { protocol: protocol.toUpperCase(), mode: t(`admin.mailProxy.${data.mode}`) }));
    } catch (err) { setResult(err.message); }
    finally { setTesting(''); }
  };
  return <section style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 16 }}>
    <h3 style={{ fontSize: 13 }}>{t('admin.mailProxy.title')}</h3>
    {available === false && <p style={{ fontSize: 12 }}>{t('admin.mailProxy.unavailable')}</p>}
    {['imap', 'smtp'].map(protocol => <div key={protocol} style={{ marginBottom: 12 }}>
      <label><input type="checkbox" checked={!!form[`${protocol}_use_proxy`]} onChange={e => set(`${protocol}_use_proxy`, e.target.checked)} /> {t('admin.mailProxy.useFor', { protocol: protocol.toUpperCase() })}</label>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0' }}>{t('admin.mailProxy.mode')}: {t(`admin.mailProxy.${(savedAccount || form)[`${protocol}_use_proxy`] ? (available ? 'proxy' : 'blocked') : 'direct'}`)}</div>
      {accountId && <button style={buttonStyle} type="button" disabled={!!testing} onClick={() => test(protocol)}>{t('admin.mailProxy.test', { protocol: protocol.toUpperCase() })}</button>}
    </div>)}
    {accountId && <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.mailProxy.testSaved')}</p>}
    {result && <p role="status">{result}</p>}
  </section>;
}
