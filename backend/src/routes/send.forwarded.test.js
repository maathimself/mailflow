import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const revalidateLiveMessageSnapshots = vi.hoisted(() => vi.fn());
const revalidateLiveMessageSnapshotGroups = vi.hoisted(() => vi.fn());

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/messageSnapshots.js', async importOriginal => ({
  ...(await importOriginal()),
  revalidateLiveMessageSnapshotGroups,
  revalidateLiveMessageSnapshots,
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock('../index.js', () => ({ imapManager: {
  fetchAttachment: vi.fn(),
  appendToSent: vi.fn(),
  upsertSentMessageRecord: vi.fn(),
  findUidByMessageIdReceipt: vi.fn(),
  upsertSentMessageRecordFromReceipt: vi.fn(),
  syncFolderOnDemand: vi.fn().mockResolvedValue(undefined),
  pluginFacade: {},
} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));

import express from 'express';
import sendRoutes from './send.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { redisClient } from '../services/redis.js';

const ACCOUNT_ID = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const MSG_ID = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
const ACCOUNT = { id: ACCOUNT_ID, email_address: 'me@example.com', name: 'Me', sender_name: null, signature: null };

function headersFrom(message) {
  const headerBlock = Buffer.from(message).toString('utf8').split(/\r?\n\r?\n/, 1)[0];
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  return new Map(unfolded.split(/\r?\n/).flatMap(line => {
    const separator = line.indexOf(':');
    return separator < 1
      ? []
      : [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]];
  }));
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '35mb' }));
  app.use('/api/mail', sendRoutes);
  return app;
}

