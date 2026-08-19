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
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
        <path d="M19 14l.7 2L22 17l-2.3 1-.7 2-.7-2-2.3-1 2.3-1 .7-2z" />
      </svg>
      {pct != null ? `${pct}%` : t('spam.badgeLabel')}
    </button>
  );
}