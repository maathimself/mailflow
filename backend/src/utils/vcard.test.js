import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateVCard, parseVCard } from './vcard.js';
import { contactFromVCardDocument, parseVCardDocument } from './vcardProperties.js';

const contact = (photoData) => ({
  uid: 'photo-test',
  displayName: 'Photo Test',
  emails: [{ value: 'photo@example.test', type: 'other' }],
  phones: [],
  photoData,
});

describe('vCard photo serialization', () => {
  it.each([
    ['image/jpeg', 'JPEG'],
    ['image/png', 'PNG'],
    ['image/gif', 'GIF'],
    ['image/webp', 'WEBP'],
  ])('round-trips folded %s data URIs', (mime, type) => {
    const payload = 'A'.repeat(180);
    const photoData = `data:${mime};base64,${payload}`;
    const vcard = generateVCard(contact(photoData));

    expect(vcard).toContain(`PHOTO;ENCODING=b;TYPE=${type}:`);
    expect(vcard).toMatch(/PHOTO;ENCODING=b;TYPE=.*\r\n /);
    expect(parseVCard(vcard).photoData).toBe(photoData);
  });

  it('makes photo-only changes byte-visible and keeps external URLs out', () => {
    const first = generateVCard(contact('data:image/png;base64,AAA'));
    const second = generateVCard(contact('data:image/png;base64,BBA'));
    const external = generateVCard(contact('https://images.example.test/photo.png'));
    const etag = value => createHash('md5').update(value).digest('hex');

    expect(first).not.toBe(second);
    expect(etag(first)).not.toBe(etag(second));
    expect(generateVCard(contact('data:image/png;base64,AAA'))).toBe(first);
    expect(external).not.toMatch(/^PHOTO/m);
    expect(parseVCard(external).photoData).toBeNull();
  });
});

describe('vCard type parsing', () => {
  it('strips double quotes from generated email types', () => {
    expect(generateVCard({
      uid: 'quoted-email-type',
      displayName: 'Quoted Email Type',
      emails: [{ value: 'quoted@example.test', type: 'wo"rk' }],
      phones: [],
    })).toContain('EMAIL;TYPE=WORK:quoted@example.test\r\n');
  });

  it('maps compound TYPE parameters to MailFlow contact labels', () => {
    const parsed = parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:types\r\nFN:Type Test\r\nEMAIL;TYPE=INTERNET,WORK:work@example.test\r\nEMAIL;TYPE="HOME,INTERNET":home@example.test\r\nTEL;TYPE=CELL,VOICE,PREF:+15550000001\r\nTEL;TYPE=WORK,VOICE:+15550000002\r\nTEL;TYPE=VOICE,PREF:+15550000003\r\nEND:VCARD\r\n`);

    expect(parsed.emails.map(({ type }) => type)).toEqual(['work', 'home']);
    expect(parsed.phones.map(({ type }) => type)).toEqual(['mobile', 'work', 'other']);
  });

  it('keeps accepting single-quoted compound TYPE values', () => {
    const parsed = parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:quoted\r\nFN:Quoted\r\nEMAIL;TYPE='HOME,INTERNET':home@example.test\r\nEND:VCARD\r\n`);

    expect(parsed.emails[0].type).toBe('home');
  });

  it.each(['3.0', '4.0'])('keeps first-email fallback for unmarked vCard %s emails', version => {
    const parsed = parseVCard([
      'BEGIN:VCARD',
      `VERSION:${version}`,
      'EMAIL:first@example.test',
      'EMAIL:second@example.test',
      'END:VCARD',
      '',
    ].join('\r\n'));

    expect(parsed.emails.map(email => email.primary)).toEqual([true, false]);
  });
});

