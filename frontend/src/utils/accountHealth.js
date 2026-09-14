// Account connection health for the sidebar indicator. Pure functions: no DOM, no
// store, no network, so they can be unit-tested with `node --test`.
//
// GET /api/accounts returns `health` computed by backend/src/services/accountHealth.js.
// This module mirrors that rule so the client can recompute a provisional code after
// WebSocket account events. Both test suites read
// backend/src/services/accountHealth.fixtures.json to keep the two rules in parity.
import { buildGoogleConnectUrl } from './googleOAuth.js';

export const STALE_AFTER_MS = 15 * 60 * 1000;

export const ACCOUNT_HEALTH_CODES = Object.freeze(['healthy', 'stale', 'failed', 'oauth_reconnect_required', 'disabled']);

// Account fields the rule reads. A patch touching none of them keeps the server code.
export const HEALTH_FIELDS = Object.freeze(['enabled', 'oauth_reconnect_required', 'sync_error', 'last_sync']);

// Spelled out literally so the i18n source-coverage test can find the keys.
export const HEALTH_LABEL_KEYS = Object.freeze({
  healthy: 'sidebar.health.healthy',
  stale: 'sidebar.health.stale',
  failed: 'sidebar.health.failed',
  oauth_reconnect_required: 'sidebar.health.reconnectRequired',
  disabled: 'sidebar.health.disabled',
});

// Existing Microsoft connect entry (AdminPanel → Integrations uses the same route).
export const MICROSOFT_OAUTH_PATH = '/oauth/microsoft';

// Priority: disabled → oauth_reconnect_required → failed → stale → healthy.
// Keep in sync with the backend; the shared fixture test fails on drift.
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

// Merges a store patch into an account and recomputes `health` only when the patch
// changes a field the rule reads. The provisional code never newly becomes "stale":
// the client's copy of last_sync only refreshes with GET /api/accounts, so it ages
// while the page is open and would mark healthy accounts stale after any WS event.
// Only a server response sets "stale"; an existing server "stale" is kept.
export function withProvisionalHealth(account, updates, now = Date.now()) {
  const merged = { ...account, ...updates };
  if (updates && Object.hasOwn(updates, 'health')) return merged;
  if (!updates || !HEALTH_FIELDS.some(field => Object.hasOwn(updates, field))) return merged;
  const next = computeAccountHealth(merged, now);
  if (next !== 'stale') return { ...merged, health: next };
  return { ...merged, health: account?.health === 'stale' ? 'stale' : 'healthy' };
}

// Store patch for a WebSocket account event, or null for unrelated events.
// account_connected implies the reconnect flag is cleared: the backend refuses to
// connect an account while oauth_reconnect_required is set.
export function accountEventPatch(type, data) {
  if (type === 'account_connected') return { sync_error: null, oauth_reconnect_required: false };
  if (type === 'account_error') {
    return data?.error === 'oauth_reconnect_required'
      ? { sync_error: data.error, oauth_reconnect_required: true }
      : { sync_error: data?.error ?? null };
  }
  return null;
}

// Same-origin URL that re-runs the provider consent flow for a reconnect-required
// account, or null when the account has no OAuth provider.
export function reconnectUrlFor(account) {
  if (account?.oauth_provider === 'google') return buildGoogleConnectUrl({ loginHint: account.email_address });
  if (account?.oauth_provider === 'microsoft') return MICROSOFT_OAUTH_PATH;
  return null;
}

// What the account context menu's "Reconnect" item does. An IMAP reconnect cannot
// fix a revoked grant, so reconnect-required OAuth accounts re-run consent instead.
export function reconnectMenuAction(account) {
  const url = account?.health === 'oauth_reconnect_required' ? reconnectUrlFor(account) : null;
  return url ? { kind: 'oauth', url } : { kind: 'imap' };
}
