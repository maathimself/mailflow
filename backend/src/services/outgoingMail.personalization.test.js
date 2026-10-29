import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import express from 'express';

const state = vi.hoisted(() => ({ redis: new Map() }));
vi.mock('./db.js', () => ({ query: vi.fn(async () => ({ rows: [{ preferences: {}, id: 'book1' }] })) }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn(), findOwnedMessages: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn(async () => null) }));
vi.mock('./draftCopies.js', () => ({ deleteSentDraft: vi.fn(async () => true) }));
vi.mock('../plugins/api.js', () => ({ getOwnedContactByEmail: vi.fn(), isPluginActivated: vi.fn(async () => true) }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('./redis.js', () => ({ redisClient: {
  get: vi.fn(async key => state.redis.get(key) ?? null),
  set: vi.fn(async (key, value, options = {}) => { if (options.NX && state.redis.has(key)) return null; state.redis.set(key, value); return 'OK'; }),
  del: vi.fn(async key => state.redis.delete(key)),
} }));

import { pluginRegistry } from '../plugins/registry.js';
import { expandOutgoingVariables } from '../plugins/templates/variables.js';
import { getOwnedContactByEmail } from '../plugins/api.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { findOwnedAccount } from './ownership.js';
import { deleteSentDraft } from './draftCopies.js';
import { prepareDelivery, deliverAndRecord, validateSendInput } from './outgoingMail.js';
import { flushHeldSends, getSendStatus } from './sendHold.js';
import sendRouter from '../routes/send.js';

pluginRegistry.register({ id: 'templates', name: 'Templates', version: '1', tier: 1, hooks: { outgoingContent: expandOutgoingVariables } });
const account = { id: 'a1', user_id: 'u1', email_address: 'me@example.test', oauth_provider: 'google' };
const identity = { account, fromName: 'Me', fromEmail: account.email_address, plaintextEmail: true };
const fields = { accountId: 'a1', to: ['Alice <alice@example.test>'], cc: ['Bob <bob@example.test>', 'ALICE@example.test'],
  bcc: ['Cara <cara@example.test>', 'Dana <dana@example.test>'], subject: 'For {{ contact.givenName }}', body: 'Hi {{ contact.givenName }} ({{ email.address }})' };
const sendMail = vi.fn();
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/send', sendRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/send/send`;
});
afterAll(async () => { await flushHeldSends(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks(); state.redis.clear();
  findOwnedAccount.mockResolvedValue(account);
  getOwnedContactByEmail.mockImplementation(async (_owner, email) => ({ first_name: email.split('@')[0].replace(/^./, c => c.toUpperCase()) }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
});
const post = extra => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'batch1' }, body: JSON.stringify({ ...fields, ...extra }) });

