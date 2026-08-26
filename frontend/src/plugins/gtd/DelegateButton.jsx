import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';
import { runDelegation } from './delegation.js';

export default function DelegateButton({ message }) {
  const { t } = useTranslation();
  const addNotification = useStore(state => state.addNotification);
  const scheduleGtdSectionsFetch = useStore(state => state.scheduleGtdSectionsFetch);
  const delegate = () => void runDelegation([message.id], {
    api, store: { addNotification, scheduleGtdSectionsFetch }, t,
  });
  return (
    <button type="button" onClick={delegate} title={t('gtd.delegate.button')} aria-label={t('gtd.delegate.button')} style={{
      border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
      padding: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0114 0v2"/><path d="M19 8v6M16 11h6"/>
      </svg>
    </button>
  );
}
