import { consume } from '../services/rateLimiter.js';
import { logAuthEvent } from '../services/authEvents.js';
import { matchApiTokenRoute } from '../services/apiTokenAllowlist.js';
import {
  answerInvalidToken, apiTokenCredential, apiTokensEnabled, findTokenByHash, hashToken, isTokenFormat,
  normalizeIp, recordTokenUse, TOKENS_OFF_ERROR,
} from '../services/apiTokens.js';
import { discardBodyUpTo, TOKEN_BODY_LIMIT_BYTES, TOKEN_BODY_TOO_LARGE } from './bodyParsers.js';

const MINUTE = 60 * 1000;
// Spent only by credentials that match no token, malformed or unknown: they are what a guess
// looks like. A valid token never touches it, so junk sent from its IP, or from a proxy
// every client shares, cannot lock it out. It is separate from the sign-in budget (auth:<ip>), so
// a stale token left in a tool cannot lock its owner out of the web sign-in.
const FAILURES = { max: 20, windowMs: 15 * MINUTE };
const PER_TOKEN = { max: 600, windowMs: 5 * MINUTE };
const PER_USER = { max: 1200, windowMs: 5 * MINUTE };
const DRAFT_SAVES = { max: 60, windowMs: 10 * MINUTE };

// API token requests (#617), decided before the body parsers and express-session run. A request
// is one only when it carries `Authorization: Bearer mfat_…`; then it is a token request and
// nothing else, so any cookie on it is ignored: express-session skips a request that already has
// req.session. Every other request passes untouched.
export async function apiTokenAuth(req, res, next) {
  const credential = apiTokenCredential(req.headers.authorization);
  if (credential === null) return next();
  try {
    await authenticate(req, res, next, credential);
  } catch (err) {
    // The switch or the token lookup failed. Nothing has been counted against anyone.
    discardBodyUpTo(req, res, TOKEN_BODY_LIMIT_BYTES, () => next(err));
  }
}

async function authenticate(req, res, next, credential) {
  // Every refusal reads off what is left of the body first (bodyParsers.js says why), up to a cap.
  const refuse = (status, body, headers = {}) => discardBodyUpTo(req, res, TOKEN_BODY_LIMIT_BYTES, () => {
    res.set(headers).status(status).json(body);
  });
  const ip = normalizeIp(req.ip);

  if (!(await apiTokensEnabled())) {
    return refuse(401, { error: TOKENS_OFF_ERROR }, { 'WWW-Authenticate': 'Bearer realm="MailFlow"' });
  }
  const token = isTokenFormat(credential) ? await findTokenByHash(hashToken(credential)) : null;
  if (!token) {
    const { limited, resetMs } = await consume(`apitoken-fail:${ip ?? 'unknown'}`, FAILURES.max, FAILURES.windowMs);
    if (limited) {
      return refuse(429, { error: 'Too many failed API token attempts. Try again later.' }, retryAfter(resetMs));
    }
    logAuthEvent('api_token_auth_fail', { ip, success: false });
    return discardBodyUpTo(req, res, TOKEN_BODY_LIMIT_BYTES, () => answerInvalidToken(res));
  }
  if (token.expired) {
    // Whoever sends it holds a real token, so it guesses nothing and costs its address nothing.
    // It never works again, so it is always told so, never to wait and retry; only how often it
    // is logged is limited.
    const { limited } = await consume(`apitoken-expired:${token.id}`, FAILURES.max, FAILURES.windowMs);
    if (!limited) logAuthEvent('api_token_auth_fail', { userId: token.user_id, username: token.username, ip, success: false });
    return discardBodyUpTo(req, res, TOKEN_BODY_LIMIT_BYTES, () => answerInvalidToken(res));
  }

  // The credential is good from here on, so nothing below is a failed attempt.
  const route = matchApiTokenRoute(req.method, req.originalUrl);
  if (!route) return refuse(403, { error: 'This API token cannot be used for this request' });
  if (route.scope && !token.scopes.includes(route.scope)) {
    return refuse(403, { error: `This API token does not have the ${route.scope} scope` });
  }
  // Before the 35 MB draft parser, and before the 1 MB one reads off a body it would refuse.
  if (Number(req.headers['content-length']) > TOKEN_BODY_LIMIT_BYTES) {
    return refuse(413, { error: TOKEN_BODY_TOO_LARGE });
  }

  const limits = [
    [`api-token:${token.id}`, PER_TOKEN, 'Too many requests for this API token. Try again later.'],
    [`api-token-user:${token.user_id}`, PER_USER, 'Too many API token requests for this account. Try again later.'],
  ];
  if (route.method === 'POST' && route.path === '/api/mail/draft') {
    limits.push([`api-token-draft:${token.user_id}`, DRAFT_SAVES, 'Too many drafts saved with API tokens. Try again later.']);
  }
  for (const [key, { max, windowMs }, error] of limits) {
    const { limited, resetMs } = await consume(key, max, windowMs);
    if (limited) return refuse(429, { error }, retryAfter(resetMs));
  }

  attachTokenIdentity(req, token, route);
  recordTokenUse(token.id, ip);
  next();
}

const retryAfter = resetMs => ({ 'Retry-After': String(Math.max(1, Math.ceil(resetMs / 1000))) });

// The identity the routes see: req.session carries the user, as a cookie session does, but it is
// a plain object for this request only. No cookie is set and nothing is written to the store.
export function attachTokenIdentity(req, token, route) {
  req.apiToken = {
    id: token.id,
    userId: token.user_id,
    username: token.username,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.created_at,
    expiresAt: token.expires_at,
    route,
  };
  req.session = tokenSession(req, { userId: token.user_id, username: token.username, apiTokenId: token.id });
}

// No allowlisted route calls the session's methods. Should one ever do so, a save, regenerate or
// reload must not pass for done, since there is no session to do it to, so they fail loudly;
// destroy ends the token identity for the rest of the request, as it ends a session; touch does
// nothing, as there is nothing to keep alive.
function tokenSession(req, fields) {
  const misuse = (operation, callback) => {
    const err = new Error(`API token requests have no session to ${operation}`);
    if (typeof callback !== 'function') throw err;
    callback(err);
  };
  return Object.defineProperties({ ...fields, isAdmin: false }, {
    destroy: {
      value(callback) {
        delete req.session;
        delete req.apiToken;
        if (typeof callback === 'function') callback();
      },
    },
    save: { value(callback) { misuse('save', callback); } },
    regenerate: { value(callback) { misuse('regenerate', callback); } },
    reload: { value(callback) { misuse('reload', callback); } },
    touch: { value() { return this; } },
  });
}
