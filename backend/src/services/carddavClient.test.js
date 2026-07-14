import { describe, it, expect } from 'vitest';
import {
  canonicalCollectionUrl,
  parseAddressBooks,
  parseCards,
  extractHref,
} from './carddavClient.js';
import { parseVCard } from '../utils/vcard.js';

const BASE = 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/';
const BOOK_BASE = 'https://cloud.example.com/dav/c/';
const CONTACTS_BASE = 'https://cloud.example.com/dav/contacts/';

describe('canonicalCollectionUrl', () => {
  it.each([
    ['HTTPS://Example.COM:443/a/../%62ooks?view=%7e', 'https://example.com/books/?view=~'],
    ['https://example.com/books', 'https://example.com/books/'],
    ['https://example.com/a%2fb', 'https://example.com/a%2Fb/'],
    ['/books', 'https://example.com/books/'],
  ])('canonicalizes %s', (raw, expected) => {
    expect(canonicalCollectionUrl(raw, 'https://example.com/')).toBe(expected);
  });

  it.each([
    ['https://example.com:8443/books', 'https://example.com:8443/books/'],
    ['https://example.com/Books', 'https://example.com/Books/'],
    ['https://example.com/books//', 'https://example.com/books//'],
    ['https://example.com/a/b/', 'https://example.com/a/b/'],
    ['https://example.com/books?b=2&a=1', 'https://example.com/books/?b=2&a=1'],
    ['https://example.com/books?a=1&b=2', 'https://example.com/books/?a=1&b=2'],
  ])('preserves distinct identity for %s', (value, expected) => {
    expect(canonicalCollectionUrl(value)).toBe(expected);
  });

  it.each([
    'not a url',
    'ftp://example.com/books',
    'https://user:pass@example.com/books',
    'https://example.com/books#fragment',
  ])('rejects invalid collection URL %s', value => {
    expect(() => canonicalCollectionUrl(value)).toThrow();
  });
});

