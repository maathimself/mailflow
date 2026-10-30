import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import AccountErrorCallout from './AccountErrorCallout.jsx';

// Microsoft's device-code sign-in, start to finish: the code to enter on Microsoft's page,
// then "checking" while the server waits for the mailbox to accept the first login, then the
// outcome. Starts as soon as it mounts; unmounting stops it.
//
// accountId: sign in again for that account. The server then refuses a different address
// (status 'wrong_account') instead of adding a second account.
// onSignedIn(result) runs once the server has stored the sign-in, whatever the connection did:
//   result = { accountId, email, connection: 'connected' | 'connecting' | 'failed', code, error }
// onDone runs from the Done button after an outcome; onCancel from Cancel before one.
// kind ('personal' | 'work') picks the app a new account signs in through. onStatus(status)
// reports each step, for the page around it.
export default function MicrosoftDeviceCode({ accountId = null, kind, onSignedIn, onDone, onCancel, onStatus }) {
  const { t } = useTranslation();
  // starting | pending | checking | done | declined | expired | error | wrong_account
  const [status, setStatus] = useState('starting');
  const [flow, setFlow] = useState(null); // { userCode, verificationUri, interval }
  const [result, setResult] = useState(null); // the final poll answer, or a retry's
  const [wrong, setWrong] = useState(null);
  const [errorText, setErrorText] = useState('');
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signedInRef = useRef(onSignedIn);
  signedInRef.current = onSignedIn;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  useEffect(() => { statusRef.current?.(status); }, [status]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    setStatus('starting');
    setFlow(null);
    setResult(null);
    setWrong(null);
    setErrorText('');
    // One poll at a time: after Microsoft approves, the server holds the poll while it waits
    // for the mailbox, so a fixed interval would overlap requests.
    const poll = async (intervalMs) => {
      if (cancelled) return;
      let answer;
      try {
        answer = await api.pollMsDeviceFlow();
      } catch (err) {
        if (!cancelled) { setStatus('error'); setErrorText(err?.message || ''); }
        return;
      }
      if (cancelled) return;
      if (answer.status === 'pending') { timer = setTimeout(() => poll(intervalMs), intervalMs); return; }
      if (answer.status === 'checking') { setStatus('checking'); setResult(answer); timer = setTimeout(() => poll(intervalMs), 0); return; }
      if (answer.status === 'success') {
        setResult(answer);
        setStatus('done');
        signedInRef.current?.(answer);
        return;
      }
      if (answer.status === 'wrong_account') setWrong({ signedInAs: answer.signedInAs, expected: answer.expected });
      if (answer.status === 'error') setErrorText(answer.error || '');
      setStatus(['declined', 'expired', 'wrong_account', 'lost'].includes(answer.status) ? answer.status : 'error');
    };
    api.startMsDeviceFlow(accountId, kind).then((data) => {
      if (cancelled) return;
      setFlow(data);
      setStatus('pending');
      const intervalMs = (data.interval || 5) * 1000;
      timer = setTimeout(() => poll(intervalMs), intervalMs);
    }).catch((err) => {
      if (cancelled) return;
      setStatus('error');
      setErrorText(err?.message || '');
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, kind, attempt]);

  const copyCode = async () => {
    if (await copyToClipboard(flow?.userCode || '')) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const small = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 };
  const quiet = { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 };
  const primary = { padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500, textDecoration: 'none', display: 'inline-block' };
  const spinner = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
  );
  const ended = (message, restartKey = 'msSignIn.startOver') => (
    <div role="alert">
      <div style={{ color: 'var(--red)', fontSize: 13, lineHeight: 1.5 }}>{message}</div>
      {errorText && (
        <details style={{ marginTop: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>
          <summary style={{ cursor: 'pointer' }}>{t('accountErrors.details')}</summary>
          <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{errorText}</div>
        </details>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setAttempt(a => a + 1)} style={primary}>{t(restartKey)}</button>
        <button type="button" onClick={onCancel} style={quiet}>{t('common.cancel')}</button>
      </div>
    </div>
  );

  let content;
  if (status === 'done') {
    content = <SignInResult result={result} onSignedIn={signedInRef.current} onDone={onDone} onSignInAgain={() => setAttempt(a => a + 1)} />;
  } else if (status === 'checking') {
    content = <div role="status" style={{ ...small, display: 'flex', alignItems: 'center', gap: 6 }}>{spinner}{t('msSignIn.checking')}</div>;
  } else if (status === 'wrong_account') {
    content = ended(t('accountErrors.wrongAccount', { signedInAs: wrong?.signedInAs, expected: wrong?.expected }));
  } else if (status === 'lost') {
    // The server no longer knows this sign-in (it restarted, say). It may have finished.
    content = (
      <div role="alert">
        <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>{t('msSignIn.lost')}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {onDone && <button type="button" onClick={onDone} style={primary}>{t('msSignIn.checkAccounts')}</button>}
          <button type="button" onClick={() => setAttempt(a => a + 1)} style={quiet}>{t('msSignIn.startOver')}</button>
        </div>
      </div>
    );
  } else if (status === 'declined') {
    content = ended(t('msSignIn.declined'));
  } else if (status === 'expired') {
    content = ended(t('msSignIn.expired'), 'msSignIn.newCode');
  } else if (status === 'error') {
    content = ended(t('msSignIn.error'));
  } else if (status === 'starting') {
    content = <div style={{ ...small, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)' }}>{spinner}{t('msSignIn.starting')}</div>;
  } else {
    content = (
      <>
        <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', fontSize: 13, color: 'var(--text-primary)' }}>
          <li style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 8 }}>{t('msSignIn.step1')}</div>
            <a href={flow?.verificationUri} target="_blank" rel="noreferrer" style={primary}>{t('msSignIn.step1Button')}</a>
          </li>
          <li>
            <div style={{ marginBottom: 8 }}>{t('msSignIn.step2')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span data-device-code style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 22, fontWeight: 700,
                letterSpacing: '0.15em', color: 'var(--text-primary)',
                padding: '6px 14px', background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)', borderRadius: 6,
              }}>
                {flow?.userCode}
              </span>
              <button type="button" onClick={copyCode} style={quiet}>{copied ? t('msSignIn.copied') : t('msSignIn.copy')}</button>
            </div>
          </li>
        </ol>
        <div style={{ ...small, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 14 }}>
          {spinner}{t('msSignIn.waiting')}
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={onCancel} style={quiet}>{t('common.cancel')}</button>
        </div>
      </>
    );
  }

  return (
    <div data-sign-in-state={status === 'done' ? undefined : status} style={{
      padding: 14, borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    }}>
      {content}
    </div>
  );
}

