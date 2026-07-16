import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFetch } from './safeFetch.js';
import { CardDavError } from './carddavTransport.js';
import {
  buildMultigetBody,
  buildSyncCollectionBody,
  discoverAddressBooks,
  fetchAddressBookDelta,
  fetchAddressBookCards,
  fetchCardResource,
  fetchCardsByHref,
  fetchSyncPage,
  deleteCardResource,
  parseMultigetCards,
  parseSupportedReports,
  parseSyncPage,
  putCardResource,
} from './carddavClient.js';

vi.mock('./hostValidation.js', () => ({
  validateHost: vi.fn().mockResolvedValue(null),
}));

vi.mock('./safeFetch.js', () => ({
  safeFetch: vi.fn(),
}));

const BASE = 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/';

function davResponse(xml, status = 207, statusText = 'Multi-Status', url, responseHeaders) {
  const encoded = new TextEncoder().encode(xml);
  let sent = false;
  const bodyRead = vi.fn(async () => {
    if (!sent && encoded.byteLength > 0) {
      sent = true;
      return { done: false, value: encoded };
    }
    return { done: true, value: undefined };
  });
  return {
    body: {
      getReader: () => ({
        cancel: vi.fn().mockResolvedValue(undefined),
        read: bodyRead,
        releaseLock: vi.fn(),
      }),
    },
    bodyRead,
    headers: new Headers({
      ...responseHeaders,
      'Content-Length': String(encoded.byteLength),
    }),
    status,
    statusText,
    ok: status >= 200 && status < 300,
    url,
  };
}

function syncPageXml(hrefs, nextToken, { truncated = false } = {}) {
  return syncEventsXml(
    hrefs.map((href, index) => ({ href, etag: `sync-${index}` })),
    nextToken,
    { truncated },
  );
}

