import { describe, expect, it, vi } from 'vitest';
import {
  buildReceipt,
  sendMessage,
  sendMessageIdempotent,
} from './sendService.js';

const account = {
  id: 'account-1',
  email_address: 'sender@example.com',
  name: 'Sender',
  signature: null,
  oauth_provider: null,
};

function input(overrides = {}) {
  return {
    userId: 'user-1',
    account,
    to: ['Recipient <recipient@example.com>'],
    cc: [],
    bcc: [],
    subject: 'Subject',
    body: 'Body',
    bodyIsHtml: false,
    ...overrides,
  };
}

function serviceDeps(overrides = {}) {
  const transport = { sendMail: vi.fn().mockResolvedValue({}) };
  return {
    query: vi.fn(),
    imapManager: {},
    resolveFromIdentity: vi.fn().mockResolvedValue({
      fromName: 'Sender',
      fromEmail: 'sender@example.com',
      fromReplyTo: null,
      signature: null,
      aliasId: null,
    }),
    buildSmtpTransport: vi.fn().mockResolvedValue({ transport, account }),
    buildMailOptions: vi.fn(options => ({
      messageId: options.messageId,
      from: `${options.fromName} <${options.fromEmail}>`,
      to: options.to.join(', '),
      subject: options.subject,
      text: options.text,
      ...(options.html !== undefined ? { html: options.html } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    })),
    renderRaw: vi.fn().mockResolvedValue(Buffer.from('raw mime')),
    embedInlineDataImages: vi.fn(html => ({ html, attachments: [] })),
    learnSentRecipients: vi.fn(),
    resolveSentFolder: vi.fn().mockResolvedValue('Sent'),
    persistSentCopy: vi.fn().mockResolvedValue({ sentCopySaved: true }),
    randomBytes: vi.fn(() => Buffer.alloc(16, 1)),
    ...overrides,
    transport,
  };
}

describe('sendMessage', () => {
  it('validates, renders, delivers, and persists a non-OAuth message in order', async () => {
    const events = [];
    const deps = serviceDeps({
      renderRaw: vi.fn(async () => {
        events.push('render');
        return Buffer.from('raw mime');
      }),
      beforeDelivery: vi.fn(async () => { events.push('reserve'); }),
      afterDelivery: vi.fn(() => { events.push('delivered'); }),
      persistSentCopy: vi.fn(async () => {
        events.push('persist');
        return { sentCopySaved: false };
      }),
    });
    deps.transport.sendMail.mockImplementation(async () => { events.push('send'); });

    const result = await sendMessage(input({
      attachments: [{
        filename: 'note.txt',
        content: Buffer.from('hello').toString('base64'),
        contentType: 'text/plain',
      }],
      priority: 'high',
    }), deps);

    expect(events).toEqual(['render', 'reserve', 'send', 'delivered', 'persist']);
    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasId: undefined, aliasEmail: undefined },
      deps,
    );
    expect(deps.buildMailOptions).toHaveBeenCalledWith(expect.objectContaining({
      to: ['Recipient <recipient@example.com>'],
      priority: 'high',
      attachments: [expect.objectContaining({
        filename: 'note.txt',
        content: Buffer.from('hello'),
        contentType: 'text/plain',
      })],
    }));
    expect(result).toMatchObject({
      ok: true,
      sentCopySaved: false,
      receipt: {
        from: { name: 'Sender', email: 'sender@example.com' },
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        subject: 'Subject',
        folder: 'Sent',
        sentCopySaved: false,
      },
    });
    expect(result.messageId).toMatch(/^<01010101.+@example\.com>$/);
  });

  it('preserves cid on inline attachments and omits it otherwise', async () => {
    const deps = serviceDeps();

    await sendMessage(input({
      attachments: [
        {
          filename: 'inline.png',
          content: Buffer.from('img').toString('base64'),
          contentType: 'image/png',
          cid: 'part1.abc@example.com',
        },
        {
          filename: 'plain.txt',
          content: Buffer.from('txt').toString('base64'),
          contentType: 'text/plain',
        },
      ],
    }), deps);

    const { attachments } = deps.buildMailOptions.mock.calls[0][0];
    expect(attachments[0]).toMatchObject({ filename: 'inline.png', cid: 'part1.abc@example.com' });
    expect(attachments[1]).not.toHaveProperty('cid');
  });

  it('skips raw rendering for OAuth providers', async () => {
    const oauthAccount = { ...account, oauth_provider: 'google' };
    const deps = serviceDeps({
      buildSmtpTransport: vi.fn().mockImplementation(async () => ({
        transport: deps.transport,
        account: oauthAccount,
      })),
    });

    await sendMessage(input({ account: oauthAccount }), deps);
    expect(deps.renderRaw).not.toHaveBeenCalled();
    expect(deps.persistSentCopy).toHaveBeenCalledWith(expect.objectContaining({ rawMessage: null }), deps);
  });

  it('reuses a message ID generated when an outbox row was enqueued', async () => {
    const deps = serviceDeps();

    const result = await sendMessage(input({
      messageId: '<queued-once@example.com>',
    }), deps);

    expect(deps.buildMailOptions).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '<queued-once@example.com>',
    }));
    expect(result.messageId).toBe('<queued-once@example.com>');
  });

  it.each([
    [{ attachments: 'bad' }, 'attachments must be an array'],
    [{ attachments: Array.from({ length: 101 }, () => ({})) }, 'Too many attachments (max 100)'],
    [{ attachments: [{ filename: '', content: '' }] }, 'attachments[0].filename is required'],
    [{ forwardedAttachments: [{ messageId: 'bad', part: '1' }] }, 'forwardedAttachments[0].messageId is invalid'],
    [{ to: ['bad-address'] }, 'to[0] is not a valid email address'],
  ])('rejects invalid compose input before building SMTP: %j', async (overrides, message) => {
    const deps = serviceDeps();
    const error = await sendMessage(input(overrides), deps).catch(err => err);
    expect(error).toMatchObject({ message, status: 400, expose: true });
    expect(deps.buildSmtpTransport).not.toHaveBeenCalled();
  });

  it('fetches forwarded attachment content through a user-scoped account query', async () => {
    const referencedAccount = { ...account, id: 'account-2' };
    const deps = serviceDeps({
      query: vi.fn().mockResolvedValueOnce({ rows: [{
        uid: 9,
        folder: 'Inbox',
        account: referencedAccount,
        attachments: [{ part: '2', filename: 'forwarded.pdf', type: 'application/pdf' }],
      }] }),
      imapManager: {
        fetchAttachment: vi.fn().mockResolvedValue(Buffer.from('pdf')),
      },
    });

    await sendMessage(input({
      forwardedAttachments: [{
        messageId: '11111111-1111-4111-8111-111111111111',
        part: '2',
      }],
    }), deps);

    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(deps.query.mock.calls[0][0]).toContain('to_jsonb(a) AS account');
    expect(deps.query.mock.calls[0][1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    ]);
    expect(deps.imapManager.fetchAttachment).toHaveBeenCalledWith(referencedAccount, 9, 'Inbox', '2');
  });
});

