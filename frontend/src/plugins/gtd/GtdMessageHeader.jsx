import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getGtdMetadata, subscribeGtdMetadata, getGtdMetadataClock, subscribeGtdMetadataClock } from './metadataStore.js';
import { buildInboxGtdIndicators } from './indicators.js';

export default function GtdMessageHeader({ message }) {
  const { t } = useTranslation();
  const metadata = useSyncExternalStore(subscribeGtdMetadata, () => getGtdMetadata(message.id), () => null);
  const now = useSyncExternalStore(subscribeGtdMetadataClock, getGtdMetadataClock);
  const indicators = buildInboxGtdIndicators(metadata, t, now);
  if (!indicators.length) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginLeft: 'auto', minWidth: 0, maxWidth: '100%' }}>
      {indicators.map(indicator => (
        <span key={indicator.state} role="img" title={indicator.title} aria-label={indicator.title} style={{
          color: indicator.color, background: indicator.background, borderRadius: 7,
          padding: '2px 6px', fontSize: 11, fontWeight: 600, overflowWrap: 'anywhere',
        }}>
          {t(`gtd.state.${indicator.state}`)}
        </span>
      ))}
    </span>
  );
}
