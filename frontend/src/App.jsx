import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/index.js';
import { api } from './utils/api.js';
import { applyTheme, getInitialTheme } from './themes.js';
import { applyFontSet } from './fonts.js'; // still used for the instant localStorage apply on mount
import { applyLayout } from './layouts.js';
import LoginPage from './components/LoginPage.jsx';
import MailApp from './components/MailApp.jsx';
import LockScreen from './components/LockScreen.jsx';

export default function App() {
  const { user, setUser, loadPreferences, isLocked } = useStore();
  const [checking, setChecking] = useState(true);

  // Register service worker on first mount — independent of auth state.
  // The SW itself does nothing until the user explicitly grants push permission.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) =>
        console.warn('Service worker registration failed:', err)
      );
    }
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('mailflow:session_expired', onExpired);
    return () => window.removeEventListener('mailflow:session_expired', onExpired);
  }, [setUser]);

  useEffect(() => {
    // Apply localStorage immediately so there's no flash while we check auth
    applyTheme(localStorage.getItem('mailflow_theme') || getInitialTheme());
    applyFontSet(localStorage.getItem('mailflow_font') || 'default');
    const savedListWidth = Number(localStorage.getItem('mailflow_list_width')) || undefined;
    applyLayout(localStorage.getItem('mailflow_layout') || 'comfortable', savedListWidth);

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
      .catch(() => {
        const params = new URLSearchParams(window.location.search);
        const m = params.get('m');
        if (m) sessionStorage.setItem('mailflow_deep_link_id', m);
        const resetToken = params.get('reset_token');
        if (resetToken) sessionStorage.setItem('mailflow_reset_token', resetToken);
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, [loadPreferences, setUser]);

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
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/*" element={user ? (isLocked ? <LockScreen /> : <MailApp />) : <Navigate to="/login" replace />} />
    </Routes>
  );
}
