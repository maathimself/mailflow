import { describe, expect, it, vi } from 'vitest';
import { openReplyFromMessage } from '../../../frontend/src/utils/composeFromMessage.js';
import * as replyService from './replyService.js';

const { selfAddressSet } = replyService;

describe('selfAddressSet', () => {
  it('includes the account address plus every alias email and reply-to address', () => {
    expect(selfAddressSet(
      { email_address: 'Me@Example.com' },
      [
        { email: 'Team@Example.com', reply_to: 'Forward@Example.com' },
        { email: 'Other@Example.com', reply_to: null },
      ],
    )).toEqual(new Set([
      'me@example.com',
      'team@example.com',
      'forward@example.com',
      'other@example.com',
    ]));
  });
});

describe('pickReplyTarget', () => {
  it('uses the first reply-to entry when it has an email', () => {
    expect(replyService.pickReplyTarget({
      reply_to: JSON.stringify([
        { name: 'Reply Desk', email: 'reply@example.com' },
        { name: 'Other', email: 'other@example.com' },
      ]),
      from_name: 'Sender',
      from_email: 'sender@example.com',
    })).toEqual({ name: 'Reply Desk', email: 'reply@example.com' });
  });

  it('falls back to the From address when reply-to is empty', () => {
    expect(replyService.pickReplyTarget({
      reply_to: [],
      from_name: 'Sender',
      from_email: 'sender@example.com',
    })).toEqual({ name: 'Sender', email: 'sender@example.com' });
  });
});

describe('computeReplyRecipients', () => {
  const message = {
    reply_to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
    from_name: 'Sender',
    from_email: 'sender@example.com',
    to_addresses: [
      { name: '', email: 'person@example.com' },
      { name: 'Me', email: 'me@example.com' },
      { name: 'Forwarding Self', email: 'forward@example.com' },
    ],
    cc_addresses: [
      { name: 'Person', email: 'PERSON@example.com' },
      { name: 'Reply Desk', email: 'reply@example.com' },
      { name: 'Colleague', email: 'colleague@example.com' },
    ],
  };
  const account = { email_address: 'me@example.com' };
  const aliases = [{ email: 'alias@example.com', reply_to: 'forward@example.com' }];

  it('computes a plain reply with only the reply target in To', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: false,
    })).toEqual({
      to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
      cc: [],
      bcc: [],
    });
  });

  it('computes reply-all without self or target addresses and dedupes preferring names', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: true,
    })).toEqual({
      to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
      cc: [
        { name: 'Person', email: 'PERSON@example.com' },
        { name: 'Colleague', email: 'colleague@example.com' },
      ],
      bcc: [],
    });
  });

  it('moves computed To and Cc recipients into Cc when explicit To replaces them', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: true,
      to: ['Redirect <redirect@example.com>'],
      cc: ['Extra <extra@example.com>'],
    })).toEqual({
      to: [{ name: 'Redirect', email: 'redirect@example.com' }],
      cc: [
        { name: 'Reply Desk', email: 'reply@example.com' },
        { name: 'Person', email: 'PERSON@example.com' },
        { name: 'Colleague', email: 'colleague@example.com' },
        { name: 'Extra', email: 'extra@example.com' },
      ],
      bcc: [],
    });
  });

  it('replaces computed Cc without moving recipients when only explicit Cc is supplied', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: true,
      cc: ['Only <only@example.com>'],
    })).toEqual({
      to: [{ name: 'Reply Desk', email: 'reply@example.com' }],
      cc: [{ name: 'Only', email: 'only@example.com' }],
      bcc: [],
    });
  });

  it('appends additive recipients and applies removal after all recipient computation', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: true,
      toAdd: ['New To <new-to@example.com>'],
      ccAdd: ['New Cc <new-cc@example.com>'],
      bccAdd: ['New Bcc <new-bcc@example.com>'],
      remove: ['reply@example.com', 'NEW-CC@example.com'],
    })).toEqual({
      to: [{ name: 'New To', email: 'new-to@example.com' }],
      cc: [
        { name: 'Person', email: 'PERSON@example.com' },
        { name: 'Colleague', email: 'colleague@example.com' },
      ],
      bcc: [{ name: 'New Bcc', email: 'new-bcc@example.com' }],
    });
  });

  it.each([
    [{ to: ['a@example.com'], toAdd: ['b@example.com'] }, 'to and toAdd'],
    [{ cc: ['a@example.com'], ccAdd: ['b@example.com'] }, 'cc and ccAdd'],
    [{ bcc: ['a@example.com'], bccAdd: ['b@example.com'] }, 'bcc and bccAdd'],
  ])('rejects mutually exclusive override and additive forms', (overrides, fields) => {
    expect(() => replyService.computeReplyRecipients(message, {
      account,
      aliases,
      replyAll: true,
      ...overrides,
    })).toThrowError(expect.objectContaining({
      message: expect.stringContaining(fields),
      status: 400,
      code: 'invalid_arguments',
    }));
  });

  it('drops self addresses in the final pass unless the caller explicitly names them', () => {
    const selfSender = {
      ...message,
      reply_to: [],
      from_name: 'Me',
      from_email: 'me@example.com',
    };

    expect(replyService.computeReplyRecipients(selfSender, {
      account,
      aliases,
      replyAll: false,
    }).to).toEqual([]);
    expect(replyService.computeReplyRecipients(selfSender, {
      account,
      aliases,
      replyAll: false,
      ccAdd: ['Forwarding Self <forward@example.com>'],
    }).cc).toEqual([
      { name: 'Forwarding Self', email: 'forward@example.com' },
    ]);
  });

  it('drops blank recipient entries in the final pass', () => {
    expect(replyService.computeReplyRecipients(message, {
      account,
      aliases,
      toAdd: ['', null],
    }).to).toEqual([
      { name: 'Reply Desk', email: 'reply@example.com' },
    ]);
  });

  it('refuses more than 100 final recipients', () => {
    const recipients = Array.from(
      { length: 100 },
      (_, index) => `person-${index}@example.com`,
    );
    expect(() => replyService.computeReplyRecipients(message, {
      account,
      aliases,
      toAdd: recipients,
    })).toThrowError(expect.objectContaining({
      status: 400,
      code: 'too_many_recipients',
    }));
  });
});

