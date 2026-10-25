import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn(), findOwnedMessages: vi.fn() }));
vi.mock('../index.js', () => ({
  imapManager: {
    appendToSent: vi.fn(async () => ({ uid: 5 })),
    upsertSentMessageRecord: vi.fn(async () => {}),
    syncFolderOnDemand: vi.fn(async () => {}),
    fetchAttachment: vi.fn(),
    fetchRawMessage: vi.fn(),
    pluginFacade: {},
  },
}));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./draftCopies.js', () => ({ deleteSentDraft: vi.fn(async () => true) }));
import { query } from './db.js';
import { findOwnedAccount, findOwnedMessages } from './ownership.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deleteSentDraft } from './draftCopies.js';
import {
  SendError, missingSendFields, validateSendInput, resolveIdentity, resolveForwarded,
  buildMailOptions, serverAutoSavesSent, renderRawMessage, prepareDelivery, deliverAndRecord,
} from './outgoingMail.js';

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', sender_name: null, signature: '<b>Sig</b>', oauth_provider: null, imap_host: 'imap.example.com', smtp_host: 'smtp.example.com' };
const MSG_ID = '11111111-1111-4111-8111-111111111111';
const valid = extra => validateSendInput({ accountId: 'a1', to: ['you@example.com'], subject: 'Hi', body: 'Hello', ...extra });
const identity = extra => ({ account, plaintextEmail: false, fromName: 'Me', fromEmail: 'me@example.com', replyTo: null, signature: null, ...extra });

// The error a call throws, so its class, status and message can be checked together.
const thrown = fn => { try { fn(); } catch (err) { return err; } return null; };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateSendInput', () => {
  it('normalizes recipients, subject and priority', () => {
    const input = valid({ to: [' you@example.com '], cc: ['c@example.com'], subject: 'Hi\r\nBcc: x@evil.com', priority: 'urgent' });
    expect(input.to).toEqual(['you@example.com']);
    expect(input.cc).toEqual(['c@example.com']);
    expect(input.bcc).toEqual([]);
    expect(input.subject).toBe('HiBcc: x@evil.com');
    expect(input.priority).toBe('normal');
    expect(input.bodyIsHtml).toBe(false);
    expect(valid({ priority: 'high' }).priority).toBe('high');
  });

  it('throws a 400 SendError with the message the route answers', () => {
    const cases = [
      [{ to: [] }, 'accountId and to required'],
      [{ attachments: 'x' }, 'attachments must be an array'],
      [{ attachments: [{ filename: ' ', content: '' }] }, 'attachments[0].filename is required'],
      [{ forwardedAttachments: [{ messageId: 'nope', part: '1' }] }, 'forwardedAttachments[0].messageId is invalid'],
      [{ forwardedMessages: Array(21).fill(MSG_ID) }, 'Too many forwarded messages (max 20)'],
      [{ cc: ['bad\n@example.com'] }, 'cc[0] contains invalid characters'],
      [{ bcc: ['nobody'] }, 'bcc[0] is not a valid email address'],
    ];
    for (const [extra, message] of cases) {
      const err = thrown(() => valid(extra));
      expect(err).toBeInstanceOf(SendError);
      expect(err).toMatchObject({ status: 400, message });
    }
  });

  it('checks the attachments before the recipients, as the route always has', () => {
    expect(thrown(() => valid({ to: ['nobody'], attachments: {} })).message).toBe('attachments must be an array');
  });

  it('missingSendFields names the missing fields only', () => {
    expect(missingSendFields({ accountId: 'a1', to: ['x@example.com'] })).toBeNull();
    expect(missingSendFields({ to: ['x@example.com'] })).toBe('accountId and to required');
    expect(missingSendFields(undefined)).toBe('accountId and to required');
  });
});

