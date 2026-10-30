// What kind of failure an account's sync_error is, stored next to it as sync_error_code so the
// UI can say what to do about it without parsing server text. The raw text stays in sync_error
// for the Details view and for diagnostics.
//
// Codes (the frontend's utils/accountErrors.js maps each to copy and actions):
//   ms_imap_disabled_personal  Microsoft accepted the sign-in but IMAP is off for an Outlook.com,
//                              Hotmail, Live or MSN mailbox: the user turns it on in Outlook.com.
//   ms_imap_disabled_work      The same for a work or school mailbox: their IT admin turns it on.
//   oauth_reauth               The OAuth sign-in no longer works (refresh token expired or
//                              revoked, password changed): the user signs in again.
//   oauth_app_config           The provider rejected the app itself (unknown client, wrong or
//                              missing secret, disabled app): an administrator has to fix it.
//   auth_failed                The server rejected a password account's username or password.
//   connection                 Anything else.

export const ACCOUNT_ERROR_CODES = Object.freeze([
  'ms_imap_disabled_personal', 'ms_imap_disabled_work', 'oauth_reauth', 'oauth_app_config',
  'auth_failed', 'connection',
]);

// Outlook.com answers the first command after a successful XOAUTH2 login with this when IMAP is
// turned off for the mailbox (Settings > Mail > Forwarding and IMAP).
const IMAP_DISABLED = /User is authenticated but not connected/i;
// Outlook's answer to an XOAUTH2 login whose access token it does not accept. isAuthFailure in
// imapManager does not match it (it looks for "authentication failed").
const XOAUTH_REJECTED = /\bAUTHENTICATE failed\b/i;

// Personal Microsoft account domains, including the country variants (hotmail.co.uk, live.fr,
// outlook.com.br, ...). A personal account can sign in through a 'common' app too, so the
// tenant alone does not settle it.
const PERSONAL_MS_DOMAIN = /@(?:outlook|hotmail|live|msn|passport|windowslive)\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i;

export function isPersonalMicrosoftAccount(account) {
  if ((account?.oauth_tenant_id || '').toLowerCase() === 'consumers') return true;
  return PERSONAL_MS_DOMAIN.test((account?.email_address || '').trim());
}

// Token endpoint answers, verified against Microsoft's AADSTS reference
// (learn.microsoft.com/entra/identity-platform/reference-error-codes). Anything else that
// fails a refresh is treated as transient and the stored token is tried as before.
const REAUTH_AADSTS = new Set([
  '50076',  // MFA now required by a policy change: sign in interactively again
  '50079',  // MFA enrollment required
  '50133',  // session invalid after a password change or expiry
  '50173',  // grant revoked, for example by a password reset
  '65001',  // consent missing: an interactive sign-in asks for it
  '70000',  // refresh token not valid
  '70008',  // refresh token expired through inactivity
  '70043',  // refresh token expired under a sign-in frequency policy
  '700082', // refresh token expired through inactivity
]);
const APP_CONFIG_AADSTS = new Set([
  '50011',   // redirect URI does not match the app registration
  '50194',   // single-tenant app used through /common
  '70002',   // client secret does not match
  '500011',  // resource service principal not found in the tenant
  '700016',  // application not found in the directory
  '7000112', // application disabled
  '7000215', // invalid client secret
  '7000222', // client secret expired
  '7000218', // secret required: "Allow public client flows" is off for a device-code app
]);
const REAUTH_OAUTH_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required']);
const APP_CONFIG_OAUTH_ERRORS = new Set(['invalid_client', 'unauthorized_client']);

// Classify a failed token refresh from the endpoint's JSON answer. Returns 'oauth_reauth',
// 'oauth_app_config', or null for a failure that may be transient (5xx, throttling, network).
export function classifyRefreshFailure(tokens) {
  const text = `${tokens?.error_description || ''}`;
  const aadsts = text.match(/AADSTS(\d+)/)?.[1] || (Array.isArray(tokens?.error_codes) ? String(tokens.error_codes[0] ?? '') : '');
  if (aadsts && REAUTH_AADSTS.has(aadsts)) return 'oauth_reauth';
  if (aadsts && APP_CONFIG_AADSTS.has(aadsts)) return 'oauth_app_config';
  const error = String(tokens?.error || '').toLowerCase();
  if (APP_CONFIG_OAUTH_ERRORS.has(error)) return 'oauth_app_config';
  if (REAUTH_OAUTH_ERRORS.has(error)) return 'oauth_reauth';
  return null;
}

// An error for a refresh that will not succeed by retrying, carrying its code.
export function terminalRefreshError(message, code) {
  return Object.assign(new Error(message), { accountErrorCode: code });
}

// accountId -> { code, detail } for the last refresh that failed terminally. ensureFreshToken
// keeps going with the stored access token (it may still be valid), so the refresh failure is
// remembered here and reported when the connection then fails, instead of the less useful
// "AUTHENTICATE failed." it causes. Cleared by a successful refresh or a new sign-in.
const refreshFailures = new Map();
export function noteRefreshFailure(accountId, failure) { refreshFailures.set(accountId, failure); }
export function clearRefreshFailure(accountId) { refreshFailures.delete(accountId); }

// accountId -> when this process last got a new access token for it (sign-in or refresh). A
// token Microsoft or Google issued minutes ago that the IMAP server still rejects is not a
// sign-in problem, and "Sign in again" would only loop; it is reported as a connection error.
export const FRESH_TOKEN_MS = 15 * 60 * 1000;
const freshTokens = new Map();
export function noteFreshToken(accountId, at = Date.now()) { freshTokens.set(accountId, at); }
function hasFreshToken(accountId, now = Date.now()) {
  const at = freshTokens.get(accountId);
  return at !== undefined && now - at < FRESH_TOKEN_MS;
}
export function refreshFailureFor(accountId) { return refreshFailures.get(accountId) || null; }

// The code and the text to record for a failed connection. authFailure is imapManager's
// isAuthFailure(detail), passed in so this module has no dependency on the engine.
export function classifyAccountError(account, detail, { authFailure = false } = {}) {
  const text = String(detail || '');
  const oauth = !!account?.oauth_provider;
  // First: imapflow reports IMAP turned off as an authentication failure, but signing in again
  // cannot fix it.
  if (account?.oauth_provider === 'microsoft' && IMAP_DISABLED.test(text)) {
    return { code: isPersonalMicrosoftAccount(account) ? 'ms_imap_disabled_personal' : 'ms_imap_disabled_work', detail: text };
  }
  if (oauth && (authFailure || XOAUTH_REJECTED.test(text))) {
    const refresh = refreshFailureFor(account.id);
    if (refresh) return { code: refresh.code, detail: refresh.detail };
    if (hasFreshToken(account.id)) return { code: 'connection', detail: text };
    return { code: 'oauth_reauth', detail: text };
  }
  if (!oauth && authFailure) return { code: 'auth_failed', detail: text };
  return { code: 'connection', detail: text };
}