describe('POST /api/mail/send — forwarded attachment guards (#F2)', () => {
let server, base;
  let ledgerDigest;
  beforeAll(async () => {
    await new Promise(r => { server = buildApp().listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });
  beforeEach(() => {
    query.mockReset();
    imapManager.fetchAttachment.mockReset();
    imapManager.appendToSent.mockReset();
    imapManager.upsertSentMessageRecord.mockReset();
    imapManager.findUidByMessageIdReceipt.mockReset();
    imapManager.upsertSentMessageRecordFromReceipt.mockReset();
    revalidateLiveMessageSnapshots.mockReset().mockResolvedValue(undefined);
    revalidateLiveMessageSnapshotGroups.mockReset().mockResolvedValue(undefined);
    createAccountSmtpTransport.mockReset();
    redisClient.get.mockReset().mockResolvedValue(null);
    redisClient.set.mockReset().mockResolvedValue('OK');
    redisClient.del.mockReset().mockResolvedValue(1);
    ledgerDigest = null;
  });

  const post = (body) => fetch(`${base}/api/mail/send`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-send-key',
    }, body: JSON.stringify(body),
  });

  it('requires a durable operation identity before SMTP or IMAP mutation', async () => {
    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['x@example.com'] }),
    });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('fails closed when the durable send reservation store is unavailable', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('INSERT INTO send_operations')) throw new Error('database unavailable');
      return { rows: [] };
    });
    const res = await post({ accountId: ACCOUNT_ID, to: ['x@example.com'] });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      operationKeyDisposition: 'rotate_on_payload_change',
    });
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('tells clients to retain a key whose provider attempt already started', async () => {
    let digest;
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.includes('INSERT INTO send_operations')) {
        digest = params[2];
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT state, payload_digest')) {
        return { rows: [{ state: 'provider_started', payload_digest: digest }] };
      }
      return { rows: [] };
    });

    const res = await post({ accountId: ACCOUNT_ID, to: ['x@example.com'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'SEND_OUTCOME_UNCERTAIN',
      operationKeyDisposition: 'retain',
    });
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
  });

  it('rejects more than 100 forwarded attachments before doing any DB work', async () => {
    const forwardedAttachments = Array.from({ length: 101 }, () => ({ messageId: MSG_ID, part: '2' }));
    const res = await post({ accountId: ACCOUNT_ID, to: ['x@example.com'], forwardedAttachments });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Too many forwarded attachments/);
    expect(query).not.toHaveBeenCalled();
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('rejects an oversized forwarded batch by declared size, before fetching any attachment', async () => {
    query.mockImplementation((sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('SELECT preferences FROM users')) return Promise.resolve({ rows: [{ preferences: {} }] });
      if (sql.includes('INSERT INTO send_operations')) { ledgerDigest = params[2]; return Promise.resolve({ rows: [] }); }
      if (sql.includes('SELECT state, payload_digest')) return Promise.resolve({ rows: [{ state: 'ready', payload_digest: ledgerDigest }] });
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) {
        return Promise.resolve({ rows: [{
          id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
          attachments: [{ part: '2', size: 30_000_000, filename: 'big.pdf', type: 'application/pdf' }],
        }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'],
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds 25 MB/);
    // The whole point: no IMAP fetch happens when the declared size already blows the limit.
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('rejects a deleted or incomplete forwarded-message source before IMAP fetch', async () => {
    query.mockImplementation((sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return Promise.resolve({ rows: [ACCOUNT] });
      if (sql.includes('SELECT preferences FROM users')) return Promise.resolve({ rows: [{ preferences: {} }] });
      if (sql.includes('INSERT INTO send_operations')) { ledgerDigest = params[2]; return Promise.resolve({ rows: [] }); }
      if (sql.includes('SELECT state, payload_digest')) return Promise.resolve({ rows: [{ state: 'ready', payload_digest: ledgerDigest }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'],
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });

    expect(res.status).toBe(404);
    const ownershipSql = query.mock.calls.find(([sql]) => sql.includes('FROM messages m'))[0];
    expect(ownershipSql).toMatch(/m\.is_deleted = false/);
    expect(ownershipSql).toMatch(/m\.metadata_complete = true/);
    expect(ownershipSql).toMatch(/JOIN folders live_folder/);
    expect(ownershipSql).toMatch(/live_folder\.is_present = true/);
    expect(ownershipSql).toMatch(/live_folder\.uid_validity IS NOT NULL/);
    expect(ownershipSql).toMatch(/folder_uid_validity/);
    expect(ownershipSql).toMatch(/folder_observation_generation/);
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
  });

  it('uses the request idempotency key for durable Sent APPEND and materializes inside completion', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@x>' });
    const account = { ...ACCOUNT, oauth_provider: null, folder_mappings: { sent: 'Sent' } };
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
    imapManager.appendToSent.mockImplementationOnce(async (_account, folder, _raw, options) => {
      expect(options.operationKey).toBe('send:user-1:request-123');
      await options.materialize({ uid: 88, uidValidity: '202', folder });
      return { uid: 88, uidValidity: '202', folder };
    });
    imapManager.upsertSentMessageRecord.mockResolvedValueOnce(undefined);
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) {
        return { rows: [account] };
      }
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book-1' }] };
      if (sql.includes('INSERT INTO send_operations')) { ledgerDigest = params[2]; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ state: 'ready', payload_digest: ledgerDigest }] };
      if (sql.includes('UPDATE send_operations')) return { rows: [{ operation_key: 'request-123' }], rowCount: 1 };
      return { rows: [] };
    });

    const res = await fetch(`${base}/api/mail/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'request-123' },
      body: JSON.stringify({ accountId: ACCOUNT_ID, to: ['x@example.com'], subject: 'hello', body: 'body' }),
    });

    expect(res.status).toBe(200);
    expect(imapManager.appendToSent).toHaveBeenCalledOnce();
    expect(imapManager.upsertSentMessageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT_ID }), 'Sent', 88, expect.objectContaining({ subject: 'hello' }),
    );
    const completionSql = query.mock.calls.find(([sql]) => sql.includes("SET state = 'completed'"))?.[0];
    expect(completionSql).toMatch(/smtp_message\s*=\s*NULL/i);
    expect(completionSql).toMatch(/smtp_envelope\s*=\s*NULL/i);
    expect(completionSql).toMatch(/raw_message\s*=\s*NULL/i);
    expect(completionSql).toMatch(/source_snapshots\s*=\s*NULL/i);
  });

  it('durably prepares the stable Message-ID and exact Sent recovery facts before SMTP starts', async () => {
    const events = [];
    const sendMail = vi.fn(async mail => {
      events.push('smtp');
      expect(Buffer.from(mail.raw).toString()).toContain(`Message-ID: ${operation.message_id}`);
      return { messageId: operation.message_id };
    });
    const account = { ...ACCOUNT, oauth_provider: null, folder_mappings: { sent: 'Sent' } };
    const operation = { state: 'ready', payload_digest: null };
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
    imapManager.appendToSent.mockResolvedValue({ uid: 88, uidValidity: '202', folder: 'Sent' });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [account] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('INSERT INTO send_operations')) {
        operation.payload_digest = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ ...operation }] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SET message_id =')) {
        events.push('prepared');
        operation.message_id = params[3];
        operation.sent_folder = params[4];
        operation.sent_metadata = JSON.parse(params[5]);
        operation.raw_message = params[6];
        operation.server_auto_saves = params[7];
        operation.smtp_message = params[8];
        operation.smtp_envelope = JSON.parse(params[9]);
        operation.prepared_payload_digest = params[10];
        operation.source_snapshots = JSON.parse(params[11]);
        return { rows: [{ ...operation }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_started'")) {
        expect(events).toEqual(['prepared']);
        operation.state = 'provider_started';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_applied'")) {
        operation.state = 'provider_applied';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'completed'")) {
        operation.state = 'completed';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book-1' }] };
      return { rows: [] };
    });

    const res = await post({
      accountId: ACCOUNT_ID,
      to: ['Visible <visible@example.com>'],
      cc: ['Copy <copy@example.com>'],
      bcc: ['Hidden <hidden@example.com>'],
      subject: 'hello',
      body: 'body',
    });

    expect(res.status).toBe(200);
    expect(events).toEqual(['prepared', 'smtp']);
    expect(operation.sent_folder).toBe('Sent');
    expect(operation.sent_metadata).toMatchObject({
      messageId: expect.stringMatching(/^<.+@example\.com>$/),
      subject: 'hello',
    });
    expect(operation.raw_message).toBeInstanceOf(Buffer);
    expect(operation.server_auto_saves).toBe(false);
    const deliveryHeaders = headersFrom(operation.smtp_message);
    expect(deliveryHeaders.get('to')).toContain('visible@example.com');
    expect(deliveryHeaders.get('cc')).toContain('copy@example.com');
    expect(deliveryHeaders.has('bcc')).toBe(false);
    expect(operation.smtp_envelope).toEqual({
      from: 'me@example.com',
      to: ['visible@example.com', 'copy@example.com', 'hidden@example.com'],
    });
    expect(headersFrom(operation.raw_message).get('bcc')).toContain('hidden@example.com');
    expect(operation.prepared_payload_digest).toBe(
      createHash('sha256')
        .update(operation.smtp_message)
        .update('\0')
        .update('{"from":"me@example.com","to":["visible@example.com","copy@example.com","hidden@example.com"]}')
        .digest('hex'),
    );
  });

  it('replays provider-applied Sent materialization without another SMTP delivery', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<stable@example.com>' });
    const account = { ...ACCOUNT, oauth_provider: null, folder_mappings: { sent: 'Sent' } };
    const operation = { state: 'ready', payload_digest: null };
    let appendAttempts = 0;
    createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
    imapManager.appendToSent.mockImplementation(async () => {
      appendAttempts++;
      if (appendAttempts === 1) throw new Error('Sent materialization unavailable');
      return { uid: 88, uidValidity: '202', folder: 'Sent' };
    });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [account] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('INSERT INTO send_operations')) {
        operation.payload_digest ||= params[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ ...operation }] };
      if (sql.includes('SELECT 1 FROM folders')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SET message_id =')) {
        Object.assign(operation, {
          message_id: params[3], sent_folder: params[4],
          sent_metadata: JSON.parse(params[5]), raw_message: params[6],
          server_auto_saves: params[7],
        });
        return { rows: [{ ...operation }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_started'")) {
        operation.state = 'provider_started';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_applied'")) {
        operation.state = 'provider_applied';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'completed'")) {
        operation.state = 'completed';
        operation.response = JSON.parse(params[3]);
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book-1' }] };
      return { rows: [] };
    });

    const body = { accountId: ACCOUNT_ID, to: ['x@example.com'], subject: 'hello', body: 'body' };
    const first = await post(body);
    expect(first.status).toBe(503);
    expect(operation.state).toBe('provider_applied');
    expect(sendMail).toHaveBeenCalledTimes(1);

    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(operation.state).toBe('completed');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(createAccountSmtpTransport).toHaveBeenCalledTimes(1);
    expect(imapManager.appendToSent).toHaveBeenCalledTimes(2);
  });

  it('replays a ready operation from its exact prepared SMTP bytes without current alias or preference drift', async () => {
    const raw = Buffer.from('From: frozen@example.com\r\nTo: Visible <visible@example.com>\r\nCc: Copy <copy@example.com>\r\nMessage-ID: <frozen@example.com>\r\n\r\nfrozen body');
    const envelope = {
      from: 'frozen@example.com',
      to: ['visible@example.com', 'copy@example.com', 'hidden@example.com'],
    };
    const preparedDigest = createHash('sha256')
      .update(raw)
      .update('\0')
      .update('{"from":"frozen@example.com","to":["visible@example.com","copy@example.com","hidden@example.com"]}')
      .digest('hex');
    const operation = {
      state: 'ready', payload_digest: null, message_id: '<frozen@example.com>',
      sent_folder: null, sent_metadata: null, raw_message: null, server_auto_saves: false,
      smtp_message: raw, smtp_envelope: envelope,
      prepared_payload_digest: preparedDigest, source_snapshots: [],
    };
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<frozen@example.com>' });
    createAccountSmtpTransport.mockResolvedValue({
      account: { ...ACCOUNT, signature: '<p>changed server signature</p>' },
      transport: { sendMail },
    });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) {
        return { rows: [{ ...ACCOUNT, signature: '<p>changed server signature</p>' }] };
      }
      if (sql.includes('SELECT preferences FROM users')) {
        return { rows: [{ preferences: { plaintextEmail: true } }] };
      }
      if (sql.includes('INSERT INTO send_operations')) {
        operation.payload_digest = params[2];
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ ...operation }] };
      if (sql.includes('FROM account_aliases')) return { rows: [{
        name: 'Changed Alias', email: 'changed@example.com', reply_to: null,
        signature: '<p>changed alias signature</p>',
      }] };
      if (sql.includes('FROM messages m')) return { rows: [] };
      if (sql.includes("SET state = 'provider_started'")) {
        operation.state = 'provider_started';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_applied'")) {
        operation.state = 'provider_applied';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'completed'")) {
        operation.state = 'completed';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO address_books')) return { rows: [{ id: 'book-1' }] };
      return { rows: [] };
    });

    const res = await post({
      accountId: ACCOUNT_ID, aliasId: 'changed-alias',
      to: ['Visible <visible@example.com>'], cc: ['Copy <copy@example.com>'],
      bcc: ['Hidden <hidden@example.com>'],
      subject: 'same request', body: 'same request body',
    });

    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledWith({ raw, envelope });
    expect(headersFrom(raw).has('bcc')).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('SELECT preferences FROM users'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM account_aliases'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM messages m'))).toBe(false);
    expect(imapManager.fetchAttachment).not.toHaveBeenCalled();
    expect(operation.state).toBe('completed');
  });

  it('records SMTP acceptance before a post-delivery source supersession', async () => {
    const events = [];
    const sendMail = vi.fn(async () => { events.push('smtp'); return { accepted: true }; });
    const source = {
      id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
      folder_uid_validity: '101', folder_observation_generation: '9',
      read_revision: '3', star_revision: '5',
      attachments: [{ part: '2', size: 5, filename: 'a.txt', type: 'text/plain' }],
    };
    const operation = { state: 'ready', payload_digest: null };
    createAccountSmtpTransport.mockResolvedValue({ account: ACCOUNT, transport: { sendMail } });
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from('exact'));
    revalidateLiveMessageSnapshotGroups
      .mockImplementationOnce(async () => { events.push('validate-pre'); })
      .mockImplementationOnce(async () => {
        events.push('validate-post');
        throw Object.assign(new Error('Message snapshot was relocated or superseded'), {
          code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true,
        });
      });
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) return { rows: [source] };
      if (sql.includes('FROM email_accounts WHERE id = ANY')) return { rows: [ACCOUNT] };
      if (sql.includes('INSERT INTO send_operations')) { operation.payload_digest ||= params[2]; return { rows: [] }; }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ ...operation }] };
      if (sql.includes('SET message_id =')) return { rows: [{ ...operation, message_id: params[3] }], rowCount: 1 };
      if (sql.includes("SET state = 'provider_started'")) {
        operation.state = 'provider_started';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'provider_applied'")) {
        events.push('provider-applied');
        operation.state = 'provider_applied';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'uncertain'")) {
        operation.state = 'uncertain';
        return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      }
      if (sql.includes("SET state = 'completed'")) throw new Error('source fence failure must defer completion');
      return { rows: [] };
    });

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'], subject: 'forward', body: 'body',
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: 'SENT_MATERIALIZATION_PENDING',
      outcome: 'provider_applied',
      retryable: true,
      operationKeyDisposition: 'retain',
    });
    expect(events).toEqual(['validate-pre', 'smtp', 'provider-applied', 'validate-post']);
    expect(operation.state).toBe('provider_applied');
  });

  it('does not hand fetched forwarded attachments to SMTP after their source relocates', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@x>' });
    createAccountSmtpTransport.mockResolvedValue({ account: ACCOUNT, transport: { sendMail } });
    const source = {
      id: MSG_ID, uid: 5, folder: 'INBOX', account_id: ACCOUNT_ID,
      folder_uid_validity: '101', folder_observation_generation: '9',
      read_revision: '3', star_revision: '5',
      attachments: [{ part: '2', size: 5, filename: 'a.txt', type: 'text/plain' }],
    };
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM email_accounts WHERE id = $1 AND user_id = $2')) return { rows: [ACCOUNT] };
      if (sql.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY')) return { rows: [source] };
      if (sql.includes('FROM email_accounts WHERE id = ANY')) return { rows: [ACCOUNT] };
      if (sql.includes('INSERT INTO send_operations')) { ledgerDigest = params[2]; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SELECT state, payload_digest')) return { rows: [{ state: 'ready', payload_digest: ledgerDigest }] };
      if (sql.includes('UPDATE send_operations')) return { rows: [{ operation_key: 'test-send-key' }], rowCount: 1 };
      return { rows: [] };
    });
    imapManager.fetchAttachment.mockResolvedValue(Buffer.from('stale'));
    revalidateLiveMessageSnapshotGroups.mockRejectedValue(Object.assign(
      new Error('Message snapshot was relocated or superseded'),
      { code: 'MESSAGE_SNAPSHOT_SUPERSEDED', retryable: true },
    ));

    const res = await post({
      accountId: ACCOUNT_ID, to: ['x@example.com'], subject: 'forward', body: 'body',
      forwardedAttachments: [{ messageId: MSG_ID, part: '2' }],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      outcome: 'not_sent',
      operationKeyDisposition: 'rotate_on_payload_change',
    });
    expect(revalidateLiveMessageSnapshotGroups).toHaveBeenCalledWith(expect.any(Map));
    const groups = revalidateLiveMessageSnapshotGroups.mock.calls[0][0];
    expect(groups.get(ACCOUNT_ID)).toEqual([expect.objectContaining({
      id: MSG_ID, uid: 5, folder: 'INBOX', uidValidity: '101', folderGeneration: '9',
    })]);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
