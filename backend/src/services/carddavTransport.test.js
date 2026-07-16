import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateHost } from './hostValidation.js';
import { safeFetch } from './safeFetch.js';
import {
  CardDavError,
  createDavOperation,
  davRequest,
  testOnlyCreateDavOperation,
} from './carddavTransport.js';

vi.mock('./hostValidation.js', () => ({
  validateHost: vi.fn().mockResolvedValue(null),
}));

vi.mock('./safeFetch.js', () => ({
  safeFetch: vi.fn(),
}));

const ORIGIN = 'https://dav.example.test';
const REQUEST_URL = `${ORIGIN}/addressbooks/user/contacts/`;

function limits(overrides = {}) {
  return {
    maxOperationBytes: 64,
    maxResponseBytes: 32,
    operationTimeoutMs: 1_000,
    requestTimeoutMs: 500,
    ...overrides,
  };
}

function fakeResponse({
  chunks = [],
  contentLength,
  hasBody = true,
  headers: responseHeaders,
  ok = true,
  status = 207,
  statusText = 'Multi-Status',
  url = REQUEST_URL,
} = {}) {
  let index = 0;
  const read = vi.fn(async () => (
    index < chunks.length
      ? { done: false, value: chunks[index++] }
      : { done: true, value: undefined }
  ));
  const cancel = vi.fn(async () => {});
  const releaseLock = vi.fn();
  const headers = new Headers(responseHeaders);
  if (contentLength != null) headers.set('Content-Length', contentLength);
  return {
    response: {
      body: hasBody ? { getReader: () => ({ cancel, read, releaseLock }) } : null,
      headers,
      ok,
      status,
      statusText,
      url,
    },
    cancel,
    read,
    releaseLock,
  };
}

function bytes(text) {
  return new TextEncoder().encode(text);
}

function request(operation, overrides = {}) {
  return davRequest(operation, 'REPORT', REQUEST_URL, {
    body: '<sync-collection/>',
    password: 'test-password',
    username: 'test-user',
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('DAV response byte limits', () => {
  it('rejects an oversized Content-Length before reading the body', async () => {
    const body = fakeResponse({ chunks: [bytes('ignored')], contentLength: '9' });
    safeFetch.mockResolvedValueOnce(body.response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({ maxResponseBytes: 8 }));

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      cause: { code: 'ERR_DAV_RESPONSE_TOO_LARGE' },
    });
    expect(body.read).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(body.releaseLock).toHaveBeenCalledOnce();
  });

  it('rejects an oversized Content-Length even when the response has no body stream', async () => {
    const response = fakeResponse({ contentLength: '9', hasBody: false });
    safeFetch.mockResolvedValueOnce(response.response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({ maxResponseBytes: 8 }));

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      cause: { code: 'ERR_DAV_RESPONSE_TOO_LARGE' },
    });
    expect(response.read).not.toHaveBeenCalled();
  });

  it('cancels a chunked UTF-8 body when streamed bytes cross the response cap', async () => {
    const body = fakeResponse({ chunks: [bytes('abc'), bytes('de')], contentLength: '2' });
    safeFetch.mockResolvedValueOnce(body.response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({ maxResponseBytes: 4 }));

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      cause: { code: 'ERR_DAV_RESPONSE_TOO_LARGE' },
    });
    expect(body.read).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it('rejects the second individually valid body when cumulative bytes cross the operation cap', async () => {
    const first = fakeResponse({ chunks: [bytes('abc')] });
    const second = fakeResponse({ chunks: [bytes('def')] });
    safeFetch.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({
      maxOperationBytes: 5,
      maxResponseBytes: 4,
    }));

    await expect(operation.run(async () => {
      await request(operation);
      return request(operation);
    })).rejects.toMatchObject({
      cause: { code: 'ERR_DAV_OPERATION_TOO_LARGE' },
    });
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it('accepts exact response and operation boundaries and decodes a split multibyte character', async () => {
    const encoded = bytes('A€');
    const body = fakeResponse({
      chunks: [encoded.slice(0, 2), encoded.slice(2)],
      contentLength: String(encoded.byteLength),
    });
    safeFetch.mockResolvedValueOnce(body.response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({
      maxOperationBytes: encoded.byteLength,
      maxResponseBytes: encoded.byteLength,
    }));

    await expect(operation.run(() => request(operation))).resolves.toMatchObject({
      bodyText: 'A€',
      requestUrl: REQUEST_URL,
    });
    expect(body.cancel).not.toHaveBeenCalled();
  });
});

