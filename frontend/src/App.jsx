import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/index.js';
import { api } from './utils/api.js';
import { applyTheme, getInitialTheme } from './themes.js';
import { applyFontSet, effectiveFontSet } from './fonts.js'; // still used for the instant localStorage apply on mount
import { applyLayout } from './layouts.js';
import LoginPage from './components/LoginPage.jsx';
import MailApp from './components/MailApp.jsx';
import LockScreen from './components/LockScreen.jsx';

export default function App() {
  const { user, setUser, loadPreferences, isLocked, setLocked, lockScreen } = useStore();
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
    const onExpired = () => { setUser(null); setLocked(false); };
    const onLocked = () => setLocked(true);
    window.addEventListener('mailflow:session_expired', onExpired);
    window.addEventListener('mailflow:locked', onLocked);
    return () => {
      window.removeEventListener('mailflow:session_expired', onExpired);
      window.removeEventListener('mailflow:locked', onLocked);
    };
  }, [setUser, setLocked]);

  useEffect(() => {
    // Apply localStorage immediately so there's no flash while we check auth
    const bootTheme = localStorage.getItem('mailflow_theme') || getInitialTheme();
    applyTheme(bootTheme);
    applyFontSet(effectiveFontSet(bootTheme, localStorage.getItem('mailflow_font') || 'default'));
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
        // Skip loading prefs while locked: the API is 423'd until unlock (#235).
        if (data.user?.locked) {
          setLocked(true);
          return;
        }
        // Locked in this browser but not on the server: the lock request never got there
        // (the network was still down when auto-lock fired, or the backend was restarting).
        // Send it again rather than let a reload lift the lock without the PIN.
        if (localStorage.getItem('mailflow_locked') === '1') {
          lockScreen();
          return;
        }
        // Load server preferences after confirming auth — overwrites localStorage so
        // settings survive cache clears and stay consistent across devices.
        await loadPreferences();
      })
      .catch((err) => {
        const params = new URLSearchParams(window.location.search);
        const m = params.get('m');
        if (m) sessionStorage.setItem('mailflow_deep_link_id', m);
        const resetToken = params.get('reset_token');
        if (resetToken) sessionStorage.setItem('mailflow_reset_token', resetToken);
        setUser(null);
        // Clear any stale client lock so a locked session that has since expired
        // doesn't strand the user back on the lock screen after they re-login (#235).
        // Only a 401 means that: a 5xx or a network error says nothing about the lock,
        // and clearing it then would let the next load in without the PIN.
        if (err?.status === 401) setLocked(false);
      })
      .finally(() => setChecking(false));
  }, [loadPreferences, setUser, setLocked, lockScreen]);

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
