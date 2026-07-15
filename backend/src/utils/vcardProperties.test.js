import { describe, expect, it, vi } from 'vitest';
import {
  contactFromVCardDocument,
  localContactHash,
  overlayContactOnVCard,
  parseVCardDocument,
  presentedEtag,
  presentedVCard,
  pushSafeSnapshot,
  semanticVCardHash,
  serializeVCardDocument,
} from './vcardProperties.js';

const MAX_VCARD_BYTES = 1024 * 1024;
const MAX_PROPERTIES = 2000;
const MAX_PARAMETERS = 64;
const MAX_CONTENT_LINE_BYTES = 64 * 1024;
const MAX_PHOTO_BYTES = 512 * 1024;

function vcard(lines, version = '3.0') {
  return ['BEGIN:VCARD', `VERSION:${version}`, ...lines, 'END:VCARD', ''].join('\r\n');
}

function parameterValuesForTest(property, name) {
  return property.params
    .filter(parameter => parameter.name === name)
    .flatMap(parameter => parameter.values);
}

function asciiVCardOfSize(size) {
  const start = 'BEGIN:VCARD\r\nVERSION:3.0\r\n';
  const end = 'END:VCARD\r\n';
  let remaining = size - Buffer.byteLength(start) - Buffer.byteLength(end);
  const lines = [];

  while (remaining > 0) {
    let lineBytes = Math.min(MAX_CONTENT_LINE_BYTES + 2, remaining);
    const tail = remaining - lineBytes;
    if (tail > 0 && tail < 4) lineBytes -= 4 - tail;
    lines.push(`X:${'a'.repeat(lineBytes - 4)}\r\n`);
    remaining -= lineBytes;
  }

  return start + lines.join('') + end;
}

function foldAsciiLine(line) {
  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < line.length) {
    const width = first ? 75 : 74;
    parts.push(`${first ? '' : ' '}${line.slice(offset, offset + width)}`);
    offset += width;
    first = false;
  }
  return parts.join('\r\n');
}

function additionalIdentityRows(contact) {
  return contact.additionalFields.map(({ id, kind, label, value }) => ({
    id,
    kind,
    label,
    value,
  }));
}

// Adapted from Nametag's Apple vCard fixture, with MailFlow-specific grouped
// parameter cases added. Source pinned to:
// https://github.com/mattogodoy/nametag/blob/bdbe7c129f600b90277a516066f78a731e67e017/tests/vcards/apple-vcard-example.vcf
const NAMETAG_DERIVED_FIXTURE = vcard([
  'PRODID:-//Apple Inc.//iPhone OS 26.2//EN',
  'N:Brown;Emmetiano;Lucas;;',
  'FN:Emmetiano Lucas Brown',
  'item1.TEL;TYPE="CELL,VOICE";X-ABLABEL=Mobile:+15551234567',
  'EMAIL;TYPE=INTERNET;TYPE=WORK:doc@bttf.com',
  'item2.ADR;TYPE=WORK:;;Rio Segre 2;Valdemorillo;Madrid;28210;Spain',
  'item2.X-ABADR:es',
  'item3.URL;TYPE=pref:biffsucks.com',
  'item3.X-ABLabel:Hobbies',
  'X-SOCIALPROFILE;TYPE=twitter:http://twitter.com/doc',
  'NOTE:Escaped comma\\, semicolon\\; newline\\nand slash\\\\ retained',
  'X-MAILFLOW-UNKNOWN;X-LABEL="one;two":opaque\\:value:tail',
  'EXPERTISE;X-LEVEL=9:Flux dynamics',
  'IMPP;TYPE=HOME:xmpp:doc@example.test',
]);

const VCARD_4_BEHAVIOR_FIXTURE = vcard([
  'UID:urn:uuid:contact-4',
  'FN:Jane Q. Doe',
  'N:Doe;Jane;Q.;;',
  'EMAIL;TYPE=WORK;PREF=1:Jane.Doe@Example.Test',
  'TEL;VALUE=uri;TYPE=CELL:tel:+15551234567;ext=9',
  'PHOTO:data:image/png;base64,AQID',
  'X-REMOTE;X-ORDER=one,two:opaque',
], '4.0');

const FOLDED_PHOTO_BEHAVIOR_FIXTURE = vcard([
  'UID:folded-photo',
  'FN:Folded Photo',
  'PHOTO;ENCODING=b;TYPE=PNG:AQ\r\n ID',
]);

function behaviorContract(raw) {
  const document = parseVCardDocument(raw);
  const projection = contactFromVCardDocument(document);
  const serialized = serializeVCardDocument(document);

  return {
    serialized,
    serializedBytes: Buffer.from(serialized).toString('base64'),
    projection,
    semanticHash: semanticVCardHash(document),
    localHash: localContactHash(projection),
  };
}

describe('vCard parsing, projection, serialization, and hashing behavior contracts', () => {
  it('captures vCard 3.0 escaping, Additional fields, and custom properties', () => {
    expect(behaviorContract(NAMETAG_DERIVED_FIXTURE)).toMatchInlineSnapshot(`
      {
        "localHash": "55b28825db91fb008c76cc907842fcce1e530ea21d5075ba053ac83f8d15ec56",
        "projection": {
          "additionalFields": [
            {
              "id": "vcard-ef137e5c921d3ae9",
              "kind": "postal-address",
              "label": "WORK",
              "value": {
                "country": "Spain",
                "extendedAddress": "",
                "locality": "Valdemorillo",
                "poBox": "",
                "postalCode": "28210",
                "region": "Madrid",
                "street": "Rio Segre 2",
              },
              "vcard": {
                "group": "item2",
                "name": "ADR",
                "params": [
                  {
                    "name": "TYPE",
                    "values": [
                      "WORK",
                    ],
                  },
                ],
              },
            },
            {
              "id": "vcard-8510414f13db4465",
              "kind": "url",
              "label": "Hobbies",
              "value": "biffsucks.com",
              "vcard": {
                "group": "item3",
                "name": "URL",
                "params": [
                  {
                    "name": "TYPE",
                    "values": [
                      "pref",
                    ],
                  },
                ],
              },
            },
            {
              "id": "vcard-67b665a82e7253f8",
              "kind": "im",
              "label": "HOME",
              "value": {
                "handle": "doc@example.test",
                "protocol": "xmpp",
              },
              "vcard": {
                "group": null,
                "name": "IMPP",
                "params": [
                  {
                    "name": "TYPE",
                    "values": [
                      "HOME",
                    ],
                  },
                ],
              },
            },
          ],
          "displayName": "Emmetiano Lucas Brown",
          "emails": [
            {
              "primary": false,
              "type": "work",
              "value": "doc@bttf.com",
            },
          ],
          "firstName": "Emmetiano",
          "lastName": "Brown",
          "notes": "Escaped comma, semicolon; newline
      and slash\\ retained",
          "organization": null,
          "phones": [
            {
              "type": "mobile",
              "value": "+15551234567",
            },
          ],
          "photoData": null,
          "uid": null,
        },
        "semanticHash": "0243c83dda67df0fb9b2409c053036e3330e79c2edcbcd98e05b217fe2adc683",
        "serialized": "BEGIN:VCARD
      VERSION:3.0
      PRODID:-//Apple Inc.//iPhone OS 26.2//EN
      N:Brown;Emmetiano;Lucas;;
      FN:Emmetiano Lucas Brown
      item1.TEL;TYPE=CELL,VOICE;X-ABLABEL=Mobile:+15551234567
      EMAIL;TYPE=INTERNET;TYPE=WORK:doc@bttf.com
      item2.ADR;TYPE=WORK:;;Rio Segre 2;Valdemorillo;Madrid;28210;Spain
      item2.X-ABADR:es
      item3.URL;TYPE=pref:biffsucks.com
      item3.X-ABLABEL:Hobbies
      X-SOCIALPROFILE;TYPE=twitter:http://twitter.com/doc
      NOTE:Escaped comma\\, semicolon\\; newline\\nand slash\\\\ retained
      X-MAILFLOW-UNKNOWN;X-LABEL="one;two":opaque\\:value:tail
      EXPERTISE;X-LEVEL=9:Flux dynamics
      IMPP;TYPE=HOME:xmpp:doc@example.test
      END:VCARD
      ",
        "serializedBytes": "QkVHSU46VkNBUkQNClZFUlNJT046My4wDQpQUk9ESUQ6LS8vQXBwbGUgSW5jLi8vaVBob25lIE9TIDI2LjIvL0VODQpOOkJyb3duO0VtbWV0aWFubztMdWNhczs7DQpGTjpFbW1ldGlhbm8gTHVjYXMgQnJvd24NCml0ZW0xLlRFTDtUWVBFPUNFTEwsVk9JQ0U7WC1BQkxBQkVMPU1vYmlsZTorMTU1NTEyMzQ1NjcNCkVNQUlMO1RZUEU9SU5URVJORVQ7VFlQRT1XT1JLOmRvY0BidHRmLmNvbQ0KaXRlbTIuQURSO1RZUEU9V09SSzo7O1JpbyBTZWdyZSAyO1ZhbGRlbW9yaWxsbztNYWRyaWQ7MjgyMTA7U3BhaW4NCml0ZW0yLlgtQUJBRFI6ZXMNCml0ZW0zLlVSTDtUWVBFPXByZWY6YmlmZnN1Y2tzLmNvbQ0KaXRlbTMuWC1BQkxBQkVMOkhvYmJpZXMNClgtU09DSUFMUFJPRklMRTtUWVBFPXR3aXR0ZXI6aHR0cDovL3R3aXR0ZXIuY29tL2RvYw0KTk9URTpFc2NhcGVkIGNvbW1hXCwgc2VtaWNvbG9uXDsgbmV3bGluZVxuYW5kIHNsYXNoXFwgcmV0YWluZWQNClgtTUFJTEZMT1ctVU5LTk9XTjtYLUxBQkVMPSJvbmU7dHdvIjpvcGFxdWVcOnZhbHVlOnRhaWwNCkVYUEVSVElTRTtYLUxFVkVMPTk6Rmx1eCBkeW5hbWljcw0KSU1QUDtUWVBFPUhPTUU6eG1wcDpkb2NAZXhhbXBsZS50ZXN0DQpFTkQ6VkNBUkQNCg==",
      }
    `);
  });

  it('captures vCard 4.0 syntax, projection, and hashes', () => {
    expect(behaviorContract(VCARD_4_BEHAVIOR_FIXTURE)).toMatchInlineSnapshot(`
      {
        "localHash": "4c59c578e03979fb2ed5c199bff36596ba5ffdfb58e0c93f320601803cff0c24",
        "projection": {
          "additionalFields": [],
          "displayName": "Jane Q. Doe",
          "emails": [
            {
              "primary": true,
              "type": "work",
              "value": "jane.doe@example.test",
            },
          ],
          "firstName": "Jane",
          "lastName": "Doe",
          "notes": null,
          "organization": null,
          "phones": [
            {
              "type": "mobile",
              "value": "tel:+15551234567;ext=9",
            },
          ],
          "photoData": "data:image/png;base64,AQID",
          "uid": "urn:uuid:contact-4",
        },
        "semanticHash": "05fb7f95e67393f76c9b69c0b96de19042d15a5636ef14fb26fb8255bbda835f",
        "serialized": "BEGIN:VCARD
      VERSION:4.0
      UID:urn:uuid:contact-4
      FN:Jane Q. Doe
      N:Doe;Jane;Q.;;
      EMAIL;TYPE=WORK;PREF=1:Jane.Doe@Example.Test
      TEL;VALUE=uri;TYPE=CELL:tel:+15551234567;ext=9
      PHOTO:data:image/png;base64,AQID
      X-REMOTE;X-ORDER=one,two:opaque
      END:VCARD
      ",
        "serializedBytes": "QkVHSU46VkNBUkQNClZFUlNJT046NC4wDQpVSUQ6dXJuOnV1aWQ6Y29udGFjdC00DQpGTjpKYW5lIFEuIERvZQ0KTjpEb2U7SmFuZTtRLjs7DQpFTUFJTDtUWVBFPVdPUks7UFJFRj0xOkphbmUuRG9lQEV4YW1wbGUuVGVzdA0KVEVMO1ZBTFVFPXVyaTtUWVBFPUNFTEw6dGVsOisxNTU1MTIzNDU2NztleHQ9OQ0KUEhPVE86ZGF0YTppbWFnZS9wbmc7YmFzZTY0LEFRSUQNClgtUkVNT1RFO1gtT1JERVI9b25lLHR3bzpvcGFxdWUNCkVORDpWQ0FSRA0K",
      }
    `);
  });

  it('captures folded PHOTO bytes, projection, and hashes', () => {
    expect(behaviorContract(FOLDED_PHOTO_BEHAVIOR_FIXTURE)).toMatchInlineSnapshot(`
      {
        "localHash": "91da1d7ca4d830d5f40e0031eefe205b046431a0d8e12e76f541d0c7e4d5b2ed",
        "projection": {
          "additionalFields": [],
          "displayName": "Folded Photo",
          "emails": [],
          "firstName": null,
          "lastName": null,
          "notes": null,
          "organization": null,
          "phones": [],
          "photoData": "data:image/png;base64,AQID",
          "uid": "folded-photo",
        },
        "semanticHash": "c6cc7538ba6dc19e5d1ba70058ef864a5e9c440635697895051dd3d7e0df0c42",
        "serialized": "BEGIN:VCARD
      VERSION:3.0
      UID:folded-photo
      FN:Folded Photo
      PHOTO;ENCODING=b;TYPE=PNG:AQID
      END:VCARD
      ",
        "serializedBytes": "QkVHSU46VkNBUkQNClZFUlNJT046My4wDQpVSUQ6Zm9sZGVkLXBob3RvDQpGTjpGb2xkZWQgUGhvdG8NClBIT1RPO0VOQ09ESU5HPWI7VFlQRT1QTkc6QVFJRA0KRU5EOlZDQVJEDQo=",
      }
    `);
  });
});

