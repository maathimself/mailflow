// A sign-in through single sign-on vouches for the session's user for a few minutes. Creating an
// API token needs that when the account cannot sign in with a password (#617): routes/oidc.js
// records it, and services/apiTokenReauth.js reads it.
export const OIDC_CONFIRMATION_MS = 10 * 60 * 1000;

export function recordOidcConfirmation(session, providerId, now = Date.now()) {
  session.oidcConfirmedAt = now;
  session.oidcConfirmedProviderId = providerId;
}

// { providerId, until } while the last confirmation still counts, otherwise null.
export function freshOidcConfirmation(session, now = Date.now()) {
  const at = session?.oidcConfirmedAt;
  const providerId = session?.oidcConfirmedProviderId;
  if (typeof providerId !== 'string' || !Number.isFinite(at) || at > now || now - at > OIDC_CONFIRMATION_MS) return null;
  return { providerId, until: new Date(at + OIDC_CONFIRMATION_MS) };
}