describe('DAV operation lifetime', () => {
  it('aborts at the operation deadline after the per-request timer is recreated', async () => {
    safeFetch
      .mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(fakeResponse({ chunks: [bytes('ok')] }).response), 15);
      }))
      .mockImplementationOnce((_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }));
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({
      operationTimeoutMs: 20,
      requestTimeoutMs: 100,
    }));
    const pending = operation.run(async () => {
      await request(operation);
      return request(operation);
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV server did not respond (timed out)',
      cause: { name: 'TimeoutError' },
    });

    await vi.advanceTimersByTimeAsync(20);

    await rejected;
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('aborts never-settling host validation at the operation deadline', async () => {
    validateHost.mockImplementationOnce(() => new Promise(() => {}));
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({
      operationTimeoutMs: 20,
      requestTimeoutMs: 100,
    }));
    let rejection;
    operation.run(() => request(operation)).catch(error => { rejection = error; });

    await vi.advanceTimersByTimeAsync(20);

    expect(rejection).toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV server did not respond (timed out)',
      cause: { name: 'TimeoutError' },
    });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears operation and request timers after completion', async () => {
    safeFetch.mockResolvedValueOnce(fakeResponse({ chunks: [bytes('ok')] }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await operation.run(() => request(operation));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears operation and request timers after failure', async () => {
    const cause = new Error('socket closed');
    safeFetch.mockRejectedValueOnce(cause);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'Could not reach the CardDAV server: socket closed',
      cause,
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DAV request boundary', () => {
  it('exposes delta-seconds Retry-After as an absolute timestamp on 429', async () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.250Z'));
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers: { 'Retry-After': '120' },
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: '2026-07-12T12:02:00.250Z',
    });
  });

  it('exposes an IMF-fixdate Retry-After as its absolute timestamp on 429', async () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.250Z'));
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers: { 'Retry-After': 'Sun, 12 Jul 2026 12:02:00 GMT' },
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: '2026-07-12T12:02:00.000Z',
    });
  });

  it('exposes a valid past IMF-fixdate without turning it into a future delay', async () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.250Z'));
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:00 GMT' },
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('caps a huge delta-seconds Retry-After at one hour from now', async () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.250Z'));
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers: { 'Retry-After': '9999999999' },
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: '2026-07-12T13:00:00.250Z',
    });
  });

  it('caps a far-future IMF-fixdate Retry-After at one hour from now', async () => {
    vi.setSystemTime(new Date('2026-07-12T12:00:00.250Z'));
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers: { 'Retry-After': 'Fri, 01 Jan 2100 00:00:00 GMT' },
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: '2026-07-12T13:00:00.250Z',
    });
  });

  it.each([
    ['missing', undefined],
    ['arbitrary date text', 'tomorrow'],
    ['non-numeric delay', '120 seconds'],
    ['invalid IMF-fixdate', 'Sun, 32 Jul 2026 12:02:00 GMT'],
  ])('does not expose Retry-After eligibility for a 429 with %s header', async (_label, value) => {
    const headers = value === undefined ? {} : { 'Retry-After': value };
    safeFetch.mockResolvedValueOnce(fakeResponse({
      headers,
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      status: 429,
      retryAfterAt: null,
    });
  });

  it('merges caller headers and exposes a bounded non-XML success body', async () => {
    const vcard = 'BEGIN:VCARD\nVERSION:4.0\nEND:VCARD';
    safeFetch.mockResolvedValueOnce(fakeResponse({
      chunks: [bytes(vcard)],
      headers: { ETag: 'W/"opaque"', 'Content-Type': 'text/vcard' },
      status: 200,
      statusText: 'OK',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({
      maxOperationBytes: bytes(vcard).byteLength,
      maxResponseBytes: bytes(vcard).byteLength,
    }));

    const result = await operation.run(() => davRequest(operation, 'GET', REQUEST_URL, {
      headers: { Accept: 'text/vcard', Authorization: 'Basic attacker-controlled' },
      password: 'test-password',
      username: 'test-user',
    }));

    expect(result).toMatchObject({
      bodyText: vcard,
      requestUrl: REQUEST_URL,
      status: 200,
    });
    expect(result.headers.get('etag')).toBe('W/"opaque"');
    const requestHeaders = new Headers(safeFetch.mock.calls[0][1].headers);
    expect(requestHeaders.get('accept')).toBe('text/vcard');
    expect(requestHeaders.get('authorization'))
      .toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    expect(requestHeaders.has('content-type')).toBe(false);
  });

  it('returns the final trusted response URL for href resolution', async () => {
    const finalUrl = `${ORIGIN}/canonical/contacts/`;
    safeFetch.mockResolvedValueOnce(fakeResponse({ url: finalUrl }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).resolves.toMatchObject({
      bodyText: '',
      requestUrl: finalUrl,
    });
  });

  it('passes the credential origin and Basic authorization through one transport path', async () => {
    safeFetch.mockResolvedValueOnce(fakeResponse().response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await operation.run(() => request(operation, { allowPrivate: true, depth: 0 }));

    expect(validateHost).toHaveBeenCalledWith('dav.example.test', { allowPrivate: true });
    expect(safeFetch).toHaveBeenCalledWith(
      REQUEST_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('test-user:test-password').toString('base64')}`,
          Depth: '0',
        }),
        method: 'REPORT',
      }),
      { allowPrivate: true, credentialOrigin: ORIGIN },
    );
  });

  it('reads an error body through the same bounded path before parsing its DAV precondition', async () => {
    const xml = '<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>';
    safeFetch.mockResolvedValueOnce(fakeResponse({
      chunks: [bytes(xml)],
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits({ maxResponseBytes: bytes(xml).byteLength }));

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV request failed (403 Forbidden)',
      precondition: 'valid-sync-token',
      requestStatus: 403,
      status: 403,
    });
  });

  it('preserves the existing 401 message', async () => {
    safeFetch.mockResolvedValueOnce(fakeResponse({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }).response);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'Authentication failed — check the username and app password',
      requestStatus: 401,
      status: 401,
    });
  });

  it('keeps one CardDavError class and wraps cross-origin policy failures with their cause', async () => {
    const cause = Object.assign(new Error('redirect escaped'), {
      code: 'ERR_CROSS_ORIGIN_REDIRECT',
    });
    safeFetch.mockRejectedValueOnce(cause);
    const operation = testOnlyCreateDavOperation(ORIGIN, limits());

    await expect(operation.run(() => request(operation))).rejects.toSatisfy(error => (
      error instanceof CardDavError
      && error.cause === cause
      && error.cause.code === 'ERR_CROSS_ORIGIN_REDIRECT'
    ));
  });
});

describe('CardDAV client transport adoption', () => {
  it('does not let extra arguments alter production operation limits', async () => {
    safeFetch.mockResolvedValueOnce(fakeResponse({ chunks: [bytes('ok')] }).response);
    const operation = createDavOperation(ORIGIN, limits({
      maxOperationBytes: 1,
      maxResponseBytes: 1,
    }));

    await expect(operation.run(() => request(operation))).resolves.toMatchObject({
      bodyText: 'ok',
    });
  });

  it('does not re-export transport operations through the client', async () => {
    const client = await import('./carddavClient.js');

    expect(client).not.toHaveProperty('createDavOperation');
    expect(client).not.toHaveProperty('davRequest');
  });

  it('uses the streamed transport path without a response.text fallback', async () => {
    const xml = '<d:multistatus xmlns:d="DAV:"/>';
    safeFetch.mockResolvedValueOnce(fakeResponse({ chunks: [bytes(xml)] }).response);
    const { fetchAddressBookCards } = await import('./carddavClient.js');

    await expect(fetchAddressBookCards({
      url: REQUEST_URL,
      username: 'test-user',
      password: 'test-password',
    })).resolves.toEqual([]);
  });
});
