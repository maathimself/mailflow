// A sign-in just made through single sign-on, asked for by the token form (routes/oidc.js,
// action=reauth), vouches for the session's user for a few minutes. Creating an API token needs
// that when the account cannot sign in with a password (#617); services/apiTokenReauth.js reads it.
// An ordinary sign-in records nothing here: the provider may have kept its own session, so it
// proves no more than the MailFlow session already does.
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
