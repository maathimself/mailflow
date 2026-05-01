import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api.js';

// Convert a URL-safe base64 VAPID public key (as returned by the server)
// into the Uint8Array that PushManager.subscribe() expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Manages the full Web Push lifecycle:
 *   - Checks browser support and current Notification permission
 *   - Reads the existing PushManager subscription on mount
 *   - Exposes subscribe() / unsubscribe() actions for the UI
 *
 * Returns:
 *   supported      — browser supports push (SW + PushManager + Notification API)
 *   permission     — 'default' | 'granted' | 'denied'
 *   subscribed     — whether the browser has an active push subscription
 *   serverConfigured — whether the backend has VAPID keys set
 *   loading        — async action in progress
 *   subscribe()    — request permission + create subscription + POST to backend
 *   unsubscribe()  — remove subscription from browser + DELETE from backend
 */
export function usePushNotifications() {
  const [supported,        setSupported]        = useState(false);
  const [permission,       setPermission]       = useState('default');
  const [subscribed,       setSubscribed]       = useState(false);
  const [serverConfigured, setServerConfigured] = useState(null); // null = not yet checked
  const [loading,          setLoading]          = useState(false);
  const regRef = useRef(null);

  useEffect(() => {
    const ok =
      'serviceWorker' in navigator &&
      'PushManager'   in window    &&
      'Notification'  in window;
    setSupported(ok);
    if (!ok) return;

    setPermission(Notification.permission);

    // Check whether the backend has VAPID keys configured before the user
    // tries to subscribe — lets us show a clear error instead of a cryptic 503.
    api.getPushVapidKey()
      .then(() => setServerConfigured(true))
      .catch(() => setServerConfigured(false));

    // Retrieve the existing subscription (if any) so the UI reflects reality
    // without requiring the user to re-subscribe on every page load.
    navigator.serviceWorker.ready.then((reg) => {
      regRef.current = reg;
      reg.pushManager.getSubscription().then((sub) => setSubscribed(!!sub));
    });
  }, []);

  const subscribe = async () => {
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return false;

      const { publicKey } = await api.getPushVapidKey();
      const reg = regRef.current ?? (await navigator.serviceWorker.ready);

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await api.pushSubscribe(sub.toJSON());
      setSubscribed(true);
      return true;
    } catch (err) {
      console.error('Push subscribe failed:', err);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const unsubscribe = async () => {
    setLoading(true);
    try {
      const reg = regRef.current ?? (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Remove from backend first; if that fails the browser sub stays intact
        // so the user can retry. Ignore backend errors so the browser unsubscribe
        // always runs (avoids phantom subscriptions on a re-subscribe attempt).
        await api.pushUnsubscribe({ endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setLoading(false);
    }
  };

  return {
    supported,
    permission,
    subscribed,
    serverConfigured,
    loading,
    subscribe,
    unsubscribe,
  };
}
