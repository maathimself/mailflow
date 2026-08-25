import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { renderPreparedSmtp } from './preparedSmtp.js';

function headersFrom(message) {
  const headerBlock = Buffer.from(message).toString('utf8').split(/\r?\n\r?\n/, 1)[0];
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

describe('prepared SMTP rendering', () => {
  it('keeps Bcc only in the envelope and a distinct requested Sent copy', async () => {
    const envelope = {
      from: 'sender@example.com',
      to: ['visible@example.com', 'copy@example.com', 'hidden@example.com'],
    };
    const rendered = await renderPreparedSmtp({
      from: 'Sender <sender@example.com>',
      to: 'Visible <visible@example.com>',
      cc: 'Copy <copy@example.com>',
      bcc: 'A Very Long Hidden Recipient Name That Forces Header Folding <hidden@example.com>',
      headers: [{ key: 'bCc', value: 'custom-hidden@example.com' }],
      subject: 'Disclosure boundary',
      text: 'body',
      messageId: '<stable@example.com>',
      date: new Date('2026-08-26T10:00:00Z'),
    }, envelope, { includeBccInSentCopy: true });

    const deliveryHeaders = headersFrom(rendered.message);
    expect(deliveryHeaders.get('to')).toContain('visible@example.com');
    expect(deliveryHeaders.get('cc')).toContain('copy@example.com');
    expect(deliveryHeaders.has('bcc')).toBe(false);
    expect(rendered.envelope).toEqual(envelope);

    const sentHeaders = headersFrom(rendered.sentMessage);
    expect(sentHeaders.get('to')).toContain('visible@example.com');
    expect(sentHeaders.get('cc')).toContain('copy@example.com');
    expect(sentHeaders.get('bcc')).toContain('hidden@example.com');
    expect(sentHeaders.get('bcc')).not.toContain('custom-hidden@example.com');

    const expectedDigest = createHash('sha256')
      .update(rendered.message)
      .update('\0')
      .update('{"from":"sender@example.com","to":["visible@example.com","copy@example.com","hidden@example.com"]}')
      .digest('hex');
    expect(rendered.digest).toBe(expectedDigest);
  });
});
