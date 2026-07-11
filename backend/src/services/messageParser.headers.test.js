import { describe, it, expect } from 'vitest';
import {
  parseHeadersInput,
  headersToRawString,
  buildHeadersFromMessage,
  enrichParsedMetadata,
  parseMailboxList,
} from './messageParser.js';

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