function multigetXml(hrefs) {
  const cards = hrefs.map((href, index) => `<d:response><d:href>${href}</d:href>
    <d:propstat><d:prop><d:getetag>W/"card-${index}"</d:getetag>
    <C:address-data>BEGIN:VCARD
UID:${index}
FN:Contact ${index}
END:VCARD</C:address-data></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
  return `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${cards}</d:multistatus>`;
}

function syncEventsXml(events, nextToken, { truncated = false } = {}) {
  const responses = events.map((event, index) => {
    if (event.status === 404) {
      return `<d:response><d:href>${event.href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
    }
    return `<d:response><d:href>${event.href}</d:href>
      <d:propstat><d:prop><d:getetag>${event.etag ?? `delta-${index}`}</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }).join('');
  const continuation = truncated
    ? '<d:response><d:href>./</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>'
    : '';
  return `<d:multistatus xmlns:d="DAV:">${responses}${continuation}<d:sync-token>${nextToken}</d:sync-token></d:multistatus>`;
}

afterEach(() => {
  vi.useRealTimers();
  safeFetch.mockReset();
  vi.clearAllMocks();
});

describe('parseSupportedReports', () => {
  it('recognizes sync-collection and addressbook-multiget across namespace prefixes', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <D:response><D:href>/dav/contacts/</D:href><D:propstat><D:prop>
    <D:supported-report-set>
      <D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>
      <D:supported-report><D:report><card:addressbook-multiget/></D:report></D:supported-report>
    </D:supported-report-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

    expect(parseSupportedReports(xml)).toEqual({
      syncCollection: true,
      addressbookMultiget: true,
    });
  });

  it('reports unadvertised capabilities as unsupported', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/contacts/</d:href><d:propstat><d:prop>
      <d:supported-report-set><d:supported-report><d:report><d:expand-property/></d:report></d:supported-report></d:supported-report-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

    expect(parseSupportedReports(xml)).toEqual({
      syncCollection: false,
      addressbookMultiget: false,
    });
  });
});

describe('supported report discovery', () => {
  it('requests supported-report-set and returns sync-collection support per book', async () => {
    const principal = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop>
      <d:current-user-principal><d:href>/dav/principals/user/</d:href></d:current-user-principal>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const home = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/dav/principals/user/</d:href><d:propstat><d:prop>
      <C:addressbook-home-set><d:href>/dav/addressbooks/user/</d:href></C:addressbook-home-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    const books = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <d:response><d:href>/dav/addressbooks/user/</d:href><d:propstat><d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response>
      <d:href>/dav/addressbooks/user/contacts/</d:href><d:propstat><d:prop>
        <d:resourcetype><d:collection/><C:addressbook/></d:resourcetype>
        <d:displayname>Contacts</d:displayname><d:supported-report-set>
          <d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>
        </d:supported-report-set>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response></d:multistatus>`;
    safeFetch
      .mockResolvedValueOnce(davResponse(principal))
      .mockResolvedValueOnce(davResponse(home))
      .mockResolvedValueOnce(davResponse(books));

    await expect(discoverAddressBooks({
      serverUrl: 'https://cloud.example.com/',
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual([{
      url: 'https://cloud.example.com/dav/addressbooks/user/contacts/',
      displayName: 'Contacts',
      supportsSyncCollection: true,
      capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
      discoveryIndex: 0,
      addressData: [],
    }]);

    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(safeFetch.mock.calls[2][1].body).toContain('<supported-report-set/>');
    expect(safeFetch.mock.calls[2][1].body).toContain('<current-user-privilege-set/>');
    expect(safeFetch.mock.calls[2][1].body).toContain('<C:supported-address-data/>');
  });

  it('returns an empty array for a complete home-set enumeration with no books', async () => {
    const principal = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href>
      <D:propstat><D:prop><D:current-user-principal><D:href>/dav/principals/user/</D:href>
      </D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;
    const home = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>/dav/principals/user/</D:href><D:propstat><D:prop>
        <C:addressbook-home-set><D:href>/dav/addressbooks/user/</D:href></C:addressbook-home-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    const emptyBooks = `<D:multistatus xmlns:D="DAV:"><D:response>
      <D:href>/dav/addressbooks/user/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;
    safeFetch
      .mockResolvedValueOnce(davResponse(principal))
      .mockResolvedValueOnce(davResponse(home))
      .mockResolvedValueOnce(davResponse(emptyBooks));

    await expect(discoverAddressBooks({
      serverUrl: 'https://cloud.example.com/',
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { phase: 'principal', expectedCalls: 1 },
    { phase: 'home set', expectedCalls: 2 },
    { phase: 'address book', expectedCalls: 3 },
  ])('rejects a cross-origin $phase href after $expectedCalls same-origin request(s)', async ({
    phase,
    expectedCalls,
  }) => {
    const principalHref = phase === 'principal'
      ? 'https://evil.example.test/principal/'
      : '/dav/principals/user/';
    const homeHref = phase === 'home set'
      ? 'https://evil.example.test/addressbooks/user/'
      : '/dav/addressbooks/user/';
    const bookHref = phase === 'address book'
      ? 'https://evil.example.test/addressbooks/user/contacts/'
      : '/dav/addressbooks/user/contacts/';
    const principal = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href>
      <D:propstat><D:prop><D:current-user-principal><D:href>${principalHref}</D:href>
      </D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;
    const home = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>/dav/principals/user/</D:href><D:propstat><D:prop>
        <C:addressbook-home-set><D:href>${homeHref}</D:href></C:addressbook-home-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    const books = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>/dav/addressbooks/user/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>${bookHref}</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;
    for (const xml of [principal, home, books].slice(0, expectedCalls)) {
      safeFetch.mockResolvedValueOnce(davResponse(xml));
    }

    await expect(discoverAddressBooks({
      serverUrl: 'https://cloud.example.com/',
      username: 'user',
      password: 'app-password',
      allowPrivate: true,
    })).rejects.toThrow(/origin/i);
    expect(safeFetch).toHaveBeenCalledTimes(expectedCalls);
    expect(safeFetch.mock.calls.every(([url]) => new URL(url).origin === 'https://cloud.example.com'))
      .toBe(true);
  });

  it.each([
    { name: 'empty fragment', href: '/dav/principals/user/#' },
    { name: 'empty userinfo', href: 'https://@cloud.example.com/dav/principals/user/' },
  ])('rejects a principal href with $name before the next request', async ({ href }) => {
    const principal = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href>
      <D:propstat><D:prop><D:current-user-principal><D:href>${href}</D:href>
      </D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;
    safeFetch.mockResolvedValueOnce(davResponse(principal));

    await expect(discoverAddressBooks({
      serverUrl: 'https://cloud.example.com/',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({ code: 'ERR_DAV_HREF_SCOPE' });
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      phase: 'principal',
      principalHref: String.raw`https:\\@cloud.example.com/dav/principals/user/`,
      homeHref: '/dav/addressbooks/user/',
      expectedCalls: 1,
    },
    {
      phase: 'home set',
      principalHref: '/dav/principals/user/',
      homeHref: String.raw`https:\\@cloud.example.com/dav/addressbooks/user/`,
      expectedCalls: 2,
    },
  ])('rejects a raw backslash $phase href before the next request', async ({
    principalHref,
    homeHref,
    expectedCalls,
  }) => {
    const principal = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href>
      <D:propstat><D:prop><D:current-user-principal><D:href>${principalHref}</D:href>
      </D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;
    const home = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>/dav/principals/user/</D:href><D:propstat><D:prop>
        <C:addressbook-home-set><D:href>${homeHref}</D:href></C:addressbook-home-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    for (const xml of [principal, home].slice(0, expectedCalls)) {
      safeFetch.mockResolvedValueOnce(davResponse(xml));
    }

    await expect(discoverAddressBooks({
      serverUrl: 'https://cloud.example.com/',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({ code: 'ERR_DAV_HREF_SCOPE' });
    expect(safeFetch).toHaveBeenCalledTimes(expectedCalls);
  });
});

describe('conditional CardDAV resource operations', () => {
  it.each(['"strong"', 'W/"weak"'])(
    'fetches a vCard with opaque ETag %s',
    async etag => {
      const href = `${BASE}fetched.vcf`;
      const vcard = 'BEGIN:VCARD\nVERSION:4.0\nUID:fetched\nEND:VCARD';
      safeFetch.mockResolvedValueOnce(davResponse(
        vcard,
        200,
        'OK',
        href,
        { ETag: etag, 'Content-Type': 'text/vcard; charset=utf-8' },
      ));

      await expect(fetchCardResource({
        url: BASE,
        href,
        username: 'user',
        password: 'app-password',
      })).resolves.toEqual({ href, etag, vcard });

      const [, options] = safeFetch.mock.calls[0];
      const headers = new Headers(options.headers);
      expect(options.method).toBe('GET');
      expect(headers.get('accept')).toBe('text/vcard');
      expect(headers.has('content-type')).toBe(false);
    },
  );

  it('creates with If-None-Match and returns the final URL and response ETag', async () => {
    const href = `${BASE}created.vcf`;
    const vcard = 'BEGIN:VCARD\nVERSION:4.0\nUID:created\nEND:VCARD';
    safeFetch.mockResolvedValueOnce(davResponse(
      '',
      201,
      'Created',
      href,
      { ETag: '"created-1"' },
    ));

    await expect(putCardResource({
      url: BASE,
      href: 'created.vcf',
      vcard,
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual({ href, etag: '"created-1"' });

    const [requestUrl, options] = safeFetch.mock.calls[0];
    const headers = new Headers(options.headers);
    expect(requestUrl).toBe(href);
    expect(options.method).toBe('PUT');
    expect(options.body).toBe(vcard);
    expect(headers.get('content-type')).toBe('text/vcard; charset=utf-8');
    expect(headers.get('if-none-match')).toBe('*');
    expect(headers.has('if-match')).toBe(false);
  });

  it('updates with the stored opaque If-Match value', async () => {
    const href = `${BASE}updated.vcf`;
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nUID:updated\nEND:VCARD';
    safeFetch.mockResolvedValueOnce(davResponse(
      '',
      204,
      'No Content',
      href,
      { ETag: 'W/"updated-2"' },
    ));

    await expect(putCardResource({
      url: BASE,
      href,
      etag: 'W/"stored-1"',
      vcard,
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual({ href, etag: 'W/"updated-2"' });

    const headers = new Headers(safeFetch.mock.calls[0][1].headers);
    expect(headers.get('if-match')).toBe('W/"stored-1"');
    expect(headers.has('if-none-match')).toBe(false);
  });

  it('deletes with If-Match and treats a missing resource as success', async () => {
    const href = `${BASE}already-gone.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse('', 404, 'Not Found', href));

    await expect(deleteCardResource({
      url: BASE,
      href,
      etag: '"stored-delete"',
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual({ href });

    const [, options] = safeFetch.mock.calls[0];
    const headers = new Headers(options.headers);
    expect(options.method).toBe('DELETE');
    expect(headers.get('if-match')).toBe('"stored-delete"');
    expect(headers.has('content-type')).toBe(false);
  });

  it.each([
    ['update', 'exact', () => putCardResource({
      url: BASE,
      href: 'wildcard-update.vcf',
      etag: '*',
      vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user',
      password: 'app-password',
    })],
    ['update', 'OWS-padded', () => putCardResource({
      url: BASE,
      href: 'wildcard-update.vcf',
      etag: ' * ',
      vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user',
      password: 'app-password',
    })],
    ['delete', 'exact', () => deleteCardResource({
      url: BASE,
      href: 'wildcard-delete.vcf',
      etag: '*',
      username: 'user',
      password: 'app-password',
    })],
    ['delete', 'OWS-padded', () => deleteCardResource({
      url: BASE,
      href: 'wildcard-delete.vcf',
      etag: '\t*\t',
      username: 'user',
      password: 'app-password',
    })],
  ])('rejects %s wildcard If-Match (%s) before requesting', async (operation, _form, request) => {
    safeFetch.mockRejectedValueOnce(new Error('transport should not be reached'));

    await expect(request()).rejects.toMatchObject({
      name: 'CardDavError',
      operation,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['fetch', 403, () => fetchCardResource({
      url: BASE, href: 'blocked.vcf', username: 'user', password: 'app-password',
    })],
    ['create', 405, () => putCardResource({
      url: BASE, href: 'blocked.vcf', vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user', password: 'app-password',
    })],
    ['update', 403, () => putCardResource({
      url: BASE, href: 'blocked.vcf', etag: '"stored"', vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user', password: 'app-password',
    })],
    ['delete', 405, () => deleteCardResource({
      url: BASE, href: 'blocked.vcf', etag: '"stored"',
      username: 'user', password: 'app-password',
    })],
  ])('preserves rejected %s operation on HTTP %i', async (operation, status, request) => {
    safeFetch.mockResolvedValueOnce(davResponse('', status, 'Rejected', `${BASE}blocked.vcf`));

    await expect(request()).rejects.toMatchObject({
      name: 'CardDavError',
      operation,
      status,
    });
  });

  it.each([409, 412, 423, 429, 500, 503])(
    'keeps HTTP %i as a typed conditional update error',
    async status => {
      safeFetch.mockResolvedValueOnce(davResponse('', status, 'Rejected', `${BASE}blocked.vcf`));

      await expect(putCardResource({
        url: BASE,
        href: 'blocked.vcf',
        etag: '"stored"',
        vcard: 'BEGIN:VCARD\nEND:VCARD',
        username: 'user',
        password: 'app-password',
      })).rejects.toSatisfy(error => (
        error instanceof CardDavError
        && error.operation === 'update'
        && error.status === status
      ));
    },
  );

  it('rejects a same-origin redirect outside the collection scope', async () => {
    const redirected = 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/sibling.vcf';
    safeFetch.mockResolvedValueOnce(davResponse('', 201, 'Created', redirected));

    await expect(putCardResource({
      url: BASE,
      href: 'created.vcf',
      vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      code: 'ERR_DAV_HREF_SCOPE',
      operation: 'create',
    });
  });

  it('rejects a final cross-origin resource URL with the fetch operation', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(
      'BEGIN:VCARD\nEND:VCARD',
      200,
      'OK',
      'https://evil.example.test/stolen.vcf',
      { ETag: '"stolen"' },
    ));

    await expect(fetchCardResource({
      url: BASE,
      href: 'card.vcf',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      operation: 'fetch',
      cause: { code: 'ERR_CROSS_ORIGIN_REDIRECT' },
    });
  });

  it('rejects an out-of-scope resource href before sending credentials', async () => {
    await expect(putCardResource({
      url: BASE,
      href: 'nested/card.vcf',
      vcard: 'BEGIN:VCARD\nEND:VCARD',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      code: 'ERR_DAV_HREF_SCOPE',
      operation: 'create',
    });

    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe('initial sync network planner', () => {
  it('uses the trusted final collection URL for alias members and identity', async () => {
    const observedUrl = 'https://cloud.example.com/books/alias/';
    const canonicalUrl = 'https://cloud.example.com/books/canonical/';
    safeFetch
      .mockResolvedValueOnce(davResponse(
        syncPageXml(['contact.vcf'], 'opaque-after'),
        207,
        'Multi-Status',
        canonicalUrl,
      ))
      .mockResolvedValueOnce(davResponse(
        multigetXml(['contact.vcf']),
        207,
        'Multi-Status',
        canonicalUrl,
      ));

    const plan = await fetchAddressBookDelta({
      url: observedUrl,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan.collectionIdentity).toEqual({ observedUrl, canonicalUrl });
    expect(plan.upserts[0].href).toBe(`${canonicalUrl}contact.vcf`);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('follows continuation tokens and multigets 205 hrefs in fixed 100, 100, and 5 batches', async () => {
    const hrefs = Array.from({ length: 205 }, (_, index) => `${BASE}${index}.vcf`);
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml(hrefs.slice(0, 100), 'middle-1', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncPageXml(hrefs.slice(100, 200), 'middle-2', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncPageXml(hrefs.slice(200), 'final-token')))
      .mockResolvedValueOnce(davResponse(multigetXml(hrefs.slice(0, 100))))
      .mockResolvedValueOnce(davResponse(multigetXml(hrefs.slice(100, 200))))
      .mockResolvedValueOnce(davResponse(multigetXml(hrefs.slice(200))));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(fetchSyncPage).toBeTypeOf('function');
    expect(fetchCardsByHref).toBeTypeOf('function');
    expect(plan).toMatchObject({
      expectedRemoteToken: null,
      nextRemoteToken: 'final-token',
      capability: 'sync-collection',
      replaceAll: true,
      removedHrefs: [],
    });
    expect(plan.upserts).toHaveLength(205);
    expect(plan.upserts[0].etag).toBe('W/"card-0"');

    const bodies = safeFetch.mock.calls.map(([, options]) => options.body);
    expect(bodies.slice(0, 3)).toEqual([
      expect.stringContaining('<sync-token></sync-token>'),
      expect.stringContaining('<sync-token>middle-1</sync-token>'),
      expect.stringContaining('<sync-token>middle-2</sync-token>'),
    ]);
    expect(bodies.slice(3).map(body => body.match(/<D:href>/g)?.length || 0))
      .toEqual([100, 100, 5]);
    expect(safeFetch.mock.calls.every(([, options]) => options.depth == null)).toBe(true);
    expect(safeFetch.mock.calls.every(([, options]) => options.headers.Depth === '0')).toBe(true);
  });

  it('stops after multiget batch 2 fails', async () => {
    const hrefs = Array.from({ length: 205 }, (_, index) => `${BASE}${index}.vcf`);
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml(hrefs, 'final-token')))
      .mockResolvedValueOnce(davResponse(multigetXml(hrefs.slice(0, 100))))
      .mockRejectedValueOnce(new Error('multiget batch 2 failed'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('multiget batch 2 failed');

    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects a final sync page that is not a DAV multistatus', async () => {
    safeFetch.mockResolvedValueOnce(davResponse('<html><body>proxy error</body></html>'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('DAV multistatus');

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('rejects a complete final sync page without a usable sync token', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(syncPageXml([], '   ')));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('usable sync token');

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it.each([405, 501])('does not downgrade a per-resource %i response', async status => {
    const statusText = status === 405 ? 'Method Not Allowed' : 'Not Implemented';
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>blocked.vcf</d:href><d:status>HTTP/1.1 ${status} ${statusText}</d:status></d:response>
      <d:sync-token>must-not-advance</d:sync-token>
    </d:multistatus>`;
    safeFetch.mockResolvedValueOnce(davResponse(xml));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      name: 'CardDavError',
      status,
    });

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it.each([403, 500])('rejects a sync resource with a %i propstat without accepting its token', async status => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>failed.vcf</d:href><d:propstat><d:prop><d:getetag>stale</d:getetag></d:prop>
        <d:status>HTTP/1.1 ${status} Failed</d:status></d:propstat></d:response>
      <d:sync-token>must-not-advance</d:sync-token>
    </d:multistatus>`;
    safeFetch.mockResolvedValueOnce(davResponse(xml));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      name: 'CardDavError',
      status,
    });

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('uses the guarded full query for unsupported books', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(multigetXml([`${BASE}one.vcf`])));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-existing-token',
      supportsSyncCollection: false,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      expectedRemoteToken: 'opaque-existing-token',
      nextRemoteToken: null,
      capability: 'snapshot',
      collectionIdentity: { observedUrl: BASE, canonicalUrl: BASE },
      replaceAll: true,
      removedHrefs: [],
    });
    expect(plan.upserts).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(safeFetch.mock.calls[0][1].body).toContain('<C:addressbook-query');
    expect(safeFetch.mock.calls[0][1].body).not.toContain('<sync-collection');
  });

  it('returns a complete empty snapshot plan and sends one exact CardDAV filter', async () => {
    safeFetch.mockResolvedValueOnce(davResponse('<D:multistatus xmlns:D="DAV:"/>'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: false,
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: null,
      capability: 'snapshot',
      collectionIdentity: { observedUrl: BASE, canonicalUrl: BASE },
      replaceAll: true,
      upserts: [],
      removedHrefs: [],
    });

    const body = safeFetch.mock.calls[0][1].body;
    expect(body.match(/<C:filter\/>/g)).toHaveLength(1);
    expect(body).toContain('<D:prop><D:getetag/><C:address-data/></D:prop>');
    expect(body.indexOf('<C:filter/>')).toBeGreaterThan(body.indexOf('</D:prop>'));
  });

  it.each([405, 501])('downgrades an advertised sync report returning %i', async status => {
    safeFetch
      .mockResolvedValueOnce(davResponse('', status, status === 405 ? 'Method Not Allowed' : 'Not Implemented'))
      .mockResolvedValueOnce(davResponse(multigetXml([`${BASE}one.vcf`])));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      nextRemoteToken: null,
      capability: 'snapshot',
      replaceAll: true,
    });
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][1].body).toContain('<C:addressbook-query');
  });

  it('downgrades when an advertised multiget report returns 405', async () => {
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([`${BASE}one.vcf`], 'final-token')))
      .mockResolvedValueOnce(davResponse('', 405, 'Method Not Allowed'))
      .mockResolvedValueOnce(davResponse(multigetXml([`${BASE}one.vcf`])));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan.capability).toBe('snapshot');
    expect(safeFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { status: 401, statusText: 'Unauthorized', body: '', precondition: null },
    { status: 403, statusText: 'Forbidden', body: '', precondition: null },
    {
      status: 403,
      statusText: 'Forbidden',
      body: '<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
      precondition: 'valid-sync-token',
    },
  ])('does not downgrade strict HTTP failure $status/$precondition', async failure => {
    safeFetch.mockResolvedValueOnce(davResponse(
      failure.body,
      failure.status,
      failure.statusText,
    ));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      status: failure.status,
      precondition: failure.precondition,
    });
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('does not downgrade a timeout', async () => {
    const timeout = new Error('request expired');
    timeout.name = 'TimeoutError';
    safeFetch.mockRejectedValueOnce(timeout);

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({
      name: 'CardDavError',
      status: null,
      cause: timeout,
    });
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('does not downgrade a sync-page parse failure', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(syncPageXml([], '   ', { truncated: true })));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: null,
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('truncated without a continuation token');
    expect(safeFetch).toHaveBeenCalledOnce();
  });
});

describe('stored-token delta network planner', () => {
  it('returns a no-change delta without issuing a multiget', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(syncPageXml([], 'opaque-after')));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toEqual({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: 'opaque-after',
      capability: 'sync-collection',
      collectionIdentity: { observedUrl: BASE, canonicalUrl: BASE },
      replaceAll: false,
      upserts: [],
      removedHrefs: [],
    });
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(safeFetch.mock.calls[0][1].body).toContain('<sync-token>opaque-before</sync-token>');
  });

  it('allows a final no-change page to return the stored token', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(syncPageXml([], 'opaque-same')));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-same',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).resolves.toMatchObject({
      nextRemoteToken: 'opaque-same',
      upserts: [],
      removedHrefs: [],
    });

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('rejects a repeated continuation token after one request', async () => {
    safeFetch.mockResolvedValueOnce(davResponse(
      syncPageXml([], 'opaque-same', { truncated: true }),
    ));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-same',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/token.*cycle|repeated.*token/i);

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('rejects an A to B to A continuation cycle after two requests', async () => {
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([], 'B', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncPageXml([], 'A', { truncated: true })));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'A',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/token.*cycle|repeated.*token/i);

    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('round-trips numeric-looking continuation tokens as exact opaque strings', async () => {
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([], '00123', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncPageXml([], 'true', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncPageXml([], '1e3')));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(safeFetch.mock.calls.map(([, options]) => options.body)).toEqual([
      expect.stringContaining('<sync-token>opaque-before</sync-token>'),
      expect.stringContaining('<sync-token>00123</sync-token>'),
      expect.stringContaining('<sync-token>true</sync-token>'),
    ]);
    expect(plan.nextRemoteToken).toBe('1e3');
  });

  it('fetches one changed href for a stored-token delta', async () => {
    const href = `${BASE}changed.vcf`;
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([href], 'opaque-after')))
      .mockResolvedValueOnce(davResponse(multigetXml([href])));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: 'opaque-after',
      replaceAll: false,
      removedHrefs: [],
    });
    expect(plan.upserts).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][1].body).toContain(`<D:href>${href}</D:href>`);
  });

  it('keeps a response-level 404 as a delta removal without a multiget', async () => {
    const href = `${BASE}gone.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse(syncEventsXml([
      { href, status: 404 },
    ], 'opaque-after')));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      replaceAll: false,
      upserts: [],
      removedHrefs: [href],
    });
    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('turns a multiget 404 into a delta removal', async () => {
    const href = `${BASE}vanished.vcf`;
    const missing = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href>
      <d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([href], 'opaque-after')))
      .mockResolvedValueOnce(davResponse(missing));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      replaceAll: false,
      upserts: [],
      removedHrefs: [href],
    });
  });

  it('deduplicates paged delta events using each href latest disposition', async () => {
    const changedThenRemoved = `${BASE}removed-later.vcf`;
    const removedThenChanged = `${BASE}changed-later.vcf`;
    safeFetch
      .mockResolvedValueOnce(davResponse(syncEventsXml([
        { href: changedThenRemoved },
        { href: removedThenChanged, status: 404 },
      ], 'middle-token', { truncated: true })))
      .mockResolvedValueOnce(davResponse(syncEventsXml([
        { href: changedThenRemoved, status: 404 },
        { href: removedThenChanged },
      ], 'opaque-after')))
      .mockResolvedValueOnce(davResponse(multigetXml([removedThenChanged])));

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan).toMatchObject({
      expectedRemoteToken: 'opaque-before',
      nextRemoteToken: 'opaque-after',
      replaceAll: false,
      removedHrefs: [changedThenRemoved],
    });
    expect(plan.upserts.map(card => card.href)).toEqual([removedThenChanged]);
    expect(safeFetch.mock.calls.map(([, options]) => options.body)).toEqual([
      expect.stringContaining('<sync-token>opaque-before</sync-token>'),
      expect.stringContaining('<sync-token>middle-token</sync-token>'),
      expect.stringContaining(`<D:href>${removedThenChanged}</D:href>`),
    ]);
  });

  it('rejects duplicate member events within one delta page', async () => {
    const href = `${BASE}same-page.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse(syncEventsXml([
      { href },
      { href, status: 404 },
    ], 'opaque-after')));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/duplicate|same page/i);

    expect(safeFetch).toHaveBeenCalledOnce();
  });

  it('does not build a delta after a later sync page fails', async () => {
    const href = `${BASE}changed.vcf`;
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([href], 'middle-token', { truncated: true })))
      .mockRejectedValueOnce(new Error('delta page 2 failed'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('delta page 2 failed');

    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('does not build a delta after a multiget batch fails', async () => {
    const href = `${BASE}changed.vcf`;
    safeFetch
      .mockResolvedValueOnce(davResponse(syncPageXml([href], 'opaque-after')))
      .mockRejectedValueOnce(new Error('delta multiget failed'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('delta multiget failed');
  });

  it('does not build a delta after a sync page parse failure', async () => {
    safeFetch.mockResolvedValueOnce(davResponse('<html>not a multistatus</html>'));

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('DAV multistatus');
  });

  it('accepts exactly 100 sync pages when the last page is final', async () => {
    let page = 0;
    safeFetch.mockImplementation(() => {
      page++;
      return Promise.resolve(davResponse(syncPageXml(
        [],
        `page-${page}`,
        { truncated: page < 100 },
      )));
    });

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'stored-token',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan.nextRemoteToken).toBe('page-100');
    expect(safeFetch).toHaveBeenCalledTimes(100);
  });

  it('rejects before issuing a 101st sync page request', async () => {
    let page = 0;
    safeFetch.mockImplementation(() => {
      if (page === 100) {
        return Promise.reject(new Error('unexpected 101st sync request'));
      }
      page++;
      return Promise.resolve(davResponse(syncPageXml(
        [],
        `page-${page}`,
        { truncated: true },
      )));
    });

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'stored-token',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/100.*page|page.*limit/i);

    expect(safeFetch).toHaveBeenCalledTimes(100);
  });

  it('accepts exactly 50,000 distinct removed members', async () => {
    let page = 0;
    safeFetch.mockImplementation(() => {
      const start = page * 500;
      const events = Array.from({ length: 500 }, (_, index) => ({
        href: `${BASE}removed-${start + index}.vcf`,
        status: 404,
      }));
      page++;
      return Promise.resolve(davResponse(syncEventsXml(
        events,
        `page-${page}`,
        { truncated: page < 100 },
      )));
    });

    const plan = await fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });

    expect(plan.removedHrefs).toHaveLength(50_000);
    expect(safeFetch).toHaveBeenCalledTimes(100);
  });

  it('rejects the 50,001st distinct member before any multiget', async () => {
    let page = 0;
    safeFetch.mockImplementation(() => {
      const start = page * 500;
      const pageSize = page === 99 ? 501 : 500;
      const hrefs = Array.from(
        { length: pageSize },
        (_, index) => `${BASE}changed-${start + index}.vcf`,
      );
      page++;
      return Promise.resolve(davResponse(syncPageXml(
        hrefs,
        `page-${page}`,
        { truncated: page < 100 },
      )));
    });

    await expect(fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/50,?000|object.*limit|member.*limit/i);

    expect(safeFetch).toHaveBeenCalledTimes(100);
    expect(safeFetch.mock.calls.every(([, options]) => (
      options.body.includes('<sync-collection')
    ))).toBe(true);
  });

  it('keeps one five-minute operation deadline across sync and multiget requests', async () => {
    vi.useFakeTimers();
    const hrefs = Array.from({ length: 1_100 }, (_, index) => `${BASE}slow-${index}.vcf`);
    let callIndex = 0;
    safeFetch.mockImplementation((_url, options) => {
      const index = callIndex++;
      const xml = index === 0
        ? syncPageXml(hrefs, 'opaque-after')
        : multigetXml(hrefs.slice((index - 1) * 100, index * 100));
      return new Promise((resolve, reject) => {
        let timer;
        const onAbort = () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        };
        timer = setTimeout(() => {
          options.signal.removeEventListener('abort', onAbort);
          resolve(davResponse(xml));
        }, 29_000);
        options.signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const request = fetchAddressBookDelta({
      url: BASE,
      syncToken: 'opaque-before',
      supportsSyncCollection: true,
      username: 'user',
      password: 'app-password',
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV server did not respond (timed out)',
    });

    await vi.advanceTimersByTimeAsync(300_001);
    await rejection;

    expect(safeFetch).toHaveBeenCalledTimes(11);
    expect(safeFetch.mock.calls.some(([, options]) => (
      options.body.includes('<C:addressbook-query')
    ))).toBe(false);
  });
});

describe('incremental request builders', () => {
  it('builds an initial sync-collection request with an empty token and sync level 1', () => {
    const body = buildSyncCollectionBody('');

    expect(body).toContain('<sync-token></sync-token>');
    expect(body).toContain('<sync-level>1</sync-level>');
    expect(body).toContain('<getetag/>');
  });

  it('XML-escapes opaque sync tokens', () => {
    const body = buildSyncCollectionBody('https://opaque.example/token?x=1&y=<two>');

    expect(body).toContain('https://opaque.example/token?x=1&amp;y=&lt;two&gt;');
    expect(body).not.toContain('x=1&y=');
  });

  it('builds an addressbook-multiget request with XML-escaped hrefs', () => {
    const body = buildMultigetBody(['/dav/a&b.vcf', '/dav/<c>.vcf']);

    expect(body).toContain('<C:addressbook-multiget');
    expect(body).toContain('<D:getetag/>');
    expect(body).toContain('<C:address-data/>');
    expect(body).toContain('<D:href>/dav/a&amp;b.vcf</D:href>');
    expect(body).toContain('<D:href>/dav/&lt;c&gt;.vcf</D:href>');
  });
});

describe('parseSyncPage', () => {
  it('parses changed resources, response-level removals, and 507 continuation', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>a.vcf</d:href><d:propstat><d:prop><d:getetag>"remote-a"</d:getetag></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>gone.vcf</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
  <d:response><d:href>./</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
  <d:sync-token>https://opaque.example/token?x=1&amp;y=2</d:sync-token>
</d:multistatus>`;

    expect(parseSyncPage(xml, BASE)).toEqual({
      changed: [{ href: `${BASE}a.vcf`, etag: '"remote-a"' }],
      removed: [{ href: `${BASE}gone.vcf` }],
      nextToken: 'https://opaque.example/token?x=1&y=2',
      truncated: true,
    });
  });

  it('classifies a response-level 507 against the final request URL', async () => {
    const finalUrl = new URL('../canonical/', BASE).href;
    const originalHrefXml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>${BASE}</d:href>
        <d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
      <d:sync-token>must-not-continue</d:sync-token>
    </d:multistatus>`;
    const finalHrefXml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>./</d:href>
        <d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
      <d:sync-token>continue-from-final-url</d:sync-token>
    </d:multistatus>`;
    safeFetch
      .mockResolvedValueOnce({ ...davResponse(originalHrefXml), url: finalUrl })
      .mockResolvedValueOnce({ ...davResponse(finalHrefXml), url: finalUrl });

    await expect(fetchSyncPage({
      url: BASE,
      syncToken: 'opaque-before',
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({ code: 'ERR_DAV_HREF_SCOPE' });
    await expect(fetchSyncPage({
      url: BASE,
      syncToken: 'opaque-before',
      username: 'user',
      password: 'app-password',
    })).resolves.toMatchObject({
      nextToken: 'continue-from-final-url',
      truncated: true,
    });
  });

  it('rejects a complete initial page without a usable sync token', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:sync-token></D:sync-token></D:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow('usable sync token');
  });

  it('rejects a response without a DAV multistatus document', () => {
    expect(() => parseSyncPage('<html><body>proxy error</body></html>', BASE))
      .toThrow('DAV multistatus');
  });

  it('rejects a failed propstat even when another propstat succeeds', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>a&amp;b.vcf</d:href>
      <d:propstat><d:prop><d:getetag>stale</d:getetag></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
      <d:propstat><d:prop><d:getetag>"current"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response><d:sync-token>next</d:sync-token></d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 404,
    }));
  });

  it('keeps a changed resource whose strong ETag has an empty opaque value', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>empty.vcf</d:href>
      <d:propstat><d:prop><d:getetag>""</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response><d:sync-token>next</d:sync-token></d:multistatus>`;

    expect(parseSyncPage(xml, BASE).changed).toEqual([
      { href: `${BASE}empty.vcf`, etag: '""' },
    ]);
  });

  it('throws for an unexpected response-level status without returning its token', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>blocked.vcf</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>
      <d:sync-token>must-not-advance</d:sync-token>
    </d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 403,
    }));
  });

  it('rejects a 507 propstat on the request URI', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>./</d:href><d:propstat><d:prop/>
        <d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:propstat></d:response>
      <d:sync-token>continue-from-here</d:sync-token>
    </d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 507,
    }));
  });

  it('rejects a response-level 507 on a collection member', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>member.vcf</d:href>
        <d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
      <d:sync-token>must-not-continue</d:sync-token>
    </d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 507,
    }));
  });

  it.each([
    { name: 'missing', href: '' },
    { name: 'sibling', href: '/remote.php/dav/addressbooks/users/brmiller/sibling/' },
    { name: 'nested', href: 'nested/member.vcf' },
  ])('rejects a response-level 507 with a $name href', ({ href }) => {
    const hrefElement = href ? `<d:href>${href}</d:href>` : '';
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response>${hrefElement}<d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
      <d:sync-token>must-not-continue</d:sync-token>
    </d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE)).toThrow();
  });

  it('rejects a truncated page without a usable continuation token', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>./</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>
      <d:sync-token>   </d:sync-token>
    </d:multistatus>`;

    expect(() => parseSyncPage(xml, BASE))
      .toThrow('CardDAV sync response was truncated without a continuation token');
  });
});

describe('parseMultigetCards', () => {
  it('returns successful cards and response-level 404s in response order', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>a&amp;b.vcf</d:href><d:propstat><d:prop>
    <d:getetag>"remote-a"</d:getetag><C:address-data>BEGIN:VCARD
UID:a
FN:A &amp; B
END:VCARD</C:address-data>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>gone.vcf</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
</d:multistatus>`;

    expect(parseMultigetCards(xml, BASE)).toEqual([
      {
        href: `${BASE}a&b.vcf`,
        etag: '"remote-a"',
        vcard: 'BEGIN:VCARD\nUID:a\nFN:A & B\nEND:VCARD',
      },
      { href: `${BASE}gone.vcf`, status: 404 },
    ]);
  });

  it('throws a typed error for an unexpected per-resource status', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>blocked.vcf</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>
    </d:multistatus>`;

    expect(() => parseMultigetCards(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      message: `CardDAV multiget failed for ${BASE}blocked.vcf (403)`,
      status: 403,
      precondition: null,
    }));
  });

  it('rejects a successful resource without non-empty address-data', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <d:response><d:href>empty.vcf</d:href><d:propstat><d:prop>
        <d:getetag>"empty"</d:getetag><C:address-data>   </C:address-data>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`;

    expect(() => parseMultigetCards(xml, BASE)).toThrow('address-data');
  });

  it.each([
    {
      name: 'wrong-namespace address-data',
      properties: `<d:getetag>etag</d:getetag><X:address-data>BEGIN:VCARD
FN:Poison
END:VCARD</X:address-data>`,
    },
    {
      name: 'missing DAV getetag',
      properties: `<C:address-data>BEGIN:VCARD
FN:Missing ETag
END:VCARD</C:address-data>`,
    },
    {
      name: 'wrong-namespace getetag',
      properties: `<X:getetag>etag</X:getetag><C:address-data>BEGIN:VCARD
FN:Poison
END:VCARD</C:address-data>`,
    },
  ])('rejects a successful resource with $name', ({ properties }) => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"
      xmlns:X="urn:not-carddav"><d:response><d:href>partial.vcf</d:href><d:propstat><d:prop>
      ${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response></d:multistatus>`;

    expect(() => parseMultigetCards(xml, BASE)).toThrow(/getetag|address-data/i);
  });

  it('rejects a propstat-level 404 instead of treating it as a removal', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <d:response><d:href>gone.vcf</d:href><d:propstat><d:prop>
        <d:getetag>stale</d:getetag><C:address-data>BEGIN:VCARD
FN:Stale
END:VCARD</C:address-data>
      </d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
    </d:multistatus>`;

    expect(() => parseMultigetCards(xml, BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 404,
    }));
  });
});

