// Account connection health for the sidebar indicator. Returns a stable code, never
// localized text, provider messages or the sync_error string itself.
//
// The frontend mirrors this rule in frontend/src/utils/accountHealth.js to recompute a
// provisional code after WebSocket account events; accountHealth.fixtures.json is read
// by both test suites and keeps the two implementations in parity.

// An enabled account with no recorded error whose last successful sync is older than
// this (or that never synced) is reported as stale.
export const STALE_AFTER_MS = 15 * 60 * 1000;

export const ACCOUNT_HEALTH_CODES = Object.freeze(['healthy', 'stale', 'failed', 'oauth_reconnect_required', 'disabled']);

// Priority: disabled → oauth_reconnect_required → failed → stale → healthy.
// sync_error === 'oauth_reconnect_required' counts as reconnect-required too: the IMAP
// manager pushes that stable code over WebSocket before the flag column is re-read.
export function computeAccountHealth(account, now = Date.now()) {
  const a = account ?? {};
  if (a.enabled === false) return 'disabled';
  if (a.oauth_reconnect_required === true || a.sync_error === 'oauth_reconnect_required') return 'oauth_reconnect_required';
  if (a.sync_error) return 'failed';
  const lastSync = a.last_sync == null ? NaN : new Date(a.last_sync).getTime();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(lastSync) || nowMs - lastSync > STALE_AFTER_MS) return 'stale';
  return 'healthy';
}