describe('subject helpers', () => {
  it.each([
    ['Topic', 'Re: Topic'],
    [' Re: Topic ', 'Re: Topic'],
    ['RE: Topic', 'RE: Topic'],
    ['re : Topic', 're : Topic'],
    ['', 'Re:'],
    [null, 'Re:'],
  ])('builds an idempotent reply subject from %j', (subject, expected) => {
    expect(replyService.replySubject(subject)).toBe(expected);
  });

  it.each([
    ['Topic', 'Fwd: Topic'],
    [' Fwd: Topic ', 'Fwd: Topic'],
    ['FW: Topic', 'FW: Topic'],
    ['fwd : Topic', 'fwd : Topic'],
    ['', 'Fwd:'],
    [null, 'Fwd:'],
  ])('builds an idempotent forward subject from %j', (subject, expected) => {
    expect(replyService.forwardSubject(subject)).toBe(expected);
  });
});

describe('buildReferences', () => {
  it('uses the full ancestor chain plus message id and removes duplicates', () => {
    expect(replyService.buildReferences({
      thread_references: '<root@example.com> <parent@example.com> <parent@example.com>',
      message_id: '<message@example.com>',
      in_reply_to: '<ignored@example.com>',
    })).toEqual({
      inReplyTo: '<message@example.com>',
      references: '<root@example.com> <parent@example.com> <message@example.com>',
    });
  });

  it('keeps the root and last 20 ids when a chain exceeds 21 entries', () => {
    const ids = Array.from({ length: 25 }, (_, index) => `<id-${index}@example.com>`);
    const result = replyService.buildReferences({
      thread_references: ids.join(' '),
      message_id: '<message@example.com>',
    });
    const bounded = result.references.split(' ');

    expect(bounded).toHaveLength(21);
    expect(bounded[0]).toBe(ids[0]);
    expect(bounded.slice(1)).toEqual([...ids.slice(-19), '<message@example.com>']);
  });

  it('falls back to the message id when there is no stored ancestor chain', () => {
    expect(replyService.buildReferences({
      thread_references: null,
      message_id: '<message@example.com>',
    })).toEqual({
      inReplyTo: '<message@example.com>',
      references: '<message@example.com>',
    });
  });
});

