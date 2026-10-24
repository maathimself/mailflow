import { useTranslation } from 'react-i18next';
import { describeAccountError, OUTLOOK_WEB_URL } from '../utils/accountErrors.js';

// The account's connection error as something the user can act on: what happened, what to
// do, the buttons that do it, and the server's own words under Details.
export default function AccountErrorCallout({ account, isAdmin, onRetry, onSignIn, onEdit, onOpenIntegrations }) {
  const { t } = useTranslation();
  const info = describeAccountError(account);
  if (!info) return null;

  const body = info.bodyKey ? t(info.bodyKey, { email: account.email_address })
    : t(isAdmin ? info.adminBodyKey : info.userBodyKey);

  const primary = {
    padding: '6px 12px', borderRadius: 7, border: 'none', background: 'var(--accent)',
    color: 'var(--accent-text)', cursor: 'pointer', fontSize: 12, fontWeight: 500,
  };
  const secondary = {
    padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
    color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 500,
  };
  // The first action is the one that fixes it; the rest are secondary.
  const buttons = info.actions.flatMap((action, i) => {
    const style = i === 0 ? primary : secondary;
    switch (action) {
      case 'openOutlook':
        return [<a key={action} href={OUTLOOK_WEB_URL} target="_blank" rel="noreferrer" style={{ ...style, textDecoration: 'none' }}>
          {t('accountErrors.action.openOutlook')}
        </a>];
      case 'retry':
        return [<button key={action} type="button" onClick={onRetry} style={style}>{t('accountErrors.action.retry')}</button>];
      case 'signIn':
        return [<button key={action} type="button" onClick={onSignIn} style={style}>{t('accountErrors.action.signIn')}</button>];
      case 'edit':
        return [<button key={action} type="button" onClick={onEdit} style={style}>{t('accountErrors.action.edit')}</button>];
      case 'admin':
        return isAdmin && onOpenIntegrations
          ? [<button key={action} type="button" onClick={onOpenIntegrations} style={style}>{t('addAccount.openSettings')}</button>]
          : [];
      default:
        return [];
    }
  });

  return (
    <div role="alert" data-error-kind={info.kind} style={{
      margin: '0 14px 12px', padding: '12px 14px', borderRadius: 8,
      background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.3)',
      fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(info.titleKey)}</div>
      <div style={{ color: 'var(--text-secondary)' }}>{body}</div>
      {info.stepKeys.length > 0 && (
        <ol style={{ margin: '6px 0 0', paddingLeft: 20, listStyle: 'decimal', color: 'var(--text-secondary)' }}>
          {info.stepKeys.map(key => <li key={key}>{t(key)}</li>)}
        </ol>
      )}
      {info.outroKey && <div style={{ color: 'var(--text-secondary)', marginTop: 6 }}>{t(info.outroKey)}</div>}
      {buttons.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>{buttons}</div>}
      <details style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)' }}>
        <summary style={{ cursor: 'pointer' }}>{t('accountErrors.details')}</summary>
        <div style={{ marginTop: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
          {info.detail}
        </div>
      </details>
    </div>
  );
}
