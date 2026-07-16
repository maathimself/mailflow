// Generic, host-configurable JMAP client (RFC 8620/8621). The session URL comes from the
// account row, not a constant — Fastmail is just a settings preset that prefills it (see
// AdminPanel.jsx PRESETS.fastmail). Requires only the standard core + submission
// capabilities. Fastmail's Masked Email vendor extension is detected and used ONLY when
// the session advertises it (sessionHasMaskedEmail) — never required, so a plain Stalwart
// server works exactly the same as Fastmail.
//
// Read-only: Identity/get and (when advertised) MaskedEmail/get are the only method calls
// this module makes. There is no Identity/set or MaskedEmail/set — MailFlow sends over
// SMTP, so nothing needs to be created on the server.
//
// Because the session URL is user-configured, every request goes through safeFetch (the
// same SSRF-guarded fetch IMAP/SMTP host validation and carddavClient.js use) instead of
// plain fetch, and the host is checked with validateHost before the first request —
// see assertUrlAllowed below.
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

export const JMAP_CORE = 'urn:ietf:params:jmap:core';
export const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
export const JMAP_MASKED_EMAIL = 'https://www.fastmail.com/dev/maskedemail';

// JMAP failures follow the app-wide error idiom (see safeFetch.js, routes/draft.js): a
// plain Error carrying a machine-readable `code`, plus a `status` where a route maps it
// to an HTTP response. JMAP_CONFIG is a caller/configuration fault (bad token, wrong URL,
// missing capability) surfaced as 422; JMAP_SYNC is a transient remote failure.
export function jmapConfigError(message) {
  return Object.assign(new Error(message), { code: 'JMAP_CONFIG', status: 422 });
}

export function jmapSyncError(message) {
  return Object.assign(new Error(message), { code: 'JMAP_SYNC' });
}

// The token travels as a Bearer header on every JMAP request, so a tampered or
// redirected apiUrl must never be able to carry it to another host. Generalizes the old
// Fastmail-only pin (hardcoded api.fastmail.com origin) to: same-origin as the
// user-configured session URL — whatever host and scheme that is. Origin equality already
// implies the same scheme, so an apiUrl downgraded to http when the session was loaded
// over https is rejected here too. Re-checked on every request (not just at session-load
// time) so a session object handed to fetchIdentities from anywhere other than
// loadJmapSession can't smuggle the Bearer token to another host.
function assertSameOriginApiUrl(sessionUrl, apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw jmapConfigError('The JMAP server returned an unusable API URL');
  }
  if (url.origin !== new URL(sessionUrl).origin) {
    throw jmapConfigError('The JMAP server returned an API URL on a different host');
  }
  return url.href;
}

// SSRF guard for the user-configured session URL: HTTPS is required so the Bearer token
// never travels in the clear, unless the host is genuinely private/local AND the caller's
// policy allows private hosts (matches carddavAccount.js's save-time rule for its own
// user-configured server URL). The host itself is then checked with validateHost — the
// same private/reserved-IP check IMAP/SMTP hosts get — under the real allowPrivate policy.
async function assertUrlAllowed(url, allowPrivate) {
  if (url.protocol === 'http:') {
    if (!allowPrivate) throw jmapConfigError('The JMAP session URL must use https');
    const publicErr = await validateHost(url.hostname, { allowPrivate: false });
    if (!publicErr) { // resolves to a public address
      throw jmapConfigError('HTTPS is required for a public host; plaintext HTTP is only allowed for a private/local address');
    }
  } else if (url.protocol !== 'https:') {
    throw jmapConfigError('The JMAP session URL must use https');
  }
  const hostErr = await validateHost(url.hostname, { allowPrivate });
  if (hostErr) throw jmapConfigError(`JMAP session URL: ${hostErr}`);
}

function safeFetchError(error) {
  if (error.name === 'TimeoutError') {
    return jmapSyncError('The JMAP server did not respond in time');
  }
  return jmapSyncError('Could not reach the JMAP server');
}