describe('vCard compatibility facade', () => {
  it.each([
    'status:open',
    'sip:alice@example.test',
    'webcal:event-id',
  ])('matches strict parsing for colon-bearing NOTE value %s', value => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `NOTE;X-P=trailing\\:${value}`,
      'END:VCARD',
      '',
    ].join('\r\n');
    const strict = contactFromVCardDocument(parseVCardDocument(raw));
    const compatible = parseVCard(raw);

    expect(strict.notes).toBe(value);
    expect(compatible.notes).toBe(value);
  });

  it('keeps defaulting versionless legacy consumer cards to vCard 3.0', () => {
    expect(parseVCard([
      'BEGIN:VCARD',
      'UID:legacy-versionless',
      'FN:Legacy Versionless',
      'END:VCARD',
      '',
    ].join('\r\n'))).toMatchObject({
      uid: 'legacy-versionless',
      displayName: 'Legacy Versionless',
    });
  });

  it('preserves malformed version error surfaces while defaulting legacy cards', () => {
    expect(() => parseVCard('BEGIN:VCARD\r\nVERSION\r\nEND:VCARD\r\n'))
      .toThrow('vCard contains an invalid content line');
    expect(() => parseVCard('BEGIN:VCARD\r\n'))
      .toThrow('vCard must end with END:VCARD');
  });

  it.each([
    ['empty', {}, []],
    ['phone-only', {
      phones: [{ value: '+15551234567', type: 'mobile' }],
    }, ['TEL;TYPE=MOBILE:+15551234567']],
  ])('keeps legacy UID and mandatory FN placeholders for %s contacts', (
    _case,
    contact,
    extraLines,
  ) => {
    expect(generateVCard(contact)).toBe([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:',
      'FN:',
      ...extraLines,
      'END:VCARD',
      '',
    ].join('\r\n'));
  });

  it('keeps deterministic vCard 3.0 bytes for existing contact consumers', () => {
    const vcard = generateVCard({
      uid: 'deterministic',
      displayName: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
      emails: [{ value: 'jane@example.test', type: 'work', primary: true }],
      phones: [{ value: '+15551234567', type: 'mobile' }],
      organization: 'Example Corp',
      notes: 'Line one\nLine two',
    });

    expect(vcard).toBe([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:deterministic',
      'FN:Jane Doe',
      'N:Doe;Jane;;;',
      'EMAIL;TYPE=WORK:jane@example.test',
      'TEL;TYPE=MOBILE:+15551234567',
      'ORG:Example Corp',
      'NOTE:Line one\\nLine two',
      'END:VCARD',
      '',
    ].join('\r\n'));
    expect(generateVCard(parseVCard(vcard))).toBe(vcard);
  });

  it('keeps deriving FN only for newly generated compatibility cards', () => {
    const generated = generateVCard({
      firstName: 'Jane',
      lastName: 'Doe',
      emails: [],
      phones: [],
    });
    const generatedFromBlank = generateVCard({
      displayName: '',
      firstName: 'Jane',
      lastName: 'Doe',
      emails: [],
      phones: [],
    });

    expect(generated).toContain('FN:Jane Doe\r\n');
    expect(generatedFromBlank).toContain('FN:Jane Doe\r\n');
  });

  it('keeps the last PHOTO value, including a trailing URL clear', () => {
    const withTwoEmbedded = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
      'PHOTO;ENCODING=b;TYPE=PNG:BAUG',
      'END:VCARD',
      '',
    ].join('\r\n');
    const withTrailingUrl = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PHOTO;ENCODING=b;TYPE=PNG:AQID',
      'PHOTO;VALUE=URI:https://images.example.test/photo.png',
      'END:VCARD',
      '',
    ].join('\r\n');

    expect(parseVCard(withTwoEmbedded).photoData).toBe('data:image/png;base64,BAUG');
    expect(parseVCard(withTrailingUrl).photoData).toBeNull();
  });

  it('projects supported Additional fields without exposing raw syntax', () => {
    const parsed = parseVCard([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:additional',
      'FN:Additional',
      'item1.URL:https://example.test',
      'item1.X-ABLabel:Portfolio',
      'END:VCARD',
      '',
    ].join('\r\n'));

    expect(parsed.additionalFields).toEqual([
      expect.objectContaining({
        kind: 'url',
        label: 'Portfolio',
        value: 'https://example.test',
      }),
    ]);
  });

  it('rejects unsupported non-base64 data URI photos', () => {
    expect(() => generateVCard({
      uid: 'data-uri',
      displayName: 'Data URI',
      emails: [],
      phones: [],
      photoData: 'data:image/svg+xml,<svg></svg>',
    })).toThrow(/unsupported PHOTO MIME type/);
  });
});
