import { useTranslation } from 'react-i18next';
import { delegateLabel, delegateTooltip } from '../utils/delegation.js';

export default function DelegatePill({ delegation, compact = false }) {
  const { t } = useTranslation();
  const label = delegateLabel(delegation);
  if (!label) return null;
  return (
    <span
      className={`delegate-pill${compact ? ' delegate-pill--compact' : ''}`}
      title={delegateTooltip(delegation)}
      aria-label={t('gtd.delegate.assignedTo', { name: label })}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="m16 11 2 2 4-4"/>
      </svg>
      <span className="delegate-pill__text">{label}</span>
    </span>
  );
}
