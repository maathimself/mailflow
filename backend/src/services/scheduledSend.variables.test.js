import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('./db.js', () => ({ pool: {}, query: vi.fn() }));
vi.mock('./ownership.js', () => ({ findOwnedAccount: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('./outgoingMail.js', () => ({
  prepareDelivery: vi.fn(), deliverAndRecord: vi.fn(), buildMailOptions: vi.fn(), renderRawMessage: vi.fn(),
  sanitizeSmtpError: vi.fn(), serverAutoSavesSent: vi.fn(() => false), validateSendInput: vi.fn(value => value),
}));
import { findOwnedAccount } from './ownership.js';
import { prepareDelivery, deliverAndRecord, buildMailOptions, renderRawMessage } from './outgoingMail.js';
import { ScheduledSender, openJson, sealJson, aad } from './scheduledSend.js';
import { classifySendError } from './scheduledSendRules.js';

const row = { id: 'm1', user_id: 'u1', account_id: 'a1', claim_token: 'claim', version: 1, smtp_started_at: '2026-10-29T01:00:00Z' };
const input = { subject: '{{ date.month }}', body: '{{ contact.givenName }}', bodyIsHtml: false };
const content = { subject: 'October', body: 'Ada', bodyIsHtml: false };
const built = { payload: { v: 1, ...input, messageId: '<stable@example.test>' }, input, identity: {}, forwarded: {} };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('ENCRYPTION_KEY', '7a'.repeat(32));
  findOwnedAccount.mockResolvedValue({ id: 'a1', enabled: true });
  prepareDelivery.mockResolvedValue({ content, contentTransformed: true });
  deliverAndRecord.mockResolvedValue({ messageId: '<stable@example.test>', sentFolder: 'Sent' });
});
describe('scheduled variable content', () => {
  const copies = [
    { recipient: 'alice@example.test', content: { subject: 'Alice', body: 'Hi Alice', bodyIsHtml: false }, messageId: '<alice@example.test>', date: new Date('2026-10-29T01:00:00Z') },
    { recipient: 'bob@example.test', content: { subject: 'Bob', body: 'Hi Bob', bodyIsHtml: false }, messageId: '<bob@example.test>', date: new Date('2026-10-29T01:00:00Z') },
  ];
  it('persists progress before every recipient and never treats the first acceptance as completion', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const sender = new ScheduledSender({ db });
    vi.spyOn(sender, 'build').mockResolvedValue(built);
    const failed = vi.spyOn(sender, 'afterError').mockResolvedValue(false);
    prepareDelivery.mockResolvedValue({ content, contentTransformed: true, personalizedDeliveries: copies });
    const interrupted = Object.assign(new Error('personalized interrupted'), { code: 'EPERSONALIZED' });
    deliverAndRecord.mockImplementation(async (_message, hooks) => {
      await hooks.onAttempt(copies[0].recipient);
      await hooks.onDelivered({ ok: true }, { personalization: { recipient: copies[0].recipient } });
      await hooks.onAttempt(copies[1].recipient);
      throw interrupted;
    });
    await sender.send(row);
    const acceptedWrite = db.query.mock.calls.find(([sql]) => sql.includes('CASE WHEN $5'));
    expect(acceptedWrite[1][4]).toBe(false);
    const progress = openJson(db.query.mock.calls.at(-1)[1][2], aad.payload(row)).deliveryProgress;
    expect(progress).toEqual({ attempted: ['alice@example.test', 'bob@example.test'], accepted: ['alice@example.test'], finished: ['alice@example.test'] });
    expect(failed).toHaveBeenCalledWith(row, interrupted, 'send');
    expect(classifySendError(interrupted, { phase: 'send' }).outcome).toBe('uncertain');
  });
  it('an explicit retry skips confirmed recipients and retains their original recovery snapshots', async () => {
    const payload = { ...built.payload, preparedDeliveries: copies.map(copy => ({ ...copy, date: copy.date.toISOString() })),
      deliveryProgress: { attempted: ['alice@example.test'], accepted: ['alice@example.test'], finished: ['alice@example.test'] } };
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const sender = new ScheduledSender({ db });
    vi.spyOn(sender, 'build').mockResolvedValue({ ...built, payload });
    vi.spyOn(sender, 'markSent').mockResolvedValue(true);
    prepareDelivery.mockResolvedValue({ content, contentTransformed: true, personalizedDeliveries: [copies[1]] });
    deliverAndRecord.mockImplementation(async (_message, hooks) => {
      await hooks.onAttempt('bob@example.test');
      await hooks.onDelivered({ ok: true }, { personalization: { recipient: 'bob@example.test' } });
      return {};
    });
    await sender.send(row);
    expect(prepareDelivery).toHaveBeenCalledWith(input, built.identity, built.forwarded, expect.objectContaining({ excludeRecipients: ['alice@example.test'] }));
    const saved = openJson(db.query.mock.calls[0][1][3], aad.payload(row));
    expect(saved.preparedDeliveries[0]).toEqual(payload.preparedDeliveries[0]);
    expect(db.query.mock.calls.at(-1)[1][4]).toBe(true);
  });
  it('recovers only confirmed copies with each copy’s own content, Message-ID and Date', async () => {
    const appendToSent = vi.fn();
    const sender = new ScheduledSender({ db: {}, imap: () => ({ appendToSent }) });
    vi.spyOn(sender, 'awaitSentFolder').mockResolvedValue({ path: 'Sent' });
    vi.spyOn(sender, 'findInSent').mockResolvedValue(null);
    vi.spyOn(sender, 'stillClaimed').mockResolvedValue(true);
    const marked = vi.spyOn(sender, 'markSent').mockResolvedValue(true);
    buildMailOptions.mockReturnValue({ text: 'Hi Alice' }); renderRawMessage.mockResolvedValue(Buffer.from('Alice copy'));
    await sender.finishPersonalized(row, { enabled: true }, { ...built, payload: { ...built.payload,
      preparedDeliveries: copies.map(copy => ({ ...copy, date: copy.date.toISOString() })),
      deliveryProgress: { accepted: ['alice@example.test'], finished: ['alice@example.test', 'bob@example.test'] } } });
    expect(buildMailOptions).toHaveBeenCalledWith(expect.objectContaining(copies[0].content), built.identity, built.forwarded,
      { messageId: copies[0].messageId, date: copies[0].date });
    expect(appendToSent).toHaveBeenCalledTimes(1);
    expect(marked).toHaveBeenCalledWith(row, expect.objectContaining({ rejected: ['bob@example.test'], sentCopySaved: true }), false);
  });
  it('a recovered first Sent copy does not falsely prove delivery of a whole personalized list', async () => {
    const sender = new ScheduledSender({ db: {} });
    const end = vi.spyOn(sender, 'end').mockResolvedValue(false);
    const find = vi.spyOn(sender, 'findInSent');
    const stored = { ...row, payload_enc: sealJson({ ...built.payload, preparedDeliveries: copies }, aad.payload(row)) };
    await sender.checkSent(stored);
    expect(end).toHaveBeenCalledWith(stored, { outcome: 'uncertain', code: 'interrupted' }, expect.any(Object));
    expect(find).not.toHaveBeenCalled();
  });
  it('stores an encrypted expanded snapshot before SMTP, preserving template tokens for retries', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const sender = new ScheduledSender({ db });
    vi.spyOn(sender, 'build').mockResolvedValue(built);
    vi.spyOn(sender, 'markSent').mockResolvedValue(true);
    await sender.send(row);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('payload_enc = $4');
    const saved = openJson(params[3], aad.payload(row));
    expect(saved.body).toBe('{{ contact.givenName }}');
    expect(saved.preparedContent).toEqual(content);
    expect(prepareDelivery).toHaveBeenCalledWith(input, built.identity, built.forwarded, expect.objectContaining({ date: expect.any(Date) }));
    expect(deliverAndRecord).toHaveBeenCalledOnce();
  });
  it('never sends if the claim is lost while the expanded content is being saved', async () => {
    const sender = new ScheduledSender({ db: { query: vi.fn().mockResolvedValue({ rowCount: 0 }) } });
    vi.spyOn(sender, 'build').mockResolvedValue(built);
    await sender.send(row);
    expect(deliverAndRecord).not.toHaveBeenCalled();
  });
  it('recovers the Sent copy using the saved snapshot instead of resolving a changed contact', async () => {
    const appendToSent = vi.fn();
    const sender = new ScheduledSender({ db: {}, imap: () => ({ appendToSent }) });
    vi.spyOn(sender, 'build').mockResolvedValue({ ...built, payload: { ...built.payload, preparedContent: content } });
    vi.spyOn(sender, 'awaitSentFolder').mockResolvedValue({ path: 'Sent' });
    vi.spyOn(sender, 'findInSent').mockResolvedValue(null);
    vi.spyOn(sender, 'stillClaimed').mockResolvedValue(true);
    vi.spyOn(sender, 'markSent').mockResolvedValue(true);
    buildMailOptions.mockReturnValue({ text: 'Ada' }); renderRawMessage.mockResolvedValue(Buffer.from('sent copy'));
    await sender.finishAccepted(row);
    expect(buildMailOptions).toHaveBeenCalledWith(expect.objectContaining(content), built.identity, built.forwarded,
      { messageId: '<stable@example.test>', date: new Date(row.smtp_started_at) });
    expect(prepareDelivery).not.toHaveBeenCalled();
    expect(appendToSent).toHaveBeenCalledOnce();
  });
});
