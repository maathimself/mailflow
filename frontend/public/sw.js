// MailFlow Service Worker — handles Web Push and notification clicks.
// Intentionally minimal: no fetch interception, no caching strategy.
// The sole purpose of this SW is push delivery and notification click handling.

self.addEventListener('install', () => {
  // Force this SW to activate immediately, bypassing the waiting phase.
  // Safe here because this SW does no fetch interception or caching — there
  // is no state to hand off from the old version to the new one.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of all existing clients so push events reach this SW version.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (_) {
    return;
  }

  const {
    title       = 'MailFlow',
    body        = 'New message',
    icon        = '/icon-512.png',
    url         = '/',
    unreadCount,          // intentionally no default — undefined means "don't touch badge"
  } = data;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const promises = [];

        // Update the home screen badge (iOS 17.4+, Android Chrome PWA).
        // Only runs when unreadCount is explicitly provided — a missing value
        // means the backend couldn't determine the count and should not clear it.
        // Uses self.navigator — bare `navigator` is not reliably exposed in iOS
        // Safari service worker scope.
        try {
          if (self.navigator && 'setAppBadge' in self.navigator && unreadCount != null) {
            const p = unreadCount > 0
              ? self.navigator.setAppBadge(unreadCount)
              : self.navigator.clearAppBadge();
            if (p && typeof p.then === 'function') promises.push(p.catch(() => {}));
          }
        } catch (_) {}

        // iOS/WebKit requires showNotification() to be called for every push event.
        // Skipping it — even when a client is focused — causes WebKit to log a
        // user-visible-notification violation and will eventually revoke push permission.
        // The in-app WebSocket toast still fires independently via the open client.
        promises.push(
          self.registration.showNotification(title, {
            body,
            icon,
            badge: '/icon-512.png',
            data:  { url },
            // Replace any existing MailFlow notification so rapid arrivals
            // don't stack unboundedly in the notification center.
            tag:      'mailflow-new-mail',
            renotify: true,
          })
        );

        return Promise.all(promises);
      })
  );
});

// Persist a deep-link target in IndexedDB so the page can consume it on focus or
// launch. This is the reliable channel on iOS: postMessage can be missed on a
// focus-with-reload, and iOS ignores the openWindow() URL on a cold launch — but a
// persisted target survives both. Fully guarded so a storage error never rejects
// the waitUntil. (Only reachable when the app is backgrounded — iOS does not fire
// notificationclick at all for a fully-terminated PWA.)
function storePendingDeepLink(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const open = indexedDB.open('mailflow-nav', 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore('kv'); } catch (_) {} };
      open.onerror = done;
      open.onblocked = done;
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(url, 'pending_deeplink');
          tx.oncomplete = () => { db.close(); done(); };
          tx.onerror = () => { db.close(); done(); };
          tx.onabort = () => { db.close(); done(); };
        } catch (_) { done(); }
      };
    } catch (_) { done(); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const deepLink = !!targetUrl && targetUrl !== '/';

  event.waitUntil(
    (deepLink ? storePendingDeepLink(targetUrl) : Promise.resolve())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => {
        const existing = clients.find(
          (c) => new URL(c.url).origin === self.location.origin
        );
        if (existing) {
          // Nudge the live client to consume the persisted deep-link immediately
          // (no reload). Harmless if nothing is listening.
          if (deepLink) existing.postMessage({ type: 'mailflow_deeplink' });
          return existing.focus();
        }
        // Cold/killed: openWindow's URL is honored on Chromium and ignored on iOS,
        // but the persisted target above covers iOS on the next app launch.
        return self.clients.openWindow(targetUrl);
      })
  );
});