describe('resolveIdentity', () => {
  beforeEach(() => {
    findOwnedAccount.mockResolvedValue(account);
    query.mockImplementation(async sql => ({
      rows: sql.includes('account_aliases')
        ? [{ name: 'Alias', email: 'alias@other.org', reply_to: 'reply@other.org', signature: null }]
        : [{ preferences: { plaintextEmail: true } }],
    }));
  });

  it('is the account by default, with its signature and the plain-text preference', async () => {
    const id = await resolveIdentity('u1', valid());
    expect(findOwnedAccount).toHaveBeenCalledWith('u1', 'a1');
    expect(id).toEqual({ account, plaintextEmail: true, fromName: 'Me', fromEmail: 'me@example.com', replyTo: null, signature: '<b>Sig</b>' });
  });

  it('takes an alias of the account, which inherits the signature unless it has its own', async () => {
    const id = await resolveIdentity('u1', valid({ aliasId: 'al1' }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('account_aliases'), ['al1', 'a1']);
    expect(id).toMatchObject({ fromName: 'Alias', fromEmail: 'alias@other.org', replyTo: 'reply@other.org', signature: '<b>Sig</b>' });
  });

  it('an edited signature replaces it, and an empty one removes it', async () => {
    expect((await resolveIdentity('u1', valid({ editedSignature: '' }))).signature).toBeNull();
    expect((await resolveIdentity('u1', valid({ editedSignature: '<p>New</p><script>x</script>' }))).signature).not.toContain('script');
  });

  it('throws a 404 SendError for an account the user does not own', async () => {
    findOwnedAccount.mockResolvedValue(null);
    await expect(resolveIdentity('u1', valid())).rejects.toMatchObject({ name: 'SendError', status: 404, message: 'Account not found' });
  });
});

describe('resolveForwarded', () => {
  it('is empty without forwarded content and touches nothing', async () => {
    expect(await resolveForwarded('u1', valid())).toEqual({ attachments: [], messages: [] });
    expect(findOwnedMessages).not.toHaveBeenCalled();
  });

  it('fetches forwarded parts and whole messages in order', async () => {
    findOwnedMessages.mockImplementation(async (_u, ids) => ids.map(id => ({ id, uid: 9, folder: 'INBOX', account_id: 'a1', subject: 'Spam\r\n', attachments: [{ part: '2', filename: 'a.pdf', type: 'application/pdf', size: 3 }] })));
    query.mockResolvedValue({ rows: [account] });
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from('pdf'));
    imapManager.fetchRawMessage.mockResolvedValue(Buffer.from('Subject: x\r\n\r\nraw'));
    const fwd = await resolveForwarded('u1', valid({ forwardedAttachments: [{ messageId: MSG_ID, part: '2' }], forwardedMessages: [MSG_ID] }));
    expect(fwd.attachments).toEqual([{ filename: 'a.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }]);
    expect(fwd.messages).toEqual([expect.objectContaining({ filename: 'Spam.eml', contentType: 'message/rfc822', contentDisposition: 'attachment' })]);
  });

  it('turns any fetch failure into a SendError with its status, or 500', async () => {
    findOwnedMessages.mockResolvedValue([]);
    await expect(resolveForwarded('u1', valid({ forwardedMessages: [MSG_ID] })))
      .rejects.toMatchObject({ name: 'SendError', status: 404, message: 'Forwarded message not found' });
    findOwnedMessages.mockRejectedValue(new Error('connection reset'));
    await expect(resolveForwarded('u1', valid({ forwardedMessages: [MSG_ID] })))
      .rejects.toMatchObject({ name: 'SendError', status: 500, message: 'connection reset' });
  });
});

describe('buildMailOptions', () => {
  it('builds headers and both parts from the input and identity', () => {
    const opts = buildMailOptions(
      valid({ priority: 'low', inReplyTo: '<a@x>\r\n', quotedBody: '\n> old' }),
      identity({ replyTo: 'r@example.com', signature: '<i>S</i>' }),
    );
    expect(opts.messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
    expect(opts).toMatchObject({ from: 'Me <me@example.com>', replyTo: 'r@example.com', to: 'you@example.com', subject: 'Hi', priority: 'low', inReplyTo: '<a@x>', references: '<a@x>' });
    expect(opts.cc).toBeUndefined();
    expect(opts.text).toBe('Hello\n\n-- \nS\n> old');
    expect(opts.html).toContain('<i>S</i>');
    expect(opts.attachments).toBeUndefined();
  });

  it('takes a Message-ID fixed before, in place of a random one', () => {
    expect(buildMailOptions(valid(), identity(), undefined, { messageId: '<abc.123@example.com>' }).messageId).toBe('<abc.123@example.com>');
    const longest = `<${'a'.repeat(200)}@${'d'.repeat(255)}>`;
    expect(buildMailOptions(valid(), identity(), undefined, { messageId: longest }).messageId).toBe(longest);
  });

  it('refuses a fixed Message-ID that is not <local@domain>', () => {
    for (const messageId of ['abc@example.com', '<abc@example.com>\r\nBcc: x@evil.com', '<abc>', '<a b@example.com>', '<@example.com>', '', null,
      '<a\x00b@example.com>', '<ab@exa\x7fmple.com>', '<a\tb@example.com>', `<${'a'.repeat(201)}@example.com>`, `<a@${'d'.repeat(256)}>`]) {
      expect(() => buildMailOptions(valid(), identity(), undefined, { messageId })).toThrow(TypeError);
    }
  });

  it('takes a Date decided by the caller, and refuses one that is not a valid Date', () => {
    const date = new Date('2026-10-25T07:00:00Z');
    expect(buildMailOptions(valid(), identity(), undefined, { date }).date).toBe(date);
    for (const bad of ['2026-10-25', new Date('nope'), 0, null]) {
      expect(() => buildMailOptions(valid(), identity(), undefined, { date: bad })).toThrow(TypeError);
    }
  });

  it('sends no HTML part for a plain-text user', () => {
    expect(buildMailOptions(valid(), identity({ plaintextEmail: true })).html).toBeUndefined();
  });

  it('gives every call its own Message-ID', () => {
    expect(buildMailOptions(valid(), identity()).messageId).not.toBe(buildMailOptions(valid(), identity()).messageId);
  });

  it('dates the message when it is built, so every render of it carries the same Date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
      const opts = buildMailOptions(valid(), identity());
      expect(opts.date).toEqual(new Date('2026-10-24T10:00:00Z'));
      vi.setSystemTime(new Date('2026-10-24T10:00:30Z'));
      expect((await renderRawMessage(opts)).toString()).toContain('\r\nDate: Sat, 24 Oct 2026 10:00:00 +0000\r\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('orders attachments: inline images, uploads, forwarded parts, forwarded messages', () => {
    const opts = buildMailOptions(
      valid({ bodyIsHtml: true, body: '<p><img src="data:image/png;base64,iVBORw0KGgo="></p>', attachments: [{ filename: 'up.txt', content: Buffer.from('u').toString('base64') }] }),
      identity(),
      { attachments: [{ filename: 'fwd.pdf' }], messages: [{ filename: 'm.eml' }] },
    );
    expect(opts.attachments.map(a => a.filename ?? 'inline')).toEqual([expect.any(String), 'up.txt', 'fwd.pdf', 'm.eml']);
    expect(opts.attachments[0].cid).toBeTruthy();
    expect(opts.attachments[1]).toMatchObject({ content: Buffer.from('u'), contentType: 'application/octet-stream' });
  });
});

describe('serverAutoSavesSent', () => {
  it('trusts OAuth accounts and Gmail over Gmail SMTP only', () => {
    expect(serverAutoSavesSent({ ...account, oauth_provider: 'microsoft' })).toBe(true);
    expect(serverAutoSavesSent({ ...account, imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com', auth_user: 'me@gmail.com' })).toBe(true);
    expect(serverAutoSavesSent({ ...account, imap_host: 'imap.gmail.com', smtp_host: 'smtp.sendgrid.net' })).toBe(false);
    expect(serverAutoSavesSent(account)).toBe(false);
  });
});

describe('renderRawMessage', () => {
  it('renders the message with CRLF line ends (#365)', async () => {
    const raw = (await renderRawMessage(buildMailOptions(valid(), identity()))).toString();
    expect(raw).toMatch(/\r\nSubject: Hi\r\n/);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('prepareDelivery', () => {
  it('throws a SendError for an SMTP configuration the account cannot send with', async () => {
    createAccountSmtpTransport.mockResolvedValue({ status: 400, error: 'Plain-text SMTP is not allowed' });
    await expect(prepareDelivery(valid(), identity())).rejects.toMatchObject({ name: 'SendError', status: 400, message: 'Plain-text SMTP is not allowed' });
  });

  it('checks a fixed Message-ID and Date before it connects or refreshes anything', async () => {
    await expect(prepareDelivery(valid(), identity(), undefined, { messageId: '<bad\r\n@example.com>' })).rejects.toThrow(TypeError);
    await expect(prepareDelivery(valid(), identity(), undefined, { date: new Date('nope') })).rejects.toThrow(TypeError);
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('hands its smtp options to the account transport', async () => {
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn() } });
    await prepareDelivery(valid(), identity(), undefined, { smtp: { trackStage: true } });
    expect(createAccountSmtpTransport).toHaveBeenCalledWith(account, { trackStage: true });
  });

  it('passes a fixed Message-ID on to the message and its Sent copy', async () => {
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn() } });
    const delivery = await prepareDelivery(valid(), identity(), undefined, { messageId: '<fixed@example.com>' });
    expect(delivery.mailOptions.messageId).toBe('<fixed@example.com>');
    expect(delivery.rawMessage.toString()).toContain('\r\nMessage-ID: <fixed@example.com>\r\n');
  });

  it('passes a fixed Date on to the message and its Sent copy', async () => {
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn() } });
    const date = new Date('2026-10-25T07:00:00Z');
    const delivery = await prepareDelivery(valid(), identity(), undefined, { date });
    expect(delivery.mailOptions.date).toBe(date);
    expect(delivery.rawMessage.toString()).toContain('\r\nDate: Sun, 25 Oct 2026 07:00:00 +0000\r\n');
  });

  it('uses the account the transport returns and renders the Sent copy only when needed', async () => {
    const refreshed = { ...account, oauth_provider: 'google' };
    createAccountSmtpTransport.mockResolvedValue({ account: refreshed, transport: { sendMail: vi.fn() } });
    const delivery = await prepareDelivery(valid(), identity());
    expect(delivery).toMatchObject({ account: refreshed, serverAutoSaves: true, rawMessage: null });
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail: vi.fn() } });
    expect((await prepareDelivery(valid(), identity())).rawMessage).toBeInstanceOf(Buffer);
  });
});

describe('deliverAndRecord', () => {
  const sendMail = vi.fn();
  const message = async (extra) => {
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
    const input = valid();
    return { userId: 'u1', input, identity: identity(), delivery: await prepareDelivery(input, identity()), ...extra };
  };
  beforeEach(() => {
    sendMail.mockResolvedValue({});
    resolveSentFolder.mockResolvedValue('Sent');
    query.mockResolvedValue({ rows: [{ id: 'book1' }] });
  });

  it('delivers, deletes the draft, stores the Sent copy once and reports the result', async () => {
    const onResult = vi.fn();
    const msg = await message({ sentDraft: { uid: 3, folder: 'Drafts', accountId: 'a1' } });
    const result = await deliverAndRecord(msg, { onResult });
    expect(result).toEqual({ ok: true, sentFolder: 'Sent', messageId: msg.delivery.mailOptions.messageId });
    expect(onResult).toHaveBeenCalledWith(result);
    expect(sendMail).toHaveBeenCalledWith(msg.delivery.mailOptions);
    expect(deleteSentDraft).toHaveBeenCalledWith('u1', account, { uid: 3, folder: 'Drafts', accountId: 'a1' });
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
    expect(imapManager.appendToSent).toHaveBeenCalledWith(account, 'Sent', msg.delivery.rawMessage);
  });

  it('calls onDelivered once SMTP accepted, before the draft is deleted', async () => {
    const order = [];
    const onDelivered = vi.fn(async early => { order.push(['delivered', early]); });
    deleteSentDraft.mockImplementationOnce(async () => { order.push(['draft']); return true; });
    sendMail.mockResolvedValue({ rejected: ['bad@example.com'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliverAndRecord(await message({ sentDraft: { uid: 3 } }), { onDelivered });
    expect(order).toEqual([['delivered', { ok: true, rejected: ['bad@example.com'] }], ['draft']]);
    // The refusals with their codes, for the scheduler to tell deferrals from rejections.
    expect(onDelivered.mock.calls[0][1]).toEqual({ refusals: [] });
    sendMail.mockResolvedValue({ rejected: ['later@example.com', 'bad@example.com'], rejectedErrors: [
      Object.assign(new Error('x'), { recipient: 'later@example.com', responseCode: 450 }),
      Object.assign(new Error('x'), { recipient: 'bad@example.com', responseCode: 550 }),
    ] });
    await deliverAndRecord(await message(), { onDelivered });
    expect(onDelivered.mock.calls[1][1]).toEqual({ refusals: [
      { recipient: 'later@example.com', responseCode: 450 }, { recipient: 'bad@example.com', responseCode: 550 },
    ] });
  });

  it('rejects with a public message and calls onFailure when SMTP refuses the message', async () => {
    const onFailure = vi.fn();
    const onResult = vi.fn();
    sendMail.mockRejectedValue(new Error('535 5.7.8 bad credentials'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deliverAndRecord(await message(), { onFailure, onResult }))
      .rejects.toMatchObject({ publicMessage: 'Authentication failed. Check your email account credentials.' });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(imapManager.appendToSent).not.toHaveBeenCalled();
  });

  it('keeps the SMTP error on the rejection, so a retry can tell 4xx from 5xx', async () => {
    const smtpErr = Object.assign(new Error('451 4.3.0 try again later'), { responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO' });
    sendMail.mockRejectedValue(smtpErr);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await deliverAndRecord(await message()).catch(e => e);
    expect(err.cause).toBe(smtpErr);
    expect(err).toMatchObject({ message: 'Send failed', responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO', publicMessage: 'Failed to send message. Please try again.' });

    sendMail.mockRejectedValue(new Error('socket closed'));
    const bare = await deliverAndRecord(await message()).catch(e => e);
    expect(bare.cause.message).toBe('socket closed');
    expect(Object.keys(bare)).toEqual(['publicMessage']);
  });

  it('still reports a delivered message as sent when what follows fails', async () => {
    const onFailure = vi.fn();
    resolveSentFolder.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverAndRecord(await message(), { onFailure })).toEqual({ ok: true, sentCopySaved: false });
    expect(onFailure).not.toHaveBeenCalled();
  });
});