describe('autoSelectAlias', () => {
  const aliases = [
    { id: 'alias-1', email: 'first@example.com' },
    { id: 'alias-2', email: 'second@example.com' },
  ];

  it('selects the first alias addressed in the original To or Cc list', () => {
    expect(replyService.autoSelectAlias({
      to_addresses: JSON.stringify([{ name: '', email: 'SECOND@example.com' }]),
      cc_addresses: [{ name: '', email: 'first@example.com' }],
      from_email: 'sender@example.com',
    }, aliases)).toBe('alias-1');
  });

  it('selects an alias that sent the original message', () => {
    expect(replyService.autoSelectAlias({
      to_addresses: [],
      cc_addresses: [],
      from_email: 'SECOND@example.com',
    }, aliases)).toBe('alias-2');
  });

  it('returns null when no alias matches', () => {
    expect(replyService.autoSelectAlias({
      to_addresses: [],
      cc_addresses: [],
      from_email: 'sender@example.com',
    }, aliases)).toBeNull();
  });
});

describe('buildReply', () => {
  const account = {
    id: 'account-1',
    user_id: 'user-1',
    email_address: 'me@example.com',
  };
  const aliases = [{ id: 'alias-1', email: 'team@example.com', reply_to: null }];
  const message = {
    id: 'message-row-1',
    account_id: 'account-1',
    uid: 42,
    folder: 'INBOX',
    message_id: '<message@example.com>',
    thread_references: '<root@example.com>',
    subject: 'Topic',
    from_name: 'Sender',
    from_email: 'sender@example.com',
    reply_to: [],
    to_addresses: [{ name: 'Team', email: 'team@example.com' }],
    cc_addresses: [{ name: 'Colleague', email: 'colleague@example.com' }],
    body_text: 'Original',
    body_html: '<p>Original</p>',
    attachments: [],
  };

  it('returns a sendMessage compose input and hard-validates an explicit alias', async () => {
    const result = await replyService.buildReply({
      message,
      account,
      aliases,
      replyAll: true,
      body: 'Response',
      bodyIsHtml: false,
      noQuote: true,
      alias: 'TEAM@example.com',
    }, {
      resolveAlias: async (accountId, aliasEmail) => (
        accountId === account.id && aliasEmail === 'TEAM@example.com'
          ? aliases[0]
          : null
      ),
    });

    expect(result).toEqual({
      account,
      aliasId: 'alias-1',
      userId: 'user-1',
      to: ['Sender <sender@example.com>'],
      cc: ['Colleague <colleague@example.com>'],
      bcc: [],
      subject: 'Re: Topic',
      body: 'Response',
      bodyIsHtml: false,
      quotedBody: '',
      quotedBodyHtml: null,
      inReplyTo: '<message@example.com>',
      references: '<root@example.com> <message@example.com>',
    });
  });

  it('throws alias_not_found when an explicit selector does not resolve', async () => {
    await expect(replyService.buildReply({
      message,
      account,
      aliases,
      body: 'Response',
      noQuote: true,
      alias: 'missing@example.com',
    }, {
      resolveAlias: async () => null,
    })).rejects.toMatchObject({
      name: 'AliasNotFoundError',
      status: 422,
      code: 'alias_not_found',
    });
  });

  it('re-fetches referenced cid parts and returns base64 attachments with matching cids', async () => {
    const fetchAttachment = vi.fn(async (_account, _uid, _folder, part) => (
      Buffer.from(`content-${part}`)
    ));
    const inlineMessage = {
      ...message,
      body_html: '<p>Original</p><img src="cid:<image-1>"><img src=\'CID:image-2\'><img src="cid:image-1">',
      attachments: [
        { part: '2', cid: 'image-1', filename: 'one.png', type: 'image/png' },
        { part: '3', content_id: '<image-2>', filename: 'two.jpg', type: 'image/jpeg' },
      ],
    };

    const result = await replyService.buildReply({
      message: inlineMessage,
      account,
      aliases,
      body: 'Response',
      includeInlineImages: true,
    }, {
      imapManager: { fetchAttachment },
    });

    expect(result.quotedBodyHtml).toContain('<img src="cid:<image-1>">');
    expect(result.attachments).toEqual([
      {
        filename: 'one.png',
        content: Buffer.from('content-2').toString('base64'),
        contentType: 'image/png',
        cid: 'image-1',
      },
      {
        filename: 'two.jpg',
        content: Buffer.from('content-3').toString('base64'),
        contentType: 'image/jpeg',
        cid: 'image-2',
      },
    ]);
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(fetchAttachment).toHaveBeenNthCalledWith(1, account, 42, 'INBOX', '2');
    expect(fetchAttachment).toHaveBeenNthCalledWith(2, account, 42, 'INBOX', '3');
  });

  it('does not fetch inline parts when quoting is disabled', async () => {
    const fetchAttachment = vi.fn();
    const result = await replyService.buildReply({
      message: {
        ...message,
        body_html: '<img src="cid:image-1">',
        attachments: [{ part: '2', cid: 'image-1' }],
      },
      account,
      aliases,
      body: 'Response',
      noQuote: true,
      includeInlineImages: true,
    }, {
      imapManager: { fetchAttachment },
    });

    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('attachments');
  });

  it('enforces the 25 MB attachment budget for re-fetched inline images', async () => {
    await expect(replyService.buildReply({
      message: {
        ...message,
        body_html: '<img src="cid:image-1">',
        attachments: [{ part: '2', cid: 'image-1' }],
      },
      account,
      aliases,
      body: 'Response',
      includeInlineImages: true,
    }, {
      imapManager: {
        fetchAttachment: async () => Buffer.alloc(26_214_401),
      },
    })).rejects.toMatchObject({
      status: 400,
      code: 'attachment_too_large',
    });
  });
});

