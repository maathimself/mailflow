import { describe, expect, it } from 'vitest';
import {
  WRITE_ERROR_CODES,
  buildWriteReceipt,
  writeError,
} from './writeResult.js';

describe('buildWriteReceipt', () => {
  it('matches the documented immediate-send receipt exactly', () => {
    expect(buildWriteReceipt({
      from: { name: 'A', email: 'a@b.com' },
      to: [{ name: '', email: 'x@y.com' }],
      cc: [],
      bcc: [],
      subject: 'Quarterly report',
      attachments: [{ filename: 'q.pdf', size: 8123 }],
      messageId: '<a@b>',
      sentCopySaved: true,
      folder: 'Sent',
    }, {
      sent: true,
    })).toEqual({
      sent: true,
      message_id: '<a@b>',
      from: { name: 'A', email: 'a@b.com' },
      to: [{ name: '', email: 'x@y.com' }],
      cc: [],
      bcc: [],
      subject: 'Quarterly report',
      attachments: [{ filename: 'q.pdf', size: 8123 }],
      sent_copy_saved: true,
      folder: 'Sent',
    });
  });

  it('matches the documented queued-send receipt exactly', () => {
    expect(buildWriteReceipt({
      subject: 'Quarterly report',
    }, {
      queued: true,
      outboxId: 'outbox-1',
      sendAt: '2026-07-28T10:00:30.000Z',
      undoSeconds: 30,
      note: 'Cancel with unsend_email before send_at.',
    })).toEqual({
      queued: true,
      outbox_id: 'outbox-1',
      send_at: '2026-07-28T10:00:30Z',
      undo_seconds: 30,
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Quarterly report',
      attachments: [],
      note: 'Cancel with unsend_email before send_at.',
    });
  });

  it('re-keys result-specific service fields and preserves attachment source metadata', () => {
    expect(buildWriteReceipt({
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Re: Subject',
      attachments: [{ filename: 'deck.pdf', size: 2144000, source: 'forwarded' }],
      messageId: '<reply@example.com>',
      sentCopySaved: true,
      inReplyTo: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
    }, {
      sent: true,
      recipientsComputed: {
        reply_target: 'sender@example.com',
        excluded_self: ['me@example.com'],
      },
    })).toEqual({
      sent: true,
      message_id: '<reply@example.com>',
      in_reply_to: '<original@example.com>',
      references: '<root@example.com> <original@example.com>',
      recipients_computed: {
        reply_target: 'sender@example.com',
        excluded_self: ['me@example.com'],
      },
      from: {},
      to: [],
      cc: [],
      bcc: [],
      subject: 'Re: Subject',
      attachments: [{ filename: 'deck.pdf', size: 2144000, source: 'forwarded' }],
      sent_copy_saved: true,
    });
  });
});

describe('writeError', () => {
  it.each(WRITE_ERROR_CODES)('%s is emitted as a stable isError prefix', (code) => {
    const result = writeError(code, 'detail');
    expect(result).toEqual({
      content: [{ type: 'text', text: `${code}: detail` }],
      isError: true,
    });
  });
});