describe('sendMessageIdempotent', () => {
  it('uses the unchanged Redis namespace and reserves after rendering immediately before sendMail', async () => {
    const events = [];
    const redisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockImplementation(async (_key, value) => {
        events.push(value === '__inflight__' ? 'reserve' : 'cache');
        return 'OK';
      }),
      del: vi.fn(),
    };
    const deps = serviceDeps({
      redisClient,
      renderRaw: vi.fn(async () => {
        events.push('render');
        return Buffer.from('raw');
      }),
    });
    deps.transport.sendMail.mockImplementation(async () => { events.push('send'); });

    await sendMessageIdempotent(input({ idempotencyKey: 'key-1' }), deps);

    expect(events.slice(0, 3)).toEqual(['render', 'reserve', 'send']);
    expect(redisClient.get).toHaveBeenCalledWith('send_idem:user-1:key-1');
    expect(redisClient.set.mock.calls[0]).toEqual([
      'send_idem:user-1:key-1',
      '__inflight__',
      { NX: true, EX: 300 },
    ]);
  });

  it('returns cached results and conflicts on in-flight results without sending', async () => {
    const cachedDeps = serviceDeps({
      redisClient: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        set: vi.fn(),
        del: vi.fn(),
      },
    });
    await expect(sendMessageIdempotent(input({ idempotencyKey: 'cached' }), cachedDeps))
      .resolves.toEqual({ ok: true });
    expect(cachedDeps.transport.sendMail).not.toHaveBeenCalled();

    const inflightDeps = serviceDeps({
      redisClient: {
        get: vi.fn().mockResolvedValue('__inflight__'),
        set: vi.fn(),
        del: vi.fn(),
      },
    });
    await expect(sendMessageIdempotent(input({ idempotencyKey: 'busy' }), inflightDeps))
      .rejects.toMatchObject({ status: 409, expose: true });
    expect(inflightDeps.transport.sendMail).not.toHaveBeenCalled();
  });

  it('does not delete somebody else’s reservation when NX reports a conflict', async () => {
    const redisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null),
      del: vi.fn(),
    };
    const deps = serviceDeps({ redisClient });

    await expect(sendMessageIdempotent(input({ idempotencyKey: 'race' }), deps))
      .rejects.toMatchObject({ status: 409 });
    expect(redisClient.del).not.toHaveBeenCalled();
    expect(deps.transport.sendMail).not.toHaveBeenCalled();
  });

  it('releases the reservation on pre-delivery failure and stores durable success after delivery', async () => {
    const preRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };
    const preDeps = serviceDeps({ redisClient: preRedis });
    preDeps.transport.sendMail.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(sendMessageIdempotent(input({ idempotencyKey: 'pre' }), preDeps)).rejects.toThrow('SMTP failed');
    expect(preRedis.del).toHaveBeenCalledWith('send_idem:user-1:pre');

    const postRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn(),
    };
    const postDeps = serviceDeps({
      redisClient: postRedis,
      resolveSentFolder: vi.fn().mockRejectedValue(new Error('DB failed after delivery')),
    });
    await expect(sendMessageIdempotent(input({ idempotencyKey: 'post' }), postDeps))
      .rejects.toThrow('DB failed after delivery');
    expect(postRedis.set).toHaveBeenLastCalledWith(
      'send_idem:user-1:post',
      JSON.stringify({ ok: true }),
      { EX: 86400 },
    );
    expect(postRedis.del).not.toHaveBeenCalled();
  });
});

