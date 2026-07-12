import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

export default function LockScreen() {
  const { t } = useTranslation();
  const { user, setUser, setLocked } = useStore();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleUnlock(e) {
    e.preventDefault();
    if (!password.trim()) return;
    setUnlocking(true);
    setError('');
    try {
      await api.unlock(password);
      setLocked(false);
    } catch (err) {
      setError(err?.message === 'Incorrect password'
        ? t('lockScreen.wrongPassword')
        : (err?.message || t('lockScreen.wrongPassword')));
      setPassword('');
    } finally {
      setUnlocking(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await api.logout();
    } catch { /* intentional */ }
    localStorage.removeItem('mailflow_locked_message');
    setLocked(false);
    setUser(null);
  }

  const initials = ((user?.displayName || user?.username || '?')[0]).toUpperCase();

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'var(--bg-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 340,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24,
      }}>
        {/* Lock icon */}
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--bg-tertiary)',
          border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)',
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
        </div>

        {/* User info */}
        <div style={{ textAlign: 'center' }}>
          {user?.avatar ? (
            <img src={user.avatar} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', marginBottom: 8 }} />
          ) : (
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--accent)', color: 'var(--accent-text)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 700, margin: '0 auto 8px',
            }}>
              {initials}
            </div>
          )}
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
            {user?.displayName || user?.username}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            {t('lockScreen.subtitle')}
          </div>
        </div>

        {/* Unlock form */}
        <form onSubmit={handleUnlock} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder={t('lockScreen.passwordPlaceholder')}
            disabled={unlocking}
            style={{
              width: '100%', padding: '10px 12px',
              background: 'var(--bg-secondary)', border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 8, color: 'var(--text-primary)', fontSize: 14,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', textAlign: 'center' }}>{error}</div>
          )}
          <button
            type="submit"
            disabled={unlocking || !password.trim()}
            style={{
              width: '100%', padding: '10px 0',
              background: 'var(--accent)', color: 'var(--accent-text)', border: 'none',
              borderRadius: 8, fontWeight: 600, fontSize: 14,
              cursor: unlocking ? 'not-allowed' : 'pointer',
              opacity: unlocking ? 0.7 : 1,
            }}
          >
            {unlocking ? t('lockScreen.unlocking') : t('lockScreen.unlockButton')}
          </button>
        </form>

        {/* Sign out */}
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          style={{
            background: 'none', border: 'none',
            color: 'var(--text-tertiary)', fontSize: 13,
            cursor: signingOut ? 'not-allowed' : 'pointer',
            padding: 0, opacity: signingOut ? 0.5 : 1,
          }}
        >
          {signingOut ? t('lockScreen.signingOut') : t('lockScreen.signOut')}
        </button>
      </div>
    </div>
  );
}