describe('buildQuote', () => {
  const date = '2026-07-28T12:34:56.000Z';
  const localeDate = new Date(date).toLocaleString();

  it('builds the frontend-compatible text quote and adds gmail_quote to the HTML wrapper', () => {
    expect(replyService.buildQuote({
      date,
      from_name: 'Sender\r\nInjected',
      from_email: 'sender@example.com',
      body_text: 'First line\nSecond line',
      body_html: '<p>Original HTML</p>',
      attachments: [],
    }, {})).toEqual({
      quotedBody: `\n\n---\nOn ${localeDate}, Sender Injected <sender@example.com> wrote:\n> First line\n> Second line`,
      quotedBodyHtml: `<div class="gmail_quote" style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${localeDate}, Sender Injected <sender@example.com> wrote:</p><p>Original HTML</p></div>`,
    });
  });

  it('uses empty quote values when the corresponding source body is absent', () => {
    expect(replyService.buildQuote({
      from_name: '',
      from_email: 'sender@example.com',
      body_text: '',
      body_html: '',
    }, {})).toEqual({
      quotedBody: '',
      quotedBodyHtml: null,
    });
  });

  it('replaces cid image tags with filename placeholders by default', () => {
    expect(replyService.buildQuote({
      from_name: 'Sender',
      from_email: 'sender@example.com',
      body_html: '<p>Before</p><img alt="photo" src="cid:<image-1>"><img src=\'CID:missing\'>',
      attachments: [
        { part: '2', cid: 'image-1', filename: 'photo.png', type: 'image/png' },
      ],
    }, {}).quotedBodyHtml).toContain(
      '<p>Before</p>[inline image: photo.png][inline image: attachment]',
    );
  });

  it('keeps cid image tags when inline images are requested', () => {
    const html = '<p>Before</p><img src="cid:image-1">';
    expect(replyService.buildQuote({
      from_name: 'Sender',
      from_email: 'sender@example.com',
      body_html: html,
      attachments: [{ part: '2', content_id: '<image-1>', filename: 'photo.png' }],
    }, { includeInlineImages: true }).quotedBodyHtml).toContain(html);
  });
});

