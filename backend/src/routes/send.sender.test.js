import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// POST /api/mail/send — the optional fromEmail sender-authorization surface added on top
// of the existing accountId/aliasId shape: mutual exclusivity with aliasId, exact/wildcard
// authorization against sendable_addresses, the 422 SENDER_UNAVAILABLE miss, and the
// resulting mailOptions (From/Reply-To) actually handed to the SMTP transport. The
// underlying matching precedence is covered by senderAuthorization.test.js; this file is
// about how the send route wires it end-to-end (real authorizeSendableAddress, mocked db
// + SMTP transport).
const { sendMailMock, streamSendMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn().mockResolvedValue({}),
  streamSendMock: vi.fn().mockResolvedValue({
    message: { on(event, cb) { if (event === 'end') setImmediate(cb); return this; } },
  }),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn((opts) => (opts?.streamTransport ? { sendMail: streamSendMock } : { sendMail: sendMailMock })),
  },
}));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
}));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/encryption.js', () => ({ decrypt: vi.fn(v => (v ? `plain-${v}` : v)) }));
vi.mock('../services/hostValidation.js', () => ({
  resolveForConnection: vi.fn().mockResolvedValue({ host: 'smtp.example.com', servername: null }),
}));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: false }),
}));
vi.mock('../services/redis.js', () => ({
  redisClient: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) },
}));
vi.mock('../services/gtdTransitions.js', () => ({ runTransitionsForSentMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./oauth.js', () => ({ refreshMicrosoftToken: vi.fn() }));

import express from 'express';
import { query } from '../services/db.js';
import sendRoutes from './send.js';

function accountRow(overrides = {}) {
  return {
    id: 'acct-1', user_id: 'u1', sender_name: null, name: 'Work', email_address: 'me@example.com',
    smtp_host: 'smtp.example.com', smtp_port: 587, smtp_tls: 'STARTTLS', imap_skip_tls_verify: false,
    auth_user: 'me@example.com', auth_pass: 'enc:pass', oauth_provider: null, oauth_access_token: null,
    signature: null, folder_mappings: {},
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', sendRoutes);
  return app;
}

let server;
let base;

beforeAll(async () => {
  await new Promise((resolve) => { server = buildApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// A dispatcher keyed on SQL text, not call order — the send route schedules a
// fire-and-forget setImmediate (contact auto-learn) that can issue its OWN query() calls
// interleaved with (or after) the next test's, since real loopback HTTP traffic yields the
// event loop many times. Matching by SQL content instead of a positional mockResolvedValueOnce
// queue makes that interleaving harmless: an unmatched/deferred call always safely gets {rows: []}.
function mockQueries({ account, sendable = [], alias = null, sentFolder = null } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM email_accounts WHERE id')) return { rows: account ? [account] : [] };
    if (sql.includes('SELECT preferences FROM users')) return { rows: [{}] };
    if (sql.includes('FROM sendable_addresses')) return { rows: sendable };
    if (sql.includes('FROM account_aliases WHERE id')) return { rows: alias ? [alias] : [] };
    if (sql.includes('FROM folders WHERE account_id')) return { rows: sentFolder ? [{ path: sentFolder }] : [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  sendMailMock.mockClear();
});

const send = (body) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const BASE_BODY = { accountId: 'acct-1', to: ['them@example.com'], subject: 'Hi', body: 'hello' };

describe('POST /mail/send — aliasId/fromEmail mutual exclusivity', () => {
  it('rejects a request with both aliasId and fromEmail before touching the DB', async () => {
    const res = await send({ ...BASE_BODY, aliasId: 'alias-1', fromEmail: 'sales@example.com' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /mail/send — fromEmail authorization', () => {
  it('authorizes an exact sendable-address match and sends From that address', async () => {
    mockQueries({ account: accountRow(), sendable: [{ address: 'sales@example.com', name: 'Sales', reply_to: [] }] });

    const res = await send({ ...BASE_BODY, fromEmail: 'sales@example.com' });

    expect(res.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledOnce();
    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions.from).toBe('Sales <sales@example.com>');
  });

  // End-to-end seam proof: a Masked Email address synced into sendable_addresses
  // (kind='masked') must authorize a real send exactly like a synced identity —
  // kind is never selected/filtered by this route or senderAuthorization.js.
  it('authorizes and sends from a Masked Email-sourced sendable address', async () => {
    mockQueries({ account: accountRow(), sendable: [{ address: 'random1@fastmail.example', name: 'Private address', reply_to: [] }] });

    const res = await send({ ...BASE_BODY, fromEmail: 'random1@fastmail.example' });

    expect(res.status).toBe(200);
    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions.from).toBe('Private address <random1@fastmail.example>');
  });

  it('authorizes a wildcard-covered address and sends From the exact requested address', async () => {
    mockQueries({ account: accountRow(), sendable: [{ address: '*@example.com', name: 'Catch-all', reply_to: [] }] });

    const res = await send({ ...BASE_BODY, fromEmail: 'anything@example.com' });

    expect(res.status).toBe(200);
    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions.from).toBe('Catch-all <anything@example.com>');
  });

  it('rejects a fromEmail not in the sendable set with 422 SENDER_UNAVAILABLE, never reaching SMTP', async () => {
    mockQueries({ account: accountRow(), sendable: [] });

    const res = await send({ ...BASE_BODY, fromEmail: 'unknown@example.com' });
    const resBody = await res.json();

    expect(res.status).toBe(422);
    expect(resBody.code).toBe('SENDER_UNAVAILABLE');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('rejects a matched row whose stored name contains header control characters (defense in depth)', async () => {
    mockQueries({ account: accountRow(), sendable: [{ address: 'sales@example.com', name: 'Evil\r\nBcc: x@evil.example', reply_to: [] }] });

    const res = await send({ ...BASE_BODY, fromEmail: 'sales@example.com' });

    expect(res.status).toBe(422);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('omits the Reply-To header entirely when the identity has an empty reply_to', async () => {
    mockQueries({ account: accountRow(), sendable: [{ address: 'sales@example.com', name: 'Sales', reply_to: [] }] });

    await send({ ...BASE_BODY, fromEmail: 'sales@example.com' });

    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions).not.toHaveProperty('replyTo');
  });

  it('sets Reply-To from the matched identity when present', async () => {
    mockQueries({
      account: accountRow(),
      sendable: [{ address: 'sales@example.com', name: 'Sales', reply_to: [{ name: 'Help', email: 'help@example.com' }] }],
    });

    await send({ ...BASE_BODY, fromEmail: 'sales@example.com' });

    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions.replyTo).toEqual([{ name: 'Help', address: 'help@example.com' }]);
  });
});

describe('POST /mail/send — aliasId path is unchanged', () => {
  it('still sends from an alias when aliasId is given (no fromEmail involved)', async () => {
    mockQueries({
      account: accountRow(),
      alias: { id: 'alias-1', account_id: 'acct-1', name: 'Sales', email: 'sales@example.com', reply_to: null, signature: null },
    });

    const res = await send({ ...BASE_BODY, aliasId: 'alias-1' });

    expect(res.status).toBe(200);
    const mailOptions = sendMailMock.mock.calls[0][0];
    expect(mailOptions.from).toBe('Sales <sales@example.com>');
  });
});
