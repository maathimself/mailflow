import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

export default function JevSettingsCard() {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.getJevStatus().then(status => { if (active) setConfigured(status.configured); })
      .catch(() => { if (active) setError(t('admin.integrations.jev.errorStatus')); });
    return () => { active = false; };
  }, [t]);

  async function save() {
    if (!key.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.saveJevKey(key);
      setConfigured(true);
      setKey('');
    } catch {
      setError(t('admin.integrations.jev.errorSave'));
    } finally { setBusy(false); }
  }

  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.removeJevKey();
      setConfigured(false);
      setKey('');
    } catch {
      setError(t('admin.integrations.jev.errorRemove'));
    } finally { setBusy(false); }
  }

  return (
    <section style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('admin.integrations.jev.title')}</h3>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.integrations.jev.disclosure')}</p>
      <p style={{ fontSize: 12 }}>{configured === null ? t('common.loading') :
        configured ? t('admin.integrations.jev.configured') : t('admin.integrations.jev.notConfigured')}</p>
      <label style={{ display: 'block', fontSize: 12 }} htmlFor="jev-api-key">{t('admin.integrations.jev.keyLabel')}</label>
      <input id="jev-api-key" type="password" autoComplete="new-password" value={key}
        onChange={event => setKey(event.target.value)} placeholder={t('admin.integrations.jev.keyPlaceholder')}
        style={{ width: '100%', maxWidth: 400, padding: 8, borderRadius: 7, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={save} disabled={busy || !key.trim()}>{t('admin.integrations.jev.save')}</button>
        {configured && <button onClick={remove} disabled={busy}>{t('admin.integrations.jev.remove')}</button>}
      </div>
      {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    </section>
  );
}