describe('buildForwardQuote', () => {
  it('builds frontend-compatible forwarded headers and body with gmail_quote HTML', () => {
    const date = '2026-07-28T12:34:56.000Z';
    const localeDate = new Date(date).toLocaleString();
    const result = replyService.buildForwardQuote({
      date,
      from_name: 'Sender\r\nInjected',
      from_email: 'sender@example.com',
      subject: 'Topic\r\nBcc: hidden@example.com',
      to_addresses: JSON.stringify([
        { name: 'One', email: 'one@example.com' },
        { name: '', email: 'two@example.com' },
      ]),
      cc_addresses: [{ name: 'Three', email: 'three@example.com' }],
      body_text: 'Original text',
      body_html: '<p>Original HTML</p><img src="cid:image-1">',
      attachments: [{ cid: 'image-1', filename: 'photo.png' }],
    });

    expect(result).toEqual({
      quotedBody: `\n\n---------- Forwarded message ----------\nFrom: Sender Injected <sender@example.com>\nDate: ${localeDate}\nSubject: Topic Bcc: hidden@example.com\nTo: One <one@example.com>, two@example.com\nCc: Three <three@example.com>\n\nOriginal text`,
      quotedBodyHtml: `<div class="gmail_quote" style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: Sender Injected <sender@example.com><br>Date: ${localeDate}<br>Subject: Topic Bcc: hidden@example.com<br>To: One <one@example.com>, two@example.com<br>Cc: Three <three@example.com></p><p>Original HTML</p>[inline image: photo.png]</div>`,
    });
  });
});

