// A tab opened before a server update keeps running the old app. Vite names each lazily loaded
// file (Settings, Contacts, the composer) by a hash of its contents, and after an update the server
// has only the new set, so the first of those screens the old app opens fails with the browser's
// dynamic-import error. A reload picks up the new app: index.html is served no-store.
//
// Dependency-free on purpose: ErrorBoundary uses it, and the boundary must not import anything
// that could itself be what failed.

// Firefox, Chromium and Safari word the failure differently; Vite adds its own for CSS.
const STALE_BUILD_MESSAGES = [
  /error loading dynamically imported module/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

export function isStaleBuildError(error) {
  const message = String(error?.message ?? error ?? '');
  return STALE_BUILD_MESSAGES.some(re => re.test(message));
}

const RELOADED_AT_KEY = 'mailflow_stale_build_reload_at';
// At most one automatic reload a minute, so a file that is really missing cannot loop the page.
export const AUTO_RELOAD_INTERVAL_MS = 60_000;

// Records an automatic reload and answers whether one may happen now. Without session storage
// (some private modes throw) a loop could not be stopped, so it answers no and the user reloads.
export function claimAutoReload(storage, now = Date.now()) {
  try {
    const last = Number(storage.getItem(RELOADED_AT_KEY)) || 0;
    if (now - last < AUTO_RELOAD_INTERVAL_MS) return false;
    storage.setItem(RELOADED_AT_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
