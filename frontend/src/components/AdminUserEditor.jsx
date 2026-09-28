import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import PasswordInput from './PasswordInput.jsx';

// Lets an admin change another user's sign-in name, recovery email and password: the way back
// in for someone who forgot their password and never set a recovery email.
export default function AdminUserEditor({ user, isSelf, onClose, onSaved }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(user.username);
  const [recoveryEmail, setRecoveryEmail] = useState(user.recoveryEmail || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async e => {
    e.preventDefault();
    setError(null);
    if (password && password.length < 8) { setError(t('admin.users.passwordTooShort')); return; }
    if (password && password !== confirm) { setError(t('admin.users.passwordMismatch')); return; }

    const changes = {};
    const nextUsername = username.trim().toLowerCase();
    if (nextUsername !== user.username) changes.username = nextUsername;
    const nextEmail = recoveryEmail.trim().toLowerCase();
    if (nextEmail !== (user.recoveryEmail || '')) changes.recoveryEmail = nextEmail;
    if (!Object.keys(changes).length && !password) { onClose(); return; }

    setSaving(true);
    try {
      if (Object.keys(changes).length) await api.admin.updateUser(user.id, changes);
      if (password) await api.admin.setUserPassword(user.id, password);
      onSaved({ ...user, username: changes.username ?? user.username, recoveryEmail: changes.recoveryEmail ?? user.recoveryEmail });
    } catch (err) {
      const message = err?.message || '';
      setError(message === 'Username already taken' ? t('admin.users.usernameTaken')
        : message === 'Invalid email address' ? t('admin.users.invalidEmail')
          : t('admin.users.saveFailed', { message }));
    } finally {
      setSaving(false);
    }
  };

  const input = {
    width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 8, fontSize: 13,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none',
  };
  const label = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 5 };
  const hint = { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.4 };

  return createPortal(
    <div
      onClick={e => e.target === e.currentTarget && !saving && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 3000, padding: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <form
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.users.editTitle', { username: user.username })}
        autoComplete="off"
        style={{
          width: '100%', maxWidth: 420, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 14, boxShadow: 'var(--shadow-modal)', padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('admin.users.editTitle', { username: user.username })}
        </div>

        <div>
          <label style={label} htmlFor="admin-user-username">{t('admin.users.username')}</label>
          <input id="admin-user-username" style={input} value={username} autoComplete="off"
            onChange={e => setUsername(e.target.value)} />
          <div style={hint}>{t('admin.users.usernameHint')}</div>
        </div>

        <div>
          <label style={label} htmlFor="admin-user-recovery">{t('admin.users.recoveryEmail')}</label>
          <input id="admin-user-recovery" type="email" style={input} value={recoveryEmail} autoComplete="off"
            placeholder={t('admin.security.recoveryEmailPh')}
            onChange={e => setRecoveryEmail(e.target.value)} />
          <div style={hint}>{t('admin.users.recoveryEmailHint')}</div>
        </div>

        <div>
          <label style={label} htmlFor="admin-user-password">{t('admin.users.newPassword')}</label>
          {/* new-password: stops the browser filling in the admin's own saved password here. */}
          <PasswordInput id="admin-user-password" style={input} value={password} autoComplete="new-password"
            onChange={e => setPassword(e.target.value)} />
          {password && (
            <div style={{ marginTop: 8 }}>
              <PasswordInput aria-label={t('admin.users.confirmPassword')} placeholder={t('admin.users.confirmPassword')}
                style={input} value={confirm} autoComplete="new-password" onChange={e => setConfirm(e.target.value)} />
            </div>
          )}
          <div style={hint}>{isSelf ? t('admin.users.newPasswordHintSelf') : t('admin.users.newPasswordHint')}</div>
        </div>

        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onClose} disabled={saving} style={{
            padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
            background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
          }}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={saving} style={{
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, border: 'none',
            background: 'var(--accent)', color: '#fff', cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
