import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { delegationPillData } from './delegation.js';
import { getGtdMetadata, subscribeGtdMetadata } from './metadataStore.js';

export default function DelegatePill({ message }) {
  const { t } = useTranslation();
  const metadata = useSyncExternalStore(
    subscribeGtdMetadata,
    () => getGtdMetadata(message.id),
    () => null,
  );
  const delegation = message.delegation || metadata?.delegation;
  const data = delegationPillData(delegation);
  if (!data) return null;
  const age = data.days == null ? '' : ` · ${data.days}d`;
  return (
    <span
      title={data.email || data.label}
      aria-label={t('gtd.delegate.pillAria', {
        name: data.label,
        days: data.days ?? 0,
        count: data.days ?? 0,
      })}
      style={{
        display: 'inline-flex', alignItems: 'center', maxWidth: 150, padding: '0 6px',
        borderRadius: 7, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', color: '#E08B3D',
        background: 'rgba(224,139,61,0.15)', flexShrink: 0,
      }}
    >
      {data.label}{age}
    </span>
  );
}
