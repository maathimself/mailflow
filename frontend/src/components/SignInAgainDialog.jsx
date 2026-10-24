import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import MicrosoftDeviceCode, { SignInResult } from './MicrosoftDeviceCode.jsx';
import { REPAIR_FLAG } from '../utils/accountErrors.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// "Sign in again" for one account whose sign-in stopped working. The sign-in names the
// account, so signing in as a different address is refused and explained instead of adding a
// second account. Microsoft accounts connected with the device code sign in again with it;
// those connected through the instance's own app on Microsoft's page (a confidential client),
// and Google accounts, go back through the provider's page in a new tab.
export default function SignInAgainDialog({ account, onClose, onSignedIn }) {
  const { t } = useTranslation();
  // null | 'waiting' | 'success' | { result } | { signedInAs, expected } | { error }
  const [redirectState, setRedirectState] = useState(null);
  const [msRedirect, setMsRedirect] = useState(null); // null while unknown, then true or false
  const closeTimer = useRef(null);
  const dialogRef = useRef(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const provider = account?.oauth_provider;
  // A confidential Microsoft account's refresh token belongs to the instance's own app, which
  // signs in on Microsoft's page; use it when that page is set up.
  useEffect(() => {
    if (provider !== 'microsoft' || account?.oauth_public_client !== false) { setMsRedirect(false); return undefined; }
    let cancelled = false;
    api.getIntegrationsStatus()
      .then(d => { if (!cancelled) setMsRedirect(!!d?.microsoft?.workRedirect); })
      .catch(() => { if (!cancelled) setMsRedirect(false); });
    return () => { cancelled = true; };
  }, [provider, account?.oauth_public_client]);
  const redirect = provider === 'google' || (provider === 'microsoft' && msRedirect === true);

  useEffect(() => {
    if (!redirect) return undefined;
    const handle = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'oauth_success' && e.data?.provider === provider) {
        try { sessionStorage.removeItem(REPAIR_FLAG); } catch { /* storage unavailable */ }
        onSignedInRef.current?.();
        if (e.data.connection) {
          // The address as stored on the account, not the casing typed at the provider.
          setRedirectState({ result: { accountId: account.id, email: account.email_address, connection: e.data.connection, code: e.data.code, error: e.data.detail } });
        } else {
          setRedirectState('success');
          closeTimer.current = setTimeout(() => onCloseRef.current?.(), 2500);
        }
      } else if (e.data?.type === 'oauth_error' && e.data?.error === 'wrong_account') {
        try { sessionStorage.removeItem(REPAIR_FLAG); } catch { /* storage unavailable */ }
        setRedirectState({ signedInAs: e.data.signedInAs, expected: e.data.expected });
      } else if (e.data?.type === 'oauth_error') {
        try { sessionStorage.removeItem(REPAIR_FLAG); } catch { /* storage unavailable */ }
        setRedirectState({ error: e.data.error });
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [redirect, provider, account?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- callbacks are read through refs
  // The repair flag is only for the sign-in this dialog started: whatever the outcome, closing
  // the dialog ends it.
  useEffect(() => () => {
    clearTimeout(closeTimer.current);
    try { sessionStorage.removeItem(REPAIR_FLAG); } catch { /* storage unavailable */ }
  }, []);

  // Focus moves into the dialog, stays there while it is open, and returns where it was;
  // Escape closes it.
  useEffect(() => {
    const previous = document.activeElement;
    const focusables = () => [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])];
    (focusables()[0] || dialogRef.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current?.(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialogRef.current?.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  if (!account) return null;

  const openProvider = () => {
    setRedirectState('waiting');
    try { sessionStorage.setItem(REPAIR_FLAG, account.id); } catch { /* storage unavailable */ }
    // A real anchor click, as for the first connection: window.open is intercepted by some
    // browser extensions.
    const a = document.createElement('a');
    a.href = `/oauth/${provider}?accountId=${encodeURIComponent(account.id)}`;
    a.target = '_blank';
    a.rel = 'opener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const button = {
    padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--accent)',
    color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100, background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sign-in-again-title" style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 12,
        padding: '22px 22px 18px', maxWidth: 440, width: '100%', boxShadow: 'var(--shadow-modal)', outline: 'none',
      }} onClick={e => e.stopPropagation()}>
        <p id="sign-in-again-title" style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('accountErrors.signInDialog.title')}
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {t('accountErrors.signInDialog.body', { email: account.email_address })}
        </p>

        {provider === 'microsoft' && msRedirect === false && (
          <MicrosoftDeviceCode
            accountId={account.id}
            onSignedIn={() => onSignedInRef.current?.()}
            onDone={onClose}
            onCancel={onClose}
          />
        )}

        {redirect && (
          <div>
            {redirectState?.result ? (
              <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                <SignInResult provider={provider} result={redirectState.result} onSignedIn={() => onSignedInRef.current?.()} onDone={onClose} onSignInAgain={() => setRedirectState(null)} />
              </div>
            ) : redirectState === 'success' ? (
              <div role="status" style={{ color: 'var(--green)', fontSize: 13, fontWeight: 500 }}>{t('accountErrors.signInDialog.success')}</div>
            ) : redirectState?.signedInAs ? (
              <div role="alert" style={{ color: 'var(--red)', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
                {t('accountErrors.wrongAccount', { signedInAs: redirectState.signedInAs, expected: redirectState.expected })}
              </div>
            ) : redirectState?.error ? (
              <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12, overflowWrap: 'anywhere' }}>
                {t('common.error', { message: redirectState.error })}
              </div>
            ) : redirectState === 'waiting' ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
                {t(provider === 'google' ? 'accountErrors.signInDialog.waitingGoogle' : 'msSignIn.redirectWaiting')}
              </div>
            ) : null}
            {!redirectState?.result && redirectState !== 'success' && (
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={onClose} style={{ ...button, background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  {t('common.cancel')}
                </button>
                <button type="button" onClick={openProvider} style={button}>
                  {t(provider === 'google' ? 'accountErrors.signInDialog.continueGoogle' : 'msSignIn.continueMicrosoft')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
