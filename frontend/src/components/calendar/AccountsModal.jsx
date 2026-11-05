import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { formatMessageDateTime } from '../../utils/formatDate.js';
import PasswordInput from '../PasswordInput.jsx';
import { Btn, ErrorBox, Icon, Modal, inputStyle, labelStyle } from './calendarUi.jsx';

const INTERVALS = [5, 15, 30, 60, 180, 720];

function AccountCard({ account, onChanged }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(err.status === 409 && name === 'sync' ? t('calendar.accounts.syncRunning') : err.message);
    } finally {
      setBusy(null);
    }
  };

  const intervals = INTERVALS.includes(account.intervalMin) ? INTERVALS : [...INTERVALS, account.intervalMin].sort((a, b) => a - b);
  const synced = account.lastSyncAt
    ? t('calendar.accounts.lastSync', { when: formatMessageDateTime(account.lastSyncAt) })
    : account.lastError ? t('calendar.accounts.neverSynced') : t('calendar.accounts.firstSync');

  return (
    <div style={{ border: `1px solid ${account.lastError ? 'var(--red-border, rgba(248,113,113,0.5))' : 'var(--border)'}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{account.name || account.username}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', wordBreak: 'break-all', marginTop: 2 }}>{account.username}, {account.serverUrl}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            {synced}
            {account.calendarCount != null && ` ${t('calendar.accounts.counts', { calendars: account.calendarCount, events: account.eventCount })}`}
          </div>
        </div>
        <Btn disabled={busy === 'sync'} onClick={() => run('sync', async () => {
          const res = await api.calendar.syncAccount(account.id);
          if (res && res.ok === false) setError(res.error || t('calendar.accounts.syncFailed'));
          else setNote(t('calendar.accounts.synced'));
          await onChanged();
        })} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="sync" size={13} style={busy === 'sync' ? { animation: 'spin 0.8s linear infinite' } : undefined} />
          {busy === 'sync' ? t('calendar.accounts.syncing') : t('calendar.accounts.syncNow')}
        </Btn>
      </div>

      {account.lastError && (
        <ErrorBox>
          <strong style={{ display: 'block', marginBottom: 2 }}>{t('calendar.accounts.syncFailed')}</strong>
          {account.lastError}
        </ErrorBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {note && <div role="status" style={{ fontSize: 12.5, color: 'var(--green)' }}>{note}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {t('calendar.accounts.interval')}
          <select value={account.intervalMin} disabled={busy === 'interval'} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}
            onChange={e => run('interval', async () => { await api.calendar.updateAccount(account.id, { intervalMin: Number(e.target.value) }); await onChanged(); })}>
            {intervals.map(n => <option key={n} value={n}>{t('calendar.accounts.everyMinutes', { n })}</option>)}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <Btn kind="plain" onClick={() => { setPwOpen(o => !o); setPassword(''); }}>{t('calendar.accounts.changePassword')}</Btn>
        {!confirming && <Btn kind="danger" onClick={() => setConfirming(true)}>{t('common.remove')}</Btn>}
      </div>

      {pwOpen && (
        <form onSubmit={e => {
          e.preventDefault();
          if (!password) return;
          run('password', async () => {
            await api.calendar.updateAccount(account.id, { password });
            setPwOpen(false);
            setPassword('');
            setNote(t('calendar.accounts.passwordSaved'));
            await onChanged();
          });
        }} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label style={{ flex: 1 }}>
            <span style={labelStyle}>{t('calendar.accounts.newPassword')}</span>
            <PasswordInput value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
          </label>
          <Btn kind="primary" disabled={!password || busy === 'password'} onClick={e => e.currentTarget.form.requestSubmit()}>
            {busy === 'password' ? t('common.saving') : t('common.save')}
          </Btn>
        </form>
      )}

      {confirming && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--red-dim, rgba(248,113,113,0.1))', border: '1px solid var(--red-border, rgba(248,113,113,0.3))' }}>
          <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-primary)', lineHeight: 1.45 }}>
            {t('calendar.accounts.removeConfirm', { name: account.name || account.username })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="solidDanger" disabled={busy === 'remove'} onClick={() => run('remove', async () => { await api.calendar.removeAccount(account.id); await onChanged(); })}>
              {busy === 'remove' ? t('common.deleting') : t('common.remove')}
            </Btn>
            <Btn onClick={() => setConfirming(false)}>{t('common.cancel')}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function AddForm({ onAdded, first }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', serverUrl: '', username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const ready = form.serverUrl.trim() && form.username.trim() && form.password;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.calendar.addAccount({
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        serverUrl: form.serverUrl.trim(), username: form.username.trim(), password: form.password,
      });
      setForm({ name: '', serverUrl: '', username: '', password: '' });
      await onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!first && <h3 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('calendar.accounts.addTitle')}</h3>}
      <label>
        <span style={labelStyle}>{t('calendar.accounts.name')}</span>
        <input value={form.name} onChange={e => set({ name: e.target.value })} style={inputStyle} />
      </label>
      <label>
        <span style={labelStyle}>{t('calendar.accounts.serverUrl')}</span>
        <input data-autofocus="" value={form.serverUrl} onChange={e => set({ serverUrl: e.target.value })} placeholder="https://caldav.example.com/dav/" inputMode="url" autoComplete="off" style={inputStyle} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label>
          <span style={labelStyle}>{t('calendar.accounts.username')}</span>
          <input value={form.username} onChange={e => set({ username: e.target.value })} autoComplete="off" style={inputStyle} />
        </label>
        <label>
          <span style={labelStyle}>{t('calendar.accounts.password')}</span>
          <PasswordInput value={form.password} onChange={e => set({ password: e.target.value })} autoComplete="new-password" style={inputStyle} />
        </label>
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
        {t('calendar.accounts.appPasswordHint')} {t('calendar.accounts.googleHint')}
      </p>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn kind="primary" disabled={!ready || busy} onClick={e => e.currentTarget.form.requestSubmit()}>
          {busy ? t('calendar.accounts.connecting') : t('calendar.accounts.connect')}
        </Btn>
      </div>
    </form>
  );
}

export default function AccountsModal({ accounts, isMobile, onClose, onChanged }) {
  const { t } = useTranslation();
  const list = accounts || [];
  return (
    <Modal title={t('calendar.accounts.title')} onClose={onClose} width={560} mobile={isMobile}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {list.map(a => <AccountCard key={a.id} account={a} onChanged={onChanged} />)}
        {list.length > 0 && <div style={{ borderTop: '1px solid var(--border-subtle)' }} />}
        <AddForm first={list.length === 0} onAdded={async () => { await onChanged(); if (list.length === 0) onClose(); }} />
      </div>
    </Modal>
  );
}