describe('sendOrEnqueue', () => {
  it('uses the existing idempotent immediate-send path when undo is off', async () => {
    const service = await import('./sendService.js');
    const redisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn(),
    };
    const deps = serviceDeps({ redisClient });

    expect(service.sendOrEnqueue).toBeTypeOf('function');
    const result = await service.sendOrEnqueue(input({
      undoSeconds: 0,
      idempotencyKey: 'immediate-1',
      messageId: '<client-controlled@example.com>',
    }), deps);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('<01010101010101010101010101010101@example.com>');
    expect(redisClient.get).toHaveBeenCalledWith('send_idem:user-1:immediate-1');
    expect(deps.transport.sendMail).toHaveBeenCalledTimes(1);
  });

  it('enqueues a validated credential-free payload with the same idempotency key', async () => {
    const service = await import('./sendService.js');
    const sendAt = new Date('2026-07-28T12:00:30.000Z');
    const outboxService = {
      enqueue: vi.fn().mockResolvedValue({
        outbox_id: 'outbox-1',
        send_at: sendAt,
        undo_seconds: 30,
      }),
    };
    const deps = serviceDeps({ outboxService });

    expect(service.sendOrEnqueue).toBeTypeOf('function');
    const result = await service.sendOrEnqueue(input({
      accountId: 'account-1',
      undoSendSeconds: 30,
      undoSeconds: 30,
      idempotencyKey: 'queued-1',
      priority: 'unexpected',
      auth_pass: 'must-never-be-stored',
      deleteDraftOnSend: {
        accountId: 'source-account-1',
        uid: 7,
        folder: 'Drafts',
      },
      composeSessionRestore: {
        originalSessionId: '11111111-1111-4111-8111-111111111111',
        preferredSlot: 2,
      },
    }), deps);

    expect(deps.transport.sendMail).not.toHaveBeenCalled();
    expect(outboxService.enqueue).toHaveBeenCalledTimes(1);
    const [queued, enqueueDeps] = outboxService.enqueue.mock.calls[0];
    expect(enqueueDeps).toBe(deps);
    expect(queued).toMatchObject({
      userId: 'user-1',
      accountId: 'account-1',
      undoSeconds: 30,
      idempotencyKey: 'queued-1',
      subject: 'Subject',
      toPreview: ['Recipient <recipient@example.com>'],
      messageId: '<01010101010101010101010101010101@example.com>',
    });
    expect(queued.payload).toMatchObject({
      userId: 'user-1',
      account_id: 'account-1',
      to: ['Recipient <recipient@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Subject',
      priority: 'normal',
      body: 'Body',
      messageId: '<01010101010101010101010101010101@example.com>',
      deleteDraftOnSend: {
        accountId: 'source-account-1',
        uid: 7,
        folder: 'Drafts',
      },
      composeSessionRestore: {
        originalSessionId: '11111111-1111-4111-8111-111111111111',
        preferredSlot: 2,
      },
    });
    expect(queued.payload).not.toHaveProperty('account');
    expect(queued.payload).not.toHaveProperty('auth_pass');
    expect(queued.payload).not.toHaveProperty('undoSeconds');
    expect(queued.payload).not.toHaveProperty('undoSendSeconds');
    expect(queued.payload).not.toHaveProperty('idempotencyKey');
    expect(result).toEqual({
      queued: true,
      outboxId: 'outbox-1',
      sendAt,
      undoSeconds: 30,
    });
  });

  it('generates the queued message ID from the resolved alias identity', async () => {
    const service = await import('./sendService.js');
    const outboxService = {
      enqueue: vi.fn().mockResolvedValue({
        outbox_id: 'outbox-1',
        send_at: new Date('2026-07-28T12:00:30.000Z'),
        undo_seconds: 30,
      }),
    };
    const deps = serviceDeps({
      outboxService,
      resolveFromIdentity: vi.fn().mockResolvedValue({
        fromName: 'Alias',
        fromEmail: 'sender@alias.example',
        fromReplyTo: null,
        signature: null,
        aliasId: 'alias-1',
      }),
    });

    expect(service.sendOrEnqueue).toBeTypeOf('function');
    await service.sendOrEnqueue(input({
      undoSeconds: 30,
      aliasId: 'alias-1',
    }), deps);

    expect(deps.resolveFromIdentity).toHaveBeenCalledWith(
      account,
      { aliasId: 'alias-1', aliasEmail: undefined },
      deps,
    );
    expect(outboxService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: '<01010101010101010101010101010101@alias.example>',
      }),
      deps,
    );
  });
});

describe('buildReceipt', () => {
  it('returns normalized recipient and attachment metadata without content', () => {
    expect(buildReceipt({
      from: { name: 'Sender', email: 'sender@example.com' },
      to: ['A <a@example.com>'],
      cc: [],
      bcc: [],
      subject: 'Subject',
      attachments: [{ filename: 'a.txt', content: Buffer.from('abc') }],
      messageId: '<id@example.com>',
      sentCopySaved: true,
      folder: 'Sent',
    })).toEqual({
      from: { name: 'Sender', email: 'sender@example.com' },
      to: [{ name: 'A', email: 'a@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Subject',
      attachments: [{ filename: 'a.txt', size: 3 }],
      messageId: '<id@example.com>',
      sentCopySaved: true,
      folder: 'Sent',
    });
  });
});