// How a sign-in ended, once the server has waited for the mailbox: connected, still
// connecting, or refused (the account's error, with its fix and Try again).
export function SignInResult({ result, onSignedIn, onDone, onSignInAgain, provider = 'microsoft' }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(result);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { setCurrent(result); }, [result]);

  // "Try again" after the mailbox refused the first connection: reconnect and wait for it.
  const retry = async () => {
    setRetrying(true);
    try {
      const report = await api.reconnectAccount(current.accountId, { wait: true });
      const next = { ...current, connection: report.connection, code: report.code, error: report.error };
      setCurrent(next);
      if (report.connection !== 'failed') onSignedIn?.(next);
    } catch (err) {
      setCurrent(c => ({ ...c, connection: 'failed', code: 'connection', error: err?.message || '' }));
    } finally {
      setRetrying(false);
    }
  };

  const small = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 };
  const quiet = { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 };
  const primary = { padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: 'var(--accent-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500 };
  const done = (style) => (onDone ? <button type="button" onClick={onDone} style={style}>{t('msSignIn.done')}</button> : null);

  if (retrying) {
    return (
      <div role="status" data-sign-in-state="checking" style={{ ...small, display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1.5s linear infinite' }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
        {t('msSignIn.checking')}
      </div>
    );
  }
  if (current?.connection === 'connected') {
    return (
      <div role="status" data-sign-in-state="connected">
        <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 500, lineHeight: 1.5 }}>{t('msSignIn.connected', { email: current.email })}</div>
        {onDone && <div style={{ marginTop: 12 }}>{done(primary)}</div>}
      </div>
    );
  }
  if (current?.connection === 'failed') {
    return (
      <div data-sign-in-state="failed" style={{ margin: '0 -14px' }}>
        <AccountErrorCallout
          account={{ id: current.accountId, email_address: current.email, oauth_provider: provider, sync_error: current.error, sync_error_code: current.code }}
          onRetry={retry}
          onSignIn={onSignInAgain}
        />
        {onDone && <div style={{ padding: '0 14px' }}>{done(quiet)}</div>}
      </div>
    );
  }
  return (
    <div role="status" data-sign-in-state="connecting">
      <div style={{ ...small, color: 'var(--text-primary)' }}>{t('msSignIn.stillConnecting', { email: current?.email })}</div>
      {onDone && <div style={{ marginTop: 12 }}>{done(primary)}</div>}
    </div>
  );
}
