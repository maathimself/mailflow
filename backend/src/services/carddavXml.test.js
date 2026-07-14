import { describe, expect, it, vi } from 'vitest';
import {
  CARDDAV_NS,
  DAV_NS,
  childrenNamed,
  onlyChildNamed,
  parseDavErrorPrecondition,
  parseDavMultistatus,
  parseDavResponse,
  parseXmlDocument,
  successfulProperties,
  textOfNode,
  xmlEscape,
} from './carddavXml.js';

describe('xmlEscape', () => {
  it('escapes all five predefined XML entities', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

describe('namespace-aware DAV XML parsing', () => {
  it('requires the exact DAV namespace for multistatus', () => {
    expect(() => parseDavMultistatus(
      '<X:multistatus xmlns:X="urn:not-dav"/>',
      'sync response',
    )).toThrow(/DAV multistatus/);
  });

  it.each([
    '<multistatus xmlns="DAV:"><sync-token>next</sync-token></multistatus>',
    '<potato:multistatus xmlns:potato="DAV:"><potato:sync-token>next</potato:sync-token></potato:multistatus>',
  ])('accepts DAV elements with any bound prefix spelling', xml => {
    const root = parseDavMultistatus(xml, 'sync response');

    expect(root).toMatchObject({
      namespaceURI: DAV_NS,
      localName: 'multistatus',
    });
    expect(textOfNode(onlyChildNamed(root, DAV_NS, 'sync-token'))).toBe('next');
  });

  it('preserves opaque text while decoding standard XML entities', () => {
    const root = parseDavMultistatus(
      '<D:multistatus xmlns:D="DAV:"><D:sync-token> 00123&amp;x </D:sync-token></D:multistatus>',
      'sync response',
    );

    expect(textOfNode(onlyChildNamed(root, DAV_NS, 'sync-token'))).toBe(' 00123&x ');
  });

  it('resolves a nested CardDAV namespace without matching a foreign local name', () => {
    const root = parseDavMultistatus(`<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/contacts/a&amp;b.vcf</D:href><D:propstat><D:prop>
    <address-data xmlns="${CARDDAV_NS}">BEGIN:VCARD
FN:A &amp; B
END:VCARD</address-data>
    <X:address-data xmlns:X="urn:not-carddav">poison</X:address-data>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`, 'multiget response');
    const response = parseDavResponse(
      onlyChildNamed(root, DAV_NS, 'response'),
      'multiget response member',
    );
    const properties = successfulProperties(response);

    expect(response.href).toBe('/contacts/a&b.vcf');
    expect(properties.map(({ namespaceURI, localName }) => [namespaceURI, localName])).toEqual([
      [CARDDAV_NS, 'address-data'],
      ['urn:not-carddav', 'address-data'],
    ]);
    expect(textOfNode(properties[0])).toBe('BEGIN:VCARD\nFN:A & B\nEND:VCARD');
    expect(properties.filter(node => (
      node.namespaceURI === CARDDAV_NS && node.localName === 'address-data'
    ))).toHaveLength(1);
  });

  it('preserves ordered namespace-aware attributes on CardDAV elements', () => {
    const root = parseXmlDocument(`<C:supported-address-data
      xmlns:C="${CARDDAV_NS}" xmlns:X="urn:extension">
      <C:address-data-type content-type="text/vcard" version="4.0" X:label="modern"/>
      <C:address-data-type version="3.0" content-type="text/x-vcard"/>
    </C:supported-address-data>`, 'supported address data');

    expect(root.children.map(node => node.attributes)).toEqual([
      [
        { namespaceURI: null, localName: 'content-type', value: 'text/vcard' },
        { namespaceURI: null, localName: 'version', value: '4.0' },
        { namespaceURI: 'urn:extension', localName: 'label', value: 'modern' },
      ],
      [
        { namespaceURI: null, localName: 'version', value: '3.0' },
        { namespaceURI: null, localName: 'content-type', value: 'text/x-vcard' },
      ],
    ]);
  });

  it('rejects malformed XML, multiple roots, unbound prefixes, and a custom-entity DOCTYPE', () => {
    expect(() => parseXmlDocument(
      '<D:multistatus xmlns:D="DAV:"><D:sync-token></D:multistatus>',
      'sync response',
    )).toThrow(/valid XML/);
    expect(() => parseXmlDocument(
      '<D:multistatus xmlns:D="DAV:"/><D:multistatus xmlns:D="DAV:"/>',
      'sync response',
    )).toThrow(/valid XML|top-level/);
    expect(() => parseXmlDocument('<D:multistatus/>', 'sync response'))
      .toThrow(/unbound namespace prefix/);
    expect(() => parseXmlDocument(
      '<!DOCTYPE D:multistatus [<!ENTITY token "00123">]><D:multistatus xmlns:D="DAV:"><D:sync-token>&token;</D:sync-token></D:multistatus>',
      'sync response',
    )).toThrow(/DOCTYPE/);
  });

  it('rejects an unbound prefixed attribute QName', () => {
    expect(() => parseXmlDocument(
      '<D:error xmlns:D="DAV:" X:spoof="true"><D:valid-sync-token/></D:error>',
      'DAV error response',
    )).toThrow(/unbound namespace prefix "X"/);
  });

  it('rejects a namespace declaration with an empty prefix QName', () => {
    expect(() => parseXmlDocument(
      '<error xmlns:="DAV:"><valid-sync-token/></error>',
      'DAV error response',
    )).toThrow(/invalid namespace declaration/);
  });

  it.each([
    {
      name: 'xml rebound to DAV',
      xml: '<xml:error xmlns:xml="DAV:"><xml:valid-sync-token/></xml:error>',
    },
    {
      name: 'xmlns declared as a normal prefix',
      xml: '<xmlns:error xmlns:xmlns="DAV:"><xmlns:valid-sync-token/></xmlns:error>',
    },
    {
      name: 'another prefix bound to the XML namespace',
      xml: `<D:error xmlns:D="DAV:" xmlns:X="${XML_NS}"><D:valid-sync-token/></D:error>`,
    },
    {
      name: 'a prefix bound to the xmlns namespace',
      xml: `<D:error xmlns:D="DAV:" xmlns:X="${XMLNS_NS}"><D:valid-sync-token/></D:error>`,
    },
  ])('rejects reserved namespace binding: $name', ({ xml }) => {
    expect(() => parseXmlDocument(xml, 'DAV error response')).toThrow(/reserved namespace/);
  });

  it('accepts the implicit xml prefix and its exact reserved binding', () => {
    const root = parseXmlDocument(
      `<D:error xmlns:D="DAV:" xmlns:xml="${XML_NS}" xml:lang="en"><D:valid-sync-token/></D:error>`,
      'DAV error response',
    );

    expect(root).toMatchObject({ namespaceURI: DAV_NS, localName: 'error' });
  });
});

describe('DAV response structure', () => {
  it('requires exactly one required direct child', () => {
    const root = parseDavMultistatus(
      '<D:multistatus xmlns:D="DAV:"><D:sync-token>one</D:sync-token><D:sync-token>two</D:sync-token></D:multistatus>',
      'sync response',
    );

    expect(() => onlyChildNamed(root, DAV_NS, 'sync-token'))
      .toThrow(/exactly one.*sync-token/i);
  });

  it('requires one href and response status XOR one or more propstats', () => {
    const duplicateHref = responseNode(`<D:response xmlns:D="DAV:">
      <D:href>one</D:href><D:href>two</D:href><D:status>HTTP/1.1 200 OK</D:status>
    </D:response>`);
    const mixedShape = responseNode(`<D:response xmlns:D="DAV:">
      <D:href>one</D:href><D:status>HTTP/1.1 200 OK</D:status>
      <D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    </D:response>`);
    const missingShape = responseNode(
      '<D:response xmlns:D="DAV:"><D:href>one</D:href></D:response>',
    );

    expect(() => parseDavResponse(duplicateHref)).toThrow(/exactly one.*href/i);
    expect(() => parseDavResponse(mixedShape)).toThrow(/status.*propstat|propstat.*status/i);
    expect(() => parseDavResponse(missingShape)).toThrow(/status.*propstat|propstat.*status/i);
  });

  it('requires exactly one prop and one parseable status per propstat', () => {
    const missingStatus = responseNode(`<D:response xmlns:D="DAV:">
      <D:href>one</D:href><D:propstat><D:prop><D:getetag>etag</D:getetag></D:prop></D:propstat>
    </D:response>`);
    const invalidStatus = responseNode(`<D:response xmlns:D="DAV:">
      <D:href>one</D:href><D:propstat><D:prop/><D:status>success</D:status></D:propstat>
    </D:response>`);

    expect(() => parseDavResponse(missingStatus)).toThrow(/exactly one.*status/i);
    expect(() => parseDavResponse(invalidStatus)).toThrow(/parseable.*status/i);
  });

  it('returns only ordered properties from successful propstats', () => {
    const response = parseDavResponse(responseNode(`<D:response xmlns:D="DAV:" xmlns:X="urn:extension">
      <D:href> 00123 </D:href>
      <D:propstat><D:prop><D:getetag>0007</D:getetag><X:getetag>extension</X:getetag></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
      <D:propstat><D:prop><D:getetag>stale</D:getetag></D:prop>
        <D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
    </D:response>`));

    expect(response.href).toBe(' 00123 ');
    expect(response.status).toBeNull();
    expect(response.propstats.map(({ status }) => status)).toEqual([200, 404]);
    expect(successfulProperties(response).map(node => ({
      namespaceURI: node.namespaceURI,
      localName: node.localName,
      text: textOfNode(node),
    }))).toEqual([
      { namespaceURI: DAV_NS, localName: 'getetag', text: '0007' },
      { namespaceURI: 'urn:extension', localName: 'getetag', text: 'extension' },
    ]);
  });
});

describe('parseDavErrorPrecondition', () => {
  it('finds an exact DAV valid-sync-token after another DAV child', () => {
    expect(parseDavErrorPrecondition(
      '<anything:error xmlns:anything="DAV:"><anything:other/><anything:valid-sync-token/></anything:error>',
    )).toBe('valid-sync-token');
  });

  it.each([
    '',
    'not XML',
    '<html><body>Forbidden</body></html>',
    '<X:error xmlns:X="urn:not-dav"><X:valid-sync-token/></X:error>',
    '<D:error xmlns:D="DAV:" xmlns:X="urn:not-dav"><X:valid-sync-token/></D:error>',
  ])('returns null for a non-DAV error precondition', xml => {
    expect(parseDavErrorPrecondition(xml)).toBeNull();
  });

  it.each([
    '<D:error xmlns:D="DAV:" X:spoof="true"><D:valid-sync-token/></D:error>',
    '<xml:error xmlns:xml="DAV:"><xml:valid-sync-token/></xml:error>',
    '<xmlns:error xmlns:xmlns="DAV:"><xmlns:valid-sync-token/></xmlns:error>',
  ])('does not accept a namespace-invalid DAV error document', xml => {
    expect(parseDavErrorPrecondition(xml)).toBeNull();
  });

  it('does not accept a malformed default-namespace spoof document', () => {
    expect(parseDavErrorPrecondition(
      '<error xmlns:="DAV:"><valid-sync-token/></error>',
    )).toBeNull();
  });
});

describe('CardDAV client XML boundary', () => {
  it('does not parse a successful response as a DAV error body', async () => {
    vi.resetModules();
    const parseErrorPrecondition = vi.fn();
    vi.doMock('./carddavXml.js', async importOriginal => ({
      ...await importOriginal(),
      parseDavErrorPrecondition: parseErrorPrecondition,
    }));
    vi.doMock('./hostValidation.js', () => ({
      validateHost: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('./safeFetch.js', () => ({
      safeFetch: vi.fn().mockResolvedValue(new Response(
        '<D:multistatus xmlns:D="DAV:"/>',
        { status: 207, statusText: 'Multi-Status' },
      )),
    }));

    try {
      const { fetchAddressBookCards } = await import('./carddavClient.js');

      await expect(fetchAddressBookCards({
        url: 'https://carddav.example.test/addressbooks/user/contacts/',
        username: 'user',
        password: 'app-password',
      })).resolves.toEqual([]);
      expect(parseErrorPrecondition).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('./carddavXml.js');
      vi.doUnmock('./hostValidation.js');
      vi.doUnmock('./safeFetch.js');
      vi.resetModules();
    }
  });
});

function responseNode(xml) {
  const root = parseXmlDocument(xml, 'DAV response fixture');
  expect(childrenNamed({ children: [root] }, DAV_NS, 'response')).toEqual([root]);
  return root;
}