describe('fetchCardsByHref completeness', () => {
  it('rejects an empty multiget input before requesting it', async () => {
    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: [],
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/non-empty|href/i);

    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('rejects duplicate normalized multiget inputs before requesting them', async () => {
    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: ['card.vcf', `${BASE}card.vcf`],
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/duplicate|unique/i);

    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('normalizes a relative requested href once for the body and result identity', async () => {
    const href = `${BASE}card.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse(multigetXml([href])));

    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: ['card.vcf'],
      username: 'user',
      password: 'app-password',
    })).resolves.toEqual([expect.objectContaining({ href })]);

    expect(safeFetch.mock.calls[0][1].body).toContain(`<D:href>${href}</D:href>`);
    expect(safeFetch.mock.calls[0][1].body).not.toContain('<D:href>card.vcf</D:href>');
  });

  it('rejects a batch when a requested href has no terminal response', async () => {
    safeFetch.mockResolvedValueOnce(davResponse('<d:multistatus xmlns:d="DAV:"/>'));

    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: [`${BASE}missing.vcf`],
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('missing.vcf');
  });

  it('rejects a batch when a requested href has multiple terminal responses', async () => {
    const href = `${BASE}duplicate.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse(multigetXml([href, href])));

    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: [href],
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow('duplicate.vcf');
  });

  it('rejects a batch containing an extra unrequested result', async () => {
    const requested = `${BASE}requested.vcf`;
    const extra = `${BASE}extra.vcf`;
    safeFetch.mockResolvedValueOnce(davResponse(multigetXml([requested, extra])));

    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: [requested],
      username: 'user',
      password: 'app-password',
    })).rejects.toThrow(/extra|unrequested|terminal/i);
  });

  it.each([
    ['sibling', '/remote.php/dav/addressbooks/users/brmiller/sibling.vcf'],
    ['parent', '../parent.vcf'],
    ['nested', 'nested/card.vcf'],
    ['cross-origin', 'https://evil.example.test/card.vcf'],
    ['credential-bearing', 'https://user:secret@cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/card.vcf'],
    ['fragment', 'card.vcf#fragment'],
  ])('rejects an out-of-scope %s multiget response', async (_name, responseHref) => {
    const xml = multigetXml([responseHref]);
    safeFetch.mockResolvedValueOnce(davResponse(xml));

    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: [`${BASE}card.vcf`],
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({ code: 'ERR_DAV_HREF_SCOPE' });
  });

  it('rejects an out-of-scope requested href before requesting it', async () => {
    await expect(fetchCardsByHref({
      url: BASE,
      hrefs: ['nested/card.vcf'],
      username: 'user',
      password: 'app-password',
    })).rejects.toMatchObject({ code: 'ERR_DAV_HREF_SCOPE' });

    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe('CardDavError', () => {
  it('preserves status, DAV precondition, cause, and response body parsing', async () => {
    const responseBody = `<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`;
    const response = davResponse(responseBody, 403, 'Forbidden');
    safeFetch.mockResolvedValue(response);

    const request = fetchAddressBookCards({
      url: BASE,
      username: 'user',
      password: 'app-password',
    });

    await expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV request failed (403 Forbidden)',
      status: 403,
      requestStatus: 403,
      precondition: 'valid-sync-token',
    });
    expect(response.bodyRead).toHaveBeenCalledTimes(2);

    const cause = new Error('socket closed');
    expect(new CardDavError('failed', { status: 500, cause })).toMatchObject({
      name: 'CardDavError',
      status: 500,
      precondition: null,
      cause,
    });
  });

  it('keeps the existing user-facing authentication message', async () => {
    const response = davResponse('', 401, 'Unauthorized');
    safeFetch.mockResolvedValue(response);

    const request = fetchAddressBookCards({
      url: BASE,
      username: 'user',
      password: 'wrong-password',
    });

    await expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'Authentication failed — check the username and app password',
      status: 401,
    });
    expect(response.bodyRead).toHaveBeenCalledOnce();
  });

  it('wraps timeouts with the timeout message and original cause', async () => {
    const cause = new Error('request expired');
    cause.name = 'TimeoutError';
    safeFetch.mockRejectedValue(cause);

    const request = fetchAddressBookCards({
      url: BASE,
      username: 'user',
      password: 'app-password',
    });

    await expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'CardDAV server did not respond (timed out)',
      status: null,
      precondition: null,
      cause,
    });
  });

  it('wraps network failures with the reachability message and original cause', async () => {
    const cause = new Error('socket closed');
    safeFetch.mockRejectedValue(cause);

    const request = fetchAddressBookCards({
      url: BASE,
      username: 'user',
      password: 'app-password',
    });

    await expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'Could not reach the CardDAV server: socket closed',
      status: null,
      precondition: null,
      cause,
    });
  });

  it('short-circuits principal discovery on a typed 401 response', async () => {
    const response = davResponse('', 401, 'Unauthorized');
    safeFetch.mockResolvedValue(response);

    const request = discoverAddressBooks({
      serverUrl: BASE,
      username: 'user',
      password: 'wrong-password',
    });

    await expect(request).rejects.toMatchObject({
      name: 'CardDavError',
      message: 'Authentication failed — check the username and app password',
      status: 401,
    });
    expect(safeFetch).toHaveBeenCalledOnce();
  });
});
