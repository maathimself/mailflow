import { describe, it, expect } from 'vitest';
import {
  parseHeadersInput,
  headersToRawString,
  buildHeadersFromMessage,
  enrichParsedMetadata,
  parseMailboxList,
  parseDeliveryAddresses,
  snippetFromBody,
  parseMessage,
  decodeMimeWords,
  parseRawHeaders,
} from './messageParser.js';

describe('snippetFromBody', () => {
  it('drops "label ( URL )" link targets left by HTML-to-text converters', () => {
    const text = 'Read the interview ( https://f90a918a.click.convertkit-mail2.com/8xu32z2gd3bkh2mv36c9/e0hph7hk8p07n2f3/aHR0cHM6 ) A new issue just went out ( https://f90a918a.click.convertkit-mail2.com/unsubscribe )';
    expect(snippetFromBody(text)).toBe('Read the interview A new issue just went out');
  });

  it('routes an HTML document shipped as text/plain through the HTML stripper', () => {
    const text = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8" /></head><body><p>Your package was delivered today.</p></body></html>';
    expect(snippetFromBody(text)).toBe('Your package was delivered today.');
  });

  it('sweeps up leftover empty parens from partially converted bodies', () => {
    expect(snippetFromBody('() Relink to We stopped importing transactions from your bank.'))
      .toBe('Relink to We stopped importing transactions from your bank.');
  });

  it('keeps Markdown link labels and drops their URLs', () => {
    expect(snippetFromBody('[Confirm your email](https://example.com/confirm?t=abc) to finish signing up'))
      .toBe('Confirm your email to finish signing up');
  });

  it('drops bare, angle-wrapped, and mailto URLs', () => {
    expect(snippetFromBody('View invoice <https://pay.example.com/inv/42> or write to mailto:billing@example.com'))
      .toBe('View invoice or write to');
  });

  it('drops protocol-less www hosts', () => {
    expect(snippetFromBody('Shop the sale at www.example.com/sale today only'))
      .toBe('Shop the sale at today only');
  });

  it('collapses standalone emphasis runs but keeps inline emphasis', () => {
    expect(snippetFromBody('** Big Sale ** starts _now_')).toBe('Big Sale starts _now_');
  });

  it('does not strip parenthesized prose, times, or bare domains', () => {
    const text = 'Standup moved to (1:00 PM) tomorrow (room B), details at example.com';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('does not misroute prose that mentions an HTML tag', () => {
    const text = 'Use the <b> tag for bold; multiply with 2 * 3 and keep snake_case names';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('still decodes entities and strips invisible preheader chars', () => {
    expect(snippetFromBody('Sale ends soon&hellip;\u200B\u200C see inside'))
      .toBe('Sale ends soon… see inside');
  });

  it('still falls back to the html argument when text is empty', () => {
    expect(snippetFromBody('', '<p>Hello &amp; welcome</p>')).toBe('Hello & welcome');
  });

  it('caps snippets at 200 characters', () => {
    expect(snippetFromBody('x'.repeat(500))).toHaveLength(200);
  });
});

describe('parseMessage', () => {
  it('cleans link URLs out of sync-time snippets from text/plain parts', async () => {
    const parsed = await parseMessage({
      uid: 1,
      envelope: { subject: 'Weekly digest', from: [{ name: 'News', address: 'news@example.com' }] },
      flags: new Set(),
      bodyStructure: { type: 'text/plain', part: '1', encoding: '7bit', parameters: { charset: 'utf-8' } },
      bodyParts: new Map([['1', Buffer.from('Read more ( https://click.example.com/track/abc123 )')]]),
    });
    expect(parsed.snippet).toBe('Read more');
  });
});

describe('parseHeadersInput', () => {
  it('parses Buffer headers', () => {
    const buf = Buffer.from('Subject: TEST\r\nFrom: a@b.com\r\n');
    expect(parseHeadersInput(buf)).toEqual({
      subject: 'TEST',
      from: 'a@b.com',
    });
  });

  it('parses plain objects', () => {
    expect(parseHeadersInput({ Subject: 'Hello', From: 'x@y.com' })).toEqual({
      subject: 'Hello',
      from: 'x@y.com',
    });
  });
});

describe('headersToRawString', () => {
  it('serializes parsed headers back to text', () => {
    const raw = headersToRawString(Buffer.from('Subject: TEST\r\nTo: a@b.com\r\n'));
    expect(raw).toContain('Subject: TEST');
    expect(raw).toContain('To: a@b.com');
  });
});

describe('enrichParsedMetadata', () => {
  it('fills from account identity for Sent folder when envelope from is empty', () => {
    const parsed = {
      fromEmail: '',
      fromName: '',
      subject: '(no subject)',
      to: [],
      cc: [],
      parsedHeaders: { subject: 'TEST', to: 'bob@example.com' },
    };
    enrichParsedMetadata(parsed, {
      accountEmail: 'alice@example.com',
      accountName: 'Alice',
      senderName: 'Alice S',
      folderPath: 'INBOX.Sent',
      sentFolderPath: 'INBOX.Sent',
    });
    expect(parsed.fromEmail).toBe('alice@example.com');
    expect(parsed.fromName).toBe('Alice S');
    expect(parsed.subject).toBe('TEST');
    expect(parsed.to).toEqual([{ name: '', email: 'bob@example.com' }]);
  });
});

describe('parseMailboxList', () => {
  it('parses named and bare addresses', () => {
    expect(parseMailboxList('"Bob" <bob@example.com>, cc@example.com')).toEqual([
      { name: 'Bob', email: 'bob@example.com' },
      { name: '', email: 'cc@example.com' },
    ]);
  });
});

describe('parseDeliveryAddresses', () => {
  it('parses a single Delivered-To header', () => {
    expect(parseDeliveryAddresses({ 'delivered-to': 'alice+work@example.com' }))
      .toEqual(['alice+work@example.com']);
  });

  it('parses multiple values folded onto separate lines', () => {
    expect(parseDeliveryAddresses({ 'delivered-to': 'a@example.com\nb@example.com' }))
      .toEqual(['a@example.com', 'b@example.com']);
  });

  it('parses X-Original-To', () => {
    expect(parseDeliveryAddresses({ 'x-original-to': 'catchall@example.com' }))
      .toEqual(['catchall@example.com']);
  });

  it('dedupes the same address across headers, case-insensitively', () => {
    expect(parseDeliveryAddresses({
      'delivered-to': 'Alice@Example.com',
      'x-original-to': 'alice@example.com',
    })).toEqual(['alice@example.com']);
  });

  it('extracts the email from angle-bracket forms', () => {
    expect(parseDeliveryAddresses({ 'delivered-to': 'Alice Smith <alice@example.com>' }))
      .toEqual(['alice@example.com']);
  });

  it('returns [] when no delivery headers are present', () => {
    expect(parseDeliveryAddresses({})).toEqual([]);
    expect(parseDeliveryAddresses(undefined)).toEqual([]);
  });

  it('ignores junk lines that do not parse as an address', () => {
    expect(parseDeliveryAddresses({ 'delivered-to': 'not-an-email\nbob@example.com' }))
      .toEqual(['bob@example.com']);
  });

  it('caps the number of captured addresses', () => {
    const flood = Array.from({ length: 80 }, (_, i) => `user${i}@example.com`).join(', ');
    expect(parseDeliveryAddresses({ 'delivered-to': flood })).toHaveLength(50);
  });

  // #475: alias-forwarding services record the receiving alias in their own header.
  it('adds the receiving alias of a genuine 33Mail wrapper', () => {
    expect(parseDeliveryAddresses({
      from: `"Stripe 'billing@stripe.example' via 33Mail" <sender@mailer1.33mail.com>`,
      'delivered-to': 'me@gmail.example',
      'x-33mail-original-to': 'Shop@MyName.33mail.com',
    })).toEqual(['me@gmail.example', 'shop@myname.33mail.com']);
  });

  it('takes the alias header on a wrapper even without the display-name pattern', () => {
    expect(parseDeliveryAddresses({
      from: 'sender@mailer1.33mail.com',
      'x-33mail-original-to': 'shop@myname.33mail.com',
    })).toEqual(['shop@myname.33mail.com']);
  });

  it('ignores a forged alias header when From is not the forwarder', () => {
    expect(parseDeliveryAddresses({
      from: 'attacker@evil.example',
      'delivered-to': 'me@gmail.example',
      'x-33mail-original-to': 'shop@myname.33mail.com',
    })).toEqual(['me@gmail.example']);
  });
});

describe('buildHeadersFromMessage', () => {
  it('builds headers from stored message fields', () => {
    const raw = buildHeadersFromMessage({
      from_name: 'Alice',
      from_email: 'alice@example.com',
      to_addresses: JSON.stringify([{ name: 'Bob', email: 'bob@example.com' }]),
      subject: 'TEST',
      message_id: '<abc@mail>',
      date: '2026-07-11T12:00:00Z',
    });
    expect(raw).toContain('From: "Alice" <alice@example.com>');
    expect(raw).toContain('To: "Bob" <bob@example.com>');
    expect(raw).toContain('Subject: TEST');
    expect(raw).toContain('Message-ID: <abc@mail>');
  });
});

describe('decodeMimeWords charsets (#454)', () => {
  it('honors the charset an encoded-word declares instead of assuming UTF-8', () => {
    // The exact shape reported in #454: a Finnish subject in ISO-8859-1 came back as
    // replacement characters because every encoded-word was decoded as UTF-8.
    expect(decodeMimeWords('=?iso-8859-1?Q?Hyv=E4=E4_p=E4iv=E4=E4?=')).toBe('Hyvää päivää');
    expect(decodeMimeWords('=?windows-1252?Q?Caf=E9?=')).toBe('Café');
    expect(decodeMimeWords('=?ISO-8859-1?B?SHl24Q==?=')).toBe('Hyvá');
  });

  it('distinguishes charsets that differ on the same byte', () => {
    // 0xA4 is the currency sign in ISO-8859-1 and the euro sign in ISO-8859-15. Getting
    // both right is what proves the label is read rather than latin1 being hardcoded.
    expect(decodeMimeWords('=?iso-8859-15?Q?100_=A4?=')).toBe('100 €');
    expect(decodeMimeWords('=?iso-8859-1?Q?100_=A4?=')).toBe('100 ¤');
  });

  it('still decodes UTF-8 and leaves unencoded text alone', () => {
    expect(decodeMimeWords('=?UTF-8?Q?Hyv=C3=A4=C3=A4?=')).toBe('Hyvää');
    expect(decodeMimeWords('=?utf-8?B?SHl2w6TDpA==?=')).toBe('Hyvää');
    expect(decodeMimeWords('Plain ASCII subject')).toBe('Plain ASCII subject');
  });

  it('strips an RFC 2231 language tag from the charset', () => {
    expect(decodeMimeWords('=?iso-8859-1*fi?Q?Hyv=E4?=')).toBe('Hyvä');
  });

  it('falls back to readable text for an unknown charset label', () => {
    // "unknown-8bit" and friends are not TextDecoder labels. Single-byte Western text is
    // the common case, so these should degrade to readable rather than to U+FFFD.
    expect(decodeMimeWords('=?unknown-8bit?Q?Caf=E9?=')).toBe('Café');
    // A bogus label carrying genuine UTF-8 bytes still decodes as UTF-8.
    expect(decodeMimeWords('=?x-nonsense?Q?Hyv=C3=A4?=')).toBe('Hyvä');
  });

  it('joins adjacent encoded-words that use a non-UTF-8 charset', () => {
    expect(decodeMimeWords('=?iso-8859-1?Q?Hyv=E4=E4?= =?iso-8859-1?Q?_p=E4iv=E4=E4?='))
      .toBe('Hyvää päivää');
  });
});

describe('raw 8-bit header bytes (#454)', () => {
  const latin1Header = Buffer.concat([
    Buffer.from('From: test@example.com\r\nSubject: Hyv', 'ascii'),
    Buffer.from([0xE4, 0xE4]),
    Buffer.from(' p', 'ascii'),
    Buffer.from([0xE4]),
    Buffer.from('iv', 'ascii'),
    Buffer.from([0xE4, 0xE4]),
    Buffer.from('\r\n', 'ascii'),
  ]);

  it('recovers raw 8-bit bytes that carry no encoded-word at all', () => {
    // Non-conformant but common. Decoding the block as UTF-8 destroyed these bytes before
    // any encoded-word decoding could run, giving the same symptom by a different route.
    expect(parseRawHeaders(latin1Header).subject).toBe('Hyvää päivää');
  });

  it('keeps valid UTF-8 header bytes as UTF-8', () => {
    const utf8Header = Buffer.from('Subject: Hyvää päivää\r\n', 'utf8');
    expect(parseRawHeaders(utf8Header).subject).toBe('Hyvää päivää');
  });

  it('applies the same recovery to the raw header string', () => {
    expect(headersToRawString(latin1Header)).toContain('Hyvää päivää');
  });

  it('scopes the fallback per line so one bad header cannot spoil the rest', () => {
    // A block holding a genuinely UTF-8 subject next to one latin1 display name. Choosing
    // the encoding for the whole block at once turned that subject into mojibake
    // ("SÃ¤hkÃ¶posti"), which is worse than the single replacement character it replaced.
    const mixed = Buffer.concat([
      Buffer.from('Subject: Sähköposti toimii\r\n', 'utf8'),
      Buffer.from('From: "J', 'ascii'),
      Buffer.from([0xF6]),
      Buffer.from('rgen" <j@example.com>\r\n', 'ascii'),
    ]);
    const parsed = parseRawHeaders(mixed);
    expect(parsed.subject).toBe('Sähköposti toimii');
    expect(parsed.from).toBe('"Jörgen" <j@example.com>');
  });
});