describe('personalization for all recipient fields', () => {
  it('preflights every distinct To/Cc/Bcc recipient and delivers isolated envelopes with unique content and IDs', async () => {
    const input = validateSendInput(fields);
    const delivery = await prepareDelivery(input, identity, undefined, { messageId: '<batch@example.test>' });
    expect(getOwnedContactByEmail).toHaveBeenCalledTimes(4);
    expect(sendMail).not.toHaveBeenCalled();
    // Stream transport deliberately keeps Bcc for Sent copies. Capture the normal SMTP MIME
    // stream instead, whose default excludes Bcc, without making a network connection.
    const wire = nodemailer.createTransport({ name: 'test-wire', version: '1', send(mail, done) {
      const chunks = [];
      const stream = mail.message.createReadStream();
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', done);
      stream.on('end', () => done(null, { envelope: mail.message.getEnvelope(), message: Buffer.concat(chunks) }));
    } });
    sendMail.mockImplementation(async options => {
      const rendered = await wire.sendMail(options);
      expect(rendered.envelope.to).toEqual(options.envelope.to);
      const headers = rendered.message.toString().split('\r\n\r\n')[0];
      expect(headers).not.toMatch(/^Bcc:/mi);
      expect(headers).not.toContain('cara@example.test');
      expect(headers).not.toContain('dana@example.test');
      return {};
    });
    await deliverAndRecord({ userId: 'u1', input, identity, delivery, sentDraft: { uid: 1 } });
    expect(sendMail.mock.calls.map(([mail]) => [mail.envelope.to[0], mail.text])).toEqual([
      ['alice@example.test', 'Hi Alice (alice@example.test)'], ['bob@example.test', 'Hi Bob (bob@example.test)'],
      ['cara@example.test', 'Hi Cara (cara@example.test)'], ['dana@example.test', 'Hi Dana (dana@example.test)'],
    ]);
    expect(new Set(sendMail.mock.calls.map(([mail]) => mail.messageId)).size).toBe(4);
    expect(sendMail.mock.calls[0][0].cc).toContain('bob@example.test');
    expect(deleteSentDraft).toHaveBeenCalledTimes(1);
  });
  it('rejects missing data for a Bcc recipient before creating a transport or sending any copy', async () => {
    getOwnedContactByEmail.mockImplementation(async (_owner, email) => email.startsWith('dana') ? null : { first_name: 'Known' });
    await expect(prepareDelivery(validateSendInput(fields), identity)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('dana@example.test') });
    expect(createAccountSmtpTransport).not.toHaveBeenCalled(); expect(sendMail).not.toHaveBeenCalled();
  });
  it('keeps ordinary messages and date-only templates as one group delivery', async () => {
    const input = validateSendInput({ ...fields, subject: 'Hi', body: '{{ date.month }}' });
    const delivery = await prepareDelivery(input, identity);
    expect(delivery.personalizedDeliveries).toBeUndefined();
    await deliverAndRecord({ userId: 'u1', input, identity, delivery });
    expect(sendMail).toHaveBeenCalledTimes(1); expect(sendMail.mock.calls[0][0].envelope).toBeUndefined();
  });
  it('retries only recipients not already confirmed, with stable per-recipient Message-IDs', async () => {
    const input = validateSendInput(fields);
    const original = await prepareDelivery(input, identity, undefined, { messageId: '<batch@example.test>' });
    getOwnedContactByEmail.mockClear();
    const retry = await prepareDelivery(input, identity, undefined, { messageId: '<batch@example.test>', excludeRecipients: ['alice@example.test', 'bob@example.test'] });
    expect(getOwnedContactByEmail.mock.calls.map(call => call[1])).toEqual(['cara@example.test', 'dana@example.test']);
    expect(retry.personalizedDeliveries.map(copy => copy.messageId)).toEqual(original.personalizedDeliveries.slice(2).map(copy => copy.messageId));
  });
  it('caches a partial failure so retrying the same send cannot duplicate the successful copy', async () => {
    sendMail.mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('refused'), { responseCode: 550 }));
    const first = await post();
    expect(first.status).toBe(500);
    expect((await first.json()).error).toContain('Confirmed delivered: alice@example.test');
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(deleteSentDraft).not.toHaveBeenCalled();
    const retry = await post(); expect(retry.status).toBe(409);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
  it('allows retry after a definitive authentication failure before any recipient received a copy', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('authentication failed'), { code: 'EAUTH', responseCode: 535 }));
    const first = await post(); expect(first.status).toBe(500);
    expect(state.redis.has('send_idem:u1:batch1')).toBe(false);
    const retry = await post(); expect(retry.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(5);
  });
  it('keeps Undo Send status at sending until the entire personalized list finishes', async () => {
    let release;
    sendMail.mockResolvedValueOnce({}).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const response = await post({ undoSeconds: 10 });
    const { pendingId } = await response.json();
    const flushing = flushHeldSends();
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(2));
    expect(await getSendStatus('u1', pendingId)).toEqual({ status: 'sending' });
    release({}); await flushing;
    expect((await getSendStatus('u1', pendingId)).status).toBe('sent');
    expect(sendMail).toHaveBeenCalledTimes(4);
  });
});
