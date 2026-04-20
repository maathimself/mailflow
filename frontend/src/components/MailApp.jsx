import { useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { LAYOUTS } from '../layouts.js';
import Sidebar from './Sidebar.jsx';
import MessageList from './MessageList.jsx';
import MessagePane from './MessagePane.jsx';
import ComposeModal from './ComposeModal.jsx';
import AdminPanel from './AdminPanel.jsx';
import NotificationToasts from './NotificationToasts.jsx';

export default function MailApp() {
  const {
    setAccounts, setUnreadCounts, showAdmin,
    setShowAdmin, setAdminTab, composing, sidebarCollapsed, layout,
    unreadCounts, selectedAccountId,
  } = useStore();

  const currentLayout = LAYOUTS[layout] || LAYOUTS.classic;

  useWebSocket();

  useEffect(() => {
    // Load accounts
    api.getAccounts()
      .then(accounts => {
        setAccounts(accounts); // also sets accountsReady:true in the store
      })
      .catch(err => {
        console.error(err);
        // Even on error, mark accounts as ready so MessageList doesn't hang
        useStore.setState({ accountsReady: true });
      });

    // Load unread counts
    const refreshCounts = () => {
      api.getUnreadCounts()
        .then(setUnreadCounts)
        .catch(console.error);
    };
    refreshCounts();
    const interval = setInterval(refreshCounts, 60000);
    return () => clearInterval(interval);
  }, []);

  // Update browser tab title with unread count for the selected account (or total)
  useEffect(() => {
    const count = selectedAccountId
      ? (unreadCounts.byAccount[selectedAccountId] ?? 0)
      : unreadCounts.total;
    document.title = count > 0 ? `(${count}) MailFlow` : 'MailFlow';
  }, [unreadCounts, selectedAccountId]);

  // Handle OAuth callback redirects (e.g. /?oauth_success=microsoft).
  // This lives here rather than inside IntegrationsTab because the OAuth popup
  // loads a fresh app instance where the admin panel isn't open, so any check
  // inside IntegrationsTab would never run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('oauth_success');
    const oauthError = params.get('oauth_error');

    if (provider) {
      window.history.replaceState({}, '', '/');
      if (window.opener) {
        // We're in the OAuth popup tab — notify the opener and close
        window.opener.postMessage({ type: 'oauth_success', provider }, '*');
        window.close();
      } else {
        // Same-tab redirect — reload accounts and open the Accounts tab
        api.getAccounts()
          .then(accounts => { setAccounts(accounts); })
          .catch(console.error);
        setAdminTab('accounts');
        setShowAdmin(true);
      }
    } else if (oauthError) {
      window.history.replaceState({}, '', '/');
      if (window.opener) {
        window.opener.postMessage({ type: 'oauth_error', error: oauthError }, '*');
        window.close();
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      display: 'flex', height: '100vh', overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      <Sidebar />

      <div style={{
        flex: 1, display: 'flex', overflow: 'hidden',
        minWidth: 0, flexDirection: currentLayout.direction,
        height: '100%',
      }}>
        <MessageList />
        <MessagePane />
      </div>

      {composing && <ComposeModal />}
      {showAdmin && <AdminPanel />}
      <NotificationToasts />
    </div>
  );
}