function assertSuccessfulResponse(response) {
  if (response.status === 401 || response.status === 403) {
    throw jmapConfigError('The JMAP server rejected the API token or its permissions');
  }
  if (!response.ok) throw jmapSyncError('JMAP synchronization failed');
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw jmapSyncError('The JMAP server returned an invalid response');
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse() {
  throw jmapSyncError('The JMAP server returned an invalid response');
}

// Identity/MaskedEmail results drive sendable-address reconciliation, so validate the
// shape of the response before trusting it: reject a malformed or attacker-shaped result
// rather than silently producing bad sendable addresses or masking a partial provider failure.
function validateMethodResult(methodName, result, requestArguments) {
  if (!isObject(result)) invalidResponse();
  if (result.accountId !== requestArguments.accountId) invalidResponse();
  if ((methodName === 'Identity/get' || methodName === 'MaskedEmail/get') && !Array.isArray(result.list)) {
    invalidResponse();
  }
}

function requirePrimaryAccount(session, capability, label) {
  const accountId = session.primaryAccounts?.[capability];
  if (!accountId || !session.accounts?.[accountId]?.accountCapabilities?.[capability]) {
    throw jmapConfigError(`The JMAP server did not provide a usable primary ${label} account`);
  }
  return accountId;
}

// True only when the session both advertises the Masked Email capability AND names a
// primary account for it that actually has it in its accountCapabilities — mirrors the
// submission check in loadJmapSession, but this one is optional: callers detect it, they
// never require it.
export function sessionHasMaskedEmail(session) {
  const accountId = session?.primaryAccounts?.[JMAP_MASKED_EMAIL];
  return Boolean(
    session?.capabilities?.[JMAP_MASKED_EMAIL]
    && accountId
    && session.accounts?.[accountId]?.accountCapabilities?.[JMAP_MASKED_EMAIL],
  );
}

// Discover and validate a JMAP session at the given (user-configured) session URL.
// Capabilities beyond core + submission are ignored, not required — a server can
// advertise Masked Email, Sieve, whatever else; this layer never looks at it. The
// returned session carries the discovery URL alongside the parsed JMAP session object so
// later calls (fetchIdentities) can re-pin the API URL's origin against it.
//
// allowPrivate mirrors the admin connection policy (see connectionPolicy.js) that already
// gates IMAP/SMTP host access; fetchFn defaults to the SSRF-guarded safeFetch and is only
// ever overridden by tests.
export async function loadJmapSession(sessionUrl, token, { fetchFn = safeFetch, allowPrivate = false } = {}) {
  const url = new URL(sessionUrl);
  await assertUrlAllowed(url, allowPrivate);

  let response;
  try {
    response = await fetchFn(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }, { allowPrivate });
  } catch (error) {
    throw safeFetchError(error);
  }

  assertSuccessfulResponse(response);
  const session = await responseJson(response);
  assertSameOriginApiUrl(url.href, session.apiUrl);

  if (!session.capabilities?.[JMAP_CORE]) {
    throw jmapConfigError('The JMAP server did not advertise the core capability');
  }
  if (!session.capabilities?.[JMAP_SUBMISSION]) {
    throw jmapConfigError('The JMAP API token is missing Email submission permission');
  }
  requirePrimaryAccount(session, JMAP_SUBMISSION, 'Email submission');

  return { ...session, sessionUrl: url.href };
}

// extraUsing declares a vendor capability (e.g. Masked Email) for this call only — never
// added by default, so a plain core+submission request never advertises anything Fastmail-
// specific.
async function jmapRequest(session, token, methodCalls, { fetchFn = safeFetch, allowPrivate = false, extraUsing = [] } = {}) {
  const apiUrl = assertSameOriginApiUrl(session.sessionUrl, session.apiUrl);
  let response;
  try {
    response = await fetchFn(apiUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        using: [JMAP_CORE, JMAP_SUBMISSION, ...extraUsing],
        methodCalls,
      }),
    }, { allowPrivate });
  } catch (error) {
    throw safeFetchError(error);
  }

  assertSuccessfulResponse(response);
  const payload = await responseJson(response);
  if (!Array.isArray(payload.methodResponses)) {
    throw jmapSyncError('The JMAP server returned an invalid response');
  }

  const expectedByTag = new Map(methodCalls.map(call => [call[2], call]));
  const seenTags = new Set();
  for (const item of payload.methodResponses) {
    if (!Array.isArray(item) || item.length !== 3) invalidResponse();
    const requestedCall = expectedByTag.get(item[2]);
    if (!requestedCall || seenTags.has(item[2])) invalidResponse();
    seenTags.add(item[2]);
    if (item[0] === 'error') {
      throw jmapSyncError('The JMAP server rejected a synchronization method');
    }
    if (item[0] !== requestedCall[0]) invalidResponse();
    validateMethodResult(item[0], item[1], requestedCall[1]);
  }
  if (seenTags.size !== expectedByTag.size) invalidResponse();
  return payload.methodResponses;
}

function responseByTag(responses, tag) {
  const response = responses.find(item => item[2] === tag);
  if (!response) throw jmapSyncError('The JMAP server omitted a synchronization result');
  return response[1];
}

// Fetch every sending identity for the account's primary submission account.
export async function fetchIdentities(session, token, opts) {
  const submissionAccountId = session.primaryAccounts[JMAP_SUBMISSION];
  const responses = await jmapRequest(session, token, [
    ['Identity/get', { accountId: submissionAccountId, ids: null }, 'identities'],
  ], opts);
  return responseByTag(responses, 'identities').list;
}

// Fetch every Masked Email address for the account's primary Masked Email account. Only
// callable when sessionHasMaskedEmail(session) — the vendor capability is added to the
// `using` array for this call alone, so a server that never advertised it never sees it
// requested.
export async function fetchMaskedEmails(session, token, opts) {
  if (!sessionHasMaskedEmail(session)) {
    throw jmapConfigError('The JMAP session does not advertise Masked Email');
  }
  const maskedEmailAccountId = session.primaryAccounts[JMAP_MASKED_EMAIL];
  const responses = await jmapRequest(session, token, [
    ['MaskedEmail/get', { accountId: maskedEmailAccountId, ids: null }, 'masked-emails'],
  ], { ...opts, extraUsing: [JMAP_MASKED_EMAIL] });
  return responseByTag(responses, 'masked-emails').list;
}
