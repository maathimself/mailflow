import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { detectProvider } from '../utils/providerDetect.js';

// The first step of Add account: type an address and continue, or pick a provider. A personal
// Microsoft address goes straight to "Sign in with Microsoft"; Gmail, Yahoo and iCloud to their
// presets; anything else to the IMAP form.
//
// status: GET /api/integrations/status's microsoft entry (null while loading).
// onChoose(choice, email): choice is microsoftPersonal | microsoftWork | gmail | yahoo | icloud | other.
export function microsoftAvailability(status) {
  return {
    personal: !!status?.personalAccounts,
    work: !!status?.workAccounts,
  };
}

const MicrosoftLogo = () => (
  <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
  </svg>
);
const MailIcon = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.75" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2 7 12 14 22 7"/>
  </svg>
);
const ServerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.75" aria-hidden="true">
    <rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/>
    <line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>
  </svg>
);

// googleStatus: the status's google entry; with signIn, the Gmail tile signs in on Google's page.
export default function AddAccountChooser({ status, googleStatus, isAdmin, onChoose, onOpenSettings }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const available = microsoftAvailability(status);
  const loading = status == null;

  const tiles = [
    { id: 'microsoftPersonal', name: t('addAccount.tile.outlook'), sub: t('addAccount.tile.outlookSub'), icon: <MicrosoftLogo />,
      disabled: !loading && !available.personal, reason: t('addAccount.personalOff') },
    { id: 'microsoftWork', name: t('addAccount.tile.work'), sub: t('addAccount.tile.workSub'), icon: <MicrosoftLogo />,
      disabled: !loading && !available.work, reason: t('addAccount.workOff') },
    { id: 'gmail', name: t('addAccount.tile.gmail'), sub: googleStatus?.signIn ? t('addAccount.tile.gmailSignIn') : t('addAccount.tile.gmailSub'), icon: <MailIcon color="#ea4335" /> },
    { id: 'yahoo', name: t('addAccount.tile.yahoo'), sub: t('addAccount.tile.yahooSub'), icon: <MailIcon color="#6001d2" /> },
    { id: 'icloud', name: t('addAccount.tile.icloud'), sub: t('addAccount.tile.icloudSub'), icon: <MailIcon color="#3693f3" /> },
    { id: 'other', name: t('addAccount.tile.other'), sub: t('addAccount.tile.otherSub'), icon: <ServerIcon /> },
  ];

  const submit = (e) => {
    e.preventDefault();
    const provider = detectProvider(email);
    if (!provider) { setNotice(t('addAccount.invalidEmail')); return; }
    if (provider === 'microsoftPersonal' && !loading && !available.personal) { setNotice(t('addAccount.personalOff')); return; }
    setNotice('');
    onChoose(provider, email.trim());
  };

  const inputStyle = {
    flex: '1 1 220px', minWidth: 0, padding: '9px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>{t('addAccount.title')}</div>

      <form onSubmit={submit} noValidate>
        <label htmlFor="add-account-email" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          {t('addAccount.emailLabel')}
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input id="add-account-email" type="email" autoComplete="email" value={email}
            onChange={e => { setEmail(e.target.value); setNotice(''); }}
            placeholder={t('admin.accounts.emailPh')} style={inputStyle} />
          <button type="submit" style={{
            padding: '9px 18px', background: 'var(--accent)', border: 'none', borderRadius: 8,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>{t('addAccount.continue')}</button>
        </div>
        {notice && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{notice}</div>}
      </form>

      <div style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '22px 0 10px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {t('addAccount.orChoose')}
      </div>
      {/* gridAutoRows 1fr: every tile the height of the tallest, so rows line up however the
          names wrap. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gridAutoRows: '1fr', gap: 10 }}>
        {tiles.map(tile => (
          <div key={tile.id} data-tile={tile.id} style={{ display: 'flex' }}>
            {/* aria-disabled, not disabled: a tile that is off stays focusable, so keyboard and
                screen reader users reach the reason it gives. */}
            <button type="button" aria-disabled={tile.disabled ? 'true' : undefined}
              aria-describedby={`tile-${tile.id}-detail`}
              onClick={() => { if (!tile.disabled) onChoose(tile.id, email.trim()); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', width: '100%', flex: 1,
                padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)',
                background: 'var(--bg-tertiary)', cursor: tile.disabled ? 'not-allowed' : 'pointer',
                opacity: tile.disabled ? 0.55 : 1, color: 'var(--text-primary)',
              }}>
              <span style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, borderRadius: 8, background: 'var(--bg-secondary)',
              }}>{tile.icon}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{tile.name}</span>
                <span id={`tile-${tile.id}-detail`} style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {tile.disabled ? tile.reason : tile.sub}
                </span>
              </span>
            </button>
          </div>
        ))}
      </div>
      {/* One link under the grid rather than one under each tile that is off, which made that
          tile's row taller than the rest. */}
      {isAdmin && onOpenSettings && tiles.some(tile => tile.disabled) && (
        <button type="button" onClick={onOpenSettings} style={{
          marginTop: 10, background: 'none', border: 'none', padding: '2px 0',
          color: 'var(--accent)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
        }}>{t('addAccount.openSettings')}</button>
      )}
    </div>
  );
}
