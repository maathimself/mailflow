import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getGtdMetadata, subscribeGtdMetadata } from './metadataStore.js';
import { buildInboxGtdIndicators } from './indicators.js';

export default function GtdInboxIndicators({ message }) {
  const { t } = useTranslation();
  const metadata = useSyncExternalStore(
    subscribeGtdMetadata,
    () => getGtdMetadata(message.id),
    () => null,
  );
  const indicators = buildInboxGtdIndicators(metadata, t);
  if (!indicators.length) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, overflow: 'hidden', flexShrink: 0 }}>
      {indicators.map(indicator => (
        <span key={indicator.state} style={{
          color: indicator.color,
          background: indicator.background,
          borderRadius: 7,
          padding: '0 5px',
          fontSize: 10,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}>
          {indicator.label}
        </span>
      ))}
    </span>
  );
}