describe('buildForward', () => {
  const account = {
    id: 'account-1',
    user_id: 'user-1',
    email_address: 'me@example.com',
  };
  const aliases = [{ id: 'alias-1', email: 'team@example.com' }];
  const message = {
    id: '11111111-1111-4111-8111-111111111111',
    uid: 42,
    folder: 'INBOX',
    subject: 'Topic',
    from_name: 'Sender',
    from_email: 'sender@example.com',
    to_addresses: [{ name: 'Team', email: 'team@example.com' }],
    cc_addresses: [],
    body_text: 'Original text',
    body_html: '<p>Original HTML</p>',
    attachments: [
      { part: '2', filename: 'deck.pdf', type: 'application/pdf', size: 100 },
      { part: '', filename: 'missing-part.txt', type: 'text/plain', size: 10 },
    ],
  };

  it('returns a sendMessage compose input and forwards stored attachment parts by reference', async () => {
    const result = await replyService.buildForward({
      message,
      account,
      aliases,
      to: ['Recipient <recipient@example.com>'],
      note: 'Please review.',
    }, {});

    expect(result).toMatchObject({
      account,
      aliasId: 'alias-1',
      userId: 'user-1',
      to: ['Recipient <recipient@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Fwd: Topic',
      body: 'Please review.',
      bodyIsHtml: false,
      quotedBody: expect.stringContaining('---------- Forwarded message ----------'),
      quotedBodyHtml: expect.stringContaining('class="gmail_quote"'),
      forwardedAttachments: [{
        messageId: '11111111-1111-4111-8111-111111111111',
        part: '2',
      }],
    });
  });

  it('omits forwardedAttachments when skipAttachments is true', async () => {
    const result = await replyService.buildForward({
      message,
      account,
      aliases,
      to: ['recipient@example.com'],
      skipAttachments: true,
    }, {});

    expect(result).not.toHaveProperty('forwardedAttachments');
  });

  it('hard-validates an explicit alias selector', async () => {
    await expect(replyService.buildForward({
      message,
      account,
      aliases,
      to: ['recipient@example.com'],
      alias: 'missing@example.com',
    }, {
      resolveAlias: async () => null,
    })).rejects.toMatchObject({
      status: 422,
      code: 'alias_not_found',
    });
  });
});

describe('composeFromMessage port parity', () => {
  const account = {
    id: 'account-1',
    email_address: 'me@example.com',
    aliases: [{
      id: 'alias-1',
      email: 'team@example.com',
      reply_to: 'forwarding-self@example.com',
    }],
  };
  const baseMessage = {
    id: 'message-row-1',
    account_id: 'account-1',
    message_id: '<message@example.com>',
    in_reply_to: '<parent@example.com>',
    thread_references: '<parent@example.com>',
    subject: 'Topic',
    from_name: 'Sender',
    from_email: 'sender@example.com',
    reply_to: [],
    to_addresses: [
      { name: 'Me', email: 'me@example.com' },
      { name: 'Person', email: 'person@example.com' },
    ],
    cc_addresses: [{ name: 'Colleague', email: 'colleague@example.com' }],
    date: '2026-07-28T12:34:56.000Z',
    body_text: 'First line\nSecond line',
    body_html: '<p>Original HTML</p>',
    attachments: [],
  };

  async function runFrontend(message, replyAll = true) {
    let compose;
    await openReplyFromMessage(message, {
      accounts: [account],
      replyAll,
      openCompose: value => { compose = value; },
      getMessageBody: async () => ({
        text: message.body_text,
        html: message.body_html,
        attachments: message.attachments,
      }),
    });
    return compose;
  }

  it('matches frontend recipients, subject, text quote, wrapper style, and short references', async () => {
    const frontend = await runFrontend(baseMessage);
    const recipients = replyService.computeReplyRecipients(baseMessage, {
      account,
      aliases: account.aliases,
      replyAll: true,
    });
    const quote = replyService.buildQuote(baseMessage, {});
    const threading = replyService.buildReferences(baseMessage);

    expect(recipients.to).toEqual(frontend.to);
    expect(recipients.cc).toEqual(frontend.cc);
    expect(replyService.replySubject(baseMessage.subject)).toBe(frontend.subject);
    expect(quote.quotedBody).toBe(frontend.quotedBody);
    expect(quote.quotedBodyHtml?.replace(' class="gmail_quote"', '')).toBe(frontend.quotedBodyHtml);
    expect(quote.quotedBodyHtml).toContain('class="gmail_quote"');
    expect(threading.inReplyTo).toBe(frontend.inReplyTo);
    expect(threading.references).toBe(frontend.references);
  });

  it('intentionally differs by deduping reply-all Cc case-insensitively and preferring names', async () => {
    const message = {
      ...baseMessage,
      to_addresses: [{ name: '', email: 'duplicate@example.com' }],
      cc_addresses: [{ name: 'Duplicate', email: 'DUPLICATE@example.com' }],
    };
    const frontend = await runFrontend(message);
    const backend = replyService.computeReplyRecipients(message, {
      account,
      aliases: account.aliases,
      replyAll: true,
    });

    expect(frontend.cc).toEqual([
      { name: '', email: 'duplicate@example.com' },
      { name: 'Duplicate', email: 'DUPLICATE@example.com' },
    ]);
    expect(backend.cc).toEqual([
      { name: 'Duplicate', email: 'DUPLICATE@example.com' },
    ]);
    expect(backend.cc).not.toEqual(frontend.cc);
  });

  it('intentionally differs by recognizing an uppercase RE prefix', async () => {
    const message = { ...baseMessage, subject: 'RE: Topic' };
    const frontend = await runFrontend(message, false);
    const backend = replyService.replySubject(message.subject);

    expect(frontend.subject).toBe('Re: RE: Topic');
    expect(backend).toBe('RE: Topic');
    expect(backend).not.toBe(frontend.subject);
  });

  it('intentionally differs by retaining the full thread_references ancestor chain', async () => {
    const message = {
      ...baseMessage,
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
    };
    const frontend = await runFrontend(message, false);
    const backend = replyService.buildReferences(message);

    expect(frontend.references).toBe('<parent@example.com> <message@example.com>');
    expect(backend.references).toBe(
      '<root@example.com> <parent@example.com> <message@example.com>',
    );
    expect(backend.references).not.toBe(frontend.references);
  });

  it('intentionally differs by treating alias reply-to addresses as self', async () => {
    const message = {
      ...baseMessage,
      to_addresses: [{ name: 'Me', email: 'me@example.com' }],
      cc_addresses: [{
        name: 'Forwarding Self',
        email: 'forwarding-self@example.com',
      }],
    };
    const frontend = await runFrontend(message);
    const backend = replyService.computeReplyRecipients(message, {
      account,
      aliases: account.aliases,
      replyAll: true,
    });

    expect(frontend.cc).toEqual([{
      name: 'Forwarding Self',
      email: 'forwarding-self@example.com',
    }]);
    expect(backend.cc).toEqual([]);
    expect(backend.cc).not.toEqual(frontend.cc);
  });
});