describe('extractHref (discovery)', () => {
  it('pulls current-user-principal href, resolving relative to origin', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/remote.php/dav/</d:href>
        <d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/brmiller/</d:href></d:current-user-principal></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      </d:response></d:multistatus>`;
    expect(extractHref(xml, 'current-user-principal', 'https://cloud.example.com/remote.php/dav/'))
      .toBe('https://cloud.example.com/remote.php/dav/principals/users/brmiller/');
  });

  it('pulls addressbook-home-set href across a carddav namespace prefix', () => {
    // This is the exact shape that the old key-derivation bug failed on.
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
      <d:response><d:href>/remote.php/dav/principals/users/brmiller/</d:href>
        <d:propstat><d:prop><card:addressbook-home-set><d:href>/remote.php/dav/addressbooks/users/brmiller/</d:href></card:addressbook-home-set></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      </d:response></d:multistatus>`;
    expect(extractHref(xml, 'addressbook-home-set', 'https://cloud.example.com/remote.php/dav/principals/users/brmiller/'))
      .toBe('https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/');
  });

  it('returns null when the property is absent', () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href>
      <d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`;
    expect(extractHref(xml, 'current-user-principal', BASE)).toBeNull();
  });

  it('does not accept a same-local-name property from a foreign namespace', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:X="urn:not-dav"><D:response>
      <D:href>/remote.php/dav/</D:href><D:propstat><D:prop>
        <X:current-user-principal><D:href>/poison/</D:href></X:current-user-principal>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;

    expect(extractHref(xml, 'current-user-principal', BASE)).toBeNull();
  });
});

describe('parseAddressBooks', () => {
  it('preserves discovery order, direct privileges, and ordered address-data attributes', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>personal/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <D:current-user-privilege-set>
          <D:privilege><D:bind/></D:privilege>
          <D:privilege><D:write-content/></D:privilege>
        </D:current-user-privilege-set>
        <C:supported-address-data>
          <C:address-data-type content-type="text/vcard" version="4.0"/>
          <C:address-data-type content-type="text/x-vcard" version="3.0"/>
          <C:address-data-type/>
          <C:address-data-type content-type="text/x-vcard"/>
          <C:address-data-type version="4.0"/>
        </C:supported-address-data>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>shared/</D:href><D:propstat><D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Shared</D:displayname>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(parseAddressBooks(xml, BASE)).toEqual([
      {
        url: `${BASE}personal/`,
        displayName: 'Personal',
        supportsSyncCollection: false,
        capabilities: { create: 'allowed', update: 'allowed', delete: 'denied' },
        discoveryIndex: 0,
        addressData: [
          { contentType: 'text/vcard', version: '4.0' },
          { contentType: 'text/x-vcard', version: '3.0' },
          { contentType: 'text/vcard', version: '3.0' },
          { contentType: 'text/x-vcard', version: '3.0' },
          { contentType: 'text/vcard', version: '4.0' },
        ],
      },
      {
        url: `${BASE}shared/`,
        displayName: 'Shared',
        supportsSyncCollection: false,
        capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
        discoveryIndex: 1,
        addressData: [],
      },
    ]);
  });

  it('expands DAV write and all aggregate privileges', () => {
    const bookResponse = (href, privilege) => `<D:response><D:href>${href}</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:current-user-privilege-set><D:privilege><D:${privilege}/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat></D:response>
      ${bookResponse('write/', 'write')}${bookResponse('all/', 'all')}
    </D:multistatus>`;

    expect(parseAddressBooks(xml, BASE).map(book => book.capabilities)).toEqual([
      { create: 'allowed', update: 'allowed', delete: 'allowed' },
      { create: 'allowed', update: 'allowed', delete: 'allowed' },
    ]);
  });

  it('collapses equivalent collection spellings while preserving first response order', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/remote.php/dav/addressbooks/users/brmiller/%63ontacts</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(parseAddressBooks(xml, BASE)).toEqual([{
      url: 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/',
      displayName: 'Contacts',
      supportsSyncCollection: false,
      capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
      discoveryIndex: 0,
      addressData: [],
    }]);
  });

  it('rejects equivalent duplicates with conflicting metadata', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/remote.php/dav/addressbooks/users/brmiller/contacts/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>/remote.php/dav/addressbooks/users/brmiller/%63ontacts</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Other</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(() => parseAddressBooks(xml, BASE)).toThrow(/canonical|conflict|metadata/i);
  });

  it('returns only addressbook collections, resolving relative hrefs', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/remote.php/dav/addressbooks/users/brmiller/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/addressbooks/users/brmiller/contacts/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
      <d:displayname>Contacts</d:displayname>
      <cs:getctag>42</cs:getctag>
      <d:supported-report-set>
        <d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>
      </d:supported-report-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const books = parseAddressBooks(xml, BASE);
    expect(books).toEqual([{
      url: 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/',
      displayName: 'Contacts',
      supportsSyncCollection: true,
      capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
      discoveryIndex: 0,
      addressData: [],
    }]);
  });

  it('is namespace-prefix agnostic (uppercase D:/C:)', () => {
    const xml = `<multistatus xmlns="DAV:" xmlns:potato="urn:ietf:params:xml:ns:carddav">
  <response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop>
    <status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/dav/work/</href>
    <propstat><prop><resourcetype><collection/><potato:addressbook/></resourcetype><displayname>Work</displayname></prop>
    <status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;
    const books = parseAddressBooks(xml, 'https://cloud.example.com/dav/');
    expect(books).toEqual([{
      url: 'https://cloud.example.com/dav/work/',
      displayName: 'Work',
      supportsSyncCollection: false,
      capabilities: { create: 'unknown', update: 'unknown', delete: 'unknown' },
      discoveryIndex: 0,
      addressData: [],
    }]);
  });

  it('returns an authoritative empty list when only the home collection self response exists', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${BASE}</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;

    expect(parseAddressBooks(xml, BASE)).toEqual([]);
  });

  it('accepts literal at signs and percent-encoded delimiters in collection path segments', () => {
    const hrefs = ['book@team/', 'book%40team/', 'book%23team/'];
    const responses = hrefs.map(href => `<D:response><D:href>${href}</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/>
      </D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response>`).join('');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat></D:response>${responses}</D:multistatus>`;

    expect(parseAddressBooks(xml, BASE).map(book => book.url)).toEqual(
      hrefs.map(href => new URL(href, BASE).href),
    );
  });

  it('ignores a complete non-addressbook child after examining its resourcetype', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${BASE}</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      <D:response><D:href>notes.txt</D:href><D:propstat><D:prop><D:resourcetype/>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(parseAddressBooks(xml, BASE)).toEqual([]);
  });

  it('rejects an empty multistatus without the required home collection self response', () => {
    expect(() => parseAddressBooks('<D:multistatus xmlns:D="DAV:"/>', BASE))
      .toThrow(/self response|home collection/i);
  });

  it.each([
    {
      name: 'address book missing its href',
      response: `<D:response><D:propstat><D:prop><D:resourcetype>
        <D:collection/><C:addressbook/></D:resourcetype></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    },
    {
      name: 'foreign addressbook lookalike',
      response: `<D:response><D:href>poison/</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/><X:addressbook/></D:resourcetype></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    },
    {
      name: 'malformed propstat',
      response: `<D:response><D:href>broken/</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/><C:addressbook/></D:resourcetype></D:prop></D:propstat></D:response>`,
    },
    {
      name: 'member outside the home collection',
      response: `<D:response><D:href>/remote.php/dav/addressbooks/users/brmiller-evil/contacts/</D:href>
        <D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    },
  ])('rejects incomplete discovery: $name', ({ response }) => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"
      xmlns:X="urn:not-carddav"><D:response><D:href>${BASE}</D:href>
      <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${response}</D:multistatus>`;

    expect(() => parseAddressBooks(xml, BASE)).toThrow();
  });

  it('rejects the 1,001st discovery response', () => {
    const responses = Array.from({ length: 1_000 }, (_, index) => `<D:response>
      <D:href>book-${index}/</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/><C:addressbook/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${BASE}</D:href><D:propstat><D:prop><D:resourcetype>
        <D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat></D:response>${responses}</D:multistatus>`;

    expect(() => parseAddressBooks(xml, BASE)).toThrow(/1,000|discovery response/i);
  });
});

describe('parseCards', () => {
  it('accepts an exact empty DAV multistatus as a complete snapshot', () => {
    expect(parseCards('<D:multistatus xmlns:D="DAV:"/>', BOOK_BASE)).toEqual([]);
  });

  it('ignores a canonical collection self response expressed as ./', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>./</D:href>
      <D:propstat><D:prop><D:getetag>collection</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

    expect(parseCards(xml, BOOK_BASE)).toEqual([]);
  });

  it.each([
    '<html><body>proxy error</body></html>',
    '<X:multistatus xmlns:X="urn:not-dav"/>',
  ])('rejects a non-DAV snapshot document', xml => {
    expect(() => parseCards(xml, BOOK_BASE)).toThrow(/DAV multistatus/);
  });

  it('rejects a truncated address-book response', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/uid1.vcf</d:href>
    <d:propstat><d:prop><d:getetag>etag</d:getetag><card:address-data>BEGIN:VCARD
UID:uid1
FN:Jane Doe
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response><d:href>/dav/c/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status>
    <d:error><d:number-of-matches-within-limits/></d:error></d:response>
</d:multistatus>`;
    expect(() => parseCards(xml, BOOK_BASE))
      .toThrow('CardDAV server returned a truncated address book response');
  });

  it('extracts vCards and ignores a well-formed canonical collection self response', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response>
    <d:href>/dav/contacts/</d:href>
    <d:propstat><d:prop><d:getetag>"coll"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/contacts/uid1.vcf</d:href>
    <d:propstat><d:prop>
      <d:getetag>W/"abc123"</d:getetag>
      <card:address-data>BEGIN:VCARD
VERSION:3.0
UID:uid1
FN:John Doe
EMAIL;TYPE=WORK:john@example.com
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const cards = parseCards(xml, CONTACTS_BASE);
    expect(cards).toHaveLength(1); // the collection self-entry (no address-data) is skipped
    expect(cards[0].etag).toBe('W/"abc123"');
    expect(cards[0].url ?? cards[0].href).toContain('uid1.vcf');
    expect(cards[0].vcard.startsWith('BEGIN:VCARD')).toBe(true);

    // The vCard round-trips through the existing parser into a contact shape.
    const parsed = parseVCard(cards[0].vcard);
    expect(parsed.uid).toBe('uid1');
    expect(parsed.displayName).toBe('John Doe');
    expect(parsed.emails[0].value).toBe('john@example.com');
  });

  it('rejects a failed member propstat instead of returning a partial snapshot', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/stale.vcf</d:href><d:propstat><d:prop>
    <d:getetag>stale</d:getetag><card:address-data>BEGIN:VCARD
UID:stale
FN:Stale Contact
END:VCARD</card:address-data>
  </d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
  <d:response><d:href>/dav/c/current.vcf</d:href><d:propstat><d:prop>
    <d:getetag>current</d:getetag><card:address-data>BEGIN:VCARD
UID:current
FN:Current Contact
END:VCARD</card:address-data>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 404,
    }));
  });

  it.each([
    {
      name: 'missing href',
      response: `<D:response><D:propstat><D:prop><D:getetag>etag</D:getetag>
        <C:address-data>BEGIN:VCARD\nFN:Missing href\nEND:VCARD</C:address-data></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    },
    {
      name: 'propstat missing status',
      response: `<D:response><D:href>broken.vcf</D:href><D:propstat><D:prop>
        <D:getetag>etag</D:getetag><C:address-data>BEGIN:VCARD\nFN:Broken\nEND:VCARD</C:address-data>
      </D:prop></D:propstat></D:response>`,
    },
  ])('rejects a malformed snapshot response: $name', ({ response }) => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      ${response}</D:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow();
  });

  it('rejects a failed response-level member status', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>gone.vcf</D:href>
      <D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow(expect.objectContaining({
      name: 'CardDavError',
      status: 404,
    }));
  });

  it.each([
    {
      name: 'missing CardDAV address-data',
      properties: '<D:getetag>etag</D:getetag>',
    },
    {
      name: 'foreign address-data lookalike',
      properties: `<D:getetag>etag</D:getetag><X:address-data>BEGIN:VCARD
FN:Poison
END:VCARD</X:address-data>`,
    },
    {
      name: 'missing DAV getetag',
      properties: `<C:address-data>BEGIN:VCARD
FN:No ETag
END:VCARD</C:address-data>`,
    },
  ])('rejects a partial snapshot member: $name', ({ properties }) => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"
      xmlns:X="urn:not-carddav"><D:response><D:href>partial.vcf</D:href><D:propstat><D:prop>
      ${properties}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response></D:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow();
  });

  it.each([
    'https://evil.example.test/dav/c/card.vcf',
    'https://user:secret@cloud.example.com/dav/c/card.vcf',
    'card.vcf#fragment',
    '/dav/c-evil/card.vcf',
    '/dav/c/../escape.vcf',
    'nested/card.vcf',
    'nested%2Fcard.vcf',
    'nested%5Ccard.vcf',
  ])('rejects a snapshot member outside direct collection scope: %s', href => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>etag</D:getetag>
        <C:address-data>BEGIN:VCARD\nFN:Out of scope\nEND:VCARD</C:address-data>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow(/href|scope|collection|origin/i);
  });

  it.each([
    { name: 'empty fragment', href: 'card.vcf#' },
    { name: 'empty userinfo', href: 'https://@cloud.example.com/dav/c/card.vcf' },
  ])('rejects a snapshot href with $name', ({ href }) => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getetag>etag</D:getetag>
        <C:address-data>BEGIN:VCARD\nFN:Out of scope\nEND:VCARD</C:address-data>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(() => parseCards(xml, BOOK_BASE)).toThrow(/credentials|fragment/i);
  });

  it('accepts literal at signs and percent-encoded delimiters in member path segments', () => {
    const hrefs = ['person@company.vcf', 'person%40company.vcf', 'card%23.vcf'];
    const responses = hrefs.map(href => `<D:response><D:href>${href}</D:href>
      <D:propstat><D:prop><D:getetag>etag</D:getetag><C:address-data>
      BEGIN:VCARD\nFN:Valid member\nEND:VCARD</C:address-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      ${responses}</D:multistatus>`;

    expect(parseCards(xml, BOOK_BASE).map(card => card.href)).toEqual(
      hrefs.map(href => new URL(href, BOOK_BASE).href),
    );
  });

  it('preserves numeric-looking ETags and exact vCard whitespace after entity decoding', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
      <D:response><D:href>opaque.vcf?rev=001</D:href><D:propstat><D:prop>
        <D:getetag>0007</D:getetag><C:address-data>  BEGIN:VCARD
FN:A &amp; B
END:VCARD  </C:address-data>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    </D:multistatus>`;

    expect(parseCards(xml, BOOK_BASE)).toEqual([{
      href: `${BOOK_BASE}opaque.vcf?rev=001`,
      etag: '0007',
      vcard: '  BEGIN:VCARD\nFN:A & B\nEND:VCARD  ',
    }]);
  });

  it('maps a Nextcloud vCard with grouped (item1.EMAIL) properties', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/g.vcf</d:href>
    <d:propstat><d:prop><d:getetag>g1</d:getetag>
      <card:address-data>BEGIN:VCARD
VERSION:3.0
UID:grp-1
FN:Jane Roe
item1.EMAIL;TYPE=INTERNET:jane@example.com
item1.X-ABLabel:Work
item2.TEL;TYPE=CELL:+15551234567
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const parsed = parseVCard(parseCards(xml, BOOK_BASE)[0].vcard);
    expect(parsed.uid).toBe('grp-1');
    expect(parsed.emails[0].value).toBe('jane@example.com'); // grouped email is not lost
    expect(parsed.phones[0].value).toBe('+15551234567');
  });

  it('decodes XML entities inside address-data', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/x.vcf</d:href>
    <d:propstat><d:prop><d:getetag>e</d:getetag>
      <card:address-data>BEGIN:VCARD
FN:Tom &amp; Jerry
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const cards = parseCards(xml, BOOK_BASE);
    expect(cards[0].vcard).toContain('Tom & Jerry');
  });

  it('decodes numeric XML character references inside address-data', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/numeric.vcf</d:href>
    <d:propstat><d:prop><d:getetag>e</d:getetag>
      <card:address-data>BEGIN:VCARD&#13;
FN:Jane&#x20;Doe&#13;
PHOTO;ENCODING=b;TYPE=PNG:AQID&#13;
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

    const card = parseCards(xml, BOOK_BASE)[0];
    expect(card.vcard).toBe([
      'BEGIN:VCARD',
      'FN:Jane Doe',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
      'END:VCARD',
    ].join('\r\n'));
    expect(parseVCard(card.vcard)).toMatchObject({
      displayName: 'Jane Doe',
      photoData: 'data:image/png;base64,AQID',
    });
  });

  it('parses a large book whose response exceeds 1000 XML entity references', () => {
    // Regression: fast-xml-parser >=4.5.5 defaults maxTotalExpansions to 1000.
    // A real address book's REPORT response carries far more counted entity
    // references than that (&lt; / &gt; / &quot; in vCard data), so the whole
    // sync was rejected with "Entity expansion limit exceeded".
    const N = 1500;
    const responses = Array.from({ length: N }, (_, i) => `
  <d:response><d:href>/dav/c/uid${i}.vcf</d:href>
    <d:propstat><d:prop><d:getetag>"e${i}"</d:getetag>
      <card:address-data>BEGIN:VCARD
VERSION:3.0
UID:uid${i}
ORG:Tom &lt;${i}&gt; Ltd
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`).join('');
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`;
    const cards = parseCards(xml, BOOK_BASE);
    expect(cards).toHaveLength(N);
    expect(cards[0].vcard).toContain('Tom <0> Ltd'); // entities still decoded
  });
});
