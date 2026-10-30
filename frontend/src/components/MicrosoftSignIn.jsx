import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MicrosoftDeviceCode, { SignInResult } from './MicrosoftDeviceCode.jsx';
import { OUTLOOK_WEB_URL } from '../utils/accountErrors.js';

// "Sign in with Microsoft" inside Add account. Personal accounts (Outlook.com, Hotmail, Live,
// MSN) use the device-code sign-in. Work and school accounts use Microsoft's own page
// (redirect) when the instance's app has a secret and redirect URI, with the code as the
// alternative; otherwise the code.
//
// status: GET /api/integrations/status's microsoft entry. onDone after the outcome; onCancel
// to go back.
export default function MicrosoftSignIn({ mode, status, onSignedIn, onDone, onCancel }) {
  const { t } = useTranslation();
  // Microsoft's page is the main path whenever the instance's own app signs this kind of
  // account in with a secret and redirect URI: such an app may not allow the device code
  // ("Allow public client flows" off, AADSTS7000218). The code stays as the alternative.
  const redirectAvailable = mode === 'work' ? !!status?.workRedirect : !!status?.personalRedirect;
  const [useCode, setUseCode] = useState(!redirectAvailable);
  const [redirect, setRedirect] = useState(null); // null | 'waiting' | { result } | { error }
  const [deviceStatus, setDeviceStatus] = useState(null);
  // Once there is an outcome, the Outlook.com note would only repeat it.
  const finished = ['done', 'lost'].includes(deviceStatus) || !!redirect?.result;
  // Which app signs personal accounts in: MailFlow's shared one shows Microsoft's unverified notice.
  const sharedApp = mode === 'personal' && status?.personalVia === 'shared';

  useEffect(() => {
    if (useCode) return undefined;
    const handle = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'oauth_success' && e.data?.provider === 'microsoft') {
        const result = { accountId: e.data.accountId, email: e.data.email, connection: e.data.connection || 'connecting', code: e.data.code, error: e.data.detail };
        setRedirect({ result });
        onSignedIn?.(result);
      } else if (e.data?.type === 'oauth_error') {
        setRedirect({ error: e.data.error });
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [useCode]); // eslint-disable-line react-hooks/exhaustive-deps -- one listener per mode

  const openMicrosoft = () => {
    setRedirect('waiting');
    // A real anchor click, as for the other OAuth sign-ins: window.open is intercepted by some
    // browser extensions.
    const a = document.createElement('a');
    a.href = '/oauth/microsoft';
    a.target = '_blank';
    a.rel = 'opener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const box = { padding: '12px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5 };
  const primary = { padding: '8px 16px', background: 'var(--accent)', border: 'none', borderRadius: 8, color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500 };
  const link = { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 14 }}>
        {t(mode === 'work' ? 'msSignIn.titleWork' : 'msSignIn.titlePersonal')}
      </div>

      {mode === 'personal' && !finished && (
        <div style={{ ...box, background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', marginBottom: 14 }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('msSignIn.beforeTitle')}</div>
          <div style={{ color: 'var(--text-secondary)' }}>{t('msSignIn.beforeBody')}</div>
          <ol style={{ margin: '6px 0 8px', paddingLeft: 20, listStyle: 'decimal', color: 'var(--text-secondary)' }}>
            <li>{t('accountErrors.imapOffPersonal.step1')}</li>
            <li>{t('accountErrors.imapOffPersonal.step2')}</li>
            <li>{t('accountErrors.imapOffPersonal.step3')}</li>
          </ol>
          <a href={OUTLOOK_WEB_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 500 }}>
            {t('accountErrors.action.openOutlook')}
          </a>
        </div>
      )}

      {useCode ? (
        <MicrosoftDeviceCode kind={mode} onSignedIn={onSignedIn} onDone={onDone} onCancel={onCancel} onStatus={setDeviceStatus} />
      ) : (
        <div style={{ padding: 14, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          {redirect?.result ? (
            <SignInResult result={redirect.result} onSignedIn={onSignedIn} onDone={onDone} onSignInAgain={() => setRedirect(null)} />
          ) : (
            <>
              {redirect?.error && (
                <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10, overflowWrap: 'anywhere' }}>
                  {t('msSignIn.error')} {redirect.error}
                </div>
              )}
              {redirect === 'waiting' && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{t('msSignIn.redirectWaiting')}</div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" onClick={openMicrosoft} style={primary}>{t('msSignIn.continueMicrosoft')}</button>
                <button type="button" onClick={onCancel} style={{ ...primary, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                  {t('common.cancel')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {redirectAvailable && !redirect?.result && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => { setUseCode(c => !c); setRedirect(null); }} style={link}>
            {t(useCode ? 'msSignIn.useRedirect' : 'msSignIn.useCode')}
          </button>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {t(sharedApp ? 'msSignIn.finePrintShared' : 'msSignIn.finePrintOwn')}
      </div>
    </div>
  );
}
