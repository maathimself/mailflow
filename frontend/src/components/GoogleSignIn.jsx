import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SignInResult } from './MicrosoftDeviceCode.jsx';

// "Sign in with Google" inside Add account: Google's own page opens in a new tab, and the
// outcome comes back once the server has waited for the mailbox's first connection, as for
// Microsoft. onDone after the outcome; onCancel to go back.
export default function GoogleSignIn({ onSignedIn, onDone, onCancel }) {
  const { t } = useTranslation();
  const [state, setState] = useState(null); // null | 'waiting' | { result } | { error }

  useEffect(() => {
    const handle = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'oauth_success' && e.data?.provider === 'google') {
        const result = { accountId: e.data.accountId, email: e.data.email, connection: e.data.connection || 'connecting', code: e.data.code, error: e.data.detail };
        setState({ result });
        onSignedIn?.(result);
      } else if (e.data?.type === 'oauth_error') {
        setState({ error: e.data.error });
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- one listener for the view's life

  const openGoogle = () => {
    setState('waiting');
    // A real anchor click, as for the other sign-ins: window.open is intercepted by some
    // browser extensions.
    const a = document.createElement('a');
    a.href = '/oauth/google';
    a.target = '_blank';
    a.rel = 'opener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const primary = { padding: '8px 16px', background: 'var(--accent)', border: 'none', borderRadius: 8, color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500 };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 14 }}>{t('googleSignIn.title')}</div>
      <div data-google-sign-in style={{ padding: 14, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
        {state?.result ? (
          <SignInResult provider="google" result={state.result} onSignedIn={onSignedIn} onDone={onDone} onSignInAgain={() => setState(null)} />
        ) : (
          <>
            {state?.error && (
              <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10, overflowWrap: 'anywhere' }}>
                {t('accountErrors.signInFailed')}: {state.error}
              </div>
            )}
            {state === 'waiting' && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{t('accountErrors.signInDialog.waitingGoogle')}</div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={openGoogle} style={primary}>{t('accountErrors.signInDialog.continueGoogle')}</button>
              <button type="button" onClick={onCancel} style={{ ...primary, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
      <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>{t('googleSignIn.finePrint')}</div>
    </div>
  );
}
