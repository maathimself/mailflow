import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/index.js';
import { api } from './utils/api.js';
import { applyTheme } from './themes.js';
import { applyFontSet } from './fonts.js'; // still used for the instant localStorage apply on mount
import { applyLayout } from './layouts.js';
import LoginPage from './components/LoginPage.jsx';
import MailApp from './components/MailApp.jsx';

export default function App() {
  const { user, setUser, loadPreferences } = useStore();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Apply localStorage immediately so there's no flash while we check auth
    applyTheme(localStorage.getItem('mailflow_theme') || 'dark');
    applyFontSet(localStorage.getItem('mailflow_font') || 'default');
    applyLayout(localStorage.getItem('mailflow_layout') || 'classic');

    // Handle OAuth popup callback
    const params = new URLSearchParams(window.location.search);
    const oauthSuccess = params.get('oauth_success');
    const oauthError = params.get('oauth_error');
    if ((oauthSuccess || oauthError) && window.opener) {
      if (oauthSuccess) {
        window.opener.postMessage({ type: 'oauth_success', provider: oauthSuccess }, window.location.origin);
      } else {
        window.opener.postMessage({ type: 'oauth_error', error: oauthError }, window.location.origin);
      }
      window.close();
      return;
    }

    api.me()
      .then(async (data) => {
        setUser(data.user);
        // Load server preferences after confirming auth — overwrites localStorage so
        // settings survive cache clears and stay consistent across devices.
        await loadPreferences();
      })
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div style={{
        height: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--bg-primary)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            border: '2px solid var(--border)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 0.8s linear infinite'
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
      <Route path="/*" element={user ? <MailApp /> : <Navigate to="/login" />} />
    </Routes>
  );
}