describe('retained vCard property tree', () => {
  it('preserves groups, ordered parameters, structured values, escapes, and unknown properties', () => {
    const document = parseVCardDocument(NAMETAG_DERIVED_FIXTURE);

    expect(document.version).toBe('3.0');
    expect(document.properties.find(property => property.name === 'TEL')).toEqual({
      group: 'item1',
      name: 'TEL',
      params: [
        { name: 'TYPE', values: ['CELL', 'VOICE'] },
        { name: 'X-ABLABEL', values: ['Mobile'] },
      ],
      rawValue: '+15551234567',
    });
    expect(document.properties.find(property => property.name === 'EMAIL').params).toEqual([
      { name: 'TYPE', values: ['INTERNET'] },
      { name: 'TYPE', values: ['WORK'] },
    ]);
    expect(document.properties.find(property => property.name === 'N').rawValue)
      .toBe('Brown;Emmetiano;Lucas;;');
    expect(document.properties.find(property => property.name === 'NOTE').rawValue)
      .toBe('Escaped comma\\, semicolon\\; newline\\nand slash\\\\ retained');
    expect(document.properties.find(property => property.name === 'X-MAILFLOW-UNKNOWN'))
      .toEqual({
        group: null,
        name: 'X-MAILFLOW-UNKNOWN',
        params: [{ name: 'X-LABEL', values: ['one;two'] }],
        rawValue: 'opaque\\:value:tail',
      });
    expect(document.properties.find(property => property.name === 'X-ABADR')).toEqual({
      group: 'item2',
      name: 'X-ABADR',
      params: [],
      rawValue: 'es',
    });
    expect(document.properties.find(property => property.name === 'EXPERTISE')).toEqual({
      group: null,
      name: 'EXPERTISE',
      params: [{ name: 'X-LEVEL', values: ['9'] }],
      rawValue: 'Flux dynamics',
    });
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it.each(['3.0', '4.0'])('accepts vCard %s and normalizes case-insensitive names only', version => {
    const document = parseVCardDocument([
      'begin:vcard',
      `version:${version}`,
      'Item7.email;type="Work,INTERNET":Mixed.Case@Example.Test',
      'end:vcard',
      '',
    ].join('\n'));

    expect(document).toEqual({
      version,
      properties: [{
        group: 'Item7',
        name: 'EMAIL',
        params: [{ name: 'TYPE', values: ['Work', 'INTERNET'] }],
        rawValue: 'Mixed.Case@Example.Test',
      }],
    });
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('splits at the first colon outside quoted parameters', () => {
    const document = parseVCardDocument(vcard([
      'X-REFERENCE;X-URI="urn:example:label";X-ESCAPED=one\\:two:raw\\:value:tail',
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'X-REFERENCE',
      params: [
        { name: 'X-URI', values: ['urn:example:label'] },
        { name: 'X-ESCAPED', values: ['one\\'] },
      ],
      rawValue: 'two:raw\\:value:tail',
    });
  });

  it('round-trips caret escapes and scans double-quoted parameter delimiters', () => {
    const quoted = parseVCardDocument(vcard([
      'X-REFERENCE;X-LABEL="one;two:three":payload',
    ]));
    const document = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'X-REFERENCE',
        params: [{
          name: 'X-VALUES',
          values: ['^n', '^^', '"quoted"', 'line\nbreak'],
        }],
        rawValue: 'payload',
      }],
    };

    expect(quoted.properties[0].params).toEqual([
      { name: 'X-LABEL', values: ['one;two:three'] },
    ]);
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('uses the standards content delimiter after a terminal parameter backslash', () => {
    const document = parseVCardDocument(vcard([
      'X-REFERENCE;X-P=foo\\:https://example.test/a',
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'X-REFERENCE',
      params: [{ name: 'X-P', values: ['foo\\'] }],
      rawValue: 'https://example.test/a',
    });
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('preserves unquoted parameter whitespace and decoded vCard 4.0 line breaks', () => {
    const parsed = parseVCardDocument(vcard([
      'X-REFERENCE;X-P=  padded  :payload',
    ], '4.0'));
    const constructed = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'X-REFERENCE',
        params: [{ name: 'X-P', values: ['\n'] }],
        rawValue: 'payload',
      }],
    };

    expect(parsed.properties[0].params).toEqual([
      { name: 'X-P', values: ['  padded  '] },
    ]);
    expect(parseVCardDocument(serializeVCardDocument(parsed))).toEqual(parsed);
    expect(parseVCardDocument(serializeVCardDocument(constructed))).toEqual(constructed);
  });

  it.each(['^n', '^N', '^^', "^'"])(
    'preserves literal vCard 3.0 parameter sequence %s',
    value => {
      const document = parseVCardDocument(vcard([
        `X-REFERENCE;X-P=literal${value}case:payload`,
      ]));

      expect(document.properties[0].params).toEqual([
        { name: 'X-P', values: [`literal${value}case`] },
      ]);
      expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
    },
  );

  it.each(['3.0', '4.0'])(
    'preserves literal surrounding apostrophes in vCard %s parameters',
    version => {
      const document = parseVCardDocument(vcard([
        "X-REFERENCE;X-P='quoted':payload",
      ], version));

      expect(document.properties[0].params).toEqual([
        { name: 'X-P', values: ["'quoted'"] },
      ]);
      expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
    },
  );

  it('treats an apostrophe inside an unquoted parameter value as ordinary text', () => {
    const document = parseVCardDocument(vcard([
      "X-REFERENCE;X-LABEL=O'Reilly:payload",
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'X-REFERENCE',
      params: [{ name: 'X-LABEL', values: ["O'Reilly"] }],
      rawValue: 'payload',
    });
  });

  it.each([
    ["ordinary apostrophe", "O'Reilly"],
    ['literal surrounding single quotes', "'quoted'"],
  ])('round-trips parameter values containing %s', (_case, value) => {
    const document = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'X-REFERENCE',
        params: [{ name: 'X-LABEL', values: [value] }],
        rawValue: 'payload',
      }],
    };

    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('preserves whitespace inside quoted parameter values', () => {
    const document = parseVCardDocument(vcard([
      'X-REFERENCE;X-LABEL=  "  padded  "  ;TYPE="CELL,VOICE":payload',
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'X-REFERENCE',
      params: [
        { name: 'X-LABEL', values: ['  padded  '] },
        { name: 'TYPE', values: ['CELL', 'VOICE'] },
      ],
      rawValue: 'payload',
    });
    const serialized = serializeVCardDocument(document);
    expect(serialized).toContain('X-LABEL="  padded  ";TYPE=CELL,VOICE:payload\r\n');
    expect(parseVCardDocument(serialized)).toEqual(document);
  });

  it('parses individually quoted and mixed parameter-list entries', () => {
    const document = parseVCardDocument(vcard([
      'X-REFERENCE;P="one","two";Q=plain,"quoted",tail;TYPE="CELL,VOICE":payload',
    ]));

    expect(document.properties[0].params).toEqual([
      { name: 'P', values: ['one', 'two'] },
      { name: 'Q', values: ['plain', 'quoted', 'tail'] },
      { name: 'TYPE', values: ['CELL', 'VOICE'] },
    ]);
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('keeps literal commas except in a legacy whole-quoted compound TYPE', () => {
    const document = parseVCardDocument(vcard([
      'X-REFERENCE;P="Last, First";TYPE="CELL,VOICE":payload',
    ]));

    expect(document.properties[0].params).toEqual([
      { name: 'P', values: ['Last, First'] },
      { name: 'TYPE', values: ['CELL', 'VOICE'] },
    ]);
  });

  it('quotes comma-containing parameter-list entries individually', () => {
    const document = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'X-REFERENCE',
        params: [{
          name: 'P',
          values: ['Last, First', 'plain', 'Suffix, Jr.'],
        }],
        rawValue: 'payload',
      }],
    };

    const serialized = serializeVCardDocument(document);

    expect(serialized).toContain('P="Last, First",plain,"Suffix, Jr.":payload\r\n');
    expect(parseVCardDocument(serialized)).toEqual(document);
  });

  it('round-trips empty parameter entries and literal backslashes at every boundary', () => {
    const document = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'X-REFERENCE',
        params: [
          { name: 'P-EMPTY', values: ['', 'first', '', ''] },
          { name: 'P-COMMA', values: ['before-comma\\', 'after'] },
          { name: 'P-SEMICOLON', values: ['before-semicolon\\'] },
          { name: 'P-QUOTE', values: ['before-quote\\"after'] },
          { name: 'P-COLON', values: ['before-colon\\'] },
        ],
        rawValue: 'payload',
      }],
    };
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it.each([1, 2, 4])('preserves %i external parameter backslashes exactly', count => {
    const slashes = '\\'.repeat(count);
    const document = parseVCardDocument(vcard([
      'X-REFERENCE'
        + `;P-UNQUOTED=${slashes}ordinary`
        + `;P-QUOTED="${slashes}ordinary,${slashes}semi;${slashes}colon:tail"`
        + `;P-COMMA=${slashes},tail`
        + `;P-SEMICOLON=${slashes};P-NEXT=next`
        + `;P-COLON=${slashes}:payload`,
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'X-REFERENCE',
      params: [
        { name: 'P-UNQUOTED', values: [`${slashes}ordinary`] },
        {
          name: 'P-QUOTED',
          values: [`${slashes}ordinary,${slashes}semi;${slashes}colon:tail`],
        },
        { name: 'P-COMMA', values: [slashes, 'tail'] },
        { name: 'P-SEMICOLON', values: [slashes] },
        { name: 'P-NEXT', values: ['next'] },
        { name: 'P-COLON', values: [slashes] },
      ],
      rawValue: 'payload',
    });
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it('folds UTF-8 content at 75 octets without splitting code points', () => {
    const document = {
      version: '4.0',
      properties: [{
        group: null,
        name: 'NOTE',
        params: [],
        rawValue: `Résumé ${'🙂'.repeat(40)} fin`,
      }],
    };

    const serialized = serializeVCardDocument(document);
    const physicalLines = serialized.split('\r\n').filter(Boolean);

    expect(physicalLines.some(line => line.startsWith(' '))).toBe(true);
    expect(physicalLines.every(line => Buffer.byteLength(line, 'utf8') <= 75)).toBe(true);
    expect(serialized).not.toContain('\ufffd');
    expect(parseVCardDocument(serialized)).toEqual(document);
  });
});

describe('vCard safety boundaries', () => {
  it('accepts exactly 1 MiB and rejects one decoded vCard byte more', () => {
    const atLimit = asciiVCardOfSize(MAX_VCARD_BYTES);
    const overLimit = asciiVCardOfSize(MAX_VCARD_BYTES + 1);

    expect(Buffer.byteLength(atLimit)).toBe(MAX_VCARD_BYTES);
    expect(parseVCardDocument(atLimit).properties).toHaveLength(16);
    expect(() => parseVCardDocument(overLimit)).toThrow(/1 MiB/);
  });

  it('accepts 2,000 properties and rejects property 2,001', () => {
    const properties = Array.from({ length: MAX_PROPERTIES }, (_, index) => `X-P:${index}`);

    expect(parseVCardDocument(vcard(properties)).properties).toHaveLength(MAX_PROPERTIES);
    expect(() => parseVCardDocument(vcard([...properties, 'X-P:overflow'])))
      .toThrow(/2,000 properties/);
  });

  it('accepts 64 ordered parameters and rejects parameter 65', () => {
    const parameters = Array.from({ length: MAX_PARAMETERS }, (_, index) => `;P${index}=v`)
      .join('');

    expect(parseVCardDocument(vcard([`TEL${parameters}:1`])).properties[0].params)
      .toHaveLength(MAX_PARAMETERS);
    expect(() => parseVCardDocument(vcard([`TEL${parameters};OVERFLOW=v:1`])))
      .toThrow(/64 parameters/);
  });

  it('accepts a 64 KiB physical line and rejects one physical byte more', () => {
    const atLimit = `NOTE:${'a'.repeat(MAX_CONTENT_LINE_BYTES - 5)}`;
    const overLimit = `${atLimit}a`;

    expect(Buffer.byteLength(atLimit)).toBe(MAX_CONTENT_LINE_BYTES);
    expect(parseVCardDocument(vcard([atLimit])).properties[0].rawValue)
      .toHaveLength(MAX_CONTENT_LINE_BYTES - 5);
    expect(() => parseVCardDocument(vcard([overLimit]))).toThrow(/64 KiB physical line/);
  });

  it('accepts a 64 KiB unfolded non-PHOTO line and rejects one unfolded byte more', () => {
    const firstValue = 'a'.repeat(40_000);
    const exactTail = 'b'.repeat(MAX_CONTENT_LINE_BYTES - 5 - firstValue.length);
    const exact = vcard([`NOTE:${firstValue}\r\n ${exactTail}`]);
    const over = vcard([`NOTE:${firstValue}\r\n ${exactTail}b`]);

    expect(parseVCardDocument(exact).properties[0].rawValue)
      .toHaveLength(MAX_CONTENT_LINE_BYTES - 5);
    expect(() => parseVCardDocument(over)).toThrow(/64 KiB unfolded line/);
  });

  it('applies the unfolded-line limit to VERSION at its exact boundary', () => {
    const suffix = '3.0';
    const prefix = 'VERSION:';
    const exactLine = prefix
      + ' '.repeat(MAX_CONTENT_LINE_BYTES - Buffer.byteLength(prefix + suffix))
      + suffix;
    const overLine = `${exactLine} `;

    expect(Buffer.byteLength(exactLine)).toBe(MAX_CONTENT_LINE_BYTES);
    const card = versionLine => [
      'BEGIN:VCARD',
      foldAsciiLine(versionLine),
      'END:VCARD',
      '',
    ].join('\r\n');

    expect(parseVCardDocument(card(exactLine)).version).toBe('3.0');
    expect(() => parseVCardDocument(card(overLine)))
      .toThrow(/64 KiB unfolded line/);
  });

  it('allows folded PHOTO past the unfolded-line cap through 512 KiB decoded', () => {
    const photo = Buffer.alloc(MAX_PHOTO_BYTES, 0xa5).toString('base64');
    const folded = foldAsciiLine(`PHOTO;ENCODING=b;TYPE=JPEG:${photo}`);
    const document = parseVCardDocument(vcard([folded]));

    expect(document.properties[0].rawValue).toBe(photo);
  });

  it('limits folded URI PHOTO by unfolded bytes without shrinking embedded PHOTO capacity', () => {
    const header = 'PHOTO;VALUE=URI:';
    const exactUri = foldAsciiLine(header + 'a'.repeat(MAX_CONTENT_LINE_BYTES - header.length));
    const oversizedUri = foldAsciiLine(
      header + 'a'.repeat(MAX_CONTENT_LINE_BYTES - header.length + 1),
    );
    const embedded = Buffer.alloc(MAX_PHOTO_BYTES, 0xa5).toString('base64');

    expect(parseVCardDocument(vcard([exactUri])).properties[0].rawValue)
      .toHaveLength(MAX_CONTENT_LINE_BYTES - header.length);
    expect(() => parseVCardDocument(vcard([oversizedUri])))
      .toThrow('vCard exceeds the 64 KiB unfolded line limit');
    expect(() => serializeVCardDocument({
      version: '4.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: [{ name: 'VALUE', values: ['URI'] }],
        rawValue: 'a'.repeat(MAX_CONTENT_LINE_BYTES - header.length + 1),
      }],
    })).toThrow('vCard exceeds the 64 KiB unfolded line limit');
    expect(() => parseVCardDocument(vcard([
      foldAsciiLine(`PHOTO;ENCODING=b;TYPE=JPEG:${embedded}`),
    ]))).not.toThrow();
  });

  it('rejects a decoded PHOTO one byte beyond 512 KiB', () => {
    const photo = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xa5).toString('base64');
    const folded = foldAsciiLine(`PHOTO;ENCODING=b;TYPE=JPEG:${photo}`);

    expect(() => parseVCardDocument(vcard([folded]))).toThrow(/512 KiB photo/);
  });

  it.each([
    ['parsing', photo => parseVCardDocument(vcard([foldAsciiLine(`PHOTO:${photo}`)]))],
    ['serialization', photo => serializeVCardDocument({
      version: '3.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue: photo }],
    })],
  ])('accepts exactly 512 KiB and rejects one byte more for legacy PHOTO %s', (_case, run) => {
    const atLimit = Buffer.alloc(MAX_PHOTO_BYTES, 0xa5).toString('base64');
    const overLimit = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xa5).toString('base64');

    expect(() => run(atLimit)).not.toThrow();
    expect(() => run(overLimit)).toThrow(/512 KiB photo/);
  });

  it('rejects oversized base64 PHOTO data before decoding it', () => {
    const photo = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xa5).toString('base64');
    const bufferFrom = vi.spyOn(Buffer, 'from');

    try {
      expect(() => serializeVCardDocument({
        version: '3.0',
        properties: [{
          group: null,
          name: 'PHOTO',
          params: [{ name: 'ENCODING', values: ['b'] }],
          rawValue: photo,
        }],
      })).toThrow(/512 KiB photo/);
      expect(bufferFrom.mock.calls.some(([value]) => (
        typeof value === 'string' && value.length > MAX_PHOTO_BYTES
      ))).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it('checks the document byte budget before decoding a valid PHOTO', () => {
    const photo = Buffer.alloc(MAX_PHOTO_BYTES, 0xa5).toString('base64');
    const encodedPhoto = photo.replace(/=+$/, '');
    const bufferFrom = vi.spyOn(Buffer, 'from');

    try {
      expect(() => serializeVCardDocument({
        version: '3.0',
        properties: [
          ...Array.from({ length: 6 }, (_value, index) => ({
            group: null,
            name: `X-FILL-${index}`,
            params: [],
            rawValue: 'a'.repeat(60 * 1024),
          })),
          {
            group: null,
            name: 'PHOTO',
            params: [{ name: 'ENCODING', values: ['b'] }],
            rawValue: photo,
          },
        ],
      })).toThrow(/1 MiB/);
      expect(bufferFrom.mock.calls.some(([value]) => value === encodedPhoto)).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it('rejects an oversized URI PHOTO before folding its content line', () => {
    const rawValue = 'https://example.test/' + 'a'.repeat(MAX_VCARD_BYTES);
    const bufferFrom = vi.spyOn(Buffer, 'from');

    try {
      expect(() => serializeVCardDocument({
        version: '4.0',
        properties: [{
          group: null,
          name: 'PHOTO',
          params: [{ name: 'VALUE', values: ['URI'] }],
          rawValue,
        }],
      })).toThrow(/1 MiB/);
      expect(bufferFrom.mock.calls.some(([value]) => (
        typeof value === 'string' && value.length > MAX_VCARD_BYTES
      ))).toBe(false);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it.each([
    ['parsing', photo => parseVCardDocument(vcard([`PHOTO:${photo}`]))],
    ['serialization', photo => serializeVCardDocument({
      version: '3.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue: photo }],
    })],
  ])('rejects malformed legacy PHOTO base64 during %s', (_case, run) => {
    expect(() => run('not-valid-***')).toThrow(/invalid base64/);
  });

  it.each([
    ['invalid alphabet', 'AQI*'],
    ['impossible unpadded sextet length', 'A'],
    ['incomplete padded quartet', 'A=='],
    ['padding without payload', '=='],
    ['padding before the end', 'AA=A'],
    ['noncanonical discarded bits after one byte', 'AB=='],
    ['noncanonical discarded bits after two bytes', 'AAB='],
  ].flatMap(([reason, photo]) => [
    [reason, 'parsing', () => parseVCardDocument(vcard([
      `PHOTO;ENCODING=b;TYPE=JPEG:${photo}`,
    ]))],
    [reason, 'serialization', () => serializeVCardDocument({
      version: '3.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: [{ name: 'ENCODING', values: ['b'] }],
        rawValue: photo,
      }],
    })],
  ]))('rejects base64 with %s during %s', (_reason, _operation, run) => {
    expect(run).toThrow(/invalid base64/);
  });

  it.each([
    ['padded', 'AQI='],
    ['unpadded', 'AQI'],
    ['ASCII whitespace', 'AQ I='],
  ])('accepts canonical %s base64 PHOTO data', (_case, photo) => {
    expect(() => parseVCardDocument(vcard([
      `PHOTO;ENCODING=b;TYPE=JPEG:${photo}`,
    ]))).not.toThrow();
    expect(() => serializeVCardDocument({
      version: '3.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: [{ name: 'ENCODING', values: ['b'] }],
        rawValue: photo,
      }],
    })).not.toThrow();
  });

  it('accepts arbitrary percent-encoded octets in non-base64 data URI photos', () => {
    const rawValue = 'data:image/png,%89PNG%0D%0A';
    const document = parseVCardDocument(vcard([`PHOTO:${rawValue}`], '4.0'));

    expect(document.properties[0].rawValue).toBe(rawValue);
    expect(contactFromVCardDocument(document).photoData).toBe(rawValue);
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it.each([
    ['parsing', rawValue => parseVCardDocument(vcard([`PHOTO:${rawValue}`], '4.0'))],
    ['serialization', rawValue => serializeVCardDocument({
      version: '4.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue }],
    })],
  ])('rejects malformed percent escapes in non-base64 data URI photos during %s', (
    _case,
    run,
  ) => {
    expect(() => run('data:image/png,%8G')).toThrow(/invalid data URI encoding/);
    expect(() => run('data:image/png,%')).toThrow(/invalid data URI encoding/);
  });

  it.each([
    ['parsing', rawValue => parseVCardDocument(vcard([
      foldAsciiLine(`PHOTO:${rawValue}`),
    ], '4.0'))],
    ['serialization', rawValue => serializeVCardDocument({
      version: '4.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue }],
    })],
  ])('counts decoded bytes for non-base64 data URI photos during %s', (_case, run) => {
    const prefix = 'data:application/octet-stream,';
    const atLimit = prefix + 'a'.repeat(MAX_PHOTO_BYTES);
    const overLimit = `${atLimit}a`;

    expect(() => run(atLimit)).not.toThrow();
    expect(() => run(overLimit)).toThrow(/512 KiB photo/);
  });

  it.each([
    ['group line break', {
      group: 'item1\r\nX-INJECT', name: 'X-SAFE', params: [], rawValue: 'value',
    }],
    ['group delimiter', {
      group: 'item1;TYPE=WORK', name: 'X-SAFE', params: [], rawValue: 'value',
    }],
    ['property-name line break', {
      group: null, name: 'X-SAFE\r\nX-INJECT', params: [], rawValue: 'value',
    }],
    ['property-name delimiter', {
      group: null, name: 'X-SAFE;TYPE=WORK', params: [], rawValue: 'value',
    }],
    ['parameter-name line break', {
      group: null,
      name: 'X-SAFE',
      params: [{ name: 'TYPE\r\nX-INJECT', values: ['WORK'] }],
      rawValue: 'value',
    }],
    ['parameter-name delimiter', {
      group: null,
      name: 'X-SAFE',
      params: [{ name: 'TYPE:INJECT', values: ['WORK'] }],
      rawValue: 'value',
    }],
    ['raw-value carriage return', {
      group: null, name: 'X-SAFE', params: [], rawValue: 'value\rX-INJECT:payload',
    }],
    ['raw-value newline', {
      group: null, name: 'X-SAFE', params: [], rawValue: 'value\nX-INJECT:payload',
    }],
  ])('rejects serializer structural injection through %s', (_case, property) => {
    expect(() => serializeVCardDocument({
      version: '4.0',
      properties: [property],
    })).toThrow(/invalid (?:property group|property name|parameter name)|line break/);
  });
});

describe('MailFlow contact projection', () => {
  const richDocument = () => parseVCardDocument(vcard([
    'UID:contact-1',
    'FN:Jane Doe',
    'N:Doe;Jane;;;',
    'EMAIL;TYPE=INTERNET,WORK:Jane.Doe@Example.Test',
    'TEL;TYPE=CELL,VOICE:+1 555 123 4567',
    'ORG:Example Corp;Research',
    'NOTE:Line one\\nLine two',
    'item1.ADR;TYPE=WORK:PO Box 1;Floor 2;123 Main St\\nUnit 4;Vancouver;BC;V1V 1V1;Canada',
    'item1.X-ABLabel:Office',
    'URL;TYPE=HOME:https://example.test/jane',
    'item2.IMPP:x-apple:jane_handle',
    'item2.X-ABLabel:Signal',
    'BDAY:1990-02-03',
    'ANNIVERSARY:2020-04-05',
    'item3.X-ABDATE:2012-06-07',
    'item3.X-ABLabel:Graduation',
    'ROLE:Engineering Lead',
    'TITLE:Principal Engineer',
    'NICKNAME:JD',
    'GEO:geo:49.2827,-123.1207',
    'item4.X-MAILFLOW-CUSTOM:Blue',
    'item4.X-ABLabel:Favorite color',
  ]));

  it('projects core fields and every supported Additional-field kind', () => {
    const first = contactFromVCardDocument(richDocument());
    const second = contactFromVCardDocument(richDocument());

    expect(first).toMatchObject({
      uid: 'contact-1',
      displayName: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
      emails: [{ value: 'jane.doe@example.test', type: 'work', primary: false }],
      phones: [{ value: '+1 555 123 4567', type: 'mobile' }],
      organization: 'Example Corp',
      notes: 'Line one\nLine two',
      photoData: null,
    });
    expect(first.additionalFields.map(({ kind, label, value }) => ({ kind, label, value })))
      .toEqual([
        {
          kind: 'postal-address',
          label: 'Office',
          value: {
            poBox: 'PO Box 1',
            extendedAddress: 'Floor 2',
            street: '123 Main St\nUnit 4',
            locality: 'Vancouver',
            region: 'BC',
            postalCode: 'V1V 1V1',
            country: 'Canada',
          },
        },
        { kind: 'url', label: 'HOME', value: 'https://example.test/jane' },
        {
          kind: 'im',
          label: 'Signal',
          value: { protocol: 'signal', handle: 'jane_handle' },
        },
        { kind: 'birthday', label: 'Birthday', value: '1990-02-03' },
        { kind: 'anniversary', label: 'Anniversary', value: '2020-04-05' },
        { kind: 'date', label: 'Graduation', value: '2012-06-07' },
        { kind: 'role', label: 'Role', value: 'Engineering Lead' },
        { kind: 'title', label: 'Title', value: 'Principal Engineer' },
        { kind: 'nickname', label: 'Nickname', value: 'JD' },
        {
          kind: 'geo',
          label: 'Location',
          value: { latitude: 49.2827, longitude: -123.1207 },
        },
        { kind: 'custom-text', label: 'Favorite color', value: 'Blue' },
      ]);
    expect(new Set(first.additionalFields.map(field => field.id)).size)
      .toBe(first.additionalFields.length);
    expect(first.additionalFields.map(field => field.id))
      .toEqual(second.additionalFields.map(field => field.id));
    expect(first.additionalFields.every(field => (
      typeof field.vcard.name === 'string'
      && Array.isArray(field.vcard.params)
      && Object.hasOwn(field.vcard, 'group')
    ))).toBe(true);
  });

  it('serializes and round-trips a label-less typed Additional field', () => {
    const contact = {
      uid: 'labelless-birthday',
      displayName: 'No Label',
      firstName: null,
      lastName: null,
      emails: [],
      phones: [],
      organization: null,
      notes: null,
      photoData: null,
      additionalFields: [
        { id: 'field-1', kind: 'birthday', label: '', value: '1985-07-12' },
      ],
    };

    // A canonical/typed field maps to a real vCard property (BDAY) and only needs a
    // label for X-ABLABEL grouping. A blank label must not throw on serialization.
    expect(() => localContactHash(contact)).not.toThrow();
    const overlaid = overlayContactOnVCard({ version: '3.0', properties: [] }, contact);
    const serialized = serializeVCardDocument(overlaid);
    expect(overlaid.properties.some(property => property.name === 'BDAY')).toBe(true);
    expect(serialized).not.toMatch(/X-ABLABEL/i);

    const reparsed = contactFromVCardDocument(parseVCardDocument(serialized));
    expect(reparsed.additionalFields).toEqual([
      expect.objectContaining({ kind: 'birthday', value: '1985-07-12' }),
    ]);
  });

  it('still requires a label for a custom-text Additional field', () => {
    const contact = {
      uid: 'labelless-custom',
      displayName: 'No Label',
      emails: [],
      phones: [],
      additionalFields: [
        { id: 'field-1', kind: 'custom-text', label: '', value: 'Blue' },
      ],
    };
    expect(() => overlayContactOnVCard({ version: '3.0', properties: [] }, contact))
      .toThrow(/custom text field requires a label/);
  });

  it('keeps URL photos opaque and never fetches them', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error('unexpected fetch');
    };

    try {
      const document = parseVCardDocument(vcard([
        'UID:url-photo',
        'FN:URL Photo',
        'PHOTO;VALUE=URI:https://images.example.test/photo.jpg',
      ]));
      const contact = contactFromVCardDocument(document);

      expect(contact.photoData).toBeNull();
      expect(document.properties.find(property => property.name === 'PHOTO').rawValue)
        .toBe('https://images.example.test/photo.jpg');
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains explicit non-HTTP URI photos through projection and explicit-null overlay', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error('unexpected fetch');
    };

    try {
      const document = parseVCardDocument(vcard([
        'UID:cid-photo',
        'FN:CID Photo',
        'PHOTO;VALUE=URI:cid:photo1',
      ]));
      const photo = document.properties.find(property => property.name === 'PHOTO');
      const contact = contactFromVCardDocument(document);
      const overlaid = overlayContactOnVCard(document, { ...contact, photoData: null });

      expect(photo).toEqual({
        group: null,
        name: 'PHOTO',
        params: [{ name: 'VALUE', values: ['URI'] }],
        rawValue: 'cid:photo1',
      });
      expect(contact.photoData).toBeNull();
      expect(overlaid.properties.find(property => property.name === 'PHOTO')).toEqual(photo);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats an unparameterized vCard 4.0 PHOTO as an opaque URI', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error('unexpected fetch');
    };

    try {
      const document = parseVCardDocument([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'PHOTO:cid:photo1',
        'UID:cid-photo-default',
        'FN:CID Photo Default',
        'END:VCARD',
        '',
      ].join('\r\n'));
      const photo = document.properties.find(property => property.name === 'PHOTO');
      const contact = contactFromVCardDocument(document);
      const overlaid = overlayContactOnVCard(document, { ...contact, photoData: null });
      const reparsed = parseVCardDocument(serializeVCardDocument(document));

      expect(photo).toEqual({
        group: null,
        name: 'PHOTO',
        params: [],
        rawValue: 'cid:photo1',
      });
      expect(contact.photoData).toBeNull();
      expect(overlaid.properties.find(property => property.name === 'PHOTO')).toEqual(photo);
      expect(reparsed).toEqual(document);
      expect(semanticVCardHash(reparsed)).toBe(semanticVCardHash(document));
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('distinguishes an absent photo from invalid embedded photo data', () => {
    const withoutPhoto = parseVCardDocument(vcard(['UID:no-photo', 'FN:No Photo']));

    expect(contactFromVCardDocument(withoutPhoto).photoData).toBeNull();
    expect(() => parseVCardDocument(vcard([
      'UID:bad-photo',
      'FN:Bad Photo',
      'PHOTO;ENCODING=b;TYPE=JPEG:not-valid-***',
    ]))).toThrow(/invalid base64/);
  });

  it.each([
    ['vCard 3.0 JPEG', 'PHOTO;ENCODING=b;TYPE=JPEG:AQID', '3.0',
      'data:image/jpeg;base64,AQID'],
    ['vCard 3.0 PNG', 'PHOTO;ENCODING=b;TYPE=PNG:AQID', '3.0',
      'data:image/png;base64,AQID'],
    ['vCard 3.0 GIF', 'PHOTO;ENCODING=b;TYPE=GIF:AQID', '3.0',
      'data:image/gif;base64,AQID'],
    ['vCard 3.0 WebP', 'PHOTO;ENCODING=b;TYPE=WEBP:AQID', '3.0',
      'data:image/webp;base64,AQID'],
    ['vCard 4.0 JPEG data URI', 'PHOTO:data:image/jpeg;base64,AQID', '4.0',
      'data:image/jpeg;base64,AQID'],
    ['vCard 4.0 PNG data URI', 'PHOTO:data:image/png;base64,AQID', '4.0',
      'data:image/png;base64,AQID'],
    ['vCard 4.0 GIF data URI', 'PHOTO:data:image/gif;base64,AQID', '4.0',
      'data:image/gif;base64,AQID'],
    ['vCard 4.0 WebP data URI', 'PHOTO:data:image/webp;base64,AQID', '4.0',
      'data:image/webp;base64,AQID'],
  ])('projects supported %s photos', (_case, photo, version, expected) => {
    const document = parseVCardDocument(vcard([photo], version));

    expect(contactFromVCardDocument(document).photoData).toBe(expected);
  });

  it.each([
    ['HTML data URI', 'PHOTO:data:text/html;base64,PGgxPk5vdCBhIHBob3RvPC9oMT4=', '4.0'],
    ['BMP binary', 'PHOTO;ENCODING=b;TYPE=BMP:AQID', '3.0'],
    ['unknown binary type', 'PHOTO;ENCODING=b;TYPE=PDF:AQID', '3.0'],
  ])('keeps unsupported %s PHOTO media opaque and unrendered', (_case, photo, version) => {
    const document = parseVCardDocument(vcard([photo], version));
    const contact = contactFromVCardDocument(document);

    expect(contact.photoData).toBeNull();
    expect(overlayContactOnVCard(document, contact)).toEqual(document);
  });
});

describe('MailFlow contact overlay', () => {
  const losslessDocument = () => parseVCardDocument(vcard([
    'UID:lossless-contact',
    'FN:Jane Doe',
    'N:Doe;Jane;Middle;Dr.;Jr.',
    'item1.EMAIL;TYPE=WORK;PREF=1;X-VENDOR=keep:jane@example.test',
    'item1.X-ABLabel:Work inbox',
    'ORG:Example Corp;Research Division',
    'item2.URL;TYPE=HOME;X-VENDOR=keep:https://example.test/jane',
    'item2.X-ABLabel:Portfolio',
    'GEO:not-a-coordinate',
  ]));

  it('preserves every retained property on an unchanged overlay', () => {
    const document = losslessDocument();
    const contact = contactFromVCardDocument(document);

    expect(overlayContactOnVCard(document, contact)).toEqual(document);
  });

  it('changes only the matched owned email value', () => {
    const document = losslessDocument();
    const contact = contactFromVCardDocument(document);
    contact.emails[0].value = 'updated@example.test';
    const expected = structuredClone(document);
    expected.properties.find(property => property.name === 'EMAIL').rawValue
      = 'updated@example.test';

    expect(overlayContactOnVCard(document, contact)).toEqual(expected);
  });

  it.each([
    ['3.0', 'TYPE=WORK;X-VENDOR=first', 'TYPE=HOME,PREF;X-VENDOR=second'],
    ['4.0', 'TYPE=WORK;PREF=2;X-VENDOR=first', 'TYPE=HOME;PREF=1;X-VENDOR=second'],
  ])('round-trips email primary edits using vCard %s preference semantics', (
    version,
    firstParams,
    secondParams,
  ) => {
    const document = parseVCardDocument(vcard([
      `item1.EMAIL;${firstParams}:first@example.test`,
      'item1.X-ABLabel:First inbox',
      `item2.EMAIL;${secondParams}:second@example.test`,
      'item2.X-ABLabel:Second inbox',
    ], version));
    const fallback = contactFromVCardDocument(parseVCardDocument(vcard([
      'EMAIL:first@example.test',
      'EMAIL:second@example.test',
    ], version)));
    const contact = contactFromVCardDocument(document);
    const edited = structuredClone(contact);
    edited.emails[0].primary = true;
    edited.emails[1].primary = false;

    const overlaid = overlayContactOnVCard(document, edited);
    const serialized = serializeVCardDocument(overlaid);
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));
    const emailProperties = overlaid.properties.filter(property => property.name === 'EMAIL');

    expect(fallback.emails.map(email => email.primary)).toEqual([false, false]);
    expect(contact.emails.map(email => email.primary)).toEqual([false, true]);
    expect(localContactHash(edited)).not.toBe(localContactHash(contact));
    expect(serialized).not.toBe(serializeVCardDocument(document));
    expect(projected.emails.map(email => email.primary)).toEqual([true, false]);
    expect(emailProperties.map(property => property.group)).toEqual(['item1', 'item2']);
    expect(emailProperties.map(property => parameterValuesForTest(property, 'X-VENDOR')))
      .toEqual([['first'], ['second']]);
    expect(overlaid.properties.filter(property => property.name === 'X-ABLABEL'))
      .toEqual(document.properties.filter(property => property.name === 'X-ABLABEL'));
    if (version === '4.0') {
      expect(emailProperties.map(property => parameterValuesForTest(property, 'PREF')))
        .toEqual([['1'], []]);
    } else {
      expect(emailProperties.map(property => parameterValuesForTest(property, 'TYPE')))
        .toEqual([['WORK', 'PREF'], ['HOME']]);
    }
  });

  it.each([
    ['3.0', 'TYPE=WORK,PREF', 'TYPE=HOME'],
    ['4.0', 'TYPE=WORK;PREF=1', 'TYPE=HOME'],
  ])('round-trips an all-false email primary edit using vCard %s', (
    version,
    firstParams,
    secondParams,
  ) => {
    const document = parseVCardDocument(vcard([
      'UID:all-false-primary',
      'FN:All False Primary',
      `EMAIL;${firstParams}:first@example.test`,
      `EMAIL;${secondParams}:second@example.test`,
    ], version));
    const contact = contactFromVCardDocument(document);
    const edited = structuredClone(contact);
    edited.emails.forEach(email => { email.primary = false; });

    const overlaid = overlayContactOnVCard(document, edited);
    const serialized = serializeVCardDocument(overlaid);
    const reparsed = parseVCardDocument(serialized);
    const projected = contactFromVCardDocument(reparsed);
    const emailProperties = overlaid.properties.filter(property => property.name === 'EMAIL');

    expect(contact.emails.map(email => email.primary)).toEqual([true, false]);
    expect(localContactHash(edited)).not.toBe(localContactHash(contact));
    expect(projected.emails.map(email => email.primary)).toEqual([false, false]);
    expect(localContactHash(projected)).toBe(localContactHash(edited));
    expect(overlayContactOnVCard(reparsed, projected)).toEqual(reparsed);
    expect(emailProperties.flatMap(property => parameterValuesForTest(property, 'PREF')))
      .toEqual([]);
    expect(emailProperties.flatMap(property => parameterValuesForTest(property, 'TYPE')))
      .not.toContain('PREF');
  });

  it('clears every ranked vCard 4 preference without rewriting an unchanged card', () => {
    const document = parseVCardDocument(vcard([
      'EMAIL;PREF=1:first@example.test',
      'EMAIL;PREF=2:second@example.test',
    ], '4.0'));
    const contact = contactFromVCardDocument(document);
    const originalBytes = serializeVCardDocument(document);
    const edited = structuredClone(contact);
    edited.emails.forEach(email => { email.primary = false; });

    const overlaid = overlayContactOnVCard(document, edited);
    const reparsedDocument = parseVCardDocument(serializeVCardDocument(overlaid));
    const reparsed = contactFromVCardDocument(reparsedDocument);

    expect(serializeVCardDocument(overlayContactOnVCard(document, contact)))
      .toBe(originalBytes);
    expect(overlaid.properties.filter(property => property.name === 'EMAIL')
      .flatMap(property => parameterValuesForTest(property, 'PREF'))).toEqual([]);
    expect(reparsed.emails.map(email => email.primary)).toEqual([false, false]);
    expect(localContactHash(reparsed)).toBe(localContactHash(edited));
  });

  it('does not append missing UID or FN properties when projected values are empty', () => {
    const document = parseVCardDocument(vcard([
      'X-REMOTE:opaque',
    ]));

    expect(overlayContactOnVCard(document, contactFromVCardDocument(document)))
      .toEqual(document);
  });

  it.each([
    ['missing', ['N:Doe;Jane;;;']],
    ['blank', ['FN:', 'N:Doe;Jane;;;']],
  ])('preserves an unchanged %s retained FN', (_case, lines) => {
    const document = parseVCardDocument(vcard([
      'UID:retained-fn',
      ...lines,
      'EMAIL:jane@example.test',
    ]));
    const contact = contactFromVCardDocument(document);

    const overlaid = overlayContactOnVCard(document, contact);

    expect(contact.displayName).toBeNull();
    expect(overlaid).toEqual(document);
    expect(localContactHash(contactFromVCardDocument(overlaid)))
      .toBe(localContactHash(contact));
  });

  it('updates owned fields, drops protected metadata, and preserves an unknown grouped property', () => {
    const document = parseVCardDocument(vcard([
      'PRODID:-//Remote server//EN',
      'REV:20260101T000000Z',
      'UID:old-uid',
      'FN:Old Name',
      'N:Name;Old;;;',
      'EMAIL;TYPE=HOME:old@example.test',
      'NOTE:Old note',
      'item8.X-REMOTE-OPAQUE;X-ORDER="one;two":raw\\,opaque',
      'PHOTO;VALUE=URI:https://images.example.test/remote.jpg',
    ], '4.0'));
    const originalUnknown = structuredClone(
      document.properties.find(property => property.name === 'X-REMOTE-OPAQUE'),
    );
    const contact = contactFromVCardDocument(document);
    const overlaid = overlayContactOnVCard(document, {
      ...contact,
      uid: 'new-uid',
      displayName: 'New Name',
      firstName: 'New',
      lastName: 'Name',
      emails: [{ value: 'new@example.test', type: 'work', primary: true }],
      notes: 'New note',
    });
    const projected = contactFromVCardDocument(overlaid);

    expect(overlaid.version).toBe('4.0');
    expect(overlaid.properties.some(property => property.name === 'PRODID')).toBe(false);
    expect(overlaid.properties.some(property => property.name === 'REV')).toBe(false);
    expect(overlaid.properties.find(property => property.name === 'X-REMOTE-OPAQUE'))
      .toEqual(originalUnknown);
    expect(overlaid.properties.find(property => property.name === 'PHOTO').rawValue)
      .toBe('https://images.example.test/remote.jpg');
    expect(projected).toMatchObject({
      uid: 'new-uid',
      displayName: 'New Name',
      firstName: 'New',
      lastName: 'Name',
      emails: [{ value: 'new@example.test', type: 'work', primary: true }],
      notes: 'New note',
      photoData: null,
    });
    expect(document.properties.some(property => property.name === 'PRODID')).toBe(true);
  });

  it('treats null embedded photo data as explicit removal', () => {
    const document = parseVCardDocument(vcard([
      'UID:photo-remove',
      'FN:Photo Remove',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
    ]));
    const contact = contactFromVCardDocument(document);

    expect(contact.photoData).toBe('data:image/png;base64,AQID');
    expect(overlayContactOnVCard(document, { ...contact, photoData: null }).properties)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'PHOTO' })]));
  });

  it('removes legacy unparameterized base64 photos on explicit null', () => {
    const document = parseVCardDocument(vcard([
      'UID:legacy-photo-remove',
      'FN:Legacy Photo Remove',
      'PHOTO:AQID',
    ]));
    const contact = contactFromVCardDocument(document);

    expect(contact.photoData).toBe('data:image/jpeg;base64,AQID');
    expect(overlayContactOnVCard(document, { ...contact, photoData: null }).properties)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'PHOTO' })]));
  });

  it.each([
    ['JPEG', 'data:image/jpeg;charset=binary,%FF%D8%FF', '/9j/'],
    ['PNG', 'data:image/png;charset=binary,%89PNG%0D%0A', 'iVBORw0K'],
  ])('canonicalizes owned vCard 3.0 percent-encoded %s photos', (
    type,
    photoData,
    payload,
  ) => {
    const document = parseVCardDocument(vcard([
      'UID:data-uri-photo',
      'FN:Data URI Photo',
    ]));
    const contact = contactFromVCardDocument(document);

    const overlaid = overlayContactOnVCard(document, { ...contact, photoData });
    const serialized = serializeVCardDocument(overlaid);
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));
    const photo = overlaid.properties.find(property => property.name === 'PHOTO');

    expect(photo).toEqual({
      group: null,
      name: 'PHOTO',
      params: [
        { name: 'ENCODING', values: ['b'] },
        { name: 'TYPE', values: [type] },
      ],
      rawValue: payload,
    });
    expect(serialized).toContain(`PHOTO;ENCODING=b;TYPE=${type}:${payload}\r\n`);
    expect(localContactHash(projected)).toBe(localContactHash({ ...contact, photoData }));
  });

  it('rewrites an edited PHOTO in place without dropping retained metadata', () => {
    const document = parseVCardDocument(vcard([
      'item7.PHOTO;ENCODING=b;TYPE=PNG;X-VENDOR=keep:AQID',
      'item7.X-ABLabel:Avatar',
    ]));
    const contact = contactFromVCardDocument(document);
    const photoData = 'data:image/png;base64,BAUG';

    const overlaid = overlayContactOnVCard(document, { ...contact, photoData });
    const photo = overlaid.properties.find(property => property.name === 'PHOTO');
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));

    expect(photo.group).toBe('item7');
    expect(parameterValuesForTest(photo, 'X-VENDOR')).toEqual(['keep']);
    expect(overlaid.properties).toContainEqual({
      group: 'item7',
      name: 'X-ABLABEL',
      params: [],
      rawValue: 'Avatar',
    });
    expect(reparsed.photoData).toBe(photoData);
    expect(localContactHash(reparsed)).toBe(localContactHash({ ...contact, photoData }));
  });

  it.each([
    ['HTML', 'data:text/html;base64,PGgxPk5vdCBhIHBob3RvPC9oMT4='],
    ['BMP', 'data:image/bmp;base64,AQID'],
    ['SVG', 'data:image/svg+xml,<svg></svg>'],
  ])('rejects unsupported outbound owned %s photos', (_case, photoData) => {
    const document = parseVCardDocument(vcard([
      'UID:unsupported-outbound-photo',
      'FN:Unsupported Outbound Photo',
    ]));
    const contact = contactFromVCardDocument(document);

    expect(() => overlayContactOnVCard(document, { ...contact, photoData }))
      .toThrow(/unsupported PHOTO MIME type/);
  });

  it('serializes new custom text as a grouped property without item-group collisions', () => {
    const document = parseVCardDocument(vcard([
      'item1.X-REMOTE:first',
      'item3.X-REMOTE:third',
    ]));
    const overlaid = overlayContactOnVCard(document, {
      uid: 'custom-contact',
      displayName: 'Custom Contact',
      emails: [],
      phones: [],
      additionalFields: [{
        id: 'custom-stable-id',
        kind: 'custom-text',
        label: 'Favorite color',
        value: 'Blue',
      }],
    });
    const custom = overlaid.properties.find(property => property.name === 'X-MAILFLOW-CUSTOM');
    const label = overlaid.properties.find(property => (
      property.name === 'X-ABLABEL' && property.group === custom.group
    ));

    expect(custom).toEqual({
      group: 'item2',
      name: 'X-MAILFLOW-CUSTOM',
      params: [{ name: 'X-MAILFLOW-ID', values: ['custom-stable-id'] }],
      rawValue: 'Blue',
    });
    expect(label).toEqual({
      group: 'item2',
      name: 'X-ABLABEL',
      params: [],
      rawValue: 'Favorite color',
    });
    expect(serializeVCardDocument(overlaid)).toContain(
      'item2.X-MAILFLOW-CUSTOM;X-MAILFLOW-ID=custom-stable-id:Blue\r\n'
      + 'item2.X-ABLABEL:Favorite color\r\n',
    );
  });

  it('rejects new custom text without an explicit label before hashing or overlay', () => {
    const document = parseVCardDocument(vcard([
      'UID:unlabeled-custom',
      'FN:Unlabeled Custom',
    ]));
    const contact = {
      ...contactFromVCardDocument(document),
      additionalFields: [{
        id: 'unlabeled-custom-field',
        kind: 'custom-text',
        label: '',
        value: 'Blue',
      }],
    };

    expect(() => localContactHash(contact))
      .toThrow('MailFlow custom text field requires a label');
    expect(() => overlayContactOnVCard(document, contact))
      .toThrow('MailFlow custom text field requires a label');
  });

  it('allocates new custom text away from stale occupied metadata groups', () => {
    const document = parseVCardDocument(vcard([
      'UID:stale-custom-group',
      'FN:Stale Custom Group',
      'item1.X-REMOTE:opaque',
      'item1.X-ABLABEL:Remote label',
    ]));
    const contact = {
      ...contactFromVCardDocument(document),
      additionalFields: [{
        id: 'new-custom-field',
        kind: 'custom-text',
        label: 'Favorite color',
        value: 'Blue',
        vcard: {
          group: 'item1',
          name: 'X-MAILFLOW-CUSTOM',
          params: [{ name: 'X-VENDOR', values: ['keep'] }],
        },
      }],
    };

    const overlaid = overlayContactOnVCard(document, contact);
    const serialized = serializeVCardDocument(overlaid);
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));
    const custom = overlaid.properties.find(property => property.name === 'X-MAILFLOW-CUSTOM');

    expect(custom).toEqual({
      group: 'item2',
      name: 'X-MAILFLOW-CUSTOM',
      params: [
        { name: 'X-VENDOR', values: ['keep'] },
        { name: 'X-MAILFLOW-ID', values: ['new-custom-field'] },
      ],
      rawValue: 'Blue',
    });
    expect(overlaid.properties).toEqual(expect.arrayContaining([
      {
        group: 'item1',
        name: 'X-ABLABEL',
        params: [],
        rawValue: 'Remote label',
      },
      {
        group: 'item2',
        name: 'X-ABLABEL',
        params: [],
        rawValue: 'Favorite color',
      },
    ]));
    expect(projected.additionalFields).toEqual([
      expect.objectContaining({
        kind: 'custom-text',
        label: 'Favorite color',
        value: 'Blue',
      }),
    ]);
  });

  it.each([
    ['3.0', '49.1;-123.1'],
    ['4.0', 'geo:49.1,-123.1'],
  ])('serializes GEO values for vCard %s', (version, rawValue) => {
    const document = parseVCardDocument(vcard([], version));
    const overlaid = overlayContactOnVCard(document, {
      uid: `geo-${version}`,
      displayName: 'Geo Contact',
      emails: [],
      phones: [],
      additionalFields: [{
        id: 'geo-field',
        kind: 'geo',
        label: 'Location',
        value: { latitude: 49.1, longitude: -123.1 },
      }],
    });
    const serialized = serializeVCardDocument(overlaid);
    const geo = overlaid.properties.find(property => property.name === 'GEO');

    expect(geo.rawValue).toBe(rawValue);
    expect(serialized).toContain(`GEO;X-MAILFLOW-ID=geo-field:${rawValue}\r\n`);
    expect(contactFromVCardDocument(parseVCardDocument(serialized)).additionalFields[0].value)
      .toEqual({ latitude: 49.1, longitude: -123.1 });
  });

  it('matches Additional groups case-insensitively while preserving retained spelling', () => {
    const mixedCase = parseVCardDocument(vcard([
      'Item1.URL:https://first.example.test',
      'item1.URL:https://second.example.test',
      'ITEM1.X-ABLabel:Website',
    ]));
    const lowerCase = parseVCardDocument(vcard([
      'item1.URL:https://first.example.test',
      'item1.URL:https://second.example.test',
      'item1.X-ABLabel:Website',
    ]));
    const contact = contactFromVCardDocument(mixedCase);
    const lowerContact = contactFromVCardDocument(lowerCase);

    expect(contact.additionalFields.map(field => field.label)).toEqual(['Website', 'Website']);
    expect(contact.additionalFields.map(field => field.id))
      .toEqual(lowerContact.additionalFields.map(field => field.id));

    const overlaid = overlayContactOnVCard(mixedCase, {
      ...contact,
      additionalFields: contact.additionalFields.map(field => ({
        ...field,
        label: 'Portfolio',
      })),
    });
    const urls = overlaid.properties.filter(property => property.name === 'URL');
    const labels = overlaid.properties.filter(property => property.name === 'X-ABLABEL');

    expect(urls.map(property => property.group)).toEqual(['Item1', 'item1']);
    expect(labels).toEqual([{
      group: 'Item1',
      name: 'X-ABLABEL',
      params: [],
      rawValue: 'Portfolio',
    }]);
    expect(contactFromVCardDocument(overlaid).additionalFields.map(field => field.label))
      .toEqual(['Portfolio', 'Portfolio']);
  });

  it('reorders retained Additional rows in owned target order', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.X-ABLabel:One',
      'item2.URL:https://two.example.test',
      'item2.X-ABLabel:Two',
    ]));
    const contact = contactFromVCardDocument(document);
    const edited = {
      ...contact,
      additionalFields: [...contact.additionalFields].reverse(),
    };

    const projected = contactFromVCardDocument(
      parseVCardDocument(serializeVCardDocument(overlayContactOnVCard(document, edited))),
    );

    expect(projected.additionalFields.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'https://two.example.test', label: 'Two' },
      { value: 'https://one.example.test', label: 'One' },
    ]);
    expect(localContactHash(projected)).toBe(localContactHash(edited));
  });

  it('splits one retained row before changing a shared-group label', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const contact = contactFromVCardDocument(document);
    const edited = structuredClone(contact);
    edited.additionalFields[1].label = 'Second';

    const overlaid = overlayContactOnVCard(document, edited);
    const projected = contactFromVCardDocument(
      parseVCardDocument(serializeVCardDocument(overlaid)),
    );
    const urls = overlaid.properties.filter(property => property.name === 'URL');

    expect(projected.additionalFields.map(field => field.label)).toEqual(['Shared', 'Second']);
    expect(urls[0].group).toBe('item1');
    expect(urls[1].group).not.toBe('item1');
  });

  it('accepts an empty standard Additional label and drops the custom label', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://example.test',
      'item1.X-ABLabel:Website',
    ]));
    const contact = contactFromVCardDocument(document);
    contact.additionalFields[0].label = '';

    // A typed field maps to a real property (URL) and only needs a label for
    // X-ABLABEL grouping, so a blank label clears the custom label instead of failing.
    expect(() => localContactHash(contact)).not.toThrow();
    const overlaid = overlayContactOnVCard(document, contact);
    expect(overlaid.properties.some(property => property.name === 'X-ABLABEL')).toBe(false);
    const projected = contactFromVCardDocument(
      parseVCardDocument(serializeVCardDocument(overlaid)),
    );
    expect(projected.additionalFields).toEqual([
      expect.objectContaining({ kind: 'url', label: 'URL', value: 'https://example.test' }),
    ]);
  });

  it('projects current Additional kinds and labels after overlay', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://existing.example.test',
      'item1.X-ABLabel:Website',
      'URL:https://change.example.test',
    ]));
    const contact = contactFromVCardDocument(document);
    contact.additionalFields[1] = {
      ...contact.additionalFields[1],
      kind: 'role',
      label: 'Portfolio',
      value: 'Editor',
    };
    contact.additionalFields.push({
      id: 'new-nickname',
      kind: 'nickname',
      label: 'Alias',
      value: 'JD',
    });

    const projected = contactFromVCardDocument(overlayContactOnVCard(document, contact));

    expect(projected.additionalFields.map(({ kind, label, value, vcard: metadata }) => ({
      kind,
      label,
      value,
      name: metadata.name,
    }))).toEqual([
      { kind: 'url', label: 'Website', value: 'https://existing.example.test', name: 'URL' },
      { kind: 'role', label: 'Portfolio', value: 'Editor', name: 'ROLE' },
      { kind: 'nickname', label: 'Alias', value: 'JD', name: 'NICKNAME' },
    ]);
  });

  it('serializes new URL and IMPP Additional values as URI syntax', () => {
    const document = parseVCardDocument(vcard([
      'UID:uri-additional',
      'FN:URI Additional',
    ], '4.0'));
    const contact = {
      ...contactFromVCardDocument(document),
      additionalFields: [
        {
          id: 'new-url',
          kind: 'url',
          label: 'Portfolio',
          value: 'https://example.test/a,b;c?x=1,2',
        },
        {
          id: 'new-impp',
          kind: 'im',
          label: 'Chat',
          value: { protocol: 'xmpp', handle: 'user,name;tag@example.test' },
        },
      ],
    };

    const serialized = serializeVCardDocument(overlayContactOnVCard(document, contact));
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));

    expect(serialized).toContain(
      'URL;X-MAILFLOW-ID=new-url:https://example.test/a,b;c?x=1,2\r\n',
    );
    expect(serialized).toContain(
      'IMPP;X-MAILFLOW-ID=new-impp:xmpp:user,name;tag@example.test\r\n',
    );
    expect(projected.additionalFields.map(field => field.value)).toEqual([
      'https://example.test/a,b;c?x=1,2',
      { protocol: 'xmpp', handle: 'user,name;tag@example.test' },
    ]);
  });
});

