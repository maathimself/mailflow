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
