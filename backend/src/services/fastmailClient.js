export const JMAP_CORE = 'urn:ietf:params:jmap:core';
export const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
export const JMAP_MASKED_EMAIL = 'https://www.fastmail.com/dev/maskedemail';

const SESSION_URL = 'https://api.fastmail.com/jmap/session';
const FASTMAIL_ORIGIN = 'https://api.fastmail.com';

// Fastmail failures follow the app-wide error idiom (see safeFetch.js, routes/draft.js):
// a plain Error carrying a machine-readable `code`, plus a `status` where a route maps
// it to an HTTP response. FASTMAIL_CONFIG is a caller/configuration fault (bad token,
// missing permission) surfaced as 422; FASTMAIL_SYNC is a transient remote failure.
export function fastmailConfigError(message) {
  return Object.assign(new Error(message), { code: 'FASTMAIL_CONFIG', status: 422 });
}

export function fastmailSyncError(message) {
  return Object.assign(new Error(message), { code: 'FASTMAIL_SYNC' });
}

// Pin the session-advertised API URL to Fastmail's own origin over HTTPS. The token is
// sent as a Bearer header on every JMAP request, so a tampered or redirected apiUrl must
// never be able to carry it to another host.
function assertFastmailApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== FASTMAIL_ORIGIN) {
    throw fastmailConfigError('Fastmail returned an unexpected API URL');
  }
  return url.href;
}

function safeFetchError(error) {
  if (error.name === 'TimeoutError') {
    return fastmailSyncError('Fastmail did not respond in time');
  }
  return fastmailSyncError('Could not reach Fastmail');
}

function assertSuccessfulResponse(response) {
  if (response.status === 401 || response.status === 403) {
    throw fastmailConfigError('Fastmail rejected the API token or its permissions');
  }
  if (!response.ok) throw fastmailSyncError('Fastmail synchronization failed');
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw fastmailSyncError('Fastmail returned an invalid response');
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse() {
  throw fastmailSyncError('Fastmail returned an invalid response');
}

// JMAP results drive identity/alias reconciliation, so validate the shape of every
// method response before trusting it: reject a malformed or attacker-shaped result
// rather than silently producing bad aliases or masking a partial provider failure.
function validateMethodResult(methodName, result, requestArguments) {
  if (!isObject(result)) invalidResponse();
  if (result.accountId !== requestArguments.accountId) invalidResponse();

  if (methodName === 'Identity/get' || methodName === 'MaskedEmail/get') {
    if (!Array.isArray(result.list)) invalidResponse();
    return;
  }

  if (methodName === 'Identity/set') {
    const created = result.created ?? {};
    if (!Object.hasOwn(result, 'notCreated')) invalidResponse();
    const notCreated = result.notCreated ?? {};
    if (!isObject(created) || !isObject(notCreated)) invalidResponse();

    const requestedIds = Object.keys(requestArguments.create);
    const createdIds = Object.keys(created);
    const notCreatedIds = Object.keys(notCreated);
    const returnedIds = [...createdIds, ...notCreatedIds];
    if (
      returnedIds.length !== requestedIds.length
      || new Set(returnedIds).size !== returnedIds.length
      || returnedIds.some(id => !requestedIds.includes(id))
      || Object.values(created).some(value => !isObject(value) || typeof value.id !== 'string' || !value.id)
      || Object.values(notCreated).some(value => (
        !isObject(value) || typeof value.type !== 'string' || !value.type
      ))
    ) {
      invalidResponse();
    }
  }
}

function requirePrimaryAccount(session, capability, label) {
  const accountId = session.primaryAccounts?.[capability];
  if (!accountId || !session.accounts?.[accountId]?.accountCapabilities?.[capability]) {
    throw fastmailConfigError(`Fastmail did not provide a usable primary ${label} account`);
  }
  return accountId;
}

export async function loadFastmailSession(token, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(SESSION_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    throw safeFetchError(error);
  }

  assertSuccessfulResponse(response);
  const session = await responseJson(response);
  assertFastmailApiUrl(session.apiUrl);

  if (!session.capabilities?.[JMAP_SUBMISSION]) {
    throw fastmailConfigError('Fastmail API token is missing Email submission permission');
  }
  if (!session.capabilities?.[JMAP_MASKED_EMAIL]) {
    throw fastmailConfigError('Fastmail API token is missing Masked Email permission');
  }
  const submissionAccountId = requirePrimaryAccount(session, JMAP_SUBMISSION, 'Email submission');
  const maskedEmailAccountId = requirePrimaryAccount(session, JMAP_MASKED_EMAIL, 'Masked Email');
  if (submissionAccountId !== maskedEmailAccountId) {
    throw fastmailConfigError('Fastmail capabilities must use the same Fastmail account');
  }

  return session;
}

async function jmapRequest(session, token, methodCalls, fetchFn = fetch) {
  const apiUrl = assertFastmailApiUrl(session.apiUrl);
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
        using: [JMAP_CORE, JMAP_SUBMISSION, JMAP_MASKED_EMAIL],
        methodCalls,
      }),
    });
  } catch (error) {
    throw safeFetchError(error);
  }

  assertSuccessfulResponse(response);
  const payload = await responseJson(response);
  if (!Array.isArray(payload.methodResponses)) {
    throw fastmailSyncError('Fastmail returned an invalid response');
  }

  const expectedByTag = new Map(methodCalls.map(call => [call[2], call]));
  const seenTags = new Set();
  for (const item of payload.methodResponses) {
    if (!Array.isArray(item) || item.length !== 3) invalidResponse();
    const requestedCall = expectedByTag.get(item[2]);
    if (!requestedCall || seenTags.has(item[2])) invalidResponse();
    seenTags.add(item[2]);
    if (item[0] === 'error') {
      throw fastmailSyncError('Fastmail rejected a synchronization method');
    }
    if (item[0] !== requestedCall[0]) invalidResponse();
    validateMethodResult(item[0], item[1], requestedCall[1]);
  }
  if (seenTags.size !== expectedByTag.size) invalidResponse();
  return payload.methodResponses;
}

