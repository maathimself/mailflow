import { useTranslation } from 'react-i18next';
import { buildInboxGtdIndicators } from '../utils/gtd.js';

export default function GtdInboxIndicators({ message }) {
  const { t } = useTranslation();
  const indicators = buildInboxGtdIndicators(message, t);
  if (indicators.length === 0) return null;

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      minWidth: 0, overflow: 'hidden',
    }}>
      {indicators.map(indicator => (
        <span key={indicator.state} style={{
          color: indicator.color,
          background: indicator.background,
          borderRadius: 7,
          padding: '0 5px',
          fontSize: 10,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {indicator.label}
        </span>
      ))}
    </span>
  );
}