describe('semantic vCard hash', () => {
  it('canonicalizes parameter order and repeated/list-equivalent forms without mutating syntax', () => {
    const ordered = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK;PREF=1:jane@example.test',
    ]));
    const reordered = parseVCardDocument(vcard([
      'EMAIL;PREF=1;TYPE=WORK:jane@example.test',
    ]));
    const repeated = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK;TYPE=INTERNET:jane@example.test',
    ]));
    const listed = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK,INTERNET:jane@example.test',
    ]));
    const changed = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK;PREF=2:jane@example.test',
    ]));
    const retainedSerializations = [ordered, reordered, repeated, listed]
      .map(serializeVCardDocument);

    expect(semanticVCardHash(reordered)).toBe(semanticVCardHash(ordered));
    expect(semanticVCardHash(listed)).toBe(semanticVCardHash(repeated));
    expect(semanticVCardHash(changed)).not.toBe(semanticVCardHash(ordered));
    expect([ordered, reordered, repeated, listed].map(serializeVCardDocument))
      .toEqual(retainedSerializations);
    expect(retainedSerializations[0]).toContain('TYPE=WORK;PREF=1');
    expect(retainedSerializations[1]).toContain('PREF=1;TYPE=WORK');
    expect(retainedSerializations[2]).toContain('TYPE=WORK;TYPE=INTERNET');
    expect(retainedSerializations[3]).toContain('TYPE=WORK,INTERNET');
  });

  it('canonicalizes TYPE value order without sorting ordered parameter values', () => {
    const first = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK,INTERNET;X-ORDER=one,two:jane@example.test',
    ]));
    const typeReordered = parseVCardDocument(vcard([
      'EMAIL;TYPE=INTERNET,WORK;X-ORDER=one,two:jane@example.test',
    ]));
    const orderedValueChanged = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK,INTERNET;X-ORDER=two,one:jane@example.test',
    ]));

    expect(semanticVCardHash(typeReordered)).toBe(semanticVCardHash(first));
    expect(semanticVCardHash(orderedValueChanged)).not.toBe(semanticVCardHash(first));
  });

  it('canonicalizes complete property-group alpha-renaming', () => {
    const first = parseVCardDocument(vcard([
      'item1.URL:https://example.test',
      'item1.X-ABLabel:Website',
    ]));
    const renamed = parseVCardDocument(vcard([
      'item7.URL:https://example.test',
      'item7.X-ABLabel:Website',
    ]));
    const relationChanged = parseVCardDocument(vcard([
      'item7.URL:https://example.test',
      'item8.X-ABLabel:Website',
    ]));

    expect(semanticVCardHash(renamed)).toBe(semanticVCardHash(first));
    expect(semanticVCardHash(relationChanged)).not.toBe(semanticVCardHash(first));
  });

  it('ignores formatting-only rewrites and protected metadata', () => {
    const first = parseVCardDocument([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:server-one',
      'REV:20260101T000000Z',
      'FN:Jane Doe',
      'EMAIL;TYPE="WORK,INTERNET":jane@example.test',
      'NOTE:Line one\\NLine two',
      'END:VCARD',
      '',
    ].join('\r\n'));
    const second = parseVCardDocument([
      'begin:vcard',
      'version:3.0',
      'prodid:server-two',
      'rev:20261231T235959Z',
      'fn:Jane Doe',
      'email;type=work,internet:jane@example.test',
      'note:Line one\\nLine two',
      'end:vcard',
      '',
    ].join('\n'));

    expect(semanticVCardHash(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(semanticVCardHash(second)).toBe(semanticVCardHash(first));
  });

  it('changes for unknown-property, photo-only, and photo-removal changes', () => {
    const base = parseVCardDocument(vcard([
      'UID:semantic',
      'FN:Semantic',
      'X-REMOTE:value-a',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
    ]));
    const unknownChanged = parseVCardDocument(vcard([
      'UID:semantic',
      'FN:Semantic',
      'X-REMOTE:value-b',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
    ]));
    const photoChanged = parseVCardDocument(vcard([
      'UID:semantic',
      'FN:Semantic',
      'X-REMOTE:value-a',
      'PHOTO;ENCODING=b;TYPE=PNG:BAUG',
    ]));
    const photoRemoved = parseVCardDocument(vcard([
      'UID:semantic',
      'FN:Semantic',
      'X-REMOTE:value-a',
    ]));

    expect(semanticVCardHash(unknownChanged)).not.toBe(semanticVCardHash(base));
    expect(semanticVCardHash(photoChanged)).not.toBe(semanticVCardHash(base));
    expect(semanticVCardHash(photoRemoved)).not.toBe(semanticVCardHash(base));
  });

  it('canonicalizes base64 data-URI metadata and decoded bytes', () => {
    const first = parseVCardDocument(vcard([
      'PHOTO:data:IMAGE/PNG;BASE64,AQID',
    ], '4.0'));
    const second = parseVCardDocument(vcard([
      'PHOTO:data:image/png;base64,AQ ID',
    ], '4.0'));

    expect(semanticVCardHash(second)).toBe(semanticVCardHash(first));
  });

  it('canonicalizes percent-encoded PHOTO bytes independent of hex case', () => {
    const first = parseVCardDocument(vcard([
      'PHOTO:data:image/png,%89PNG%0D%0A',
    ], '4.0'));
    const second = parseVCardDocument(vcard([
      'PHOTO:data:IMAGE/PNG,%89PNG%0d%0a',
    ], '4.0'));

    expect(semanticVCardHash(second)).toBe(semanticVCardHash(first));
  });
});