function responseByTag(responses, tag) {
  const response = responses.find(item => item[2] === tag);
  if (!response) throw fastmailSyncError('Fastmail omitted a synchronization result');
  return response[1];
}

export async function fetchFastmailSnapshot(session, token, fetchFn = fetch) {
  const submissionAccountId = session.primaryAccounts[JMAP_SUBMISSION];
  const maskedEmailAccountId = session.primaryAccounts[JMAP_MASKED_EMAIL];
  const responses = await jmapRequest(session, token, [
    ['Identity/get', { accountId: submissionAccountId, ids: null }, 'identities'],
    ['MaskedEmail/get', { accountId: maskedEmailAccountId, ids: null }, 'masked-emails'],
  ], fetchFn);
  return {
    identities: responseByTag(responses, 'identities').list,
    maskedEmails: responseByTag(responses, 'masked-emails').list,
  };
}

export async function createFastmailIdentities(session, token, identities, fetchFn = fetch) {
  if (!identities.length) return { createdIds: [], notCreatedIds: [] };

  const create = Object.fromEntries(identities.map((identity, index) => [
    `mask-${index}`,
    {
      name: identity.name,
      email: identity.email,
      replyTo: null,
      bcc: null,
      textSignature: '',
      htmlSignature: '',
    },
  ]));
  const result = await jmapRequest(session, token, [
    ['Identity/set', {
      accountId: session.primaryAccounts[JMAP_SUBMISSION],
      create,
    }, 'create-identities'],
  ], fetchFn);
  const set = responseByTag(result, 'create-identities');
  return {
    createdIds: Object.keys(set.created || {}),
    notCreatedIds: Object.keys(set.notCreated || {}),
  };
}
