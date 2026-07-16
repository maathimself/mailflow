import { DAV_MAX_RESPONSE_BYTES, parseDavErrorPrecondition } from './carddavXml.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { decrypt } from './encryption.js';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';

const DAV_REQUEST_TIMEOUT_MS = 30_000;
const DAV_OPERATION_TIMEOUT_MS = 300_000;
const DAV_MAX_OPERATION_BYTES = 128 * 1024 * 1024;

const productionLimits = Object.freeze({
  maxOperationBytes: DAV_MAX_OPERATION_BYTES,
  maxResponseBytes: DAV_MAX_RESPONSE_BYTES,
  operationTimeoutMs: DAV_OPERATION_TIMEOUT_MS,
  requestTimeoutMs: DAV_REQUEST_TIMEOUT_MS,
});
const operationStates = new WeakMap();

export class CardDavError extends Error {
  constructor(message, {
    status,
    requestStatus,
    precondition,
    operation,
    retryAfterAt,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'CardDavError';
    this.status = status ?? null;
    this.requestStatus = requestStatus ?? null;
    this.precondition = precondition ?? null;
    this.operation = operation ?? null;
    this.retryAfterAt = retryAfterAt ?? null;
  }
}

export function activeRetryAfterAt(source) {
  const retryAfterAt = source?.retryAfterAt;
  return typeof retryAfterAt === 'string' && Date.parse(retryAfterAt) > Date.now()
    ? retryAfterAt
    : null;
}

export async function resolveCarddavCredentials(config) {
  const policy = await getConnectionPolicy();
  return {
    username: config?.username,
    password: decrypt(config?.password),
    allowPrivate: policy.allowPrivateHosts,
  };
}

export function createDavOperation(credentialOrigin) {
  return createDavOperationWithLimits(credentialOrigin, productionLimits);
}

export function testOnlyCreateDavOperation(credentialOrigin, testLimits) {
  return createDavOperationWithLimits(credentialOrigin, {
    ...productionLimits,
    ...(testLimits || {}),
  });
}

function createDavOperationWithLimits(credentialOrigin, limits) {
  let origin;
  try { origin = new URL(credentialOrigin).origin; }
  catch { throw new Error('Invalid server URL'); }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('CardDAV operation timed out', 'TimeoutError'));
  }, limits.operationTimeoutMs);
  timer.unref?.();

  let closed = false;
  const operation = {
    credentialOrigin: origin,
    signal: controller.signal,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
    },
    async run(callback) {
      try {
        return await callback();
      } finally {
        operation.close();
      }
    },
  };
  operationStates.set(operation, {
    controller,
    limits,
    remainingBytes: limits.maxOperationBytes,
  });
  return Object.freeze(operation);
}

export async function davRequest(operation, method, url, {
  username,
  password,
  depth,
  body,
  headers: callerHeaders,
  acceptedStatuses = [],
  errorOperation,
  validateRedirect,
  allowPrivate = false,
} = {}) {
  const state = operationStates.get(operation);
  if (!state) throw new TypeError('davRequest requires a DAV operation');

  const headers = requestHeaders(callerHeaders, body);
  headers.Authorization = basicAuth(username, password);
  if (depth != null) headers.Depth = String(depth);

  const requestController = new AbortController();
  const requestTimer = setTimeout(() => {
    requestController.abort(new DOMException('CardDAV request timed out', 'TimeoutError'));
  }, state.limits.requestTimeoutMs);
  requestTimer.unref?.();
  const signal = AbortSignal.any([operation.signal, requestController.signal]);

  let response;
  let bodyText;
  let requestUrl;
  try {
    const parsedUrl = await abortable(assertHostAllowed(url, allowPrivate), signal);
    if (parsedUrl.origin !== operation.credentialOrigin) {
      throw errorWithCode(
        'Credentials cannot be sent to a different origin',
        'ERR_CROSS_ORIGIN_REDIRECT',
      );
    }
    response = await safeFetch(url, {
      method,
      headers,
      body,
      signal,
    }, {
      allowPrivate,
      credentialOrigin: operation.credentialOrigin,
      ...(validateRedirect ? { validateRedirect } : {}),
    });
    requestUrl = response.url || parsedUrl.href;
    if (new URL(requestUrl).origin !== operation.credentialOrigin) {
      throw errorWithCode(
        'Credentialed redirects must stay on the configured origin',
        'ERR_CROSS_ORIGIN_REDIRECT',
      );
    }
    bodyText = await readBody(response, state);
  } catch (error) {
    if (error instanceof CardDavError) throw error;
    if (error.name === 'TimeoutError'
      || (signal.aborted && signal.reason?.name === 'TimeoutError')) {
      throw new CardDavError('CardDAV server did not respond (timed out)', {
        operation: errorOperation,
        cause: error,
      });
    }
    throw new CardDavError(`Could not reach the CardDAV server: ${error.message}`, {
      operation: errorOperation,
      cause: error,
    });
  } finally {
    clearTimeout(requestTimer);
  }

  if (response.status === 401) {
    throw new CardDavError('Authentication failed — check the username and app password', {
      status: response.status,
      requestStatus: response.status,
      precondition: parseDavErrorPrecondition(bodyText),
      operation: errorOperation,
    });
  }
  if (!response.ok && response.status !== 207 && !acceptedStatuses.includes(response.status)) {
    throw new CardDavError(`CardDAV request failed (${response.status} ${response.statusText})`, {
      status: response.status,
      requestStatus: response.status,
      precondition: parseDavErrorPrecondition(bodyText),
      operation: errorOperation,
      retryAfterAt: response.status === 429
        ? parseRetryAfter(response.headers.get('retry-after'))
        : null,
    });
  }
  return {
    bodyText,
    headers: response.headers,
    requestUrl,
    status: response.status,
  };
}