describe('local contact hash', () => {
  const camelContact = () => ({
    uid: 'stable-uid',
    displayName: null,
    firstName: 'Jane\r\nQ.',
    lastName: 'Doe',
    emails: [
      { value: ' Jane.Doe@Example.Test ', type: 'Work', primary: true },
      { value: 'other@example.test', type: 'OTHER', primary: false },
    ],
    phones: [{ value: '+1 555 123 4567', type: 'CELL' }],
    organization: 'Example Corp',
    notes: 'Line one\r\nLine two',
    photoData: 'data:IMAGE/PNG;base64,QUJDRA==',
    additionalFields: [{
      id: 'field-stable-1',
      kind: 'CUSTOM-TEXT',
      label: 'Favorite\r\ncolor',
      value: 'Blue',
      vcard: {
        name: 'X-MAILFLOW-CUSTOM',
        group: 'item1',
        params: [{ values: ['one', 'two'], name: 'TYPE' }],
      },
    }],
  });

  it('matches database/API naming shapes and harmless object-key ordering', () => {
    const api = camelContact();
    const database = {
      id: 'database-id',
      address_book_id: 'book-id',
      uid: 'stable-uid',
      display_name: '',
      first_name: 'Jane\nQ.',
      last_name: 'Doe',
      emails: [
        { primary: 1, type: 'work', value: 'jane.doe@example.test' },
        { primary: 0, type: 'other', value: 'other@example.test' },
      ],
      phones: [{ type: 'mobile', value: '+15551234567' }],
      organization: 'Example Corp',
      notes: 'Line one\nLine two',
      photo_data: 'data:image/png;base64,QUJD\nRA==',
      additional_fields: [{
        value: 'Blue',
        label: 'Favorite\ncolor',
        kind: 'custom-text',
        id: 'field-stable-1',
        vcard: {
          params: [{ name: 'type', values: ['ONE', 'TWO'] }],
          group: 'item1',
          name: 'x-mailflow-custom',
        },
      }],
      etag: 'ignored',
      created_at: 'ignored',
      updated_at: 'ignored',
      send_count: 999,
      is_auto: true,
    };

    expect(localContactHash(api)).toMatch(/^[a-f0-9]{64}$/);
    expect(localContactHash(database)).toBe(localContactHash(api));
  });

  it('normalizes null and empty owned scalar representations', () => {
    const first = camelContact();
    const second = {
      ...camelContact(),
      displayName: '',
      organization: null,
    };
    first.organization = '';

    expect(localContactHash(second)).toBe(localContactHash(first));
  });

  it('ignores incidental persistence keys inside Additional fields', () => {
    const original = camelContact();
    const withPersistence = structuredClone(original);
    Object.assign(withPersistence.additionalFields[0], {
      databaseId: 'row-123',
      createdAt: '2026-07-11T00:00:00Z',
      is_auto: true,
    });
    Object.assign(withPersistence.additionalFields[0].vcard, {
      databaseId: 'metadata-row-123',
      etag: 'ignored',
    });
    withPersistence.additionalFields[0].vcard.params[0].databaseId = 'parameter-row-123';

    expect(localContactHash(withPersistence)).toBe(localContactHash(original));
  });

  it('hashes only owned Additional id, kind, label, and value data', () => {
    const original = camelContact();
    const syntaxChanged = structuredClone(original);
    syntaxChanged.additionalFields[0].vcard = {
      group: 'remote-group',
      name: 'X-REMOTE-SYNTAX',
      params: [
        { name: 'PREF', values: ['1'] },
        { name: 'X-VENDOR', values: ['opaque'] },
      ],
    };

    expect(localContactHash(syntaxChanged)).toBe(localContactHash(original));
  });

  it('canonicalizes supported local photo MIME identity and decoded bytes', () => {
    const paddedJpeg = { ...camelContact(), photoData: 'data:image/jpeg;base64,AQI=' };
    const aliasWithWhitespace = {
      ...camelContact(),
      photoData: 'data:IMAGE/JPG;base64,A Q I',
    };
    const differentBytes = { ...camelContact(), photoData: 'data:image/jpeg;base64,AQM=' };
    const sameBytesPng = { ...camelContact(), photoData: 'data:image/png;base64,AQI=' };

    expect(localContactHash(aliasWithWhitespace)).toBe(localContactHash(paddedJpeg));
    expect(localContactHash(differentBytes)).not.toBe(localContactHash(paddedJpeg));
    expect(localContactHash(sameBytesPng)).not.toBe(localContactHash(paddedJpeg));
  });

  it('canonicalizes supported percent-encoded local photo bytes', () => {
    const upper = { ...camelContact(), photoData: 'data:image/png,%89PNG%0D%0A' };
    const lower = { ...camelContact(), photoData: 'data:IMAGE/PNG,%89PNG%0d%0a' };
    const changed = { ...camelContact(), photoData: 'data:image/png,%89PNG%0D%0B' };

    expect(localContactHash(lower)).toBe(localContactHash(upper));
    expect(localContactHash(changed)).not.toBe(localContactHash(upper));
  });

  it.each([
    ['uid', contact => { contact.uid = 'changed'; }],
    ['display name', contact => { contact.displayName = 'Changed'; }],
    ['first name', contact => { contact.firstName = 'Changed'; }],
    ['last name', contact => { contact.lastName = 'Changed'; }],
    ['email', contact => { contact.emails[0].value = 'changed@example.test'; }],
    ['email type', contact => { contact.emails[0].type = 'home'; }],
    ['email primary flag', contact => { contact.emails[0].primary = false; }],
    ['email order', contact => { contact.emails.reverse(); }],
    ['phone', contact => { contact.phones[0].value = '+15550000000'; }],
    ['phone type', contact => { contact.phones[0].type = 'home'; }],
    ['organization', contact => { contact.organization = 'Changed'; }],
    ['notes', contact => { contact.notes = 'Changed'; }],
    ['photo', contact => { contact.photoData = 'data:image/png;base64,AQID'; }],
    ['Additional value', contact => { contact.additionalFields[0].value = 'Red'; }],
    ['Additional label', contact => { contact.additionalFields[0].label = 'Other'; }],
    ['Additional kind', contact => { contact.additionalFields[0].kind = 'url'; }],
    ['Additional stable ID', contact => { contact.additionalFields[0].id = 'changed-id'; }],
  ])('changes when the owned %s changes', (_field, mutate) => {
    const original = camelContact();
    const changed = structuredClone(original);
    mutate(changed);

    expect(localContactHash(changed)).not.toBe(localContactHash(original));
  });
});

