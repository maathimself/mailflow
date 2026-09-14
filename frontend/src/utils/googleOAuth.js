// Google (Gmail) OAuth helpers for the web panel. Pure functions: no DOM, no
// store, no network, so they can be unit-tested with `node --test`.
//
// The backend redirects the OAuth callback ONLY to
//   /?oauth_success=google&oauth_result=<created|updated>
//   /?oauth_error=<code>&oauth_provider=google
// Microsoft keeps its legacy format (/?oauth_success=microsoft, /?oauth_error=<code>).
// Query values are never rendered: everything is mapped to a fixed i18n key.

export const GOOGLE_OAUTH_PATH = '/oauth/google';
export const GOOGLE_OAUTH_CALLBACK_PATH = '/oauth/google/callback';

// Placeholder the backend returns instead of the stored client secret. Sending it
// back unchanged keeps the stored value (same contract as Microsoft).
export const REDACTED_CLIENT_SECRET = '•'.repeat(8);

// Stable success results from the contract. Keys are spelled out literally so
// the i18n source-coverage test can find them.
const GOOGLE_SUCCESS_KEYS = {
  created: 'admin.integrations.google.resultCreated',
  updated: 'admin.integrations.google.resultUpdated',
};
const GOOGLE_SUCCESS_FALLBACK_KEY = 'admin.integrations.google.resultConnected';

// Stable error codes from the contract.
const GOOGLE_ERROR_KEYS = {
  access_denied: 'admin.integrations.google.errorAccessDenied',
  invalid_state: 'admin.integrations.google.errorInvalidState',
  not_configured: 'admin.integrations.google.errorNotConfigured',
  email_not_verified: 'admin.integrations.google.errorEmailNotVerified',
  missing_refresh_token: 'admin.integrations.google.errorMissingRefreshToken',
  scope_missing: 'admin.integrations.google.errorScopeMissing',
  authentication_failed: 'admin.integrations.google.errorAuthenticationFailed',
};
const GOOGLE_ERROR_FALLBACK_KEY = 'admin.integrations.google.errorGeneric';

const GENERIC_SUCCESS_KEY = 'admin.integrations.oauthGenericSuccess';
const GENERIC_ERROR_KEY = 'admin.integrations.oauthGenericError';

// Own-property lookup so codes like "__proto__" or "toString" fall back to the
// generic key instead of resolving to inherited Object members.
function lookup(map, code, fallback) {
  return typeof code === 'string' && Object.hasOwn(map, code) ? map[code] : fallback;
}

// Same-origin URL that starts the Google consent flow. `loginHint` preselects
// the Google account (used by "Reconnect Gmail").
export function buildGoogleConnectUrl({ loginHint } = {}) {
  const hint = typeof loginHint === 'string' ? loginHint.trim() : '';
  if (!hint) return GOOGLE_OAUTH_PATH;
  return `${GOOGLE_OAUTH_PATH}?${new URLSearchParams({ login_hint: hint }).toString()}`;
}

// Exact redirect URI the admin must register in Google Cloud Console.
export function buildGoogleRedirectUri(location) {
  const origin = String(location?.origin || '').replace(/\/+$/, '');
  return `${origin}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

export function isGoogleReconnectRequired(account) {
  return account?.oauth_provider === 'google' && account?.oauth_reconnect_required === true;
}

// Maps OAuth callback query parameters to { provider, status, messageKey }, or
// null when the query carries no OAuth result. `provider` is 'google' or 'other'.
// An error wins over a success if both are present.
export function parseOAuthResult(searchParams) {
  if (searchParams == null) return null;
  const query = typeof searchParams === 'string' ? new URLSearchParams(searchParams) : searchParams;
  if (typeof query.get !== 'function') return null;

  const error = query.get('oauth_error');
  if (error) {
    if (query.get('oauth_provider') === 'google') {
      return { provider: 'google', status: 'error', messageKey: lookup(GOOGLE_ERROR_KEYS, error, GOOGLE_ERROR_FALLBACK_KEY) };
    }
    return { provider: 'other', status: 'error', messageKey: GENERIC_ERROR_KEY };
  }

  const success = query.get('oauth_success');
  if (success) {
    if (success === 'google') {
      return { provider: 'google', status: 'success', messageKey: lookup(GOOGLE_SUCCESS_KEYS, query.get('oauth_result'), GOOGLE_SUCCESS_FALLBACK_KEY) };
    }
    return { provider: 'other', status: 'success', messageKey: GENERIC_SUCCESS_KEY };
  }

  return null;
}

// Converts the postMessage payload App.jsx forwards from an OAuth popup back into
// callback query parameters, so popup and same-tab results share one parser.
export function oauthMessageToSearchParams(data) {
  const out = new URLSearchParams();
  if (!data || typeof data !== 'object') return out;
  const str = (v) => (typeof v === 'string' ? v : '');
  if (data.type === 'oauth_success' && str(data.provider)) {
    out.set('oauth_success', data.provider);
    if (str(data.result)) out.set('oauth_result', data.result);
  } else if (data.type === 'oauth_error' && str(data.error)) {
    out.set('oauth_error', data.error);
    if (str(data.provider)) out.set('oauth_provider', data.provider);
  }
  return out;
}

// Client secret input handling. Selecting the redacted sentinel on focus is not
// reliable (a mouseup can collapse the selection and typing appends to it), so
// the field is cleared on focus and the sentinel restored if left empty.
export function secretFieldOnFocus(value) {
  if (value === REDACTED_CLIENT_SECRET) return { value: '', wasRedacted: true };
  return { value, wasRedacted: false };
}

export function secretFieldOnBlur(value, wasRedacted) {
  return wasRedacted && value === '' ? REDACTED_CLIENT_SECRET : value;
}

// Validates the secret before save. Only the exact sentinel may carry the
// redaction character; anything mixing it with other text is never sent.
export function resolveClientSecretForSave(value) {
  if (typeof value !== 'string' || value === '') return { ok: false, reason: 'required' };
  if (value === REDACTED_CLIENT_SECRET) return { ok: true, value };
  if (value.includes('•')) return { ok: false, reason: 'invalid' };
  return { ok: true, value };
}
