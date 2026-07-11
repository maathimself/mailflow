import { describe, it, expect } from 'vitest';
import { parseAddressBooks, parseCards, extractHref } from './carddavClient.js';
import { parseVCard } from '../utils/vcard.js';

const BASE = 'https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/';

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
});

describe('parseAddressBooks', () => {
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
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const books = parseAddressBooks(xml, BASE);
    expect(books).toHaveLength(1); // the plain collection is excluded
    expect(books[0].displayName).toBe('Contacts');
    expect(books[0].url).toBe('https://cloud.example.com/remote.php/dav/addressbooks/users/brmiller/contacts/');
  });

  it('is namespace-prefix agnostic (uppercase D:/C:)', () => {
    const xml = `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response><D:href>/dav/work/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Work</D:displayname></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;
    const books = parseAddressBooks(xml, BASE);
    expect(books).toHaveLength(1);
    expect(books[0].displayName).toBe('Work');
  });
});

describe('parseCards', () => {
  it('rejects a truncated address-book response', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav/c/uid1.vcf</d:href>
    <d:propstat><d:prop><card:address-data>BEGIN:VCARD
UID:uid1
FN:Jane Doe
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response><d:href>/dav/c/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status>
    <d:error><d:number-of-matches-within-limits/></d:error></d:response>
</d:multistatus>`;
    expect(() => parseCards(xml, BASE))
      .toThrow('CardDAV server returned a truncated address book response');
  });

  it('extracts vCards + etags and skips entries without address-data', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response>
    <d:href>/dav/contacts/</d:href>
    <d:propstat><d:prop><d:getetag>"coll"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/contacts/uid1.vcf</d:href>
    <d:propstat><d:prop>
      <d:getetag>"abc123"</d:getetag>
      <card:address-data>BEGIN:VCARD
VERSION:3.0
UID:uid1
FN:John Doe
EMAIL;TYPE=WORK:john@example.com
END:VCARD</card:address-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
    const cards = parseCards(xml, BASE);
    expect(cards).toHaveLength(1); // the collection self-entry (no address-data) is skipped
    expect(cards[0].etag).toBe('abc123'); // quotes stripped
    expect(cards[0].url ?? cards[0].href).toContain('uid1.vcf');
    expect(cards[0].vcard.startsWith('BEGIN:VCARD')).toBe(true);

    // The vCard round-trips through the existing parser into a contact shape.
    const parsed = parseVCard(cards[0].vcard);
    expect(parsed.uid).toBe('uid1');
    expect(parsed.displayName).toBe('John Doe');
    expect(parsed.emails[0].value).toBe('john@example.com');
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
    const parsed = parseVCard(parseCards(xml, BASE)[0].vcard);
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
    const cards = parseCards(xml, BASE);
    expect(cards[0].vcard).toContain('Tom & Jerry');
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
    const cards = parseCards(xml, BASE);
    expect(cards).toHaveLength(N);
    expect(cards[0].vcard).toContain('Tom <0> Ltd'); // entities still decoded
  });
});