describe('vCard property validation and normalization regressions', () => {
  it.each([
    ['parsing', params => parseVCardDocument(vcard([
      foldAsciiLine(`PHOTO;${params}:${Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xa5).toString('base64')}`),
    ]))],
    ['serialization', params => serializeVCardDocument({
      version: '3.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: params.split(';').map(parameter => {
          const [name, value] = parameter.split('=');
          return { name, values: [value] };
        }),
        rawValue: Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xa5).toString('base64'),
      }],
    })],
  ])('uses the first repeated PHOTO VALUE during %s', (_case, run) => {
    expect(() => run('VALUE=binary;VALUE=uri;ENCODING=b'))
      .toThrow('vCard exceeds the 512 KiB photo limit');
    expect(() => run('VALUE=uri;VALUE=binary;ENCODING=b'))
      .toThrow('vCard exceeds the 64 KiB unfolded line limit');
  });

  it.each([
    ['empty', [
      'item1.URL;X-MAILFLOW-ID=:https://one.example.test',
      'item1.X-ABLabel:One',
    ], 'vCard contains an invalid MailFlow Additional field ID'],
    ['multiple values on one property', [
      'item1.URL;X-MAILFLOW-ID=one,two:https://one.example.test',
      'item1.X-ABLabel:One',
    ], 'vCard contains an invalid MailFlow Additional field ID'],
    ['duplicate', [
      'item1.URL;X-MAILFLOW-ID=duplicate:https://one.example.test',
      'item1.X-ABLabel:One',
      'item2.URL;X-MAILFLOW-ID=duplicate:https://two.example.test',
      'item2.X-ABLabel:Two',
    ], 'vCard contains duplicate MailFlow Additional field IDs'],
  ])('rejects %s persisted Additional IDs during projection', (_case, lines, error) => {
    const document = parseVCardDocument(vcard(lines));
    const original = structuredClone(document);

    expect(() => contactFromVCardDocument(document)).toThrow(error);
    expect(document).toEqual(original);
  });

  it('keeps a valid unique persisted Additional ID byte-identical on unchanged overlay', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL;X-MAILFLOW-ID=unique:https://one.example.test',
      'item1.X-ABLabel:One',
    ]));
    const contact = contactFromVCardDocument(document);
    const originalBytes = serializeVCardDocument(document);

    expect(contact.additionalFields[0].id).toBe('unique');
    expect(overlayContactOnVCard(document, contact)).toEqual(document);
    expect(serializeVCardDocument(overlayContactOnVCard(document, contact)))
      .toBe(originalBytes);
  });

  it('validates reserved IDs before keeping opaque GEO properties unchanged', () => {
    const malformed = parseVCardDocument(vcard([
      'GEO;X-MAILFLOW-ID=:not-a-coordinate',
    ]));
    const valid = parseVCardDocument(vcard([
      'GEO;X-MAILFLOW-ID=opaque-geo:not-a-coordinate',
    ]));
    const contact = contactFromVCardDocument(valid);
    const originalBytes = serializeVCardDocument(valid);

    expect(() => contactFromVCardDocument(malformed))
      .toThrow('vCard contains an invalid MailFlow Additional field ID');
    expect(contact.additionalFields).toEqual([]);
    expect(overlayContactOnVCard(valid, contact)).toEqual(valid);
    expect(serializeVCardDocument(overlayContactOnVCard(valid, contact)))
      .toBe(originalBytes);
  });

  it('keeps an opaque GEO occurrence before a derived same-group GEO byte-identical', () => {
    const document = parseVCardDocument(vcard([
      'item1.GEO:not-a-coordinate',
      'item1.GEO:49.1;-123.1',
      'item1.X-ABLabel:Shared',
    ]));
    const contact = contactFromVCardDocument(document);
    const originalBytes = serializeVCardDocument(document);

    expect(contact.additionalFields).toHaveLength(1);
    expect(overlayContactOnVCard(document, contact)).toEqual(document);
    expect(serializeVCardDocument(overlayContactOnVCard(document, contact)))
      .toBe(originalBytes);
  });

  it('persists a derived GEO identity after a true occurrence shift past opaque GEO', () => {
    const document = parseVCardDocument(vcard([
      'item1.GEO:not-a-coordinate',
      'item1.GEO;X-MAILFLOW-ID=saved:49.1;-123.1',
      'item1.GEO:50.1;-124.1',
      'item1.X-ABLabel:Shared',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields = target.additionalFields.slice(1);
    const expectedId = target.additionalFields[0].id;

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const retained = overlaid.properties.find(property => (
      property.name === 'GEO' && property.rawValue.startsWith('50.1')
    ));

    expect(parameterValuesForTest(retained, 'X-MAILFLOW-ID')).toEqual([expectedId]);
    expect(reparsed.additionalFields.map(field => field.id)).toEqual([expectedId]);
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it.each([
    ['missing', [
      { kind: 'url', label: 'One', value: 'https://one.example.test' },
    ], 'MailFlow Additional field requires a stable ID'],
    ['duplicate', [
      { id: 'duplicate', kind: 'url', label: 'One', value: 'https://one.example.test' },
      { id: 'duplicate', kind: 'url', label: 'Two', value: 'https://two.example.test' },
    ], 'MailFlow Additional field IDs must be unique'],
  ])('rejects %s caller Additional IDs before overlay or hashing', (
    _case,
    additionalFields,
    error,
  ) => {
    const document = parseVCardDocument(vcard([
      'UID:caller-id-invariant',
      'FN:Caller ID Invariant',
    ]));
    const contact = { ...contactFromVCardDocument(document), additionalFields };
    const original = structuredClone(document);

    expect(() => overlayContactOnVCard(document, contact)).toThrow(error);
    expect(() => localContactHash(contact)).toThrow(error);
    expect(document).toEqual(original);
  });

  it.each([
    ['postal-address', { street: '123 Main' }],
    ['im', { handle: 'alice' }],
  ])('hash-converges accepted partial %s Additional values', (kind, value) => {
    const document = parseVCardDocument(vcard([]));
    const target = {
      ...contactFromVCardDocument(document),
      additionalFields: [{
        id: `partial-${kind}`,
        kind,
        label: 'Partial',
        value,
      }],
    };

    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlayContactOnVCard(document, target)),
    ));

    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it.each([
    ['HTTP-looking', 'https://example.test/not-base64'],
    ['data-looking', 'data:image/jpeg,not-base64'],
  ].flatMap(([description, rawValue]) => [
    [description, 'parsing', () => parseVCardDocument(vcard([
      `PHOTO;ENCODING=b;TYPE=JPEG:${rawValue}`,
    ]))],
    [description, 'serialization', () => serializeVCardDocument({
      version: '3.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: [
          { name: 'ENCODING', values: ['b'] },
          { name: 'TYPE', values: ['JPEG'] },
        ],
        rawValue,
      }],
    })],
  ]))('honors explicit base64 for %s PHOTO data during %s', (
    _description,
    _operation,
    run,
  ) => {
    expect(run).toThrow('vCard PHOTO has invalid base64 data');
  });

  it('keeps explicit data-looking URI PHOTO values opaque, retained, and unfetched', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error('unexpected fetch');
    };

    try {
      const document = parseVCardDocument(vcard([
        'PHOTO;VALUE=URI:data:image/png;base64,AQID',
      ], '4.0'));
      const contact = contactFromVCardDocument(document);
      const overlaid = overlayContactOnVCard(document, { ...contact, photoData: null });

      expect(contact.photoData).toBeNull();
      expect(overlaid).toEqual(document);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ['3.0', 'line-wrapped PNG data URI', 'data:image/png;base64,AQ \r\nID',
      'data:image/png;base64,AQID'],
    ['4.0', 'line-wrapped PNG data URI', 'data:image/png;base64,AQ \r\nID',
      'data:image/png;base64,AQID'],
    ['3.0', 'line-wrapped raw JPEG base64', 'AQ \r\nID',
      'data:image/jpeg;base64,AQID'],
    ['4.0', 'line-wrapped raw JPEG base64', 'AQ \r\nID',
      'data:image/jpeg;base64,AQID'],
    ['3.0', 'percent-encoded PNG data URI', 'data:image/png,%89PNG%0D%0A',
      'data:image/png;base64,iVBORw0K'],
    ['4.0', 'percent-encoded PNG data URI', 'data:image/png,%89PNG%0D%0A',
      'data:image/png;base64,iVBORw0K'],
  ])('canonicalizes owned photo input for vCard %s (%s)', (
    version,
    _case,
    photoData,
    canonicalPhotoData,
  ) => {
    const document = parseVCardDocument(vcard([], version));
    const contact = { ...contactFromVCardDocument(document), photoData };

    expect(localContactHash(contact)).toBe(localContactHash({
      ...contact,
      photoData: canonicalPhotoData,
    }));

    const overlaid = overlayContactOnVCard(document, contact);
    const photo = overlaid.properties.find(property => property.name === 'PHOTO');
    const serialized = serializeVCardDocument(overlaid);
    const reparsed = contactFromVCardDocument(parseVCardDocument(serialized));
    const payload = photo.rawValue.slice(photo.rawValue.lastIndexOf(',') + 1);

    expect(payload).not.toMatch(/\s/);
    expect(localContactHash(reparsed)).toBe(localContactHash(contact));
  });

  it('persists and projects the stable ID of a newly added custom-text row', () => {
    const document = parseVCardDocument(vcard([
      'UID:new-custom-identity',
      'FN:New Custom Identity',
    ]));
    const target = {
      ...contactFromVCardDocument(document),
      additionalFields: [{
        id: 'custom-stable-id',
        kind: 'custom-text',
        label: 'Favorite color',
        value: 'Blue',
      }],
    };

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const property = overlaid.properties.find(entry => entry.name === 'X-MAILFLOW-CUSTOM');

    expect(parameterValuesForTest(property, 'X-MAILFLOW-ID')).toEqual(['custom-stable-id']);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('persists and projects the stable ID of a newly added URL row', () => {
    const document = parseVCardDocument(vcard([
      'UID:new-url-identity',
      'FN:New URL Identity',
    ]));
    const target = {
      ...contactFromVCardDocument(document),
      additionalFields: [{
        id: 'url-stable-id',
        kind: 'url',
        label: 'Portfolio',
        value: 'https://example.test/portfolio',
      }],
    };

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const property = overlaid.properties.find(entry => entry.name === 'URL');

    expect(parameterValuesForTest(property, 'X-MAILFLOW-ID')).toEqual(['url-stable-id']);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('keeps a retained Additional ID through a kind change', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL;X-VENDOR=keep:https://example.test/profile',
      'item1.X-ABLabel:Profile',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields[0] = {
      ...target.additionalFields[0],
      kind: 'role',
      label: 'Team role',
      value: 'Editor',
    };

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const property = overlaid.properties.find(entry => entry.name === 'ROLE');

    expect(parameterValuesForTest(property, 'X-MAILFLOW-ID'))
      .toEqual([target.additionalFields[0].id]);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('keeps both retained Additional IDs when one shared label is split', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields[1].label = 'Second';

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const properties = overlaid.properties.filter(entry => entry.name === 'URL');

    expect(parameterValuesForTest(properties[0], 'X-MAILFLOW-ID')).toEqual([]);
    expect(parameterValuesForTest(properties[1], 'X-MAILFLOW-ID'))
      .toEqual([target.additionalFields[1].id]);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('persists derived survivors when the first shared-label row is split', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields[0].label = 'First';

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const properties = overlaid.properties.filter(entry => entry.name === 'URL');

    expect(properties.map(property => parameterValuesForTest(property, 'X-MAILFLOW-ID')))
      .toEqual(target.additionalFields.map(field => [field.id]));
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it.each([
    ['deletes the first', fields => fields.slice(1), ['two']],
    ['reorders', fields => [...fields].reverse(), ['two', 'one']],
  ])('%s retained rows with persisted IDs', (_case, edit, expectedIds) => {
    const document = parseVCardDocument(vcard([
      'item1.URL;X-MAILFLOW-ID=one:https://one.example.test',
      'item1.URL;X-MAILFLOW-ID=two:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields = edit(target.additionalFields);

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));

    expect(reparsed.additionalFields.map(field => field.id)).toEqual(expectedIds);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it.each([
    ['deletes a preceding persisted row', fields => fields.slice(1), ['derived']],
    ['reorders a preceding persisted row', fields => [...fields].reverse(), ['derived', 'saved']],
  ])('%s before a derived survivor without identity drift', (_case, edit, expectedValues) => {
    const document = parseVCardDocument(vcard([
      'item1.URL;X-MAILFLOW-ID=saved:https://saved.example.test',
      'item1.URL:https://derived.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields = edit(target.additionalFields);
    const expectedIds = target.additionalFields.map(field => field.id);

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const urls = overlaid.properties.filter(property => property.name === 'URL');

    expect(reparsed.additionalFields.map(field => (
      field.value.includes('derived') ? 'derived' : 'saved'
    ))).toEqual(expectedValues);
    expect(reparsed.additionalFields.map(field => field.id)).toEqual(expectedIds);
    expect(urls.find(property => property.rawValue.includes('derived')).params)
      .toContainEqual({ name: 'X-MAILFLOW-ID', values: [expectedIds[0]] });
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('prefers and preserves a persisted Additional ID through value and label edits', () => {
    const document = parseVCardDocument(vcard([
      'item4.URL;X-MAILFLOW-ID=ordinary-stable-id:https://old.example.test',
      'item4.X-ABLabel:Old label',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields[0].label = 'New label';
    target.additionalFields[0].value = 'https://new.example.test';

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const property = overlaid.properties.find(entry => entry.name === 'URL');

    expect(target.additionalFields[0].id).toBe('ordinary-stable-id');
    expect(parameterValuesForTest(property, 'X-MAILFLOW-ID')).toEqual(['ordinary-stable-id']);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('keeps a derived Additional ID through ordinary edits without adding identity syntax', () => {
    const document = parseVCardDocument(vcard([
      'item5.URL:https://old.example.test',
      'item5.X-ABLabel:Old label',
    ]));
    const target = contactFromVCardDocument(document);
    target.additionalFields[0].label = 'New label';
    target.additionalFields[0].value = 'https://new.example.test';

    const overlaid = overlayContactOnVCard(document, target);
    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlaid),
    ));
    const property = overlaid.properties.find(entry => entry.name === 'URL');

    expect(parameterValuesForTest(property, 'X-MAILFLOW-ID')).toEqual([]);
    expect(additionalIdentityRows(reparsed)).toEqual(additionalIdentityRows(target));
    expect(localContactHash(reparsed)).toBe(localContactHash(target));
  });

  it('keeps unchanged retained remote rows byte-identical without adding identity syntax', () => {
    const raw = vcard([
      'item7.URL;TYPE=HOME;X-VENDOR=keep:https://example.test/profile',
      'item7.X-ABLabel:Profile',
    ]);
    const document = parseVCardDocument(raw);
    const contact = contactFromVCardDocument(document);
    const originalBytes = serializeVCardDocument(document);
    const overlaid = overlayContactOnVCard(document, contact);

    expect(overlaid).toEqual(document);
    expect(serializeVCardDocument(overlaid)).toBe(originalBytes);
    expect(serializeVCardDocument(overlaid)).not.toContain('X-MAILFLOW-ID');
  });

  it('uses the strict first content delimiter for NOTE and unknown properties', () => {
    const document = parseVCardDocument(vcard([
      'NOTE;X-P=trailing\\:sip:alice@example.test',
      'X-REFERENCE;X-P=trailing\\:webcal:event-id',
    ]));

    expect(document.properties).toEqual([
      {
        group: null,
        name: 'NOTE',
        params: [{ name: 'X-P', values: ['trailing\\'] }],
        rawValue: 'sip:alice@example.test',
      },
      {
        group: null,
        name: 'X-REFERENCE',
        params: [{ name: 'X-P', values: ['trailing\\'] }],
        rawValue: 'webcal:event-id',
      },
    ]);
  });

  it('rejects vCard 3.0 parameter values that can inject content lines', () => {
    const document = {
      version: '3.0',
      properties: [{
        group: null,
        name: 'X-SAFE',
        params: [{ name: 'X-LABEL', values: ['safe\r\nX-INJECT:payload'] }],
        rawValue: 'value',
      }],
    };

    expect(() => serializeVCardDocument(document))
      .toThrow('vCard parameter value contains an invalid character');
  });

  it('round-trips legal vCard 3.0 HTAB parameter whitespace', () => {
    const document = {
      version: '3.0',
      properties: [{
        group: null,
        name: 'X-SAFE',
        params: [{ name: 'X-LABEL', values: ['left\tright'] }],
        rawValue: 'value',
      }],
    };

    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it.each(['\0', '\v', '\f', '\x7f'])(
    'rejects forbidden parameter control %j in both versions',
    control => {
      for (const version of ['3.0', '4.0']) {
        expect(() => serializeVCardDocument({
          version,
          properties: [{
            group: null,
            name: 'X-SAFE',
            params: [{ name: 'X-LABEL', values: [`left${control}right`] }],
            rawValue: 'value',
          }],
        })).toThrow('vCard parameter value contains an invalid character');
      }
    },
  );

  it.each(['BEGIN', 'END', 'VERSION'])(
    'rejects structural %s pseudo-properties before serialization',
    name => {
      expect(() => serializeVCardDocument({
        version: '4.0',
        properties: [{ group: null, name, params: [], rawValue: 'value' }],
      })).toThrow('vCard document cannot contain structural properties');
    },
  );

  it.each(['\0', '\v', '\f', '\x7f'])(
    'rejects forbidden parsed parameter control %j in both versions',
    control => {
      for (const version of ['3.0', '4.0']) {
        expect(() => parseVCardDocument(vcard([
          `X-SAFE;X-LABEL=left${control}right:value`,
        ], version))).toThrow('vCard parameter value contains an invalid character');
      }
    },
  );

  it('rejects literal double quotes inside a vCard 3.0 parameter value', () => {
    expect(() => parseVCardDocument(vcard([
      'X-SAFE;X-LABEL=left"middle":value',
    ]))).toThrow('vCard parameter value contains an invalid character');
  });

  it('round-trips a valid quoted vCard 3.0 parameter value', () => {
    const document = parseVCardDocument(vcard([
      'X-SAFE;X-LABEL="left,middle":value',
    ]));

    expect(document.properties[0].params).toEqual([
      { name: 'X-LABEL', values: ['left,middle'] },
    ]);
    expect(parseVCardDocument(serializeVCardDocument(document))).toEqual(document);
  });

  it.each([
    ['parsing', rawValue => parseVCardDocument(vcard([
      foldAsciiLine(`PHOTO:${rawValue}`),
    ], '4.0'))],
    ['serialization', rawValue => serializeVCardDocument({
      version: '4.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue }],
    })],
  ])('rejects a PHOTO data carrier without a comma during %s', (_case, run) => {
    expect(() => run('data:image/png;base64AQID'))
      .toThrow('vCard PHOTO has invalid data URI encoding');
  });

  it.each([
    ['parsing', rawValue => parseVCardDocument(vcard([
      foldAsciiLine(`PHOTO:${rawValue}`),
    ], '4.0'))],
    ['serialization', rawValue => serializeVCardDocument({
      version: '4.0',
      properties: [{ group: null, name: 'PHOTO', params: [], rawValue }],
    })],
  ])('does not exempt an oversized malformed PHOTO data carrier during %s', (_case, run) => {
    const malformed = 'data:image/png;base64' + 'a'.repeat(MAX_CONTENT_LINE_BYTES);
    expect(() => run(malformed))
      .toThrow(/vCard PHOTO has invalid data URI encoding|64 KiB unfolded line limit/);
  });

  it.each([
    'item1.BEGIN:VCARD',
    'BEGIN;X-P=one:VCARD',
    'item1.END:VCARD',
    'END;X-P=one:VCARD',
    'item1.VERSION:4.0',
    'VERSION;X-P=one:4.0',
  ])('rejects parsed structural pseudo-property %s', line => {
    expect(() => parseVCardDocument(vcard([line], '4.0'))).toThrow();
  });

  it('rejects parameterized VERSION instead of silently downgrading it', () => {
    expect(() => parseVCardDocument([
      'BEGIN:VCARD',
      'VERSION;VALUE=text:4.0',
      'X-REFERENCE;X-P=line^nbreak:payload',
      'END:VCARD',
      '',
    ].join('\r\n'))).toThrow('vCard VERSION parameters are not supported');
  });

  it('uses the standards delimiter for an unlisted URI scheme after a parameter backslash', () => {
    const document = parseVCardDocument(vcard([
      'IMPP;X-P=trailing\\:sip:alice@example.test',
    ]));

    expect(document.properties[0]).toEqual({
      group: null,
      name: 'IMPP',
      params: [{ name: 'X-P', values: ['trailing\\'] }],
      rawValue: 'sip:alice@example.test',
    });
  });

  it('serializes owned vCard 4.0 UID and URI TEL edits with URI delimiters', () => {
    const document = parseVCardDocument(vcard([
      'UID:urn:uuid:old,value;part',
      'TEL;VALUE=uri:tel:+15551234567,9;ext=1',
    ], '4.0'));
    const contact = contactFromVCardDocument(document);
    contact.uid = 'urn:uuid:new,value;part';
    contact.phones[0].value = 'tel:+15551234568,9;ext=2';

    const serialized = serializeVCardDocument(overlayContactOnVCard(document, contact));
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));

    expect(serialized).toContain('UID:urn:uuid:new,value;part\r\n');
    expect(serialized).toContain('TEL;VALUE=uri:tel:+15551234568,9;ext=2\r\n');
    expect(projected.uid).toBe(contact.uid);
    expect(projected.phones[0].value).toBe(contact.phones[0].value);
  });

  it('requires exactly one ordered vCard envelope and counts structural lines', () => {
    const card = vcard(['UID:one']);
    expect(() => parseVCardDocument(card + card)).toThrow(/exactly one vCard component/);
    expect(() => parseVCardDocument('VERSION:3.0\r\nUID:none\r\n'))
      .toThrow(/BEGIN:VCARD/);
    expect(() => parseVCardDocument([
      'BEGIN:VCARD',
      ...Array.from({ length: 2500 }, () => 'VERSION:3.0'),
      'END:VCARD',
      '',
    ].join('\r\n'))).toThrow(/exactly one VERSION property/);
  });

  it.each([
    ['group', 'BAD/GROUP.X-SAFE:value', 'vCard contains an invalid property group'],
    ['property', 'BAD/NAME:value', 'vCard contains an invalid property name'],
    ['parameter', 'X-SAFE;BAD@PARAM=v:value', 'vCard contains an invalid parameter name'],
  ])('rejects an invalid parsed %s token independently', (_token, line, error) => {
    expect(() => parseVCardDocument(vcard([line]))).toThrow(error);
  });

  it('rejects deleting an earlier ambiguous retained Additional row before mutation', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const projected = contactFromVCardDocument(document);
    const edited = {
      ...projected,
      additionalFields: projected.additionalFields.slice(1),
    };

    expect(() => overlayContactOnVCard(document, edited)).toThrow(
      'MailFlow Additional fields cannot delete an earlier ambiguous retained property',
    );
    expect(document.properties.map(property => property.rawValue)).toEqual([
      'https://one.example.test',
      'https://two.example.test',
      'Shared',
    ]);
  });

  it('allows deleting the final ambiguous retained Additional row without identity drift', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const projected = contactFromVCardDocument(document);
    const edited = {
      ...projected,
      additionalFields: projected.additionalFields.slice(0, 1),
    };

    const reparsed = contactFromVCardDocument(parseVCardDocument(
      serializeVCardDocument(overlayContactOnVCard(document, edited)),
    ));

    expect(reparsed.additionalFields.map(({ id, value }) => ({ id, value }))).toEqual(
      edited.additionalFields.map(({ id, value }) => ({ id, value })),
    );
    expect(localContactHash(reparsed)).toBe(localContactHash(edited));
  });

  it('uses explicit TEXT instead of vCard 4.0 URI defaults for UID and TEL', () => {
    const document = parseVCardDocument(vcard([
      'UID;VALUE=text:id\\,one',
      'TEL;VALUE=text:call\\,me',
    ], '4.0'));
    const contact = contactFromVCardDocument(document);
    const edited = structuredClone(contact);
    edited.uid = 'id,two';
    edited.phones[0].value = 'call,you';

    const serialized = serializeVCardDocument(overlayContactOnVCard(document, edited));
    const reparsed = contactFromVCardDocument(parseVCardDocument(serialized));

    expect(contact.uid).toBe('id,one');
    expect(contact.phones[0].value).toBe('call,me');
    expect(serialized).toContain('UID;VALUE=text:id\\,two\r\n');
    expect(serialized).toContain('TEL;VALUE=text:call\\,you\r\n');
    expect(reparsed.uid).toBe(edited.uid);
    expect(reparsed.phones[0].value).toBe(edited.phones[0].value);
  });

  it('uses vCard 3.0 URL and IMPP URI defaults in projection, overlay, and hashing', () => {
    const upper = parseVCardDocument(vcard([
      'item1.URL:https://example.test/\\N',
      'item2.IMPP:xmpp:user\\N@example.test',
    ]));
    const lower = parseVCardDocument(vcard([
      'item1.URL:https://example.test/\\n',
      'item2.IMPP:xmpp:user\\n@example.test',
    ]));
    const contact = contactFromVCardDocument(upper);
    const edited = structuredClone(contact);
    edited.additionalFields[0].value = 'https://example.test/\\N/next';
    edited.additionalFields[1].value.handle = 'user\\Nnext@example.test';

    const serialized = serializeVCardDocument(overlayContactOnVCard(upper, edited));
    const reparsed = contactFromVCardDocument(parseVCardDocument(serialized));

    expect(contact.additionalFields.map(field => field.value)).toEqual([
      'https://example.test/\\N',
      { protocol: 'xmpp', handle: 'user\\N@example.test' },
    ]);
    expect(semanticVCardHash(upper)).not.toBe(semanticVCardHash(lower));
    expect(serialized).toContain('URL:https://example.test/\\N/next\r\n');
    expect(serialized).toContain('IMPP:xmpp:user\\Nnext@example.test\r\n');
    expect(localContactHash(reparsed)).toBe(localContactHash(edited));
  });

  it('lets explicit URI override TEXT defaults and normalizes newlines only for TEXT', () => {
    const uriUpper = parseVCardDocument(vcard(['TEL;VALUE=uri:tel:123\\N4']));
    const uriLower = parseVCardDocument(vcard(['TEL;VALUE=uri:tel:123\\n4']));
    const textUpper = parseVCardDocument(vcard(['TEL;VALUE=text:line\\Nbreak'], '4.0'));
    const textLower = parseVCardDocument(vcard(['TEL;VALUE=text:line\\nbreak'], '4.0'));

    expect(contactFromVCardDocument(uriUpper).phones[0].value).toBe('tel:123\\N4');
    expect(contactFromVCardDocument(textUpper).phones[0].value).toBe('line\nbreak');
    expect(semanticVCardHash(uriUpper)).not.toBe(semanticVCardHash(uriLower));
    expect(semanticVCardHash(textUpper)).toBe(semanticVCardHash(textLower));
  });

  it('counts accepted blank logical lines at the 1 MiB boundary', () => {
    const withBlankLine = size => asciiVCardOfSize(size - 2)
      .replace('END:VCARD\r\n', '\r\nEND:VCARD\r\n');
    const atLimit = withBlankLine(MAX_VCARD_BYTES);
    const overLimit = withBlankLine(MAX_VCARD_BYTES + 1);

    expect(Buffer.byteLength(atLimit)).toBe(MAX_VCARD_BYTES);
    expect(parseVCardDocument(atLimit).properties).toHaveLength(16);
    expect(() => parseVCardDocument(overLimit)).toThrow(/1 MiB/);
  });

  it('serializes and reparses an accepted exact-budget document', () => {
    const document = parseVCardDocument(asciiVCardOfSize(MAX_VCARD_BYTES));
    const serialized = serializeVCardDocument(document);

    expect(parseVCardDocument(serialized)).toEqual(document);
  });

  it('stops serialization before accessing properties after the document budget fails', () => {
    const later = {
      group: null,
      name: 'X-LATER',
      get params() {
        throw new Error('later params accessed');
      },
      rawValue: 'never',
    };

    expect(() => serializeVCardDocument({
      version: '4.0',
      properties: [{
        group: null,
        name: 'PHOTO',
        params: [{ name: 'VALUE', values: ['URI'] }],
        rawValue: 'https://example.test/' + 'a'.repeat(MAX_VCARD_BYTES),
      }, later],
    })).toThrow('vCard exceeds the 1 MiB limit');
  });

  it('rejects ambiguous same-group Additional reordering before mutation', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://one.example.test',
      'item1.URL:https://two.example.test',
      'item1.X-ABLabel:Shared',
    ]));
    const contact = contactFromVCardDocument(document);
    contact.additionalFields.reverse();

    expect(() => overlayContactOnVCard(document, contact))
      .toThrow('MailFlow Additional fields cannot reorder ambiguous retained properties');
    expect(document.properties.map(property => property.rawValue)).toEqual([
      'https://one.example.test',
      'https://two.example.test',
      'Shared',
    ]);
  });

  it('treats retained whitespace-only group labels as absent without rewriting them', () => {
    const document = parseVCardDocument(vcard([
      'item1.URL:https://example.test',
      'item1.X-ABLabel:   ',
    ]));
    const contact = contactFromVCardDocument(document);
    const originalBytes = serializeVCardDocument(document);

    expect(contact.additionalFields[0].label).toBe('URL');
    expect(localContactHash(contact)).toMatch(/^[a-f0-9]{64}$/);
    expect(overlayContactOnVCard(document, contact)).toEqual(document);
    expect(serializeVCardDocument(overlayContactOnVCard(document, contact))).toBe(originalBytes);

    // Setting a whitespace-only label is treated as clearing it: the retained blank
    // X-ABLABEL is dropped rather than rewritten to an empty value.
    contact.additionalFields[0].label = '   ';
    const overlaid = overlayContactOnVCard(document, contact);
    expect(overlaid.properties.some(property => property.name === 'X-ABLABEL')).toBe(false);
    expect(contactFromVCardDocument(
      parseVCardDocument(serializeVCardDocument(overlaid)),
    ).additionalFields).toEqual([
      expect.objectContaining({ kind: 'url', label: 'URL', value: 'https://example.test' }),
    ]);
  });

  it('normalizes TEXT newline escapes without collapsing URI escapes', () => {
    const upperUri = parseVCardDocument(vcard(['URL:https://example.test/\\N'], '4.0'));
    const lowerUri = parseVCardDocument(vcard(['URL:https://example.test/\\n'], '4.0'));
    const upperText = parseVCardDocument(vcard(['NOTE:line\\Nbreak'], '4.0'));
    const lowerText = parseVCardDocument(vcard(['NOTE:line\\nbreak'], '4.0'));

    expect(semanticVCardHash(upperUri)).not.toBe(semanticVCardHash(lowerUri));
    expect(semanticVCardHash(upperText)).toBe(semanticVCardHash(lowerText));
  });

  it('canonicalizes supported legacy PHOTO carrier aliases by MIME and decoded bytes', () => {
    const jpeg = value => parseVCardDocument(vcard([value]));
    const canonical = jpeg('PHOTO;ENCODING=b;TYPE=JPEG:AQI=');
    const aliases = jpeg('PHOTO;ENCODING=base64;TYPE=JPG:AQI');
    const differentMime = jpeg('PHOTO;ENCODING=b;TYPE=PNG:AQI=');
    const differentBytes = jpeg('PHOTO;ENCODING=b;TYPE=JPEG:AQM=');

    expect(semanticVCardHash(aliases)).toBe(semanticVCardHash(canonical));
    expect(semanticVCardHash(differentMime)).not.toBe(semanticVCardHash(canonical));
    expect(semanticVCardHash(differentBytes)).not.toBe(semanticVCardHash(canonical));
  });

  it('elides explicit URI defaults from semantic hashes', () => {
    const implicit = parseVCardDocument(vcard(['TEL:tel:+15551234567'], '4.0'));
    const explicit = parseVCardDocument(vcard([
      'TEL;VALUE=uri:tel:+15551234567',
    ], '4.0'));

    expect(semanticVCardHash(explicit)).toBe(semanticVCardHash(implicit));
  });

  it('preserves semantic vCard 4 PHOTO TYPE changes in hashes', () => {
    const home = parseVCardDocument(vcard([
      'PHOTO;TYPE=HOME:data:image/png;base64,AQID',
    ], '4.0'));
    const work = parseVCardDocument(vcard([
      'PHOTO;TYPE=WORK:data:image/png;base64,AQID',
    ], '4.0'));

    expect(semanticVCardHash(work)).not.toBe(semanticVCardHash(home));
  });

  it('canonicalizes valid raw JPEG base64 in local hashes and rejects invalid data', () => {
    const raw = { photoData: 'AQID' };
    const dataUri = { photoData: 'data:image/jpeg;base64,AQID' };
    const document = parseVCardDocument(vcard([]));
    const overlaid = overlayContactOnVCard(document, raw);
    const projected = contactFromVCardDocument(
      parseVCardDocument(serializeVCardDocument(overlaid)),
    );

    expect(localContactHash(raw)).toBe(localContactHash(dataUri));
    expect(localContactHash(projected)).toBe(localContactHash(raw));
    expect(() => localContactHash({ photoData: 'not-valid-***' }))
      .toThrow(/invalid base64/);
  });

  it('normalizes IMPP protocol casing in local hashes and serialized Additional values', () => {
    const document = parseVCardDocument(vcard([
      'item1.IMPP:xmpp:CaseSensitiveHandle',
      'item1.X-ABLabel:Chat',
    ]));
    const lower = contactFromVCardDocument(document);
    const upper = structuredClone(lower);
    upper.additionalFields[0].value.protocol = 'XMPP';
    const serialized = serializeVCardDocument(overlayContactOnVCard(document, upper));
    const projected = contactFromVCardDocument(parseVCardDocument(serialized));

    expect(localContactHash(upper)).toBe(localContactHash(lower));
    expect(serialized).toContain('IMPP:xmpp:CaseSensitiveHandle\r\n');
    expect(localContactHash(projected)).toBe(localContactHash(lower));
  });

  it('set-normalizes duplicate TYPE members in semantic hashes', () => {
    const single = parseVCardDocument(vcard(['EMAIL;TYPE=WORK:a@example.test']));
    const repeated = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK;TYPE=WORK:a@example.test',
    ]));
    const listed = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK,WORK:a@example.test',
    ]));
    const different = parseVCardDocument(vcard([
      'EMAIL;TYPE=WORK,HOME:a@example.test',
    ]));

    expect(semanticVCardHash(repeated)).toBe(semanticVCardHash(single));
    expect(semanticVCardHash(listed)).toBe(semanticVCardHash(single));
    expect(semanticVCardHash(different)).not.toBe(semanticVCardHash(single));
  });
});

describe('presented ETag tracks the served representation', () => {
  it('advances the served ETag when a modeled column changes under the same retained document', () => {
    const mapping_vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Old Name\r\nCATEGORIES:VIP\r\nEND:VCARD\r\n';
    const base = {
      uid: 'local-uid', display_name: 'Ada Lovelace', first_name: null, last_name: null,
      emails: [], phones: [], organization: null, notes: null, photo_data: null,
      additional_fields: [], vcard: '', mapping_vcard,
    };
    const renamed = { ...base, display_name: 'Grace Hopper' };
    expect(presentedEtag(renamed)).not.toBe(presentedEtag(base));
  });
});

describe('push-destined snapshot never emits a local UID on overlay failure', () => {
  // A contact whose Additional-field IDs are duplicated makes overlayContactOnVCard throw.
  const malformedContact = () => ({
    uid: 'local-uid', display_name: 'Dup', first_name: null, last_name: null,
    emails: [], phones: [], organization: null, notes: null, photo_data: null,
    additional_fields: [
      { id: 'dup', kind: 'url', label: '', value: 'https://a.test/' },
      { id: 'dup', kind: 'url', label: '', value: 'https://b.test/' },
    ],
    vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:local-uid\r\nFN:Dup\r\nEND:VCARD\r\n',
    mapping_vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:Dup\r\nEND:VCARD\r\n',
  });

  it('re-keys the fallback to the retained remote UID when preserveDocumentUid is set', () => {
    const result = presentedVCard(malformedContact(), { preserveDocumentUid: true });
    expect(result).toContain('UID:remote-uid');
    expect(result).not.toContain('UID:local-uid');
  });

  it('serve-only overlay failure still falls back to the stored local-UID vCard', () => {
    expect(presentedVCard(malformedContact(), { preserveDocumentUid: false }))
      .toContain('UID:local-uid');
  });

  it('pushSafeSnapshot re-keys a parseable stored vCard to the retained UID', () => {
    const retained = parseVCardDocument('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:remote-uid\r\nFN:X\r\nEND:VCARD\r\n');
    const stored = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:local-uid\r\nFN:X\r\nEND:VCARD\r\n';
    const out = pushSafeSnapshot(stored, retained, new Error('overlay failed'));
    expect(out).toContain('UID:remote-uid');
    expect(out).not.toContain('UID:local-uid');
  });

  it('pushSafeSnapshot fails closed (rethrows) when there is no retained UID to re-key to', () => {
    const cause = new Error('overlay failed');
    expect(() => pushSafeSnapshot('BEGIN:VCARD\r\nUID:local-uid\r\nEND:VCARD\r\n', { properties: [] }, cause))
      .toThrow(cause);
  });
});
