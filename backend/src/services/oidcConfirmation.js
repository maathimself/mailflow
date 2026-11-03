import crypto from 'crypto';

// A sign-in just made through single sign-on, asked for by the token form (routes/oidc.js,
// action=reauth), vouches for the session's user for a few minutes, once. Creating an API token
// needs that when the account cannot sign in with a password (#617); services/apiTokenReauth.js
// reads it, and spends it. An ordinary sign-in records nothing here: the provider may have kept
// its own session, so it proves no more than the MailFlow session already does.
export const OIDC_CONFIRMATION_MS = 10 * 60 * 1000;

// userId: who the provider vouched for, which is the session's user; provider: the oidc_providers
// row the id_token was checked against. Its issuer and client go in too, so that creating the token
// can tell if an admin has pointed the provider elsewhere since (apiTokens.js); the nonce is what
// marks the confirmation spent.
export function recordOidcConfirmation(session, userId, provider, now = Date.now()) {
  session.oidcConfirmation = {
    at: now,
    nonce: crypto.randomBytes(16).toString('base64url'),
    userId,
    providerId: provider.id,
    issuerUrl: provider.issuer_url,
    clientId: provider.client_id,
  };
}

// The record, with `until`, while the last confirmation still counts; otherwise null.
export function freshOidcConfirmation(session, now = Date.now()) {
  const record = session?.oidcConfirmation;
  if (!record || [record.nonce, record.userId, record.providerId, record.issuerUrl, record.clientId].some(v => typeof v !== 'string')) return null;
  if (!Number.isFinite(record.at) || record.at > now || now - record.at > OIDC_CONFIRMATION_MS) return null;
  return { ...record, until: new Date(record.at + OIDC_CONFIRMATION_MS) };
}

// A confirmation makes one token; the form asks for another sign-in for the next.
export function clearOidcConfirmation(session) {
  delete session.oidcConfirmation;
}
