import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import LogoMark from './LogoMark.jsx';

export default function GmailHeader({ searchRef }) {
  const { t } = useTranslation();
  const toggleSidebar = useStore(s => s.toggleSidebar);
  const setAdminTab = useStore(s => s.setAdminTab);
  const setShowAdmin = useStore(s => s.setShowAdmin);
  return <header className="gmail-header">
    <div className="gmail-brand">
      <button type="button" aria-label={t('sidebar.toggleSidebar')} title={t('sidebar.toggleSidebar')} onClick={toggleSidebar}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
      </button>
      <span className="gmail-brand-name"><LogoMark size={28} /><span>MailFlow</span></span>
    </div>
    <div className="gmail-search-slot" ref={searchRef} />
    <button type="button" className="gmail-settings" title={t('sidebar.settings')} aria-label={t('sidebar.settings')}
      onClick={() => { setAdminTab('appearance'); setShowAdmin(true); }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-3Z" /><circle cx="11.5" cy="11" r="3" />
      </svg>
    </button>
  </header>;
}
