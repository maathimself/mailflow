import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import LogoMark from './LogoMark.jsx';

export default function LoginPage() {
  const { t } = useTranslation();
  const { setUser, loadPreferences } = useStore();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(null); // null = loading
  const [inviteToken, setInviteToken] = useState(null);
  const [inviteEmail, setInviteEmail] = useState(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [oidcProviders, setOidcProviders] = useState([]);
  const [oidcError, setOidcError] = useState('');

  useEffect(() => {
    // Check for invite token in URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('invite');
    if (token) {
      api.validateInvite(token)
        .then(data => {
          setInviteToken(token);
          setInviteEmail(data.email);
          setMode('register');
          window.history.replaceState({}, '', '/register?invite=' + token);
        })
        .catch(() => {
          setError(t('login.inviteExpired'));
        });
    }

    // Check if open registration is enabled
    api.getRegistrationStatus()
      .then(data => setRegistrationOpen(data.open))
      .catch(() => setRegistrationOpen(true)); // fail open if unreachable

    // Load SSO providers
    api.oidc.getProviders()
      .then(data => setOidcProviders(data.providers || []))
      .catch(() => {});

    // Show any SSO error from a redirect callback
    const oidcErrParam = new URLSearchParams(window.location.search).get('oidc_error');
    if (oidcErrParam) {
      setOidcError(oidcErrParam);
      window.history.replaceState({}, '', '/');
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setError('');
    try {
      let data;
      if (mode === 'login') {
        data = await api.login(username, password);
        if (data.requiresTOTP) {
          setTotpRequired(true);
          setLoading(false);
          return;
        }
      } else {
        data = await api.register(username, password, inviteToken || undefined);
      }
      setUser(data.user);
      await loadPreferences();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submitTotp = async (e) => {
    e.preventDefault();
    if (!totpCode.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.totp.challenge(totpCode.trim());
      setUser(data.user);
      await loadPreferences();
    } catch (err) {
      setError(err.message);
      setTotpCode('');
    } finally {
      setLoading(false);
    }
  };

  const canRegister = registrationOpen || inviteToken;
  const showToggle = mode === 'login' ? canRegister : true;

  return (
    <div style={{
      minHeight: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg-primary)',
      padding: 24,
    }}>
      {/* Background decoration */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute', top: '-20%', left: '60%',
          width: 600, height: 600, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,106,247,0.08) 0%, transparent 70%)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', left: '-10%',
          width: 400, height: 400, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,106,247,0.05) 0%, transparent 70%)',
        }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 380 }}>
        {/* Logo */}
        <div style={{ marginBottom: 40, textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <LogoMark size={44} />
            <span style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Mail</span>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 600, color: 'var(--accent)', letterSpacing: '-0.03em' }}>Flow</span>
            </span>
          </div>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 14, margin: 0 }}>{t('login.tagline')}</p>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 16, padding: 32,
        }}>
          {totpRequired ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: 'var(--bg-tertiary)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.75">
                    <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>
                    <circle cx="12" cy="16" r="1" fill="var(--accent)" stroke="none"/>
                  </svg>
                </div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {t('login.totp.title')}
                </h2>
              </div>
              <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-tertiary)' }}>
                {t('login.totp.instructions')}
              </p>
              <form onSubmit={submitTotp} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                  placeholder={t('login.totp.placeholder')}
                  style={{
                    width: '100%', padding: '12px 14px',
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                    borderRadius: 8, color: 'var(--text-primary)', fontSize: 22,
                    letterSpacing: '0.3em', textAlign: 'center',
                    outline: 'none', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums',
                  }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                {error && (
                  <div style={{
                    padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
                    border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
                    color: 'var(--red)', fontSize: 13,
                  }}>{error}</div>
                )}
                <button
                  type="submit"
                  disabled={loading || totpCode.length !== 6}
                  style={{
                    padding: '11px 24px', background: 'var(--accent)',
                    border: 'none', borderRadius: 8, color: 'white',
                    fontSize: 14, fontWeight: 500, cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading || totpCode.length !== 6 ? 0.6 : 1, marginTop: 4,
                  }}
                >
                  {loading ? t('login.totp.verifying') : t('login.totp.verify')}
                </button>
                <button
                  type="button"
                  onClick={() => { setTotpRequired(false); setTotpCode(''); setError(''); }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-tertiary)',
                    fontSize: 13, cursor: 'pointer', padding: 0,
                  }}
                >
                  {t('login.totp.backToLogin')}
                </button>
              </form>
            </>
          ) : (
          <>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' }}>
            {mode === 'login' ? t('login.signIn') : t('login.createAccount')}
          </h2>
          {mode === 'register' && inviteEmail && (
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-tertiary)' }}>
              {t('login.inviteEmail')} <span style={{ color: 'var(--text-secondary)' }}>{inviteEmail}</span>
            </p>
          )}
          {mode === 'register' && !inviteEmail && (
            <p style={{ margin: '0 0 20px' }} />
          )}
          {mode === 'login' && (
            <p style={{ margin: '0 0 20px' }} />
          )}

          {oidcError && (
            <div style={{
              marginBottom: 16, padding: '10px 14px',
              background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 8, color: 'var(--red)', fontSize: 13,
            }}>{oidcError}</div>
          )}

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {t('login.username')}
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
                style={{
                  width: '100%', padding: '10px 14px',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text-primary)', fontSize: 14,
                  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {t('login.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={{
                  width: '100%', padding: '10px 14px',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text-primary)', fontSize: 14,
                  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>

            {error && (
              <div style={{
                padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
                border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
                color: 'var(--red)', fontSize: 13,
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !password}
              style={{
                padding: '11px 24px', background: 'var(--accent)',
                border: 'none', borderRadius: 8, color: 'white',
                fontSize: 14, fontWeight: 500, cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading || !username || !password ? 0.6 : 1,
                transition: 'opacity 0.15s, transform 0.1s', marginTop: 4,
              }}
              onMouseDown={e => e.target.style.transform = 'scale(0.98)'}
              onMouseUp={e => e.target.style.transform = 'scale(1)'}
            >
              {loading ? t('login.pleaseWait') : (mode === 'login' ? t('login.signIn') : t('login.createAccount'))}
            </button>
          </form>

          {mode === 'login' && oidcProviders.length > 0 && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 16px',
              }}>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{t('login.orContinueWith')}</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {oidcProviders.map(p => (
                  <a
                    key={p.id}
                    href={`/auth/oidc/${p.slug}/start`}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      padding: '10px 16px',
                      background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                      borderRadius: 8, color: 'var(--text-primary)', fontSize: 14,
                      fontWeight: 500, textDecoration: 'none',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
                    </svg>
                    {t('login.signInWith', { name: p.name })}
                  </a>
                ))}
              </div>
            </>
          )}
          </>
          )}
        </div>

        {!totpRequired && showToggle && (
          <p style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>
            {mode === 'login' ? t('login.dontHaveAccount') : t('login.alreadyHaveAccount')}
            <button
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              style={{
                background: 'none', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', fontSize: 13, padding: 0,
              }}
            >
              {mode === 'login' ? t('login.register') : t('login.signIn')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
