import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Shared confirm overlay (replaces window.confirm everywhere).
export default function ConfirmOverlay({ dialog, onClose }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Clear transient state whenever a different dialog is opened, so a previous
  // failure never leaks into the next confirmation.
  useEffect(() => { setBusy(false); setError(''); }, [dialog]);

  if (!dialog) return null;

  // Await the action rather than firing it into the void. This previously closed the
  // overlay and then called onConfirm() unawaited with no catch, so a rejected request
  // left no trace at all: the dialog was already gone and the rejection was unhandled.
  // Every destructive action here (delete account, delete alias, delete user, disable
  // a user's 2FA, delete an SSO provider, unlink an identity) therefore looked like it
  // had succeeded while the server had refused it. Keep the dialog open on failure so
  // the error is shown where the user is already looking; close only on success.
  const runConfirm = async () => {
    setError('');
    setBusy(true);
    try {
      await dialog.onConfirm();
      onClose();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
    }} onClick={busy ? undefined : onClose}>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, padding: '24px 24px 20px', maxWidth: 360, width: '100%',
        boxShadow: 'var(--shadow-modal)',
        animation: 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
      }} onClick={e => e.stopPropagation()}>
        <p style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {dialog.title}
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {dialog.message}
        </p>
        {error && (
          <div style={{
            marginBottom: 14, padding: '8px 10px',
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 7, color: 'var(--red)', fontSize: 12,
          }}>{t('common.error', { message: error })}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy} className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-secondary)',
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, fontSize: 13,
          }}>{t('common.cancel')}</button>
          <button onClick={runConfirm} disabled={busy} className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: 'none',
            background: '#dc2626', color: 'white',
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, fontSize: 13, fontWeight: 500,
          }}>{busy ? t('common.loading') : (dialog.confirmLabel || t('common.delete'))}</button>
        </div>
      </div>
    </div>
  );
}
