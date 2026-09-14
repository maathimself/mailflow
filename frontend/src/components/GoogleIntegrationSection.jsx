import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  REDACTED_CLIENT_SECRET,
  buildGoogleConnectUrl,
  buildGoogleRedirectUri,
  resolveClientSecretForSave,
  secretFieldOnBlur,
  secretFieldOnFocus,
} from '../utils/googleOAuth.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';
import ConfirmOverlay from './ConfirmOverlay.jsx';

const EMPTY_FORM = { clientId: '', clientSecret: '', redirectUri: '' };

const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
};

const noteBoxStyle = {
  padding: '12px 14px', borderRadius: 8, marginBottom: 16,
  background: 'rgba(124,106,247,0.06)',
  border: '1px solid rgba(124,106,247,0.15)',
  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
};

function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {label} {required && <span style={{ color: 'var(--red)' }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function GoogleIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

// Opens the server-side Google consent flow in a new tab (see utils/oauthWindow.js).
export function openGoogleOAuth({ loginHint } = {}) {
  openOAuthWindow(buildGoogleConnectUrl({ loginHint }));
}

// Google (Gmail) OAuth card for Settings → Integrations. Admins configure the
// Google client; any authenticated user can connect a Gmail mailbox once the
// server reports google.configured. The callback result itself is announced by
// MailApp, which is mounted for both popup and same-tab flows.
export default function GoogleIntegrationSection({ isAdmin }) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(false);
  const [hasStoredConfig, setHasStoredConfig] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState(null); // { tone: 'ok' | 'error', key }
  const [confirmDialog, setConfirmDialog] = useState(null);
  // True while the focused secret field was cleared from the redacted placeholder.
  const secretWasRedacted = useRef(false);

  const suggestedRedirectUri = buildGoogleRedirectUri(window.location);

  const refreshStatus = () => api.getIntegrationsStatus()
    .then(data => {
      const isConfigured = data?.google?.configured === true;
      setConfigured(isConfigured);
      return isConfigured;
    })
    .catch(() => { setConfigured(false); return false; });

  useEffect(() => {
    refreshStatus().then(isConfigured => { if (isConfigured) setExpanded(true); });
    if (isAdmin) {
      api.getIntegrations()
        .then(data => {
          const google = data?.google;
          if (google) {
            setHasStoredConfig(true);
            setExpanded(true);
          }
          setForm({
            clientId: google?.clientId || '',
            clientSecret: google?.clientSecret || '',
            redirectUri: google?.redirectUri || suggestedRedirectUri,
          });
        })
        .catch(() => setForm(f => ({ ...f, redirectUri: f.redirectUri || suggestedRedirectUri })));
    }

    // The popup result is announced by MailApp; here we only stop the spinner.
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data?.type === 'oauth_success' || e.data?.type === 'oauth_error') && e.data?.provider === 'google') {
        setConnecting(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps -- load once per role; refreshStatus/suggestedRedirectUri are stable for the page

  const handleSave = async () => {
    const clientId = form.clientId.trim();
    const redirectUri = form.redirectUri.trim();
    // google.configured needs all three values; an unchanged redacted secret keeps the stored one.
    const secret = resolveClientSecretForSave(form.clientSecret);
    if (!clientId || !redirectUri || (!secret.ok && secret.reason === 'required')) {
      setNotice({ tone: 'error', key: 'admin.integrations.google.requiredFields' });
      return;
    }
    if (!secret.ok) {
      setNotice({ tone: 'error', key: 'admin.integrations.google.clientSecretInvalid' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await api.saveIntegration('google', { clientId, clientSecret: secret.value, redirectUri });
      // Never keep a typed secret in state after save; show only that one is stored.
      setForm({ clientId, clientSecret: REDACTED_CLIENT_SECRET, redirectUri });
      setHasStoredConfig(true);
      await refreshStatus();
      setNotice({ tone: 'ok', key: 'admin.integrations.google.savedNote' });
    } catch {
      setNotice({ tone: 'error', key: 'admin.integrations.google.saveError' });
    } finally {
      setSaving(false);
    }
  };

  const removeConfig = async () => {
    setRemoving(true);
    setNotice(null);
    try {
      await api.deleteIntegration('google');
    } catch {
      // Rethrow a localized message so the confirm dialog stays open and shows it.
      throw new Error(t('admin.integrations.google.removeError'));
    } finally {
      setRemoving(false);
    }
    setForm({ ...EMPTY_FORM, redirectUri: suggestedRedirectUri });
    setHasStoredConfig(false);
    await refreshStatus();
    setNotice({ tone: 'ok', key: 'admin.integrations.google.removedNote' });
  };

  const handleRemove = () => {
    setConfirmDialog({
      title: t('admin.integrations.google.title'),
      message: t('admin.integrations.google.removeConfirm'),
      confirmLabel: t('admin.integrations.google.remove'),
      onConfirm: removeConfig,
    });
  };

  const handleConnect = () => {
    if (!configured) return;
    setConnecting(true);
    openGoogleOAuth();
    setTimeout(() => setConnecting(false), 5000);
  };

  const focusBorder = {
    onFocus: e => { e.target.style.borderColor = 'var(--accent)'; },
    onBlur: e => { e.target.style.borderColor = 'var(--border)'; },
  };

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 16px', display: 'flex', alignItems: 'center',
          gap: 12, cursor: 'pointer', background: 'var(--bg-tertiary)',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
      >
        <GoogleIcon />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
            {t('admin.integrations.google.title')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>
            {t('admin.integrations.google.description')}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {configured ? (
            <span style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 20,
              background: 'rgba(74,222,128,0.1)', color: 'var(--green)',
              border: '1px solid rgba(74,222,128,0.2)', fontWeight: 500,
            }}>
              {t('admin.integrations.google.configured')}
            </span>
          ) : (
            <span style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 20,
              background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
              border: '1px solid var(--border)',
            }}>
              {t('admin.integrations.google.notConfigured')}
            </span>
          )}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="var(--text-tertiary)" strokeWidth="2"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>

      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />

      {expanded && (
        <div style={{ padding: '16px', borderTop: '1px solid var(--border-subtle)' }}>
          {isAdmin && (<>
            <div style={{ ...noteBoxStyle, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
                {t('admin.integrations.google.setupTitle')}
              </div>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>{t('admin.integrations.google.step1')}</li>
                <li>{t('admin.integrations.google.step2')}</li>
                <li>{t('admin.integrations.google.step3')}</li>
                <li>{t('admin.integrations.google.step4')}</li>
                <li>{t('admin.integrations.google.step5')}</li>
              </ol>
            </div>

            <Field label={t('admin.integrations.google.clientId')} required>
              <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                placeholder={t('admin.integrations.google.clientIdPh')}
                style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                {...focusBorder} />
            </Field>

            <Field label={t('admin.integrations.google.clientSecret')} required>
              {/* Focusing clears the redacted placeholder (selecting it is unreliable and typing
                  could append to it); leaving the field empty restores it and keeps the stored secret. */}
              <input type="password" autoComplete="new-password" value={form.clientSecret}
                onChange={e => setForm(f => ({ ...f, clientSecret: e.target.value }))}
                onFocus={e => {
                  focusBorder.onFocus(e);
                  const next = secretFieldOnFocus(form.clientSecret);
                  secretWasRedacted.current = next.wasRedacted;
                  if (next.wasRedacted) setForm(f => ({ ...f, clientSecret: next.value }));
                }}
                onBlur={e => {
                  focusBorder.onBlur(e);
                  const restored = secretFieldOnBlur(form.clientSecret, secretWasRedacted.current);
                  secretWasRedacted.current = false;
                  if (restored !== form.clientSecret) setForm(f => ({ ...f, clientSecret: restored }));
                }}
                placeholder={t('admin.integrations.google.clientSecretPh')}
                style={inputStyle} />
              {hasStoredConfig && (form.clientSecret === REDACTED_CLIENT_SECRET || (secretWasRedacted.current && form.clientSecret === '')) && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                  {t('admin.integrations.google.clientSecretStoredNote')}
                </div>
              )}
            </Field>

            <Field label={t('admin.integrations.google.redirectUri')} required>
              <input value={form.redirectUri}
                onChange={e => setForm(f => ({ ...f, redirectUri: e.target.value }))}
                placeholder={suggestedRedirectUri}
                style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                {...focusBorder} />
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                {t('admin.integrations.google.redirectUriNote', { uri: suggestedRedirectUri })}
              </div>
            </Field>
          </>)}

          {!configured && (
            <div style={noteBoxStyle}>
              {isAdmin
                ? t('admin.integrations.google.notConfiguredAdminNote')
                : t('admin.integrations.google.userNoteNotConfigured')}
            </div>
          )}
          {configured && !isAdmin && (
            <div style={noteBoxStyle}>{t('admin.integrations.google.userNoteConfigured')}</div>
          )}

          {notice && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
              background: notice.tone === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(74,222,128,0.1)',
              border: `1px solid ${notice.tone === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.2)'}`,
              color: notice.tone === 'error' ? 'var(--red)' : 'var(--green)',
            }}>
              {t(notice.key)}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isAdmin && (
              <button onClick={handleSave} disabled={saving} style={{
                padding: '9px 16px', background: 'var(--bg-elevated)',
                border: '1px solid var(--border)', borderRadius: 8,
                color: 'var(--text-primary)', cursor: saving ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 500, opacity: saving ? 0.7 : 1,
              }}>
                {saving ? t('common.saving') : t('admin.integrations.google.save')}
              </button>
            )}

            <button
              onClick={handleConnect}
              disabled={!configured || connecting}
              title={!configured ? t('admin.integrations.google.notConfigured') : ''}
              style={{
                padding: '9px 16px', background: configured ? 'var(--accent)' : 'var(--bg-elevated)',
                border: `1px solid ${configured ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8, color: configured ? 'white' : 'var(--text-tertiary)',
                cursor: configured && !connecting ? 'pointer' : 'not-allowed',
                fontSize: 13, fontWeight: 500,
                opacity: !configured || connecting ? 0.6 : 1,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <GoogleIcon size={14} />
              {connecting ? t('admin.integrations.google.redirecting') : t('admin.integrations.google.connect')}
            </button>

            {/* DELETE also clears env-provided values, so offer it for env-only setups too. */}
            {isAdmin && (hasStoredConfig || configured) && (
              <button onClick={handleRemove} disabled={removing} style={{
                padding: '9px 12px', background: 'transparent',
                border: '1px solid transparent', borderRadius: 8,
                color: 'var(--text-tertiary)', cursor: removing ? 'not-allowed' : 'pointer', fontSize: 13,
                marginLeft: 'auto', opacity: removing ? 0.6 : 1,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}
              >
                {t('admin.integrations.google.remove')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
