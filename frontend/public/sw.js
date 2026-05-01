// MailFlow Service Worker — handles Web Push and notification clicks.
// Intentionally minimal: no fetch interception, no caching strategy.
// The sole purpose of this SW is push delivery and notification click handling.

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (_) {
    return;
  }

  const {
    title = 'MailFlow',
    body  = 'New message',
    icon  = '/icon-512.png',
    url   = '/',
  } = data;

  event.waitUntil(
    // Check if the user has a MailFlow window that is currently focused.
    // If so, the WebSocket already delivered an in-app toast — skip the OS
    // notification to avoid a duplicate alert.
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        if (clients.some((c) => c.focused)) return;

        return self.registration.showNotification(title, {
          body,
          icon,
          badge: '/icon-512.png',
          data:  { url },
          // Replace any existing MailFlow notification so rapid arrivals
          // don't stack unboundedly in the notification center.
          tag:      'mailflow-new-mail',
          renotify: true,
        });
      })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing window if one is already open.
        const existing = clients.find(
          (c) => new URL(c.url).origin === self.location.origin
        );
        if (existing) return existing.focus();
        return self.clients.openWindow(targetUrl);
      })
  );
});