// Retry-After is remote-controlled: a malicious/compromised server (or a MITM on
// a plaintext-allowed private target) could otherwise return a huge delay and
// freeze sync for an unbounded duration. Cap the honored eligibility delay at one
// hour so throttling stays bounded; past/immediate values pass through unchanged.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function parseRetryAfter(value) {
  if (value == null) return null;
  const cap = Date.now() + MAX_RETRY_AFTER_MS;
  if (/^\d+$/.test(value)) {
    const timestamp = BigInt(Date.now()) + BigInt(value) * 1000n;
    if (timestamp > BigInt(cap)) return new Date(cap).toISOString();
    return new Date(Number(timestamp)).toISOString();
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/.test(value)) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return null;
  return new Date(Math.min(timestamp, cap)).toISOString();
}

function requestHeaders(callerHeaders, body) {
  const requested = new Headers(callerHeaders);
  const headers = {};
  for (const [name, value] of requested) {
    if (name === 'authorization' || name === 'depth') continue;
    headers[name] = value;
  }
  if (body != null && !requested.has('content-type')) {
    headers['Content-Type'] = 'application/xml; charset=utf-8';
  }
  return headers;
}

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function assertHostAllowed(url, allowPrivate) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid server URL'); }
  const error = await validateHost(parsed.hostname, { allowPrivate });
  if (error) throw new Error(error);
  return parsed;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted])
    .finally(() => signal.removeEventListener('abort', onAbort));
}

async function readBody(response, state) {
  const declaredLengthError = contentLengthError(response, state);
  if (!response.body) {
    if (declaredLengthError) throw declaredLengthError;
    return '';
  }
  const reader = response.body.getReader();
  try {
    if (declaredLengthError) {
      await cancelReader(reader);
      throw declaredLengthError;
    }

    const decoder = new TextDecoder();
    let responseBytes = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkBytes = value.byteLength;
      if (responseBytes + chunkBytes > state.limits.maxResponseBytes) {
        await cancelReader(reader);
        throw errorWithCode(
          'CardDAV response exceeded the response byte limit',
          'ERR_DAV_RESPONSE_TOO_LARGE',
        );
      }
      if (chunkBytes > state.remainingBytes) {
        await cancelReader(reader);
        throw errorWithCode(
          'CardDAV operation exceeded the cumulative response byte limit',
          'ERR_DAV_OPERATION_TOO_LARGE',
        );
      }
      responseBytes += chunkBytes;
      state.remainingBytes -= chunkBytes;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

function contentLengthError(response, state) {
  const declaredLength = parseContentLength(response.headers?.get('content-length'));
  if (declaredLength == null) return null;
  if (declaredLength > BigInt(state.limits.maxResponseBytes)) {
    return errorWithCode(
      'CardDAV response exceeded the response byte limit',
      'ERR_DAV_RESPONSE_TOO_LARGE',
    );
  }
  if (declaredLength > BigInt(state.remainingBytes)) {
    return errorWithCode(
      'CardDAV operation exceeded the cumulative response byte limit',
      'ERR_DAV_OPERATION_TOO_LARGE',
    );
  }
  return null;
}

function parseContentLength(value) {
  if (value == null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The request is already failing; cancellation is best-effort.
  }
}

function errorWithCode(message, code) {
  return Object.assign(new Error(message), { code });
}
