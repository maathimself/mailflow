// The deep link a notification tap leaves for the page (#589). The service worker stores the target
// in IndexedDB (sw.js storePendingDeepLink) and nudges an open page with postMessage; the page reads
// it when it comes to the front.
//
// Read + atomically clear the deep-link the service worker persisted on a
// notification tap (shared IndexedDB store 'mailflow-nav'). Fully guarded so any
// storage error resolves to null instead of throwing.
export function takePendingDeepLink() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const open = indexedDB.open('mailflow-nav', 1);
      open.onupgradeneeded = () => { try { open.result.createObjectStore('kv'); } catch { /* store already exists */ } };
      open.onerror = () => done(null);
      open.onblocked = () => done(null);
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          const store = tx.objectStore('kv');
          const getReq = store.get('pending_deeplink');
          getReq.onsuccess = () => { if (getReq.result != null) store.delete('pending_deeplink'); };
          tx.oncomplete = () => { const v = getReq.result ?? null; db.close(); done(v); };
          tx.onerror = () => { db.close(); done(null); };
          tx.onabort = () => { db.close(); done(null); };
        } catch { done(null); }
      };
    } catch { done(null); }
  });
}

// On iOS a tap brings a backgrounded home-screen app to the front before the service worker has
// stored the target, so the check on visibilitychange found nothing, and the postMessage nudge sent
// while the page was still resuming could be lost. The message stayed unopened until the app next
// came to the front (#589). So when the page comes to the front, check now and, while nothing is
// there and the page stays visible, a few more times over the next few seconds. Reading also
// clears, so a target is opened once; a read already in flight still opens what it took even after
// a newer watch has replaced this one, because that target is gone from storage.
export const PENDING_DEEPLINK_RETRY_MS = [400, 1200, 3000];

export function watchPendingDeepLink({
  open,
  take = takePendingDeepLink,
  delays = PENDING_DEEPLINK_RETRY_MS,
  isVisible = () => document.visibilityState === 'visible',
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = false;
  let timer = null;
  const attempt = (index) => {
    take().then((url) => {
      if (url) { stopped = true; open(url); return; }
      if (stopped || index >= delays.length || !isVisible()) return;
      timer = schedule(() => { timer = null; attempt(index + 1); }, delays[index]);
    });
  };
  attempt(0);
  return () => { stopped = true; if (timer) cancel(timer); };
}
