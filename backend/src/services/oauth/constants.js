// OAuth constants shared by the token manager, the IMAP/SMTP transports and the send route.
// Keep this module free of imports: tests mock the token manager and the provider modules, and
// a constant read through a mocked module would silently become undefined.

export const OAUTH_PROVIDERS = new Set(['microsoft', 'google']);

export const isOAuthAccount = (account) => OAUTH_PROVIDERS.has(account?.oauth_provider);

// Message of the token manager's OAuthTokenError for a revoked or expired grant.
export const OAUTH_RECONNECT_REQUIRED_MESSAGE = 'OAuth access was revoked or expired — reconnect the account';

// Stable, secret-free results for token-manager failures on send paths, keyed by the error code.
// The SMTP transport returns them before a transport exists; the send route uses them when the
// transport's forced refresh fails.
export const OAUTH_SEND_FAILURES = Object.freeze({
  oauth_reconnect_required: Object.freeze({
    status: 409,
    error: 'Access to this account was revoked or has expired. Reconnect the account to send mail.',
  }),
  oauth_refresh_failed: Object.freeze({
    status: 503,
    error: 'Could not renew access to this account. Please try again shortly.',
  }),
});
