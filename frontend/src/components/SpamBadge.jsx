import { useTranslation } from 'react-i18next';

// Auto-spam badge shown next to a message subject when the classifier (not
// the user) flagged it as spam. Clicking opens the explain modal.
// Hidden when the user manually overrode the verdict (spam_user_override) —
// that's the user's own intent, not auto-classification.

export default function SpamBadge({ message, onClick }) {
  const { t } = useTranslation();
  const isAuto = message?.spam_verdict === 'spam' && !message?.spam_user_override;
  if (!isAuto) return null;

  const pct = message?.spam_score_ml != null
    ? Math.round((Number(message.spam_score_ml) || 0) * 100)
    : null;

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(message); }}
      title={t('spam.badgeTitle')}
      style={{
        flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', gap: 3,
        marginLeft: 6, padding: '2px 6px', borderRadius: 6,
        background: 'var(--danger-dim, rgba(220,38,38,.14))',
        color: 'var(--danger, #dc2626)',
        border: 'none', cursor: 'pointer',
        fontSize: 10.5, fontWeight: 600, lineHeight: 1.4,
        verticalAlign: 'middle',
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 14.8 7.2 17.6l.9-5.4L4.2 8.4l5.4-.8L12 2z" />
      </svg>
      <span>{t('spam.badgeLabel')}</span>
      {pct != null ? ` ${pct}%` : null}
    </button>
  );
}